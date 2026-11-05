import { randomBytes } from "node:crypto";

import { SOL_MINT } from "@heliuslabs/zolana";
import { Inject, Injectable } from "@nestjs/common";
import { encodePaymentRequest, orderFromMemo, toBaseUnits } from "@ringstack/core/ringpay";
import type { RingdEvent } from "@ringstack/ringd-client";

import type { ApiConfig } from "./config.ts";
import type { CheckoutDb, Order } from "./db.ts";
import { MENU, SHOP_NAME } from "./menu.ts";
import { API_CONFIG, CHECKOUT_DB } from "./tokens.ts";

const ORDER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newOrderId(): string {
  return Array.from(randomBytes(8), (b) => ORDER_ALPHABET[b % ORDER_ALPHABET.length]).join("");
}

export type PaymentOutcome = "recorded" | "duplicate" | "no-match";

@Injectable()
export class OrdersService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CHECKOUT_DB) private readonly db: CheckoutDb,
  ) {}

  /** Undefined for an unknown item. */
  create(itemId: unknown): Order | undefined {
    const item = MENU.find((m) => m.id === itemId);
    if (item === undefined) return undefined;
    const id = newOrderId();
    const uri = encodePaymentRequest({
      recipient: this.config.merchant,
      amount: item.price,
      order: id,
      label: SHOP_NAME,
      message: item.name,
      cluster: this.config.cluster,
    });
    return this.db.createOrder({
      id,
      item: item.name,
      mint: SOL_MINT,
      price: item.price,
      priceBase: toBaseUnits(item.price, 9).toString(),
      uri,
    });
  }

  get(id: string): Order | undefined {
    return this.db.getOrder(id);
  }

  /** Match a verified `payment.received` to an order by its memo and record it once per delivery id. */
  recordPayment(deliveryId: string, event: RingdEvent): PaymentOutcome {
    const orderId = orderFromMemo(event.memo);
    const order = orderId === undefined ? undefined : this.db.getOrder(orderId);
    if (order === undefined || event.asset !== order.mint) return "no-match";
    const recorded = this.db.recordPayment(order.id, {
      deliveryId,
      signature: event.signature,
      slot: event.slot,
      amount: event.amount,
    });
    return recorded ? "recorded" : "duplicate";
  }
}
