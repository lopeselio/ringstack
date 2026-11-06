import { SOL_MINT } from "@heliuslabs/spr";
import { parsePaymentRequest } from "@ringstack/core/ringpay";
import { deliveryId, webhookHeaders, type RingdEvent } from "@ringstack/ringd-client";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config.ts";
import { CheckoutDb, type Order } from "../src/db.ts";
import { createApp } from "../src/create-app.ts";
import type { DemoPay } from "../src/demo.controller.ts";

const SECRET = "whsec_checkout_test_0123";
const config: ApiConfig = {
  merchant: address("GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD"),
  webhookSecret: SECRET,
  cluster: "localnet",
  database: ":memory:",
  port: 0,
  host: "127.0.0.1",
  verifierUrl: "http://localhost:5173/",
};

let db: CheckoutDb;
let app: Awaited<ReturnType<typeof createApp>>;

async function setup(demoPay?: DemoPay) {
  db = new CheckoutDb(":memory:");
  app = await createApp({ config, db, logger: false, ...(demoPay ? { demoPay } : {}) });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}
beforeEach(() => setup());
afterEach(async () => {
  await app.close();
  db.close();
});

async function createOrder(item = "flat-white"): Promise<Order> {
  const res = await app.inject({ method: "POST", url: "/orders", payload: { item } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

let n = 0;
function paymentEvent(order: string | undefined, amount: string, extra: Partial<RingdEvent> = {}): RingdEvent {
  n++;
  return {
    id: `sig${n}:${n}`,
    type: "payment.received",
    wallet: "shop",
    signature: `sig${n}`,
    slot: String(100 + n),
    kind: "privateTransfer",
    direction: "inbound",
    asset: SOL_MINT,
    amount,
    ...(order === undefined ? {} : { memo: `order:${order}` }),
    backfill: false,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function deliver(event: RingdEvent, secret = SECRET) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/ringd",
    headers: webhookHeaders(secret, deliveryId(event), body),
    payload: body,
  });
}

const status = async (id: string): Promise<Order> => (await app.inject({ url: `/orders/${id}` })).json();

describe("orders", () => {
  it("creates an order with a ringpay request for the item", async () => {
    const order = await createOrder();
    expect(order).toMatchObject({ item: "Flat white", price: "0.0125", priceBase: "12500000", status: "awaiting_payment" });
    expect(order.id).toMatch(/^[A-Z2-9]{8}$/);
    expect(parsePaymentRequest(order.uri)).toMatchObject({
      recipient: config.merchant,
      amount: "0.0125",
      order: order.id,
      label: "Corner Café",
      cluster: "localnet",
    });
  });

  it("rejects unknown items and unknown orders", async () => {
    expect((await app.inject({ method: "POST", url: "/orders", payload: { item: "nope" } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/orders/NOPE" })).statusCode).toBe(404);
  });
});

describe("ringd webhook", () => {
  it("rejects bad signatures and changes nothing", async () => {
    const order = await createOrder();
    const res = await deliver(paymentEvent(order.id, "12500000"), "whsec_wrong_secret_000");
    expect(res.statusCode).toBe(400);
    expect((await status(order.id)).status).toBe("awaiting_payment");
  });

  it("marks the order paid, once per delivery id", async () => {
    const order = await createOrder();
    const event = paymentEvent(order.id, "12500000");
    expect((await deliver(event)).statusCode).toBe(204);
    expect((await deliver(event)).statusCode).toBe(204); // redelivery
    const after = await status(order.id);
    expect(after).toMatchObject({ status: "paid", received: "12500000" });
    expect(after.payments).toHaveLength(1);
    expect(after.paidAt).toBeDefined();
  });

  it("tracks underpayment until the total covers the price", async () => {
    const order = await createOrder();
    await deliver(paymentEvent(order.id, "5000000"));
    expect((await status(order.id)).status).toBe("underpaid");
    await deliver(paymentEvent(order.id, "7500000"));
    expect(await status(order.id)).toMatchObject({ status: "paid", received: "12500000" });
  });

  it("ignores other events, other assets and memos that are not this shop's orders", async () => {
    const order = await createOrder();
    for (const e of [
      paymentEvent(order.id, "12500000", { type: "payment.sent", direction: "outbound" }),
      paymentEvent(order.id, "12500000", { asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
      paymentEvent("UNKNOWN1", "12500000"),
      paymentEvent(undefined, "12500000"),
    ]) {
      expect((await deliver(e)).statusCode).toBe(204);
    }
    expect((await status(order.id)).status).toBe("awaiting_payment");
  });
});

describe("demo payments", () => {
  it("are disabled unless configured", async () => {
    const order = await createOrder();
    expect((await app.inject({ method: "POST", url: `/demo/orders/${order.id}/pay` })).statusCode).toBe(404);
  });

  it("pay the order's request and link the verifier", async () => {
    await app.close();
    db.close();
    const paidUris: string[] = [];
    await setup(async (uri: string) => {
      paidUris.push(uri);
      return { receiptLink: "ringrcpt1:abc", signature: "sig" };
    });
    const order = await createOrder();
    const res = await app.inject({ method: "POST", url: `/demo/orders/${order.id}/pay` });
    expect(res.statusCode).toBe(200);
    expect(paidUris).toEqual([order.uri]);
    expect(res.json().verifierUrl).toBe(`http://localhost:5173/?to=${config.merchant}#ringrcpt1:abc`);
  });
});
