import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { paymentsCsv, verifyAuditBundle, writeAuditBundle, type Audit } from "../src/audit.ts";
import { parseCsvRecords } from "../src/csv.ts";

const audit: Audit = {
  manifest: {
    version: 1,
    planId: "abc",
    cluster: "localnet",
    treasury: "GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
    payees: 2,
    total: "3000",
    batches: 1,
    createdAt: new Date(0).toISOString(),
  },
  batches: [{ id: "b001", signature: "sig", slot: "5", receipt: "ringrcpt1:x" }],
  payments: [
    { line: 2, batch: "b001", recipient: "R1", amountUi: "0.000001", amount: "1000", memo: 'Nov, "bonus"', signature: "sig", outputSlot: 1, commitment: "verified" },
    { line: 3, batch: "b001", recipient: "R2", amountUi: "0.000002", amount: "2000", memo: " padded ", signature: "sig", outputSlot: 2, commitment: "verified" },
  ],
};

describe("audit bundle files", () => {
  it("writes CSV that round-trips memos with commas, quotes and spaces", () => {
    const records = parseCsvRecords(paymentsCsv(audit.payments));
    expect(records[1]!.fields[5]).toBe('Nov, "bonus"');
    expect(records[2]!.fields[5]).toBe(" padded ");
  });

  it("hashes every file and rejects an edited bundle before touching the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const manifest = writeAuditBundle(dir, audit);
    expect(Object.keys(manifest.files).sort()).toEqual(["README.txt", "batches.json", "payments.csv"]);
    const csvPath = join(dir, "payments.csv");
    writeFileSync(csvPath, readFileSync(csvPath, "utf8").replace(",2000,", ",9000,"));
    const noNetwork = new Proxy({}, { get: () => { throw new Error("network used"); } }) as never;
    await expect(verifyAuditBundle(dir, noNetwork)).rejects.toThrow(/payments.csv does not match its hash/);
  });
});
