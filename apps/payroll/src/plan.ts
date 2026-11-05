/**
 * Payroll plans: validated, registry-checked, batched, and hashed so a run
 * can tell exactly which plan its state belongs to.
 */
import { createHash } from "node:crypto";

import { MAX_BATCH_PAYMENTS, encodeMemo, toBaseUnits } from "@ringstack/core";
import type { Cluster } from "@ringstack/core/receipt";
import { isAddress } from "@solana/kit";

import type { CsvRow } from "./csv.ts";

export const PLAN_VERSION = 1;

export interface PlanPayment {
  /** CSV line, for cross-referencing. */
  readonly line: number;
  readonly recipient: string;
  /** Base units, decimal string. */
  readonly amount: string;
  /** As written in the CSV. */
  readonly amountUi: string;
  readonly memo?: string;
}

export interface PlanBatch {
  readonly id: string;
  /** Base units, decimal string. */
  readonly total: string;
  readonly payments: readonly PlanPayment[];
}

export type SkipReason = "not_registered";

export interface SkippedPayment {
  readonly line: number;
  readonly recipient: string;
  readonly amountUi: string;
  readonly reason: SkipReason;
}

export interface Plan {
  readonly version: number;
  /** Hash of everything below except `createdAt` and `notes`. */
  readonly planId: string;
  readonly cluster: Cluster;
  readonly treasury: string;
  readonly mint: string;
  readonly decimals: number;
  readonly csvSha256: string;
  readonly createdAt: string;
  readonly batches: readonly PlanBatch[];
  readonly skipped: readonly SkippedPayment[];
  readonly totals: { readonly payees: number; readonly amount: string; readonly batches: number };
  /** Human-readable pre-flight findings. */
  readonly notes: readonly string[];
}

export class PlanError extends Error {
  override name = "PlanError";
}

/** Validate rows into payments. Collects every problem before throwing. */
export function validateRows(rows: readonly CsvRow[], decimals: number): PlanPayment[] {
  const errors: string[] = [];
  const out: PlanPayment[] = [];
  for (const r of rows) {
    if (!isAddress(r.address)) {
      errors.push(`line ${r.line}: ${JSON.stringify(r.address)} is not a Solana address`);
      continue;
    }
    let amount: bigint;
    try {
      amount = toBaseUnits(r.amount, decimals);
    } catch (e) {
      errors.push(`line ${r.line}: ${(e as Error).message}`);
      continue;
    }
    if (r.memo !== undefined) {
      try {
        encodeMemo(r.memo);
      } catch (e) {
        errors.push(`line ${r.line}: memo ${(e as Error).message}`);
        continue;
      }
    }
    out.push({
      line: r.line,
      recipient: r.address,
      amount: amount.toString(),
      amountUi: r.amount,
      ...(r.memo === undefined ? {} : { memo: r.memo }),
    });
  }
  if (errors.length > 0) throw new PlanError(`invalid CSV:\n  ${errors.join("\n  ")}`);
  return out;
}

/**
 * First-fit batching in CSV order: each payment goes into the first batch
 * with room that does not already pay the same recipient. Deterministic.
 */
export function batchPayments(payments: readonly PlanPayment[], maxPerBatch = MAX_BATCH_PAYMENTS): PlanBatch[] {
  if (maxPerBatch < 1 || maxPerBatch > MAX_BATCH_PAYMENTS) {
    throw new PlanError(`max per batch must be 1–${MAX_BATCH_PAYMENTS}`);
  }
  const groups: PlanPayment[][] = [];
  for (const p of payments) {
    let group = groups.find((g) => g.length < maxPerBatch && !g.some((q) => q.recipient === p.recipient));
    if (group === undefined) {
      group = [];
      groups.push(group);
    }
    group.push(p);
  }
  return groups.map((g, i) => ({
    id: `b${String(i + 1).padStart(3, "0")}`,
    total: g.reduce((s, p) => s + BigInt(p.amount), 0n).toString(),
    payments: g,
  }));
}

type PlanBody = Omit<Plan, "planId" | "createdAt" | "notes">;

export function planId(body: PlanBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
}

export interface BuildPlanInput {
  readonly rows: readonly CsvRow[];
  readonly csvText: string;
  readonly cluster: Cluster;
  readonly treasury: string;
  readonly mint: string;
  readonly decimals: number;
  readonly maxPerBatch?: number;
  readonly isRegistered: (address: string) => Promise<boolean>;
  readonly now?: Date;
}

export async function buildPlan(input: BuildPlanInput): Promise<Omit<Plan, "notes">> {
  const payments = validateRows(input.rows, input.decimals);
  const registered = new Map<string, boolean>();
  for (const address of new Set(payments.map((p) => p.recipient))) {
    registered.set(address, await input.isRegistered(address));
  }
  const payable = payments.filter((p) => registered.get(p.recipient));
  const skipped: SkippedPayment[] = payments
    .filter((p) => !registered.get(p.recipient))
    .map((p) => ({ line: p.line, recipient: p.recipient, amountUi: p.amountUi, reason: "not_registered" }));
  const batches = batchPayments(payable, input.maxPerBatch);
  const body: PlanBody = {
    version: PLAN_VERSION,
    cluster: input.cluster,
    treasury: input.treasury,
    mint: input.mint,
    decimals: input.decimals,
    csvSha256: createHash("sha256").update(input.csvText).digest("hex"),
    batches,
    skipped,
    totals: {
      payees: payable.length,
      amount: payable.reduce((s, p) => s + BigInt(p.amount), 0n).toString(),
      batches: batches.length,
    },
  };
  return { ...body, planId: planId(body), createdAt: (input.now ?? new Date()).toISOString() };
}

/** Parse plan.json and check its hash, so an edited plan is never run. */
export function loadPlan(text: string): Plan {
  const plan = JSON.parse(text) as Plan;
  if (plan.version !== PLAN_VERSION) throw new PlanError(`unsupported plan version ${plan.version}`);
  const { planId: id, createdAt: _c, notes: _n, ...body } = plan;
  if (planId(body) !== id) throw new PlanError("plan.json was modified after planning (planId mismatch); re-run plan");
  return plan;
}
