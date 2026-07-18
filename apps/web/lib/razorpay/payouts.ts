import { createHmac, timingSafeEqual } from "crypto";
import { PayoutStatus } from "@prisma/client";

// RazorpayX (payouts) API client + webhook verification + status mapping.
// Replaces Dub's Stripe Connect / PayPal / Tremendous partner payout rails.
// Docs: https://razorpay.com/docs/x/apis/

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured");
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

async function razorpayRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${RAZORPAY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: { description?: string; code?: string } };
  if (!res.ok || json.error) {
    throw new Error(`RazorpayX ${method} ${path} failed: ${json.error?.description ?? res.statusText}`);
  }
  return json;
}

// ── Onboarding: Contact + Fund Account ───────────────────────────────────────
export type RazorpayContact = { id: string; active: boolean; type: string };
export type RazorpayFundAccount = { id: string; active: boolean; account_type: string };

export function createRazorpayContact(input: {
  name: string;
  email?: string;
  referenceId: string;
}): Promise<RazorpayContact> {
  return razorpayRequest<RazorpayContact>("POST", "/contacts", {
    name: input.name,
    ...(input.email ? { email: input.email } : {}),
    type: "vendor",
    reference_id: input.referenceId,
  });
}

export function createRazorpayVpaFundAccount(input: {
  contactId: string;
  vpa: string; // UPI address, e.g. "partner@upi"
}): Promise<RazorpayFundAccount> {
  return razorpayRequest<RazorpayFundAccount>("POST", "/fund_accounts", {
    contact_id: input.contactId,
    account_type: "vpa",
    vpa: { address: input.vpa },
  });
}

export function createRazorpayBankFundAccount(input: {
  contactId: string;
  name: string;
  ifsc: string;
  accountNumber: string;
}): Promise<RazorpayFundAccount> {
  return razorpayRequest<RazorpayFundAccount>("POST", "/fund_accounts", {
    contact_id: input.contactId,
    account_type: "bank_account",
    bank_account: { name: input.name, ifsc: input.ifsc, account_number: input.accountNumber },
  });
}

// ── Payout ───────────────────────────────────────────────────────────────────
export type RazorpayPayout = { id: string; status: string; amount: number; utr?: string };

// Build the create-payout request body (pure — unit-testable without the network).
export function buildRazorpayPayoutRequest(input: {
  fundAccountId: string;
  amount: number; // minor units (paise)
  mode?: "IMPS" | "NEFT" | "UPI" | "RTGS";
  referenceId: string;
  narration?: string;
  accountNumber?: string;
}): Record<string, unknown> {
  const accountNumber = input.accountNumber ?? process.env.RAZORPAY_ACCOUNT_NUMBER;
  if (!accountNumber) throw new Error("RAZORPAY_ACCOUNT_NUMBER (RazorpayX virtual account) not configured");
  return {
    account_number: accountNumber,
    fund_account_id: input.fundAccountId,
    amount: input.amount,
    currency: "INR",
    mode: input.mode ?? "IMPS",
    purpose: "payout",
    queue_if_low_balance: true,
    reference_id: input.referenceId,
    ...(input.narration ? { narration: input.narration } : {}),
  };
}

export function createRazorpayPayout(
  input: Parameters<typeof buildRazorpayPayoutRequest>[0] & { idempotencyKey?: string },
): Promise<RazorpayPayout> {
  // Razorpay dedupes on X-Payout-Idempotency; include it when provided.
  const body = buildRazorpayPayoutRequest(input);
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured");
  return fetch(`${RAZORPAY_API_BASE}/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      ...(input.idempotencyKey ? { "X-Payout-Idempotency": input.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const json = (await res.json()) as RazorpayPayout & { error?: { description?: string } };
    if (!res.ok || json.error) throw new Error(`RazorpayX payout failed: ${json.error?.description ?? res.statusText}`);
    return json;
  });
}

export function fetchRazorpayPayout(id: string): Promise<RazorpayPayout> {
  return razorpayRequest<RazorpayPayout>("GET", `/payouts/${id}`);
}

// ── Webhook signature verification ───────────────────────────────────────────
// Razorpay signs webhooks: HMAC-SHA256(rawBody, webhookSecret) as hex, sent in
// the `X-Razorpay-Signature` header.
export function verifyRazorpayWebhookSignature(params: {
  rawBody: string;
  signature: string | null;
  secret?: string;
}): boolean {
  const secret = params.secret ?? process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !params.signature) return false;
  const expected = createHmac("sha256", secret).update(params.rawBody).digest("hex");
  const a = new Uint8Array(Buffer.from(expected));
  const b = new Uint8Array(Buffer.from(params.signature));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Status mapping (RazorpayX payout status -> Dub PayoutStatus) ──────────────
export function mapRazorpayPayoutStatus(razorpayStatus: string): PayoutStatus | null {
  switch (razorpayStatus) {
    case "processed":
      return PayoutStatus.completed;
    case "reversed":
    case "failed":
    case "rejected":
    case "cancelled":
      return PayoutStatus.failed;
    case "queued":
    case "pending":
    case "processing":
    case "created":
      return PayoutStatus.sent;
    default:
      return null;
  }
}
