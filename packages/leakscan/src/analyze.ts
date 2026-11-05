/**
 * Aggregate linkability of public pool events. Outputs counts and
 * distributions only: no per-address or per-transaction findings, so the
 * published dataset helps users without singling anyone out.
 *
 * For each withdrawal W (amount a, recipient r, time t):
 *   exact-amount set   deposits before t with amount exactly a, within `window`.
 *                      Size 1 means W can be tied to one deposit by amount alone.
 *   round trip         r made a deposit before t (money went back to a depositor).
 *   recipient reuse    r received an earlier withdrawal.
 *   naive set          all deposits before t: what an observer can't rule out
 *                      without amount or address hints.
 */
import type { PoolEvent } from "./events.ts";

export const DEFAULT_WINDOW_SECS = 7 * 24 * 3600;

export interface Bucket {
  readonly label: string;
  readonly count: number;
}

export interface DailyPoint {
  readonly day: string;
  readonly deposits: number;
  readonly withdrawals: number;
  /** Share of that day's withdrawals with an exact-amount set of size 1. */
  readonly uniqueMatchShare: number;
}

export interface LeakStats {
  readonly generatedAt: string;
  readonly network: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly windowHours: number;
  readonly totals: {
    readonly deposits: number;
    readonly withdrawals: number;
    readonly depositedSol: number;
    readonly withdrawnSol: number;
    readonly distinctDepositors: number;
    readonly distinctRecipients: number;
  };
  readonly withdrawals: {
    /** Exactly one earlier deposit of the same amount in the window. */
    readonly uniqueAmountMatch: number;
    /** No earlier deposit of that exact amount (amount gives nothing away). */
    readonly noAmountMatch: number;
    readonly roundTrip: number;
    readonly recipientReuse: number;
    /** Any of the three above. */
    readonly linkable: number;
  };
  /**
   * Each withdrawal counted once, under its strongest link: unique amount,
   * then round trip, then recipient reuse, else not linked. Sums to the total.
   */
  readonly byMainReason: {
    readonly uniqueAmount: number;
    readonly roundTrip: number;
    readonly recipientReuse: number;
    readonly notLinked: number;
  };
  /** Exact-amount set sizes across withdrawals. */
  readonly exactSetSizes: readonly Bucket[];
  /** Hours from the most recent same-amount deposit to the withdrawal. */
  readonly matchDelayHours: readonly Bucket[];
  /** Median naive anonymity set (deposits before each withdrawal). */
  readonly medianNaiveSet: number;
  /** Most common deposit amounts (in SOL) and how often they occur: common amounts blend in. */
  readonly commonDepositAmounts: readonly { readonly sol: number; readonly count: number }[];
  readonly daily: readonly DailyPoint[];
}

const LAMPORTS = 1_000_000_000;

function bucket(values: readonly number[], edges: readonly [number, string][], over: string): Bucket[] {
  const counts = new Map<string, number>([...edges.map(([, l]) => [l, 0] as [string, number]), [over, 0]]);
  for (const v of values) {
    const hit = edges.find(([max]) => v <= max);
    const label = hit ? hit[1] : over;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function analyze(
  events: readonly PoolEvent[],
  { windowSecs = DEFAULT_WINDOW_SECS, network = "devnet", now = new Date() }: { windowSecs?: number; network?: string; now?: Date } = {},
): LeakStats {
  const ordered = [...events].sort((a, b) => a.time - b.time || a.slot - b.slot);
  const deposits: PoolEvent[] = [];
  const depositors = new Set<string>();
  const recipients = new Set<string>();
  const byAmount = new Map<string, number[]>(); // amount → deposit times
  const days = new Map<string, { deposits: number; withdrawals: number; unique: number }>();

  let unique = 0;
  let none = 0;
  let roundTrip = 0;
  let reuse = 0;
  let linkable = 0;
  const main = { uniqueAmount: 0, roundTrip: 0, recipientReuse: 0, notLinked: 0 };
  const setSizes: number[] = [];
  const delays: number[] = [];
  const naive: number[] = [];

  for (const e of ordered) {
    const day = new Date(e.time * 1000).toISOString().slice(0, 10);
    const d = days.get(day) ?? { deposits: 0, withdrawals: 0, unique: 0 };
    days.set(day, d);
    if (e.kind === "deposit") {
      deposits.push(e);
      depositors.add(e.address);
      const times = byAmount.get(e.amount) ?? [];
      times.push(e.time);
      byAmount.set(e.amount, times);
      d.deposits++;
      continue;
    }
    d.withdrawals++;
    const candidates = (byAmount.get(e.amount) ?? []).filter((t) => t <= e.time && e.time - t <= windowSecs);
    const isRoundTrip = depositors.has(e.address);
    const isReuse = recipients.has(e.address);
    setSizes.push(candidates.length);
    naive.push(deposits.length);
    if (candidates.length === 0) none++;
    if (candidates.length === 1) {
      unique++;
      d.unique++;
    }
    if (candidates.length > 0) delays.push((e.time - Math.max(...candidates)) / 3600);
    if (isRoundTrip) roundTrip++;
    if (isReuse) reuse++;
    if (candidates.length === 1 || isRoundTrip || isReuse) linkable++;
    if (candidates.length === 1) main.uniqueAmount++;
    else if (isRoundTrip) main.roundTrip++;
    else if (isReuse) main.recipientReuse++;
    else main.notLinked++;
    recipients.add(e.address);
  }

  const withdrawals = ordered.filter((e) => e.kind === "withdrawal");
  const sol = (xs: PoolEvent[]) => xs.reduce((s, e) => s + Number(e.amount), 0) / LAMPORTS;
  const amountCounts = [...byAmount].map(([a, ts]) => ({ sol: Number(a) / LAMPORTS, count: ts.length }));

  return {
    generatedAt: now.toISOString(),
    network,
    from: ordered.length ? new Date(ordered[0]!.time * 1000).toISOString() : null,
    to: ordered.length ? new Date(ordered.at(-1)!.time * 1000).toISOString() : null,
    windowHours: windowSecs / 3600,
    totals: {
      deposits: deposits.length,
      withdrawals: withdrawals.length,
      depositedSol: sol(deposits),
      withdrawnSol: sol(withdrawals),
      distinctDepositors: depositors.size,
      distinctRecipients: recipients.size,
    },
    withdrawals: { uniqueAmountMatch: unique, noAmountMatch: none, roundTrip, recipientReuse: reuse, linkable },
    byMainReason: main,
    exactSetSizes: bucket(setSizes, [[0, "0"], [1, "1"], [5, "2–5"], [20, "6–20"]], "21+"),
    matchDelayHours: bucket(delays, [[1, "< 1 h"], [6, "1–6 h"], [24, "6–24 h"], [72, "1–3 days"]], "3+ days"),
    medianNaiveSet: median(naive),
    commonDepositAmounts: amountCounts.sort((a, b) => b.count - a.count || a.sol - b.sol).slice(0, 8),
    daily: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({
        day,
        deposits: v.deposits,
        withdrawals: v.withdrawals,
        uniqueMatchShare: v.withdrawals ? v.unique / v.withdrawals : 0,
      })),
  };
}
