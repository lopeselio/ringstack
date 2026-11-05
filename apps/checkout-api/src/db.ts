/**
 * Orders and the payments matched to them (node:sqlite).
 *
 * A payment row is keyed by ringd's delivery id, so a redelivered webhook is a
 * no-op. An order is `paid` once its matched payments cover the price.
 */
import { DatabaseSync } from "node:sqlite";

export type OrderStatus = "awaiting_payment" | "underpaid" | "paid";

export interface Order {
  readonly id: string;
  readonly item: string;
  readonly mint: string;
  /** UI amount as shown and put in the request, e.g. "0.0125". */
  readonly price: string;
  /** Base units, decimal string. */
  readonly priceBase: string;
  readonly uri: string;
  readonly status: OrderStatus;
  /** Base units received so far, decimal string. */
  readonly received: string;
  readonly createdAt: string;
  readonly paidAt?: string;
  readonly payments: readonly Payment[];
}

export interface Payment {
  readonly deliveryId: string;
  readonly signature: string;
  readonly slot: string;
  readonly amount: string;
  readonly receivedAt: string;
}

const SCHEMA = `
create table if not exists orders (
  id         text primary key,
  item       text not null,
  mint       text not null,
  price      text not null,
  price_base text not null,
  uri        text not null,
  status     text not null,
  received   text not null default '0',
  created_at integer not null,
  paid_at    integer
);
create table if not exists payments (
  delivery_id text primary key,
  order_id    text not null references orders (id),
  signature   text not null,
  slot        text not null,
  amount      text not null,
  received_at integer not null
);
`;

interface OrderRow {
  id: string;
  item: string;
  mint: string;
  price: string;
  price_base: string;
  uri: string;
  status: OrderStatus;
  received: string;
  created_at: number;
  paid_at: number | null;
}

export class CheckoutDb {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  createOrder(o: Pick<Order, "id" | "item" | "mint" | "price" | "priceBase" | "uri">): Order {
    this.#db
      .prepare(
        "insert into orders (id, item, mint, price, price_base, uri, status, created_at) values (?, ?, ?, ?, ?, ?, 'awaiting_payment', ?)",
      )
      .run(o.id, o.item, o.mint, o.price, o.priceBase, o.uri, Date.now());
    return this.getOrder(o.id)!;
  }

  getOrder(id: string): Order | undefined {
    const row = this.#db.prepare("select * from orders where id = ?").get(id) as OrderRow | undefined;
    if (row === undefined) return undefined;
    const payments = (
      this.#db.prepare("select * from payments where order_id = ? order by received_at").all(id) as {
        delivery_id: string;
        signature: string;
        slot: string;
        amount: string;
        received_at: number;
      }[]
    ).map((p) => ({
      deliveryId: p.delivery_id,
      signature: p.signature,
      slot: p.slot,
      amount: p.amount,
      receivedAt: new Date(p.received_at).toISOString(),
    }));
    return {
      id: row.id,
      item: row.item,
      mint: row.mint,
      price: row.price,
      priceBase: row.price_base,
      uri: row.uri,
      status: row.status,
      received: row.received,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.paid_at === null ? {} : { paidAt: new Date(row.paid_at).toISOString() }),
      payments,
    };
  }

  /**
   * Record a payment for an order, once per delivery id, and update its
   * status. Returns false when this delivery was already recorded.
   */
  recordPayment(orderId: string, p: Omit<Payment, "receivedAt">): boolean {
    this.#db.exec("begin immediate");
    try {
      const inserted = this.#db
        .prepare(
          "insert or ignore into payments (delivery_id, order_id, signature, slot, amount, received_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(p.deliveryId, orderId, p.signature, p.slot, p.amount, Date.now());
      if (inserted.changes > 0) {
        const order = this.#db.prepare("select price_base, received from orders where id = ?").get(orderId) as {
          price_base: string;
          received: string;
        };
        const received = BigInt(order.received) + BigInt(p.amount);
        const paid = received >= BigInt(order.price_base);
        this.#db
          .prepare("update orders set received = ?, status = ?, paid_at = coalesce(paid_at, ?) where id = ?")
          .run(received.toString(), paid ? "paid" : "underpaid", paid ? Date.now() : null, orderId);
      }
      this.#db.exec("commit");
      return inserted.changes > 0;
    } catch (err) {
      this.#db.exec("rollback");
      throw err;
    }
  }
}
