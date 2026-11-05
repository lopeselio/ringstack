import { verifyWebhook, type RingdEvent } from "@ringstack/ringd-client";
import { describe, expect, it } from "vitest";

import { parseConfig, type DeliveryConfig, type WebhookConfig } from "../src/config.ts";
import type { Logger } from "../src/daemon.ts";
import { RingdStore } from "../src/store.ts";
import { Dispatcher, backoffMs, routeFor } from "../src/webhooks.ts";

const SECRET = "whsec_unit_0123456789";
const quiet: Logger = { info: () => {}, error: () => {} };
const delivery: DeliveryConfig = { timeoutMs: 1000, maxAttempts: 3, retryBaseMs: 10, retryMaxMs: 25 };

const ev = (id: string, type: RingdEvent["type"] = "payment.received", wallet = "shop"): RingdEvent => ({
  id,
  type,
  wallet,
  signature: id.split(":")[0]!,
  slot: "1",
  kind: "privateTransfer",
  direction: type === "payment.sent" ? "outbound" : "inbound",
  asset: "11111111111111111111111111111111",
  amount: "5",
  backfill: false,
  createdAt: new Date(0).toISOString(),
});

describe("webhook config", () => {
  const base = `[[wallet]]\nname = "shop"\nkey_file = "k"\n`;
  const env = { HOOK_SECRET: SECRET };

  it("parses webhooks and delivery settings", () => {
    const c = parseConfig(
      `${base}[[webhook]]\nname = "orders"\nurl = "https://x.example/h"\nsecret_env = "HOOK_SECRET"\nevents = ["payment.received"]\n[delivery]\nmax_attempts = 4\nretry_base_secs = 2\n`,
      "/",
      env,
    );
    expect(c.webhooks).toEqual([
      { name: "orders", url: "https://x.example/h", secret: SECRET, events: ["payment.received"] },
    ]);
    expect(c.delivery).toMatchObject({ maxAttempts: 4, retryBaseMs: 2000, timeoutMs: 10_000 });
  });

  it("rejects insecure URLs, missing secrets and unknown filters", () => {
    const hook = (extra: string) => `${base}[[webhook]]\nname = "h"\nsecret_env = "HOOK_SECRET"\n${extra}`;
    expect(() => parseConfig(hook(`url = "http://x.example/h"`), "/", env)).toThrow(/https/);
    expect(() => parseConfig(hook(`url = "http://localhost:8080/h"`), "/", env)).not.toThrow();
    expect(() => parseConfig(hook(`url = "https://x.example/h"`), "/", {})).toThrow(/HOOK_SECRET/);
    expect(() => parseConfig(hook(`url = "https://x.example/h"\nwallets = ["nope"]`), "/", env)).toThrow(/unknown wallet/);
    expect(() => parseConfig(hook(`url = "https://x.example/h"\nevents = ["nope"]`), "/", env)).toThrow(/unknown event/);
  });
});

describe("routing and backoff", () => {
  it("routes by wallet and event filters", () => {
    const hooks: WebhookConfig[] = [
      { name: "a", url: "https://a", secret: SECRET },
      { name: "b", url: "https://b", secret: SECRET, events: ["payment.sent"] },
      { name: "c", url: "https://c", secret: SECRET, wallets: ["other"] },
    ];
    const route = routeFor(hooks);
    expect(route(ev("s:1"))).toEqual(["a"]);
    expect(route(ev("s:2", "payment.sent"))).toEqual(["a", "b"]);
    expect(route(ev("s:3", "payment.received", "other"))).toEqual(["a", "c"]);
  });

  it("backs off exponentially up to the cap", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, { retryBaseMs: 10, retryMaxMs: 25 }))).toEqual([10, 20, 25, 25]);
  });
});

describe("Dispatcher", () => {
  function setup(responses: (url: string) => Response | Promise<Response>) {
    const store = new RingdStore(":memory:");
    const hooks: WebhookConfig[] = [
      { name: "a", url: "https://a.example/h", secret: SECRET },
      { name: "b", url: "https://b.example/h", secret: SECRET },
    ];
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses(url);
    }) as unknown as typeof fetch;
    const dispatcher = new Dispatcher(store, hooks, delivery, quiet, fetchImpl);
    store.appendEvents([ev("s:1"), ev("s:2")], routeFor(hooks));
    return { store, dispatcher, calls };
  }

  it("delivers signed requests that verify, without following redirects", async () => {
    const { store, dispatcher, calls } = setup(() => new Response(null, { status: 204 }));
    expect(await dispatcher.runOnce()).toEqual({ delivered: 4, retrying: 0, failed: 0 });
    for (const c of calls) {
      const v = verifyWebhook({ body: c.init.body as string, headers: c.init.headers as Record<string, string>, secret: SECRET });
      expect(v.id).toMatch(/^shop:s:[12]$/);
      expect(c.init.redirect).toBe("manual");
    }
    expect(store.listDeliveries().every((d) => d.status === "delivered" && d.attempts === 1)).toBe(true);
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
  });

  it("isolates a failing webhook, stops its pass at the first failure, and gives up after maxAttempts", async () => {
    const { store, dispatcher, calls } = setup((url) =>
      url.startsWith("https://a") ? new Response(null, { status: 503 }) : new Response(null, { status: 200 }),
    );
    expect(await dispatcher.runOnce()).toEqual({ delivered: 2, retrying: 1, failed: 0 });
    expect(calls.filter((c) => c.url.startsWith("https://a"))).toHaveLength(1); // stopped after first failure

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await dispatcher.runOnce();
    }
    const a = store.listDeliveries({ webhook: "a" });
    expect(a.map((d) => [d.status, d.attempts, d.lastStatus])).toEqual([
      ["failed", 3, 503],
      ["failed", 3, 503],
    ]);
    expect(store.listDeliveries({ webhook: "b", status: "delivered" })).toHaveLength(2);
    expect(store.retryFailed("a")).toBe(2);
    expect(store.listDeliveries({ webhook: "a", status: "pending" }).every((d) => d.attempts === 0)).toBe(true);
  });

  it("treats network errors and redirects as failures", async () => {
    const { store, dispatcher } = setup((url) =>
      url.startsWith("https://a")
        ? Promise.reject(new TypeError("fetch failed"))
        : new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    );
    await dispatcher.runOnce();
    expect(store.listDeliveries({ webhook: "a" })[0]).toMatchObject({ status: "pending", lastError: "fetch failed" });
    expect(store.listDeliveries({ webhook: "b" })[0]).toMatchObject({ status: "pending", lastStatus: 302 });
  });
});
