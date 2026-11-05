/**
 * Run state, persisted after every transition so a run can resume.
 *
 *   pending    ── signed ──▶ submitted (signature + lastValidBlockHeight recorded BEFORE sending)
 *   submitted  ── confirmed ──▶ confirmed
 *   submitted  ── blockhash expired, not landed ──▶ pending (safe to retry: it can never land)
 *
 * A batch is never re-signed while its previous signature could still land,
 * which is what prevents paying anyone twice.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type BatchStatus = "pending" | "submitted" | "confirmed";

export interface BatchState {
  readonly status: BatchStatus;
  readonly attempts: number;
  readonly signature?: string;
  /** Block height after which `signature` can no longer land (decimal string). */
  readonly lastValidBlockHeight?: string;
  readonly slot?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface RunState {
  readonly planId: string;
  readonly batches: Record<string, BatchState>;
}

export function newRunState(planId: string, batchIds: readonly string[]): RunState {
  const now = new Date().toISOString();
  return {
    planId,
    batches: Object.fromEntries(batchIds.map((id) => [id, { status: "pending", attempts: 0, updatedAt: now }])),
  };
}

/** Load state for `planId`, or start fresh. Refuses state that belongs to another plan. */
export function loadRunState(path: string, planId: string, batchIds: readonly string[]): RunState {
  if (!existsSync(path)) return newRunState(planId, batchIds);
  const state = JSON.parse(readFileSync(path, "utf8")) as RunState;
  if (state.planId !== planId) {
    throw new Error(`${path} belongs to plan ${state.planId}, not ${planId}; refusing to mix runs`);
  }
  return state;
}

/** Atomic write: temp file + rename. */
export function saveRunState(path: string, state: RunState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function updateBatch(state: RunState, id: string, patch: Partial<BatchState>): RunState {
  const prev = state.batches[id];
  if (prev === undefined) throw new Error(`unknown batch ${id}`);
  return {
    ...state,
    batches: { ...state.batches, [id]: { ...prev, ...patch, updatedAt: new Date().toISOString() } },
  };
}

export type SubmittedResolution =
  | { readonly kind: "confirmed"; readonly slot: bigint }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" };

/**
 * What happened to a submitted batch. `status` is the cluster's signature
 * status (null when not found); `blockHeight` the current block height.
 */
export function resolveSubmitted(
  status: { slot: bigint; err: unknown; confirmationStatus: string | null } | null,
  blockHeight: bigint,
  lastValidBlockHeight: bigint,
): SubmittedResolution {
  if (status !== null && status.err === null && status.confirmationStatus !== "processed") {
    return { kind: "confirmed", slot: status.slot };
  }
  // A transaction that landed with an error moved no funds; one past its
  // blockhash lifetime can never land. Either way a fresh attempt is safe.
  if ((status !== null && status.err !== null) || blockHeight > lastValidBlockHeight) return { kind: "expired" };
  return { kind: "unknown" };
}
