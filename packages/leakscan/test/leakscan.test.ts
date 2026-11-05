import { describe, expect, it } from "vitest";
import { adviseWithdrawal, analyze, classify, mergeEvents, scan, type ParsedTransaction, type PoolEvent, type Rpc } from "../src/index.ts";

const VAULT = "Vault1111111111111111111111111111111111111";

function tx(sig: string, accounts: [string, boolean, number][], opts: { err?: unknown; time?: number } = {}): ParsedTransaction {
  return {
    slot: 100,
    blockTime: opts.time ?? 1_000,
    transaction: { signatures: [sig], message: { accountKeys: accounts.map(([pubkey, signer]) => ({ pubkey, signer })) } },
    meta: { err: opts.err ?? null, preBalances: accounts.map(() => 10_000_000), postBalances: accounts.map(([, , d]) => 10_000_000 + d) },
  };
}

const ev = (kind: PoolEvent["kind"], amount: number, address: string, time: number, sig = `${kind}-${address}-${time}`): PoolEvent => ({
  signature: sig, slot: time, time, kind, amount: String(amount), address,
});

describe("classify", () => {
  it("reads a deposit: the signer that paid the vault", () => {
    const e = classify(tx("d", [["alice", true, -2_005_000], [VAULT, false, 2_000_000]]), VAULT);
    expect(e).toMatchObject({ kind: "deposit", amount: "2000000", address: "alice" });
  });
  it("reads a withdrawal: the non-signer credited with the exact amount", () => {
    const e = classify(
      tx("w", [["relayer", true, -10_000], ["tree", false, -701_120], ["rent", false, 706_120], [VAULT, false, -1_173_240], ["bob", false, 1_173_240]]),
      VAULT,
    );
    expect(e).toMatchObject({ kind: "withdrawal", amount: "1173240", address: "bob" });
  });
  it("ignores private transfers, failures and other programs", () => {
    expect(classify(tx("t", [["relayer", true, -10_000], ["tree", false, -701_120], ["x", false, 706_120]]), VAULT)).toBeUndefined();
    expect(classify(tx("f", [["alice", true, -2_005_000], [VAULT, false, 2_000_000]], { err: { custom: 1 } }), VAULT)).toBeUndefined();
    expect(classify(tx("z", [["alice", true, -5000], [VAULT, false, 0]]), VAULT)).toBeUndefined();
  });
});

describe("analyze", () => {
  const H = 3600;
  const events = [
    ev("deposit", 1_234_567, "alice", 0),
    ev("deposit", 1_000_000_000, "carol", 1 * H),
    ev("deposit", 1_000_000_000, "dave", 2 * H),
    ev("withdrawal", 1_234_567, "bob", 3 * H), // unique amount match
    ev("withdrawal", 1_000_000_000, "erin", 4 * H), // set of 2
    ev("withdrawal", 500_000_000, "carol", 5 * H), // round trip, no amount match
    ev("withdrawal", 300_000_000, "erin", 6 * H), // recipient reuse
  ];
  const s = analyze(events, { now: new Date(0) });

  it("counts each kind of linkability", () => {
    expect(s.totals).toMatchObject({ deposits: 3, withdrawals: 4, distinctDepositors: 3, distinctRecipients: 3 });
    expect(s.withdrawals).toEqual({ uniqueAmountMatch: 1, noAmountMatch: 2, roundTrip: 1, recipientReuse: 1, linkable: 3 });
    expect(s.exactSetSizes.find((b) => b.label === "1")?.count).toBe(1);
    expect(s.exactSetSizes.find((b) => b.label === "2–5")?.count).toBe(1);
    expect(s.medianNaiveSet).toBe(3);
    expect(s.byMainReason).toEqual({ uniqueAmount: 1, roundTrip: 1, recipientReuse: 1, notLinked: 1 });
  });
  it("does not match deposits outside the window", () => {
    const late = analyze([ev("deposit", 7, "a", 0), ev("withdrawal", 7, "b", 10 * H)], { windowSecs: 5 * H });
    expect(late.withdrawals.uniqueAmountMatch).toBe(0);
    expect(late.withdrawals.noAmountMatch).toBe(1);
  });
  it("publishes no addresses or signatures", () => {
    const json = JSON.stringify(s);
    for (const name of ["alice", "bob", "carol", "dave", "erin", "deposit-"]) expect(json).not.toContain(name);
  });
});

describe("adviseWithdrawal", () => {
  const now = new Date(10 * 24 * 3600 * 1000);
  const t = now.getTime() / 1000;
  const history = [ev("deposit", 1_234_567, "me", t - 3600), ev("deposit", 2_000_000, "x", t - 7200), ev("withdrawal", 5, "used", t - 100)];

  it("flags an exact, unique, recent amount back to my own address as high risk", () => {
    const a = adviseWithdrawal(history, { amount: 1_234_567n, recipient: "me", myDepositAddresses: ["me"], now });
    expect(a.risk).toBe("high");
    expect(a.warnings.map((w) => w.code)).toEqual(["MATCHES_MY_DEPOSIT", "UNIQUE_AMOUNT", "RECENT_DEPOSIT", "RECIPIENT_IS_MY_DEPOSITOR"]);
  });
  it("flags a reused recipient", () => {
    const a = adviseWithdrawal(history, { amount: 3n, recipient: "used", myDepositAddresses: [], now });
    expect(a).toMatchObject({ risk: "medium", warnings: [{ code: "RECIPIENT_REUSED" }] });
  });
  it("is low risk for a fresh address, a different amount, after waiting", () => {
    const later = new Date(now.getTime() + 3 * 86400_000);
    expect(adviseWithdrawal(history, { amount: 700_000n, recipient: "fresh", myDepositAddresses: ["me"], now: later }).risk).toBe("low");
  });
});

describe("scan", () => {
  it("pages signatures, skips failures, stops at the time limit, and classifies", async () => {
    const sigs = [
      { signature: "s3", blockTime: 300, err: null },
      { signature: "s2", blockTime: 200, err: { x: 1 } },
      { signature: "s1", blockTime: 100, err: null },
      { signature: "s0", blockTime: 10, err: null },
    ];
    const txs: Record<string, ParsedTransaction> = {
      s3: tx("s3", [["alice", true, -1_005_000], [VAULT, false, 1_000_000]], { time: 300 }),
      s1: tx("s1", [["relayer", true, -5000]], { time: 100 }),
    };
    const calls: string[] = [];
    const rpc: Rpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        calls.push(method === "getTransaction" ? `tx:${params[0] as string}` : method);
        return (method === "getSignaturesForAddress" ? sigs : (txs[params[0] as string] ?? null)) as T;
      },
    };
    const r = await scan(rpc, { program: "P", vault: VAULT, sinceTime: 50 });
    expect(r.examined).toBe(2);
    expect(r.newest).toBe("s3");
    expect(r.events).toEqual([expect.objectContaining({ signature: "s3", kind: "deposit", address: "alice" })]);
    expect(calls).not.toContain("tx:s2");
    expect(calls).not.toContain("tx:s0");
  });
  it("merges caches without duplicates", () => {
    const a = ev("deposit", 1, "a", 1, "x");
    expect(mergeEvents([a], [a, ev("deposit", 2, "b", 2, "y")]).map((e) => e.signature)).toEqual(["y", "x"]);
  });
});
