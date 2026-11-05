import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WalletEntry } from "@ringstack/core";
import { describe, expect, it } from "vitest";

import { parsePayrollCsv } from "../src/csv.ts";
import { batchPayments, buildPlan, loadPlan, validateRows, type PlanPayment } from "../src/plan.ts";
import { assignInputs } from "../src/run.ts";
import { loadRunState, newRunState, resolveSubmitted, saveRunState, updateBatch } from "../src/state.ts";

// Valid base58 addresses (system program + well-known programs/mints).
const A = [
  "GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
];

describe("CSV", () => {
  it("parses quotes, CRLF, BOM, comments and an optional memo column", () => {
    const rows = parsePayrollCsv(
      `﻿address,amount,memo\r\n# November\r\n${A[0]},1.5,"Payroll, Nov ""26"""\r\n\r\n${A[1]},2,\n`,
    );
    expect(rows).toEqual([
      { line: 3, address: A[0], amount: "1.5", memo: 'Payroll, Nov "26"' },
      { line: 5, address: A[1], amount: "2" },
    ]);
  });

  it("rejects bad headers and ragged rows", () => {
    expect(() => parsePayrollCsv("wallet,amount\n")).toThrow(/address and amount/);
    expect(() => parsePayrollCsv("address,amount,bonus\n")).toThrow(/unknown CSV column/);
    expect(() => parsePayrollCsv(`address,amount\n${A[0]},1,extra\n`)).toThrow(/line 2: expected 2 fields/);
    expect(() => parsePayrollCsv(`address,memo,amount\n${A[0]},x\n`)).toThrow(/line 2: expected 3 fields/);
    expect(parsePayrollCsv(`address,amount,memo\n${A[0]},1\n`)).toEqual([{ line: 2, address: A[0], amount: "1" }]);
    expect(() => parsePayrollCsv(`address,amount\n"${A[0]},1\n`)).toThrow(/unterminated/);
  });
});

describe("validation and batching", () => {
  it("collects every invalid row before failing", () => {
    expect(() =>
      validateRows(
        [
          { line: 2, address: "nope", amount: "1" },
          { line: 3, address: A[0]!, amount: "1.0000000001" },
          { line: 4, address: A[1]!, amount: "1", memo: "x".repeat(33) },
        ],
        9,
      ),
    ).toThrow(/line 2.*\n.*line 3.*\n.*line 4/s);
  });

  const pay = (recipient: string, i: number): PlanPayment => ({
    line: i + 2,
    recipient,
    amount: "100",
    amountUi: "0.0000001",
  });

  it("packs up to 15 per batch, deterministically", () => {
    const ps = Array.from({ length: 31 }, (_, i) => pay(A[i % 4]! + "", i)).map((p, i) => ({ ...p, recipient: `R${i}` }));
    const batches = batchPayments(ps);
    expect(batches.map((b) => b.payments.length)).toEqual([15, 15, 1]);
    expect(batches.map((b) => b.id)).toEqual(["b001", "b002", "b003"]);
    expect(batches[0]!.total).toBe("1500");
    expect(batchPayments(ps)).toEqual(batches);
    expect(batchPayments(ps, 10).length).toBe(4);
    expect(() => batchPayments(ps, 16)).toThrow(/1–15/);
  });

  it("never puts the same recipient twice in one batch", () => {
    const batches = batchPayments([pay(A[0]!, 0), pay(A[0]!, 1), pay(A[1]!, 2), pay(A[0]!, 3)]);
    expect(batches.map((b) => b.payments.map((p) => p.line))).toEqual([[2, 4], [3], [5]]);
  });
});

describe("plans", () => {
  const csvText = `address,amount,memo\n${A[0]},1.25,Nov\n${A[1]},2\n${A[2]},3\n`;
  const build = () =>
    buildPlan({
      rows: parsePayrollCsv(csvText),
      csvText,
      cluster: "localnet",
      treasury: A[3]!,
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      isRegistered: async (a) => a !== A[1],
      now: new Date(0),
    });

  it("skips unregistered payees and totals the rest", async () => {
    const plan = await build();
    expect(plan.skipped).toEqual([{ line: 3, recipient: A[1], amountUi: "2", reason: "not_registered" }]);
    expect(plan.totals).toEqual({ payees: 2, amount: "4250000000", batches: 1 });
    expect(plan.batches[0]!.payments[0]).toMatchObject({ amount: "1250000000", memo: "Nov" });
    expect(plan.planId).toBe((await build()).planId);
  });

  it("refuses a plan edited after planning", async () => {
    const plan = { ...(await build()), notes: ["ok to change"] };
    expect(loadPlan(JSON.stringify(plan)).planId).toBe(plan.planId);
    const tampered = JSON.parse(JSON.stringify(plan));
    tampered.batches[0].payments[0].amount = "9999999999";
    expect(() => loadPlan(JSON.stringify(tampered))).toThrow(/modified/);
  });
});

describe("run state", () => {
  it("decides what a submitted batch became", () => {
    expect(resolveSubmitted({ slot: 7n, err: null, confirmationStatus: "confirmed" }, 10n, 20n)).toEqual({
      kind: "confirmed",
      slot: 7n,
    });
    expect(resolveSubmitted({ slot: 7n, err: null, confirmationStatus: "processed" }, 10n, 20n).kind).toBe("unknown");
    expect(resolveSubmitted(null, 10n, 20n).kind).toBe("unknown");
    expect(resolveSubmitted(null, 21n, 20n).kind).toBe("expired");
    expect(resolveSubmitted({ slot: 7n, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }, 10n, 20n).kind).toBe(
      "expired",
    );
  });

  it("persists atomically and refuses another plan's state", () => {
    const path = join(mkdtempSync(join(tmpdir(), "payroll-")), "plan.state.json");
    let s = newRunState("p1", ["b001", "b002"]);
    s = updateBatch(s, "b001", { status: "submitted", signature: "sig", lastValidBlockHeight: "99", attempts: 1 });
    saveRunState(path, s);
    const loaded = loadRunState(path, "p1", ["b001", "b002"]);
    expect(loaded.batches["b001"]).toMatchObject({ status: "submitted", signature: "sig", lastValidBlockHeight: "99" });
    expect(loaded.batches["b002"]!.status).toBe("pending");
    expect(() => loadRunState(path, "p2", ["b001"])).toThrow(/belongs to plan p1/);
  });
});

describe("assignInputs", () => {
  const entry = (amount: bigint) => ({ utxo: { amount } }) as unknown as WalletEntry;

  it("hands out disjoint UTXOs, largest first", () => {
    const pool = [entry(50n), entry(30n), entry(20n), entry(5n)];
    const a = assignInputs(pool, 40n)!;
    const b = assignInputs(pool, 40n)!;
    expect(a.map((e) => e.utxo.amount)).toEqual([50n]);
    expect(b.map((e) => e.utxo.amount)).toEqual([30n, 20n]);
    expect(assignInputs(pool, 40n)).toBeUndefined();
    expect(pool.map((e) => e.utxo.amount)).toEqual([5n]);
  });
});
