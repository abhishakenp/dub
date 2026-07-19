// One-off seed for the self-hosted ShipFast Partners program.
// Run with DATABASE_URL pointing at the deployed MySQL:
//   DATABASE_URL="mysql://root@<host>:<port>/planetscale" npx tsx scripts/dev/seed-shipfast.ts
// Idempotent by workspace slug. Prints the API token + IDs ShipFast needs.
import { createId } from "@/lib/api/create-id";
import { hashToken } from "@/lib/auth/hash-token";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { nanoid } from "@dub/utils";

const WS_SLUG = "shipfast";
const OWNER_EMAIL = "owner@ship-fast.ai";
const OWNER_PASSWORD = "shipfast-admin-2026";
const REFERRAL_DOMAIN = "refer.ship-fast.ai";
const BIG = 1_000_000_000;

async function main() {
  const existing = await prisma.project.findUnique({
    where: { slug: WS_SLUG },
    select: { id: true, defaultProgramId: true },
  });

  // 1) Owner user (password enables the deployed `credentials` login)
  const owner = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: {},
    create: {
      id: createId({ prefix: "user_" }),
      name: "ShipFast Owner",
      email: OWNER_EMAIL,
      emailVerified: new Date(),
      passwordHash: await hashPassword(OWNER_PASSWORD),
    },
  });

  // 2) Enterprise workspace (all limits maxed → no paywall)
  const workspace =
    existing ??
    (await prisma.project.create({
      data: {
        id: createId({ prefix: "ws_" }),
        name: "ShipFast",
        slug: WS_SLUG,
        plan: "enterprise",
        billingCycleStart: 1,
        invoicePrefix: "SHIPFAST",
        conversionEnabled: true,
        webhookEnabled: true,
        usageLimit: BIG,
        linksLimit: BIG,
        payoutsLimit: BIG,
        domainsLimit: BIG,
        tagsLimit: BIG,
        foldersLimit: BIG,
        usersLimit: BIG,
        aiLimit: BIG,
        groupsLimit: BIG,
        partnersLimit: BIG,
        users: { create: { userId: owner.id, role: "owner" } },
      },
    }));

  // 3) Referral domain for partner links
  await prisma.domain.upsert({
    where: { slug: REFERRAL_DOMAIN },
    update: {},
    create: {
      id: createId({ prefix: "dom_" }),
      slug: REFERRAL_DOMAIN,
      verified: true,
      primary: true,
      projectId: workspace.id,
    },
  });

  // 4) Program (folder + 30% sale reward + default group), idempotent
  let programId = workspace.defaultProgramId;
  if (!programId) {
    programId = createId({ prefix: "prog_" });
    const folderId = createId({ prefix: "fold_" });
    const groupId = createId({ prefix: "grp_" });
    const rewardId = createId({ prefix: "rw_" });

    await prisma.folder.create({
      data: {
        id: folderId,
        name: "Partner Links",
        projectId: workspace.id,
        accessLevel: "write",
      },
    });

    // relationMode=prisma → no FK enforcement, so defaultGroupId can point at
    // the group we create just after.
    await prisma.program.create({
      data: {
        id: programId,
        workspaceId: workspace.id,
        name: "ShipFast Affiliates",
        slug: WS_SLUG,
        domain: REFERRAL_DOMAIN,
        url: "https://ship-fast.ai",
        defaultFolderId: folderId,
        defaultGroupId: groupId,
        minPayoutAmount: 1000,
      },
    });

    await prisma.reward.create({
      data: {
        id: rewardId,
        programId,
        event: "sale",
        type: "percentage",
        amountInPercentage: new Prisma.Decimal(30),
        maxDuration: null, // lifetime recurring
        description: "30% of every sale, for the lifetime of the customer",
      },
    });

    await prisma.partnerGroup.create({
      data: {
        id: groupId,
        programId,
        name: "Affiliates",
        slug: "affiliates",
        saleRewardId: rewardId,
        additionalLinks: [] as unknown as Prisma.JsonArray,
      },
    });

    await prisma.project.update({
      where: { id: workspace.id },
      data: { defaultProgramId: programId },
    });
  }

  const program = await prisma.program.findUniqueOrThrow({
    where: { id: programId },
    select: { id: true, defaultGroupId: true, domain: true },
  });

  // Rewards to copy onto each enrollment (Dub sets these on approval; the
  // commission workflow reads enrollment.saleReward, not the group's).
  const defaultGroup = await prisma.partnerGroup.findUniqueOrThrow({
    where: { id: program.defaultGroupId! },
    select: { clickRewardId: true, leadRewardId: true, saleRewardId: true },
  });

  // 5) Test partner + enrollment + tracking link (for E2E verification)
  const partnerEmail = "test-partner@ship-fast.ai";
  let partner = await prisma.partner.findFirst({
    where: { email: partnerEmail },
    select: { id: true },
  });
  if (!partner) {
    const partnerUserId = createId({ prefix: "user_" });
    const partnerId = createId({ prefix: "pn_" });
    await prisma.user.create({
      data: {
        id: partnerUserId,
        name: "Test Partner",
        email: partnerEmail,
        emailVerified: new Date(),
        passwordHash: await hashPassword(OWNER_PASSWORD),
        defaultPartnerId: partnerId,
      },
    });
    partner = await prisma.partner.create({
      data: {
        id: partnerId,
        name: "Test Partner",
        email: partnerEmail,
        country: "US",
        users: { create: { userId: partnerUserId, role: "owner" } },
      },
      select: { id: true },
    });
  }

  const linkKey = "testpartner";
  let link = await prisma.link.findFirst({
    where: { domain: program.domain!, key: linkKey },
    select: { id: true, shortLink: true },
  });
  if (!link) {
    link = await prisma.link.create({
      data: {
        id: createId({ prefix: "link_" }),
        domain: program.domain!,
        key: linkKey,
        url: "https://ship-fast.ai",
        shortLink: `https://${program.domain}/${linkKey}`,
        projectId: workspace.id,
        programId: program.id,
        partnerId: partner.id,
        trackConversion: true,
      },
      select: { id: true, shortLink: true },
    });
  }

  await prisma.programEnrollment.upsert({
    where: {
      partnerId_programId: { partnerId: partner.id, programId: program.id },
    },
    update: {
      status: "approved",
      saleRewardId: defaultGroup.saleRewardId,
      leadRewardId: defaultGroup.leadRewardId,
      clickRewardId: defaultGroup.clickRewardId,
    },
    create: {
      id: createId({ prefix: "pge_" }),
      partnerId: partner.id,
      programId: program.id,
      groupId: program.defaultGroupId,
      status: "approved",
      saleRewardId: defaultGroup.saleRewardId,
      leadRewardId: defaultGroup.leadRewardId,
      clickRewardId: defaultGroup.clickRewardId,
    },
  });

  // 6) Workspace API token (dub_...) with full scope — for ShipFast's SDK
  const apiToken = `dub_${nanoid(24)}`;
  await prisma.restrictedToken.create({
    data: {
      name: "ShipFast integration",
      hashedKey: await hashToken(apiToken),
      partialKey: `${apiToken.slice(0, 3)}...${apiToken.slice(-4)}`,
      scopes: "apis.all",
      userId: owner.id,
      projectId: workspace.id,
    },
  });

  console.log("\n========== SHIPFAST DUB SETUP ==========");
  console.log(`Workspace:         ${workspace.id} (slug: ${WS_SLUG}, enterprise)`);
  console.log(`Program:           ${program.id}`);
  console.log(`DUB_PARTNER_GROUP_ID=${program.defaultGroupId}`);
  console.log(`DUB_API_KEY=${apiToken}`);
  console.log(`Owner login:       ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  console.log(`Test partner link: ${link.shortLink} (partner ${partner.id})`);
  console.log("========================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exit(1);
  });
