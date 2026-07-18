import { createRazorpayPartnerPayout } from "@/lib/partners/create-razorpay-payout";
import { prisma } from "@/lib/prisma";
import { PartnerPayoutMethod } from "@prisma/client";

// Dispatch RazorpayX payouts for every partner on the invoice whose payout
// method is `razorpay`. One RazorpayX payout per (partner, program), aggregating
// their processing payouts. Mirrors queueStripePayouts / sendPaypalPayouts.
export async function queueRazorpayPayouts({
  invoice,
}: {
  invoice: { id: string };
}) {
  const payouts = await prisma.payout.findMany({
    where: {
      invoiceId: invoice.id,
      status: "processing",
      method: PartnerPayoutMethod.razorpay,
    },
    select: { partnerId: true, programId: true },
  });

  // unique (partner, program) pairs
  const seen = new Set<string>();
  const pairs: { partnerId: string; programId: string }[] = [];
  for (const p of payouts) {
    const key = `${p.partnerId}:${p.programId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ partnerId: p.partnerId, programId: p.programId });
  }
  if (pairs.length === 0) return;

  await Promise.allSettled(
    pairs.map(({ partnerId, programId }) =>
      createRazorpayPartnerPayout({ invoiceId: invoice.id, partnerId, programId }),
    ),
  );
}
