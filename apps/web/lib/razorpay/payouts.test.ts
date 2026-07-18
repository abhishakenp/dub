import { createHmac } from "crypto";
import { PayoutStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRazorpayPayoutRequest,
  mapRazorpayPayoutStatus,
  verifyRazorpayWebhookSignature,
} from "./payouts";

describe("verifyRazorpayWebhookSignature", () => {
  const secret = "FBmraeJDQpR_82E";
  const rawBody = JSON.stringify({ event: "payout.processed", payload: { payout: { entity: { id: "pout_1" } } } });
  const validSig = createHmac("sha256", secret).update(rawBody).digest("hex");

  it("accepts a correctly signed payload", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody, signature: validSig, secret })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody: rawBody + " ", signature: validSig, secret })).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody, signature: validSig, secret: "wrong" })).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyRazorpayWebhookSignature({ rawBody, signature: null, secret })).toBe(false);
  });
});

describe("mapRazorpayPayoutStatus", () => {
  it("maps processed -> completed (money delivered)", () => {
    expect(mapRazorpayPayoutStatus("processed")).toBe(PayoutStatus.completed);
  });

  it("maps in-flight statuses -> sent", () => {
    for (const s of ["queued", "pending", "processing", "created"]) {
      expect(mapRazorpayPayoutStatus(s)).toBe(PayoutStatus.sent);
    }
  });

  it("maps terminal-failure statuses -> failed", () => {
    for (const s of ["reversed", "failed", "rejected", "cancelled"]) {
      expect(mapRazorpayPayoutStatus(s)).toBe(PayoutStatus.failed);
    }
  });

  it("returns null for unknown statuses", () => {
    expect(mapRazorpayPayoutStatus("something_new")).toBeNull();
  });
});

describe("buildRazorpayPayoutRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds the RazorpayX payout body in paise with INR + IMPS defaults", () => {
    const body = buildRazorpayPayoutRequest({
      fundAccountId: "fa_123",
      amount: 4900,
      referenceId: "po_abc",
      narration: "ShipFast partner payout",
      accountNumber: "2323230000000000",
    });
    expect(body).toMatchObject({
      account_number: "2323230000000000",
      fund_account_id: "fa_123",
      amount: 4900,
      currency: "INR",
      mode: "IMPS",
      purpose: "payout",
      reference_id: "po_abc",
      narration: "ShipFast partner payout",
      queue_if_low_balance: true,
    });
  });

  it("reads the virtual account number from env when not passed", () => {
    vi.stubEnv("RAZORPAY_ACCOUNT_NUMBER", "9999990000000000");
    const body = buildRazorpayPayoutRequest({ fundAccountId: "fa_1", amount: 100, referenceId: "po_1" });
    expect(body.account_number).toBe("9999990000000000");
  });

  it("throws when no virtual account number is available", () => {
    vi.stubEnv("RAZORPAY_ACCOUNT_NUMBER", "");
    expect(() => buildRazorpayPayoutRequest({ fundAccountId: "fa_1", amount: 100, referenceId: "po_1" })).toThrow(
      /RAZORPAY_ACCOUNT_NUMBER/,
    );
  });

  it("supports UPI mode for VPA fund accounts", () => {
    const body = buildRazorpayPayoutRequest({ fundAccountId: "fa_1", amount: 100, referenceId: "po_1", mode: "UPI", accountNumber: "1" });
    expect(body.mode).toBe("UPI");
  });
});
