/**
 * Agent side: fetch that pays RingPay 402 challenges privately, within a
 * spend policy checked before any money moves.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { SOL_MINT } from "@heliuslabs/zolana";
import {
  parsePaymentRequest,
  payRequest,
  prepareRequest,
  type PaymentRequest,
  type RingSession,
} from "@ringstack/core";
import type { Cluster } from "@ringstack/core/receipt";

import { PAYMENT_HEADER, REQUEST_HEADER, type PaymentChallenge } from "./protocol.ts";

export interface SpendPolicy {
  /** Most an agent pays for one call, in base units of SOL. */
  readonly maxPerCall: bigint;
  /** Most it pays per UTC day, in base units of SOL. */
  readonly dailyBudget: bigint;
  /** Hosts it may pay (e.g. "api.example.com"). Unset: any host. */
  readonly allowHosts?: readonly string[];
  /** Recipients (Solana addresses) it may pay. Unset: any registered recipient. */
  readonly allowRecipients?: readonly string[];
}

export interface SpendRecord {
  readonly at: string;
  readonly host: string;
  readonly url: string;
  readonly recipient: string;
  readonly amount: string;
  readonly signature: string;
  readonly order: string;
}

/** What the agent has paid, optionally persisted to a JSON file. */
export class SpendLedger {
  readonly #path: string | undefined;
  #records: SpendRecord[];

  constructor(path?: string) {
    this.#path = path;
    this.#records = [];
    if (path !== undefined) {
      try {
        this.#records = JSON.parse(readFileSync(path, "utf8")) as SpendRecord[];
      } catch {
        this.#records = [];
      }
    }
  }

  get records(): readonly SpendRecord[] {
    return this.#records;
  }

  spentOn(day: string): bigint {
    return this.#records.filter((r) => r.at.startsWith(day)).reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  add(record: SpendRecord): void {
    this.#records = [...this.#records, record];
    if (this.#path !== undefined) {
      writeFileSync(`${this.#path}.tmp`, `${JSON.stringify(this.#records, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${this.#path}.tmp`, this.#path);
    }
  }
}

export class SpendRefused extends Error {
  override name = "SpendRefused";
  constructor(
    readonly code: "HOST_NOT_ALLOWED" | "RECIPIENT_NOT_ALLOWED" | "OVER_PER_CALL" | "OVER_DAILY_BUDGET" | "NOT_SOL" | "BAD_CHALLENGE",
    message: string,
  ) {
    super(message);
  }
}

/** Throws `SpendRefused` if paying `amount` to `request` from `url` breaks the policy. */
export function checkPolicy(
  policy: SpendPolicy,
  ledger: SpendLedger,
  url: URL,
  request: PaymentRequest,
  amount: bigint,
  now = new Date(),
): void {
  if (policy.allowHosts !== undefined && !policy.allowHosts.includes(url.host)) {
    throw new SpendRefused("HOST_NOT_ALLOWED", `${url.host} is not on the allow-list`);
  }
  if (policy.allowRecipients !== undefined && !policy.allowRecipients.includes(request.recipient)) {
    throw new SpendRefused("RECIPIENT_NOT_ALLOWED", `recipient ${request.recipient} is not on the allow-list`);
  }
  if (request.mint !== SOL_MINT) throw new SpendRefused("NOT_SOL", "budgets are in SOL; this request is for another asset");
  if (amount > policy.maxPerCall) {
    throw new SpendRefused("OVER_PER_CALL", `price ${amount} exceeds the per-call limit ${policy.maxPerCall}`);
  }
  const spent = ledger.spentOn(now.toISOString().slice(0, 10));
  if (spent + amount > policy.dailyBudget) {
    throw new SpendRefused("OVER_DAILY_BUDGET", `paying ${amount} would exceed today's budget (${spent} of ${policy.dailyBudget} spent)`);
  }
}

export interface PaidFetchOptions {
  readonly session: RingSession;
  readonly cluster: Cluster;
  readonly policy: SpendPolicy;
  readonly ledger: SpendLedger;
  readonly fetch?: typeof fetch;
}

export interface PaidFetchResult {
  readonly response: Response;
  /** Set when this call paid. */
  readonly payment?: SpendRecord;
}

/**
 * `fetch`, paying a RingPay 402 challenge if the server asks for one. The
 * request is sent twice when it pays, so `init.body` must be re-sendable
 * (a string, bytes or URLSearchParams, not a stream).
 */
export async function paidFetch(input: string | URL, init: RequestInit, opts: PaidFetchOptions): Promise<PaidFetchResult> {
  const doFetch = opts.fetch ?? fetch;
  const url = new URL(input);
  const first = await doFetch(url, init);
  if (first.status !== 402) return { response: first };

  let challenge: PaymentChallenge | undefined;
  try {
    challenge = (await first.clone().json()) as PaymentChallenge;
  } catch {
    challenge = undefined;
  }
  const uri = first.headers.get(REQUEST_HEADER) ?? challenge?.ringpay;
  if (!uri) throw new SpendRefused("BAD_CHALLENGE", "402 without a ringpay: request");
  let request: PaymentRequest;
  try {
    request = parsePaymentRequest(uri);
  } catch (e) {
    throw new SpendRefused("BAD_CHALLENGE", `invalid ringpay: request: ${(e as Error).message}`);
  }
  if (request.order === undefined) throw new SpendRefused("BAD_CHALLENGE", "challenge has no order nonce");

  // Validates cluster and recipient registration, and converts the amount, without paying.
  const { amount } = await prepareRequest(opts.session, request, { cluster: opts.cluster });
  checkPolicy(opts.policy, opts.ledger, url, request, amount);

  const paid = await payRequest(opts.session, request, { cluster: opts.cluster });
  const record: SpendRecord = {
    at: new Date().toISOString(),
    host: url.host,
    url: url.toString(),
    recipient: request.recipient,
    amount: paid.amount.toString(),
    signature: paid.payment.signature,
    order: request.order,
  };
  opts.ledger.add(record);

  const headers = new Headers(init.headers);
  headers.set(PAYMENT_HEADER, paid.payment.signature);
  const response = await doFetch(url, { ...init, headers });
  return { response, payment: record };
}
