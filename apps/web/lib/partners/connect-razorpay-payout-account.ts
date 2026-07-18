import { prisma } from "@/lib/prisma";
import {
  createRazorpayBankFundAccount,
  createRazorpayContact,
  createRazorpayVpaFundAccount,
} from "@/lib/razorpay/payouts";
import { PartnerPayoutMethod } from "@prisma/client";

// Connect a partner's RazorpayX payout account: create (or reuse) a Contact,
// create a Fund Account (UPI VPA or bank account), persist the ids, and enable
// payouts. Mirrors the Stripe Connect / PayPal onboarding actions.
export async function connectRazorpayPayoutAccount({
  partnerId,
  destination,
}: {
  partnerId: string;
  destination:
    | { type: "vpa"; vpa: string }
    | { type: "bank"; name: string; ifsc: string; accountNumber: string };
}): Promise<{ contactId: string; fundAccountId: string }> {
  const partner = await prisma.partner.findUniqueOrThrow({
    where: { id: partnerId },
    select: { name: true, email: true, razorpayContactId: true },
  });

  const contactId =
    partner.razorpayContactId ??
    (
      await createRazorpayContact({
        name: partner.name,
        email: partner.email ?? undefined,
        referenceId: partnerId,
      })
    ).id;

  const fundAccount =
    destination.type === "vpa"
      ? await createRazorpayVpaFundAccount({ contactId, vpa: destination.vpa })
      : await createRazorpayBankFundAccount({
          contactId,
          name: destination.name,
          ifsc: destination.ifsc,
          accountNumber: destination.accountNumber,
        });

  await prisma.partner.update({
    where: { id: partnerId },
    data: {
      razorpayContactId: contactId,
      razorpayFundAccountId: fundAccount.id,
      defaultPayoutMethod: PartnerPayoutMethod.razorpay,
      payoutsEnabledAt: new Date(),
    },
  });

  return { contactId, fundAccountId: fundAccount.id };
}
