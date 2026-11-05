/**
 * Executing a plan. See state.ts for the per-batch state machine.
 *
 * Rounds: sync the treasury, give each pending batch (in plan order, up to
 * `concurrency`) its own disjoint set of UTXOs, run those batches in parallel,
 * repeat. Change from one round funds the next, so a treasury with a single
 * UTXO still completes, just one batch at a time; `payroll split` first to run
 * batches concurrently.
 */
import { MAX_MEMO_TRANSFER_INPUTS, encodeMemo, spendableUtxos, type RingSession, type WalletEntry } from "@ringstack/core";
import { address, type Address, type Signature } from "@solana/kit";

import type { Plan, PlanBatch } from "./plan.ts";
import { loadRunState, resolveSubmitted, saveRunState, updateBatch, type RunState } from "./state.ts";

export type Log = (msg: string, fields?: Record<string, unknown>) => void;

export interface RunOptions {
  readonly session: RingSession;
  readonly plan: Plan;
  readonly statePath: string;
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly log?: Log;
  /** Test hook: throw right after this batch is sent and confirmed, before recording it (a simulated crash). */
  readonly crashAfterSend?: string;
  /** Test hook: stop after this many batches are confirmed in this invocation. */
  readonly stopAfter?: number;
}

export class CrashSimulated extends Error {
  override name = "CrashSimulated";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pick UTXOs (largest first) covering `amount` from `available`, removing them. */
export function assignInputs(available: WalletEntry[], amount: bigint): WalletEntry[] | undefined {
  const picked: WalletEntry[] = [];
  let total = 0n;
  for (const e of [...available]) {
    if (total >= amount) break;
    if (picked.length === MAX_MEMO_TRANSFER_INPUTS) return undefined;
    picked.push(e);
    total += e.utxo.amount;
  }
  if (total < amount) return undefined;
  for (const e of picked) available.splice(available.indexOf(e), 1);
  return picked;
}

export async function runPlan(opts: RunOptions): Promise<RunState> {
  const { session, plan, statePath } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const maxAttempts = opts.maxAttempts ?? 3;
  const log: Log = opts.log ?? (() => {});
  const mint = address(plan.mint);

  if (plan.treasury !== session.owner) {
    throw new Error(`plan is for treasury ${plan.treasury}; this keypair is ${session.owner}`);
  }

  let state = loadRunState(
    statePath,
    plan.planId,
    plan.batches.map((b) => b.id),
  );
  const save = (next: RunState) => {
    state = next;
    saveRunState(statePath, state);
  };
  save(state);

  const rpc = session.client.solanaRpc;

  /** Resolve every submitted batch: confirmed, or provably dead and back to pending. */
  async function reconcile(): Promise<void> {
    for (const [id, b] of Object.entries(state.batches)) {
      if (b.status !== "submitted" || b.signature === undefined || b.lastValidBlockHeight === undefined) continue;
      for (;;) {
        const { value } = await rpc
          .getSignatureStatuses([b.signature as Signature], { searchTransactionHistory: true })
          .send();
        const height = await rpc.getBlockHeight().send();
        const st = value[0];
        const r = resolveSubmitted(
          st ? { slot: st.slot, err: st.err, confirmationStatus: st.confirmationStatus } : null,
          height,
          BigInt(b.lastValidBlockHeight),
        );
        if (r.kind === "confirmed") {
          save(updateBatch(state, id, { status: "confirmed", slot: r.slot.toString() }));
          log("batch confirmed (reconciled)", { batch: id, signature: b.signature });
          break;
        }
        if (r.kind === "expired") {
          save(updateBatch(state, id, { status: "pending", lastError: "previous attempt expired without landing" }));
          log("batch attempt expired; will retry", { batch: id, signature: b.signature });
          break;
        }
        await sleep(2000);
      }
    }
  }

  async function runBatch(batch: PlanBatch, inputs: WalletEntry[]): Promise<void> {
    const attempts = (state.batches[batch.id]?.attempts ?? 0) + 1;
    save(updateBatch(state, batch.id, { attempts }));
    log("batch sending", { batch: batch.id, payees: batch.payments.length, total: batch.total, inputs: inputs.length });
    const confirmed = await session.transferMany(
      batch.payments.map((p) => ({
        recipient: address(p.recipient),
        amount: BigInt(p.amount),
        ...(p.memo === undefined ? {} : { memo: encodeMemo(p.memo) }),
      })),
      {
        asset: mint,
        inputs,
        beforeSend: ({ signature, lastValidBlockHeight }) =>
          save(
            updateBatch(state, batch.id, {
              status: "submitted",
              signature,
              lastValidBlockHeight: lastValidBlockHeight.toString(),
            }),
          ),
      },
    );
    if (opts.crashAfterSend === batch.id) throw new CrashSimulated(`simulated crash after sending ${batch.id}`);
    save(updateBatch(state, batch.id, { status: "confirmed", slot: confirmed.slot.toString() }));
    log("batch confirmed", { batch: batch.id, signature: confirmed.signature, slot: confirmed.slot.toString() });
  }

  await reconcile();
  let confirmedHere = 0;

  for (;;) {
    const pending = plan.batches.filter((b) => state.batches[b.id]?.status === "pending");
    if (pending.length === 0) break;
    if (opts.stopAfter !== undefined && confirmedHere >= opts.stopAfter) break;

    await session.sync();
    const available = spendableUtxos(session.wallet, mint as Address);
    const round: { batch: PlanBatch; inputs: WalletEntry[] }[] = [];
    for (const batch of pending) {
      if (round.length >= concurrency) break;
      if (opts.stopAfter !== undefined && confirmedHere + round.length >= opts.stopAfter) break;
      const inputs = assignInputs(available, BigInt(batch.total));
      if (inputs !== undefined) round.push({ batch, inputs });
    }
    if (round.length === 0) {
      const have = spendableUtxos(session.wallet, mint as Address).reduce((s, e) => s + e.utxo.amount, 0n);
      throw new Error(
        `treasury cannot fund batch ${pending[0]!.id} (needs ${pending[0]!.total}, spendable ${have}, ` +
          `at most ${MAX_MEMO_TRANSFER_INPUTS} inputs per batch); deposit, or merge if the balance is fragmented`,
      );
    }

    const results = await Promise.allSettled(round.map((r) => runBatch(r.batch, r.inputs)));
    for (const [i, res] of results.entries()) {
      const id = round[i]!.batch.id;
      if (res.status === "fulfilled") {
        confirmedHere++;
        continue;
      }
      if (res.reason instanceof CrashSimulated) throw res.reason;
      const err = (res.reason as Error).message;
      const b = state.batches[id]!;
      log("batch failed", { batch: id, attempt: b.attempts, error: err });
      // Submitted batches are left for reconcile; failures before signing go back to pending.
      if (b.status === "pending") save(updateBatch(state, id, { lastError: err }));
      if (b.attempts >= maxAttempts && b.status === "pending") {
        throw new Error(`batch ${id} failed ${b.attempts} times; last error: ${err}`);
      }
    }
    await reconcile();
  }
  return state;
}
