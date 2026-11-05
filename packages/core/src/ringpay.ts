/**
 * `ringpay:` payment requests (spec/ringpay-uri.md). Browser-safe: no Node
 * imports, no network.
 */
import { SOL_MINT } from "@heliuslabs/zolana";
import { isAddress, type Address } from "@solana/kit";

import { MEMO_LENGTH, decodeMemo, encodeMemo } from "./memo.ts";
import type { Cluster } from "./receipt.ts";

export const RINGPAY_SCHEME = "ringpay:";
export const ORDER_MEMO_PREFIX = "order:";
export const MAX_ORDER_LENGTH = MEMO_LENGTH - ORDER_MEMO_PREFIX.length;
export const MAX_LABEL_LENGTH = 64;
export const MAX_MESSAGE_LENGTH = 256;

const ORDER = /^[A-Za-z0-9._~-]+$/;
const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const CLUSTERS: readonly Cluster[] = ["mainnet", "devnet", "localnet"];
const KNOWN = new Set(["amount", "mint", "order", "label", "message", "cluster"]);

export type RingPayErrorCode =
  | "NOT_RINGPAY"
  | "BAD_RECIPIENT"
  | "BAD_PARAM"
  | "DUPLICATE_PARAM"
  | "UNSUPPORTED_REQUIRED_PARAM"
  | "BAD_AMOUNT"
  | "BAD_MINT"
  | "BAD_ORDER"
  | "BAD_LABEL"
  | "BAD_MESSAGE"
  | "BAD_CLUSTER"
  | "WRONG_CLUSTER"
  | "NOT_REGISTERED"
  | "AMOUNT_REQUIRED"
  | "AMOUNT_MISMATCH";

export class RingPayError extends Error {
  override name = "RingPayError";
  constructor(
    readonly code: RingPayErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PaymentRequest {
  /** Registered Solana address of the payee. */
  readonly recipient: Address;
  /** UI amount as written in the URI (decimal string); absent means the payer chooses. */
  readonly amount?: string;
  /** Asset mint; SOL when the URI has no `mint`. */
  readonly mint: Address;
  readonly order?: string;
  readonly label?: string;
  readonly message?: string;
  /** `mainnet` when the URI has no `cluster`. */
  readonly cluster: Cluster;
}

function checkAmount(amount: string): void {
  if (!AMOUNT.test(amount)) throw new RingPayError("BAD_AMOUNT", `amount ${JSON.stringify(amount)} is not a plain decimal`);
  if (/^0(\.0+)?$/.test(amount)) throw new RingPayError("BAD_AMOUNT", "amount must be greater than zero");
}

function checkOrder(order: string): void {
  if (order.length === 0 || order.length > MAX_ORDER_LENGTH || !ORDER.test(order)) {
    throw new RingPayError(
      "BAD_ORDER",
      `order must be 1–${MAX_ORDER_LENGTH} characters from A–Z a–z 0–9 . _ ~ -`,
    );
  }
}

function checkText(value: string, max: number, code: "BAD_LABEL" | "BAD_MESSAGE", name: string): void {
  if (value.length === 0 || value.length > max) throw new RingPayError(code, `${name} must be 1–${max} characters`);
  // Reject control characters: these strings are shown to the payer.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RingPayError(code, `${name} contains control characters`);
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new RingPayError("BAD_PARAM", `${what} is not valid percent-encoding`);
  }
}

/** Parse and validate a `ringpay:` URI. Throws `RingPayError`. */
export function parsePaymentRequest(uri: string): PaymentRequest {
  const text = uri.trim();
  if (!text.toLowerCase().startsWith(RINGPAY_SCHEME)) {
    throw new RingPayError("NOT_RINGPAY", `payment requests start with ${RINGPAY_SCHEME}`);
  }
  const rest = text.slice(RINGPAY_SCHEME.length);
  const q = rest.indexOf("?");
  const recipient = decode(q === -1 ? rest : rest.slice(0, q), "recipient");
  if (!isAddress(recipient)) throw new RingPayError("BAD_RECIPIENT", "recipient is not a Solana address");

  const params = new Map<string, string>();
  if (q !== -1 && q < rest.length - 1) {
    for (const pair of rest.slice(q + 1).split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      const key = decode(eq === -1 ? pair : pair.slice(0, eq), "parameter name");
      const value = decode(eq === -1 ? "" : pair.slice(eq + 1), `value of ${key}`);
      if (params.has(key)) throw new RingPayError("DUPLICATE_PARAM", `parameter ${key} appears twice`);
      if (key.startsWith("req-")) {
        throw new RingPayError("UNSUPPORTED_REQUIRED_PARAM", `this wallet does not support required parameter ${key}`);
      }
      params.set(key, value);
    }
  }

  const amount = params.get("amount");
  if (amount !== undefined) checkAmount(amount);

  const mint = params.get("mint") ?? SOL_MINT;
  if (!isAddress(mint)) throw new RingPayError("BAD_MINT", "mint is not a Solana address");

  const order = params.get("order");
  if (order !== undefined) checkOrder(order);
  const label = params.get("label");
  if (label !== undefined) checkText(label, MAX_LABEL_LENGTH, "BAD_LABEL", "label");
  const message = params.get("message");
  if (message !== undefined) checkText(message, MAX_MESSAGE_LENGTH, "BAD_MESSAGE", "message");

  const cluster = (params.get("cluster") ?? "mainnet") as Cluster;
  if (!CLUSTERS.includes(cluster)) throw new RingPayError("BAD_CLUSTER", `unknown cluster ${cluster}`);

  return {
    recipient,
    mint,
    cluster,
    ...(amount === undefined ? {} : { amount }),
    ...(order === undefined ? {} : { order }),
    ...(label === undefined ? {} : { label }),
    ...(message === undefined ? {} : { message }),
  };
}

export type PaymentRequestInput = Omit<PaymentRequest, "mint" | "cluster"> &
  Partial<Pick<PaymentRequest, "mint" | "cluster">>;

/** Build a `ringpay:` URI. Validates like the parser; omits defaults (SOL, mainnet). */
export function encodePaymentRequest(req: PaymentRequestInput): string {
  if (!isAddress(req.recipient)) throw new RingPayError("BAD_RECIPIENT", "recipient is not a Solana address");
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (req.amount !== undefined) {
    checkAmount(req.amount);
    add("amount", req.amount);
  }
  if (req.mint !== undefined && req.mint !== SOL_MINT) {
    if (!isAddress(req.mint)) throw new RingPayError("BAD_MINT", "mint is not a Solana address");
    add("mint", req.mint);
  }
  if (req.order !== undefined) {
    checkOrder(req.order);
    add("order", req.order);
  }
  if (req.label !== undefined) {
    checkText(req.label, MAX_LABEL_LENGTH, "BAD_LABEL", "label");
    add("label", req.label);
  }
  if (req.message !== undefined) {
    checkText(req.message, MAX_MESSAGE_LENGTH, "BAD_MESSAGE", "message");
    add("message", req.message);
  }
  if (req.cluster !== undefined && req.cluster !== "mainnet") {
    if (!CLUSTERS.includes(req.cluster)) throw new RingPayError("BAD_CLUSTER", `unknown cluster ${req.cluster}`);
    add("cluster", req.cluster);
  }
  return `${RINGPAY_SCHEME}${req.recipient}${parts.length ? `?${parts.join("&")}` : ""}`;
}

/** UI amount → base units. Rejects more fraction digits than `decimals`. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  checkAmount(amount);
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) {
    throw new RingPayError("BAD_AMOUNT", `amount has ${frac.length} decimals; this asset has ${decimals}`);
  }
  return BigInt(whole! + frac.padEnd(decimals, "0"));
}

/** The encrypted memo for an order: `order:<id>`, fixed width. */
export function orderMemo(order: string): Uint8Array {
  checkOrder(order);
  return encodeMemo(ORDER_MEMO_PREFIX + order);
}

/** The order id in a memo (decoded text or raw bytes), or undefined if it is not an order memo. */
export function orderFromMemo(memo: string | Uint8Array | undefined): string | undefined {
  const text = typeof memo === "string" || memo === undefined ? memo : decodeMemo(memo);
  if (text === undefined || !text.startsWith(ORDER_MEMO_PREFIX)) return undefined;
  const order = text.slice(ORDER_MEMO_PREFIX.length);
  return order.length > 0 && order.length <= MAX_ORDER_LENGTH && ORDER.test(order) ? order : undefined;
}
