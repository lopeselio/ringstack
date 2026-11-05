/**
 * Incremental scan of the shielded pool's public transactions over JSON-RPC.
 *
 * Walks `getSignaturesForAddress(program)` from newest to oldest, stopping at
 * the newest signature already known (or at `sinceTime`), and fetches each new
 * transaction with `maxSupportedTransactionVersion: 1` (pool transactions are
 * v1). Only successful transactions that move the SOL vault become events.
 */
import { classify, type ParsedTransaction, type PoolEvent } from "./events.ts";

export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** A minimal JSON-RPC client with retry on 429/5xx. */
export function httpRpc(url: string, { retries = 5 }: { retries?: number } = {}): Rpc {
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        const body = (await res.json()) as { result?: T; error?: { message: string } };
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result as T;
      }
    },
  };
}

export interface ScanOptions {
  readonly program: string;
  readonly vault: string;
  /** Newest signature from a previous scan; the scan stops when it reaches it. */
  readonly until?: string;
  /** Unix seconds; older transactions are not scanned. */
  readonly sinceTime?: number;
  /** Hard cap on signatures examined in one run. */
  readonly maxSignatures?: number;
  readonly concurrency?: number;
  readonly onProgress?: (done: number, events: number) => void;
}

export interface ScanResult {
  /** New events, newest first. */
  readonly events: PoolEvent[];
  /** Newest signature seen (store it as the next `until`). */
  readonly newest?: string;
  readonly examined: number;
}

interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

export async function scan(rpc: Rpc, opts: ScanOptions): Promise<ScanResult> {
  const max = opts.maxSignatures ?? 50_000;
  const signatures: string[] = [];
  let before: string | undefined;
  let newest: string | undefined;
  outer: for (;;) {
    const page = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [
      opts.program,
      { limit: 1000, ...(before === undefined ? {} : { before }), ...(opts.until === undefined ? {} : { until: opts.until }) },
    ]);
    if (page.length === 0) break;
    newest ??= page[0]!.signature;
    for (const s of page) {
      if (opts.sinceTime !== undefined && s.blockTime !== null && s.blockTime < opts.sinceTime) break outer;
      if (s.err === null) signatures.push(s.signature);
      if (signatures.length >= max) break outer;
    }
    before = page[page.length - 1]!.signature;
    if (page.length < 1000) break;
  }

  const events: PoolEvent[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < signatures.length) {
      const sig = signatures[next++]!;
      const tx = await rpc.call<ParsedTransaction | null>("getTransaction", [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
      ]);
      const event = tx === null ? undefined : classify(tx, opts.vault);
      if (event !== undefined) events.push(event);
      done++;
      if (done % 200 === 0) opts.onProgress?.(done, events.length);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  events.sort((a, b) => b.slot - a.slot || a.signature.localeCompare(b.signature));
  return { events, ...(newest === undefined ? {} : { newest }), examined: signatures.length };
}

/** Merge new events into a dataset, deduplicated by signature, newest first. */
export function mergeEvents(existing: readonly PoolEvent[], fresh: readonly PoolEvent[]): PoolEvent[] {
  const bySig = new Map<string, PoolEvent>();
  for (const e of [...existing, ...fresh]) bySig.set(e.signature, e);
  return [...bySig.values()].sort((a, b) => b.slot - a.slot || a.signature.localeCompare(b.signature));
}
