/**
 * Vendor side: issue 402 challenges and verify payments against them.
 *
 * The paywall holds the vendor's read-only keys (a ringd-style key file). To
 * verify, it fetches the agent's transaction, decrypts its own output with its
 * viewing key, and requires: commitment matches the chain, asset and amount
 * cover the price, and the memo is `order:<nonce>` for an outstanding,
 * unexpired challenge on this resource. The nonce is then consumed.
 */
import { randomBytes } from "node:crypto";

import { SOL_MINT, ViewingKey, type ShieldedAddress } from "@heliuslabs/zolana";
import { bytes32 } from "@heliuslabs/zolana/keypair";
import {
  PaymentProofError,
  encodePaymentRequest,
  fetchShieldedTransaction,
  orderFromMemo,
  provePayment,
  toBaseUnits,
  verifyPaymentProof,
  type ShieldedTransactionReader,
} from "@ringstack/core";
import type { Cluster } from "@ringstack/core/receipt";
import type { Address, Signature } from "@solana/kit";

import { PAYMENT_HEADER, REQUEST_HEADER, SETTLED_HEADER, type PaymentChallenge } from "./protocol.ts";

const NONCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export interface PendingCharge {
  readonly resource: string;
  /** Base units. */
  readonly price: bigint;
  readonly expiresAt: number;
}

/** Outstanding nonces. `consume` must be atomic: a nonce is redeemed at most once. */
export interface NonceStore {
  issue(nonce: string, charge: PendingCharge): void;
  consume(nonce: string, now: number): PendingCharge | undefined;
}

/** In-process store; expired entries are swept on issue. Use a shared store across instances. */
export class MemoryNonceStore implements NonceStore {
  readonly #pending = new Map<string, PendingCharge>();

  issue(nonce: string, charge: PendingCharge): void {
    const now = Date.now();
    for (const [n, c] of this.#pending) if (c.expiresAt <= now) this.#pending.delete(n);
    this.#pending.set(nonce, charge);
  }

  consume(nonce: string, now: number): PendingCharge | undefined {
    const charge = this.#pending.get(nonce);
    this.#pending.delete(nonce);
    return charge !== undefined && charge.expiresAt > now ? charge : undefined;
  }

  get size(): number {
    return this.#pending.size;
  }
}

/** The vendor's read-only identity (from a key file: `readKeyFile`). */
export interface VendorKeys {
  readonly address: ShieldedAddress;
  /** Viewing secret; copied on use, never consumed. */
  readonly viewingSecret: Uint8Array;
}

export interface PaywallConfig {
  readonly client: ShieldedTransactionReader;
  readonly vendor: VendorKeys;
  /** The vendor's registered Solana address (the `ringpay:` recipient). */
  readonly recipient: Address;
  readonly cluster: Cluster;
  readonly mint?: Address;
  readonly decimals?: number;
  /** Shown to payers as the request label. */
  readonly label?: string;
  /** How long a challenge stays payable. Default 10 minutes. */
  readonly ttlMs?: number;
  readonly store?: NonceStore;
}

export type PaywallDecision =
  | { readonly paid: true; readonly signature: string; readonly amount: bigint; readonly headers: Record<string, string> }
  | {
      readonly paid: false;
      readonly status: 402;
      readonly body: PaymentChallenge;
      readonly headers: Record<string, string>;
    };

export class PaywallError extends Error {
  override name = "PaywallError";
}

export class Paywall {
  readonly #c: Required<Omit<PaywallConfig, "label">> & { label?: string };

  constructor(config: PaywallConfig) {
    this.#c = {
      mint: SOL_MINT,
      decimals: 9,
      ttlMs: 10 * 60_000,
      store: new MemoryNonceStore(),
      ...config,
    };
  }

  /** A fresh 402 challenge for `resource` at `price` (UI units). */
  challenge(resource: string, price: string, reason?: string): PaymentChallenge {
    const nonce = `x402-${Array.from(randomBytes(16), (b) => NONCE_ALPHABET[b % NONCE_ALPHABET.length]).join("")}`;
    const expiresAt = Date.now() + this.#c.ttlMs;
    this.#c.store.issue(nonce, { resource, price: toBaseUnits(price, this.#c.decimals), expiresAt });
    const ringpay = encodePaymentRequest({
      recipient: this.#c.recipient,
      amount: price,
      mint: this.#c.mint,
      order: nonce,
      ...(this.#c.label === undefined ? {} : { label: this.#c.label }),
      message: resource.slice(0, 256),
      cluster: this.#c.cluster,
    });
    return {
      error: "payment_required",
      ringpay,
      nonce,
      price,
      mint: this.#c.mint,
      expiresAt: new Date(expiresAt).toISOString(),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  /**
   * Verify that `signature` pays an outstanding challenge for `resource`.
   * Throws `PaywallError` with a reason the client can act on.
   */
  async verify(signature: string, resource: string): Promise<{ amount: bigint; nonce: string }> {
    let tx;
    try {
      tx = await fetchShieldedTransaction(this.#c.client, signature as Signature);
    } catch {
      throw new PaywallError("transaction not found (not yet indexed, or wrong cluster)");
    }
    let paid;
    try {
      const vendor = {
        shieldedAddress: () => this.#c.vendor.address,
        viewingKey: () => ViewingKey.fromBytes(bytes32(this.#c.vendor.viewingSecret.slice())),
      };
      paid = verifyPaymentProof(provePayment(vendor, tx, this.#c.cluster), tx);
    } catch (e) {
      if (e instanceof PaymentProofError) throw new PaywallError(`no valid payment to this vendor: ${e.message}`);
      throw e;
    }
    if (paid.mint !== this.#c.mint) throw new PaywallError("payment is in the wrong asset");
    const nonce = orderFromMemo(paid.memo);
    if (nonce === undefined) throw new PaywallError("payment carries no order memo");
    // Consume before comparing, so a nonce is never redeemable twice even on mismatch.
    const charge = this.#c.store.consume(nonce, Date.now());
    if (charge === undefined) throw new PaywallError("unknown, expired or already redeemed payment request");
    if (charge.resource !== resource) throw new PaywallError("payment was for a different resource");
    if (paid.amount < charge.price) throw new PaywallError(`paid ${paid.amount}, price is ${charge.price}`);
    return { amount: paid.amount, nonce };
  }

  /**
   * One request: with no payment header, a 402 challenge; with one, verify it
   * (a failed verification answers a fresh challenge carrying the reason).
   */
  async decide(paymentHeader: string | null | undefined, resource: string, price: string): Promise<PaywallDecision> {
    if (paymentHeader) {
      try {
        const { amount } = await this.verify(paymentHeader.trim(), resource);
        return { paid: true, signature: paymentHeader.trim(), amount, headers: { [SETTLED_HEADER]: paymentHeader.trim() } };
      } catch (e) {
        if (!(e instanceof PaywallError)) throw e;
        return this.#required(resource, price, e.message);
      }
    }
    return this.#required(resource, price);
  }

  #required(resource: string, price: string, reason?: string): PaywallDecision {
    const body = this.challenge(resource, price, reason);
    return { paid: false, status: 402, body, headers: { [REQUEST_HEADER]: body.ringpay } };
  }
}

/** `METHOD /path`: what a challenge is bound to. */
export function resourceOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${new URL(url, "http://localhost").pathname}`;
}

/**
 * Fetch-API middleware (Hono, Next.js route handlers, Bun, Deno, workers):
 * charges `price` per request to `handler`.
 */
export function paywalled(
  paywall: Paywall,
  price: string,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const decision = await paywall.decide(req.headers.get(PAYMENT_HEADER), resourceOf(req.method, req.url), price);
    if (!decision.paid) {
      return new Response(JSON.stringify(decision.body), {
        status: 402,
        headers: { "content-type": "application/json", ...decision.headers },
      });
    }
    const res = await handler(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(decision.headers)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** Minimal Node/Express/Fastify-compatible shapes for `paywallMiddleware`. */
export interface NodeLikeRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}
export interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/** Express-style middleware: `app.get("/x", paywallMiddleware(pw, "0.001"), handler)`. */
export function paywallMiddleware(paywall: Paywall, price: string) {
  return async (req: NodeLikeRequest, res: NodeLikeResponse, next: (err?: unknown) => void): Promise<void> => {
    try {
      const raw = req.headers[PAYMENT_HEADER];
      const header = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
      const decision = await paywall.decide(header, resourceOf(req.method ?? "GET", req.url ?? "/"), price);
      for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
      if (decision.paid) return next();
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(decision.body));
    } catch (err) {
      next(err);
    }
  };
}
