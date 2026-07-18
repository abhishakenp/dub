import { prisma } from "@/lib/prisma";
import { createRazorpayPayout } from "@/lib/razorpay/payouts";

// Send a partner's due payouts via RazorpayX. Called from the charge-succeeded
// dispatch for partners whose defaultPayoutMethod === "razorpay". Aggregates the
// partner's processing/pending payouts on this invoice, initiates one RazorpayX
// payout, and marks the payouts `sent` + records razorpayPayoutId. Final
// completed/failed comes from the webhook (app/(ee)/api/razorpay/webhook).
export async function createRazorpayPartnerPayout({
  invoiceId,
  partnerId,
  programId,
}: {
  invoiceId: string;
  partnerId: string;
  programId: string;
}): Promise<{ sent: boolean; reason?: string; razorpayPayoutId?: string }> {
  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: {
      name: true,
      razorpayFundAccountId: true,
      payoutsEnabledAt: true,
    },
  });
  if (!partner?.razorpayFundAccountId) {
    return { sent: false, reason: "partner has no RazorpayX fund account" };
  }
  if (!partner.payoutsEnabledAt) {
    return { sent: false, reason: "partner payouts not enabled" };
  }

  const payouts = await prisma.payout.findMany({
    where: { invoiceId, partnerId, programId, status: "processing" },
    select: { id: true, amount: true },
  });
  if (payouts.length === 0) {
    return { sent: false, reason: "no processing payouts" };
  }

  const totalAmount = payouts.reduce((sum, p) => sum + p.amount, 0);
  const idempotencyKey = `razorpay-payout:${invoiceId}:${partnerId}`;

  const result = await createRazorpayPayout({
    fundAccountId: partner.razorpayFundAccountId,
    amount: totalAmount, // minor units (paise)
    mode: "IMPS",
    referenceId: idempotencyKey.slice(0, 40),
    narration: "ShipFast partner payout",
    idempotencyKey,
  });

  await prisma.payout.updateMany({
    where: { id: { in: payouts.map((p) => p.id) } },
    data: {
      status: "sent",
      razorpayPayoutId: result.id,
      paidAt: null,
    },
  });

  return { sent: true, razorpayPayoutId: result.id };
}
