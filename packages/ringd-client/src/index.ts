/**
 * ringd webhook wire format: event types, signing, and verification.
 *
 * Each delivery is a POST with a JSON body (one `RingdEvent`) and:
 *   ringd-id         `<wallet>:<event id>`, stable across retries (idempotency key)
 *   ringd-timestamp  unix seconds when this attempt was signed
 *   ringd-signature  `v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`
 *
 * Receivers verify with `verifyWebhook` against the raw body, reject stale
 * timestamps, and dedupe on `ringd-id`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type RingdEventType = "payment.received" | "payment.sent" | "utxo.merged" | "wallet.activity";

export interface RingdEvent {
  /** `<signature>:<index>`, unique within a wallet. */
  readonly id: string;
  readonly type: RingdEventType;
  readonly wallet: string;
  readonly signature: string;
  readonly slot: string;
  readonly kind: "deposit" | "privateTransfer" | "ringEntry" | "publicWithdrawal" | "split" | "merge";
  readonly direction: "inbound" | "outbound" | "selfTransfer";
  /** Mint address. */
  readonly asset: string;
  /** Base units, as a decimal string. */
  readonly amount: string;
  /** Decrypted memo of the received output, when it carries one. */
  readonly memo?: string;
  /** Hex of the counterparty's compressed viewing key, when known. */
  readonly counterpartyViewingKey?: string;
  /** True for events found on a wallet's first sync (history from before ringd ran). */
  readonly backfill: boolean;
  readonly createdAt: string;
}

export const ID_HEADER = "ringd-id";
export const TIMESTAMP_HEADER = "ringd-timestamp";
export const SIGNATURE_HEADER = "ringd-signature";
export const DEFAULT_TOLERANCE_SECS = 300;

/** The idempotency key carried in `ringd-id`. */
export function deliveryId(event: Pick<RingdEvent, "wallet" | "id">): string {
  return `${event.wallet}:${event.id}`;
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** `v1=<hex>` for one attempt. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  if (secret.length === 0) throw new Error("webhook secret is empty");
  return `v1=${hmac(secret, timestamp, body)}`;
}

/** Headers for one delivery attempt of `body` (the exact bytes to send). */
export function webhookHeaders(
  secret: string,
  id: string,
  body: string,
  nowMs: number = Date.now(),
): Record<string, string> {
  const timestamp = Math.floor(nowMs / 1000);
  return {
    "content-type": "application/json",
    [ID_HEADER]: id,
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
  };
}

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

type HeaderBag = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const bag = headers as Record<string, string | readonly string[] | undefined>;
  const value = bag[name] ?? Object.entries(bag).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

export interface VerifyOptions {
  /** The raw request body, exactly as received. */
  readonly body: string | Uint8Array;
  readonly headers: HeaderBag;
  /** One secret, or several during rotation (any match passes). */
  readonly secret: string | readonly string[];
  /** Maximum age (and future skew) of `ringd-timestamp`. */
  readonly toleranceSecs?: number;
  readonly nowMs?: number;
}

export interface VerifiedWebhook {
  /** `ringd-id`: dedupe on this. */
  readonly id: string;
  readonly timestamp: number;
  readonly event: RingdEvent;
}

/** Check signature and freshness, then parse the event. Throws `WebhookVerificationError`. */
export function verifyWebhook(options: VerifyOptions): VerifiedWebhook {
  const body = typeof options.body === "string" ? options.body : new TextDecoder().decode(options.body);
  const id = header(options.headers, ID_HEADER);
  const ts = header(options.headers, TIMESTAMP_HEADER);
  const sig = header(options.headers, SIGNATURE_HEADER);
  if (id === undefined || ts === undefined || sig === undefined) {
    throw new WebhookVerificationError("missing ringd headers");
  }
  if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError("bad ringd-timestamp");
  const timestamp = Number(ts);
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const tolerance = options.toleranceSecs ?? DEFAULT_TOLERANCE_SECS;
  if (Math.abs(now - timestamp) > tolerance) throw new WebhookVerificationError("ringd-timestamp outside tolerance");

  const provided = sig
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => Buffer.from(part.slice(3), "hex"));
  const secrets = typeof options.secret === "string" ? [options.secret] : options.secret;
  const ok = secrets.some((secret) => {
    const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
    return provided.some((p) => p.length === expected.length && timingSafeEqual(p, expected));
  });
  if (!ok) throw new WebhookVerificationError("signature mismatch");

  let event: RingdEvent;
  try {
    event = JSON.parse(body) as RingdEvent;
  } catch {
    throw new WebhookVerificationError("body is not JSON");
  }
  if (deliveryId(event) !== id) throw new WebhookVerificationError("ringd-id does not match the event");
  return { id, timestamp, event };
}
