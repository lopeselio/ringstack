import { describe, expect, it } from "vitest";

import { deliveryId, verifyWebhook, webhookHeaders, type RingdEvent } from "../src/index.ts";

const event: RingdEvent = {
  id: "5sig:2",
  type: "payment.received",
  wallet: "shop",
  signature: "5sig",
  slot: "48",
  kind: "privateTransfer",
  direction: "inbound",
  asset: "11111111111111111111111111111111",
  amount: "12500000",
  memo: "order:1042",
  backfill: false,
  createdAt: "2026-11-05T10:00:00.000Z",
};
const body = JSON.stringify(event);
const now = 1_800_000_000_000;
const secret = "whsec_test";

describe("verifyWebhook", () => {
  it("accepts a signed delivery and returns the event", () => {
    const headers = webhookHeaders(secret, deliveryId(event), body, now);
    const v = verifyWebhook({ body, headers, secret, nowMs: now });
    expect(v.id).toBe("shop:5sig:2");
    expect(v.event).toEqual(event);
  });

  it("works with a Fetch Headers object, byte bodies and rotated secrets", () => {
    const headers = new Headers(webhookHeaders(secret, deliveryId(event), body, now));
    const v = verifyWebhook({
      body: new TextEncoder().encode(body),
      headers,
      secret: ["whsec_new", secret],
      nowMs: now,
    });
    expect(v.event.memo).toBe("order:1042");
  });

  it("rejects a tampered body, wrong secret, or swapped id", () => {
    const headers = webhookHeaders(secret, deliveryId(event), body, now);
    const tampered = body.replace("12500000", "99500000");
    expect(() => verifyWebhook({ body: tampered, headers, secret, nowMs: now })).toThrow(/signature/);
    expect(() => verifyWebhook({ body, headers, secret: "other", nowMs: now })).toThrow(/signature/);
    const swapped = webhookHeaders(secret, "shop:other:1", body, now);
    expect(() => verifyWebhook({ body, headers: swapped, secret, nowMs: now })).toThrow(/ringd-id/);
  });

  it("rejects stale or future timestamps and missing headers", () => {
    const headers = webhookHeaders(secret, deliveryId(event), body, now);
    expect(() => verifyWebhook({ body, headers, secret, nowMs: now + 301_000 })).toThrow(/tolerance/);
    expect(() => verifyWebhook({ body, headers, secret, nowMs: now - 301_000 })).toThrow(/tolerance/);
    expect(() => verifyWebhook({ body, headers: {}, secret, nowMs: now })).toThrow(/missing/);
  });

  it("refuses to sign with an empty secret", () => {
    expect(() => webhookHeaders("", "x", body, now)).toThrow(/empty/);
  });
});
