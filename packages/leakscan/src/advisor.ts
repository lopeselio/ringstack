/**
 * Withdrawal hygiene advisor: before a wallet withdraws, check whether the
 * withdrawal would be linkable to the user's own public deposits, using the
 * public event history plus the user's own deposit addresses (kept local).
 */
import type { PoolEvent } from "./events.ts";

export type AdviceCode =
  | "MATCHES_MY_DEPOSIT"
  | "UNIQUE_AMOUNT"
  | "RECENT_DEPOSIT"
  | "RECIPIENT_IS_MY_DEPOSITOR"
  | "RECIPIENT_REUSED";

export interface Advice {
  readonly risk: "low" | "medium" | "high";
  readonly warnings: readonly { readonly code: AdviceCode; readonly message: string }[];
  readonly suggestions: readonly string[];
}

export interface WithdrawalPlan {
  /** Lamports. */
  readonly amount: bigint;
  readonly recipient: string;
  /** Addresses this user deposited from. Stays on the user's machine. */
  readonly myDepositAddresses: readonly string[];
  readonly now?: Date;
  /** How far back a same-amount deposit still counts as a match. Default 7 days. */
  readonly windowSecs?: number;
  /** Deposits younger than this are "recent". Default 24 hours. */
  readonly recentSecs?: number;
}

export function adviseWithdrawal(events: readonly PoolEvent[], plan: WithdrawalPlan): Advice {
  const now = Math.floor((plan.now ?? new Date()).getTime() / 1000);
  const window = plan.windowSecs ?? 7 * 24 * 3600;
  const recent = plan.recentSecs ?? 24 * 3600;
  const mine = new Set(plan.myDepositAddresses);
  const amount = plan.amount.toString();

  const deposits = events.filter((e) => e.kind === "deposit" && e.time <= now);
  const sameAmount = deposits.filter((e) => e.amount === amount && now - e.time <= window);
  const myDeposits = deposits.filter((e) => mine.has(e.address));

  const warnings: { code: AdviceCode; message: string }[] = [];
  if (myDeposits.some((e) => e.amount === amount)) {
    warnings.push({
      code: "MATCHES_MY_DEPOSIT",
      message: "This is exactly the amount you deposited; amount matching can tie the two together.",
    });
  }
  if (sameAmount.length === 1 && mine.has(sameAmount[0]!.address)) {
    warnings.push({
      code: "UNIQUE_AMOUNT",
      message: "Your deposit is the only recent deposit of this exact amount, so this withdrawal points straight at it.",
    });
  }
  if (myDeposits.some((e) => now - e.time <= recent)) {
    warnings.push({
      code: "RECENT_DEPOSIT",
      message: "You deposited within the last day; a quick withdrawal narrows the timing window.",
    });
  }
  if (mine.has(plan.recipient)) {
    warnings.push({
      code: "RECIPIENT_IS_MY_DEPOSITOR",
      message: "The recipient is an address you deposited from: the funds visibly go back where they came from.",
    });
  }
  if (events.some((e) => e.kind === "withdrawal" && e.address === plan.recipient)) {
    warnings.push({
      code: "RECIPIENT_REUSED",
      message: "This recipient already received withdrawals; reusing it links those withdrawals together.",
    });
  }

  const suggestions: string[] = [];
  const codes = new Set(warnings.map((w) => w.code));
  if (codes.has("MATCHES_MY_DEPOSIT") || codes.has("UNIQUE_AMOUNT")) {
    suggestions.push("Withdraw a different amount, or split it into amounts that many others deposit.");
  }
  if (codes.has("RECENT_DEPOSIT")) suggestions.push("Wait longer before withdrawing, so more deposits land in between.");
  if (codes.has("RECIPIENT_IS_MY_DEPOSITOR") || codes.has("RECIPIENT_REUSED")) {
    suggestions.push("Withdraw to a fresh address that has no history with the pool.");
  }
  if (warnings.length > 0) suggestions.push("Or don't withdraw: pay privately inside the pool instead.");

  const high = codes.has("UNIQUE_AMOUNT") || codes.has("RECIPIENT_IS_MY_DEPOSITOR");
  return { risk: high ? "high" : warnings.length > 0 ? "medium" : "low", warnings, suggestions };
}
