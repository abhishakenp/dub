import { prisma } from "@/lib/prisma";
import {
  mapRazorpayPayoutStatus,
  verifyRazorpayWebhookSignature,
} from "@/lib/razorpay/payouts";
import { PayoutStatus } from "@prisma/client";

// POST /api/razorpay/webhook
// RazorpayX payout webhook: payout.processed -> completed (money delivered),
// payout.failed / payout.reversed -> failed. Mirrors Dub's Stripe/PayPal payout
// webhook handlers but for the self-hosted RazorpayX rail.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!verifyRazorpayWebhookSignature({ rawBody, signature })) {
    return new Response("Invalid webhook signature.", { status: 401 });
  }

  let event: {
    event?: string;
    payload?: { payout?: { entity?: { id?: string; status?: string; failure_reason?: string } } };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }

  const payout = event.payload?.payout?.entity;
  const razorpayPayoutId = payout?.id;
  const razorpayStatus = payout?.status;
  if (!razorpayPayoutId || !razorpayStatus) {
    return new Response("Missing payout entity.", { status: 200 });
  }

  const mapped = mapRazorpayPayoutStatus(razorpayStatus);
  if (!mapped || mapped === PayoutStatus.sent) {
    // in-flight statuses need no state change (payout is already `sent`)
    return new Response(`Ignored status ${razorpayStatus}.`, { status: 200 });
  }

  const existing = await prisma.payout.findUnique({
    where: { razorpayPayoutId },
    select: { id: true, status: true },
  });
  if (!existing) {
    return new Response(`No payout for ${razorpayPayoutId}.`, { status: 200 });
  }

  await prisma.payout.update({
    where: { razorpayPayoutId },
    data: {
      status: mapped,
      ...(mapped === PayoutStatus.completed ? { paidAt: new Date() } : {}),
      ...(mapped === PayoutStatus.failed
        ? { failureReason: payout.failure_reason ?? "RazorpayX payout failed" }
        : {}),
    },
  });

  // When the money is delivered, mark the payout's commissions as paid.
  if (mapped === PayoutStatus.completed) {
    await prisma.commission.updateMany({
      where: { payoutId: existing.id },
      data: { status: "paid" },
    });
  }

  return new Response(`Payout ${razorpayPayoutId} -> ${mapped}.`, { status: 200 });
}
