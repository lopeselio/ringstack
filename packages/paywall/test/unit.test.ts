import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOL_MINT, ShieldedKeypair, initializePoseidon } from "@heliuslabs/spr";
import { parsePaymentRequest, type PaymentRequest } from "@ringstack/core";
import { address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import { MemoryNonceStore, Paywall, SpendLedger, SpendRefused, checkPolicy, paywalled, resourceOf } from "../src/index.ts";

const RECIPIENT = address("GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD");
let paywall: Paywall;
let store: MemoryNonceStore;

beforeAll(async () => {
  await initializePoseidon();
  const kp = ShieldedKeypair.generate();
  const vk = kp.viewingKey();
  store = new MemoryNonceStore();
  paywall = new Paywall({
    client: {
      getShieldedTransactionsBySignature: async () => ({ transactions: [] }),
    },
    vendor: { address: kp.shieldedAddress(), viewingSecret: vk.secretBytes() },
    recipient: RECIPIENT,
    cluster: "devnet",
    label: "Forecasts",
    store,
  });
});

describe("nonce store", () => {
  it("redeems a nonce once and refuses expired ones", () => {
    const s = new MemoryNonceStore();
    s.issue("a", { resource: "GET /x", price: 5n, expiresAt: Date.now() + 1000 });
    s.issue("b", { resource: "GET /x", price: 5n, expiresAt: Date.now() - 1 });
    expect(s.consume("a", Date.now())?.price).toBe(5n);
    expect(s.consume("a", Date.now())).toBeUndefined();
    expect(s.consume("b", Date.now())).toBeUndefined();
  });
});

describe("challenges", () => {
  it("issues a ringpay request whose order is a fresh nonce", () => {
    const c = paywall.challenge("GET /v1/forecast", "0.0005");
    const req = parsePaymentRequest(c.ringpay);
    expect(req).toMatchObject({ recipient: RECIPIENT, amount: "0.0005", order: c.nonce, label: "Forecasts", cluster: "devnet" });
    expect(c.nonce).toMatch(/^x402-[A-Za-z0-9]{16}$/);
    expect(paywall.challenge("GET /v1/forecast", "0.0005").nonce).not.toBe(c.nonce);
    expect(c.mint).toBe(SOL_MINT);
  });

  it("binds resources to method and path, not query", () => {
    expect(resourceOf("get", "https://api.example.com/v1/forecast?city=Lisbon")).toBe("GET /v1/forecast");
  });

  it("answers 402 with the request in a header and the body", async () => {
    const handler = paywalled(paywall, "0.0005", () => new Response("secret"));
    const res = await handler(new Request("https://api.example.com/v1/forecast"));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(res.headers.get("ringpay-request")).toBe(body.ringpay);
    expect(body).toMatchObject({ error: "payment_required", price: "0.0005" });
  });

  it("answers a fresh challenge with the reason when the payment cannot be found", async () => {
    const handler = paywalled(paywall, "0.0005", () => new Response("secret"));
    const res = await handler(
      new Request("https://api.example.com/v1/forecast", { headers: { "ringpay-payment": "1".repeat(64) } }),
    );
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toMatch(/not found/);
  });
});

describe("spend policy", () => {
  const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
    recipient: RECIPIENT,
    amount: "0.0005",
    mint: SOL_MINT,
    order: "x402-abc",
    cluster: "devnet",
    ...over,
  });
  const url = new URL("https://api.example.com/v1/forecast");
  const policy = { maxPerCall: 1_000_000n, dailyBudget: 2_000_000n, allowHosts: ["api.example.com"] };
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as SpendRefused).code;
    }
    return "allowed";
  };

  it("allows calls within every limit", () => {
    expect(code(() => checkPolicy(policy, new SpendLedger(), url, request(), 500_000n))).toBe("allowed");
  });

  it("refuses by host, recipient, asset, per-call and daily limits", () => {
    const ledger = new SpendLedger();
    expect(code(() => checkPolicy(policy, ledger, new URL("https://evil.example/x"), request(), 1n))).toBe("HOST_NOT_ALLOWED");
    expect(code(() => checkPolicy({ ...policy, allowRecipients: ["someone-else"] }, ledger, url, request(), 1n))).toBe(
      "RECIPIENT_NOT_ALLOWED",
    );
    expect(code(() => checkPolicy(policy, ledger, url, request({ mint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") }), 1n))).toBe("NOT_SOL");
    expect(code(() => checkPolicy(policy, ledger, url, request(), 1_000_001n))).toBe("OVER_PER_CALL");
    const today = new Date().toISOString();
    ledger.add({ at: today, host: "api.example.com", url: url.href, recipient: RECIPIENT, amount: "1800000", signature: "s", order: "o" });
    expect(code(() => checkPolicy(policy, ledger, url, request(), 300_000n))).toBe("OVER_DAILY_BUDGET");
    expect(code(() => checkPolicy(policy, ledger, url, request(), 200_000n))).toBe("allowed");
  });

  it("persists the ledger and counts only today's spend", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "spend.json");
    const ledger = new SpendLedger(path);
    ledger.add({ at: "2020-01-01T00:00:00.000Z", host: "h", url: "u", recipient: "r", amount: "999", signature: "s", order: "o" });
    ledger.add({ at: new Date().toISOString(), host: "h", url: "u", recipient: "r", amount: "5", signature: "s2", order: "o2" });
    const reloaded = new SpendLedger(path);
    expect(reloaded.records).toHaveLength(2);
    expect(reloaded.spentOn(new Date().toISOString().slice(0, 10))).toBe(5n);
  });
});
