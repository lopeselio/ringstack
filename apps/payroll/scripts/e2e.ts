/**
 * Localnet payroll run:
 *   - 17 registered payees (one paid twice, some with memos) + 1 unregistered (skipped)
 *   - treasury split into 2 UTXOs, run with concurrency 2
 *   - simulated crash right after b001 lands but before it is recorded; the rerun
 *     reconciles b001 from its saved signature instead of paying again
 *   - a second plan whose saved attempt expired without landing is retried once
 *   - every payee ends with exactly what the plan says (no double payment)
 *   - an audit bundle for the run verifies with no keys; a forged amount (with
 *     its file hash updated to match) is caught against the chain
 *   - a payee proves their own pay from their own wallet; the proof cannot open
 *     a co-worker's output, and a tampered proof fails
 *
 *   pnpm --filter @ringstack/payroll e2e
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOL_MINT, ShieldedKeypair, createZolanaClient, initializePoseidon } from "@heliuslabs/zolana";
import { isWalletRegistered } from "@heliuslabs/zolana/wallet";
import {
  PaymentProofError,
  RingSession,
  clientConfigFromEnv,
  decodeMemo,
  fund,
  networkFromEnv,
  decodePaymentProof,
  fetchShieldedTransaction,
  provePayment,
  spendableUtxos,
  verifyPaymentProof,
} from "@ringstack/core";
import type { Address, Signature } from "@solana/kit";

import { AuditError, buildAudit, verifyAuditBundle, writeAuditBundle } from "../src/audit.ts";
import { checkProof, listPayslips, provePayslip } from "../src/payslip.ts";
import { parsePayrollCsv } from "../src/csv.ts";
import { buildPlan, type Plan } from "../src/plan.ts";
import { CrashSimulated, runPlan } from "../src/run.ts";
import { loadRunState, newRunState, saveRunState, updateBatch } from "../src/state.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await initializePoseidon();
const client = await createZolanaClient(clientConfigFromEnv());
const cluster = networkFromEnv();
const airdrop = (to: Address, amount: bigint) => fund(client, to, amount);

// Treasury: 0.1 SOL private, split into 2 UTXOs for concurrent batches.
const treasury = await RingSession.open(client, ShieldedKeypair.generate());
await airdrop(treasury.owner, 150_000_000n);
await treasury.deposit(100_000_000n);
await treasury.split(2);
check(spendableUtxos(treasury.wallet, SOL_MINT).length === 2, "split should leave 2 UTXOs");
console.log(`treasury ${treasury.owner} (0.1 SOL in 2 UTXOs)`);

// Payees.
const payees: RingSession[] = [];
for (let i = 0; i < 17; i++) {
  const s = await RingSession.open(client, ShieldedKeypair.generate());
  await airdrop(s.owner, 10_000_000n);
  await s.register();
  payees.push(s);
}
const unregistered = ShieldedKeypair.generate().toSolanaSigner().address;
console.log(`registered ${payees.length} payees`);

const amountOf = (i: number) => `0.00${String(i + 1).padStart(2, "0")}`; // 0.0001 … 0.0017 SOL… as UI strings
const rows = payees.map((p, i) => `${p.owner},${amountOf(i)},${i % 3 === 0 ? "Payroll 2026-11" : ""}`);
rows.push(`${unregistered},0.005,`);
rows.push(`${payees[0]!.owner},0.002,Bonus`); // payee 0 paid twice
const csvText = `address,amount,memo\n${rows.join("\n")}\n`;

const dir = mkdtempSync(join(tmpdir(), "payroll-e2e-"));
const planPath = join(dir, "plan.json");
const statePath = join(dir, "plan.state.json");

async function makePlan(text: string): Promise<Plan> {
  const built = await buildPlan({
    rows: parsePayrollCsv(text),
    csvText: text,
    cluster,
    treasury: treasury.owner,
    mint: SOL_MINT,
    decimals: 9,
    isRegistered: (owner) => isWalletRegistered({ rpc: client, owner: owner as Address }),
  });
  return { ...built, notes: [] };
}

const plan = await makePlan(csvText);
writeFileSync(planPath, JSON.stringify(plan, null, 2));
console.log(
  `plan ${plan.planId}: ${plan.totals.payees} payees in ${plan.batches.map((b) => `${b.id}(${b.payments.length})`).join(", ")}, ` +
    `skipped ${plan.skipped.length}`,
);
check(plan.skipped.length === 1 && plan.skipped[0]!.recipient === unregistered, "unregistered payee should be skipped");
check(plan.batches.length === 2 && plan.totals.payees === 18, "expected 18 payments in 2 batches");

// Expected base units per payee.
const expected = new Map<string, bigint>();
for (const b of plan.batches) for (const p of b.payments) expected.set(p.recipient, (expected.get(p.recipient) ?? 0n) + BigInt(p.amount));

// Run 1: crash right after b001 lands.
const log = (msg: string, f?: Record<string, unknown>) => console.log(`  ${msg} ${f?.["batch"] ?? ""}`);
let crashed = false;
try {
  await runPlan({ session: treasury, plan, statePath, concurrency: 2, log, crashAfterSend: "b001" });
} catch (e) {
  crashed = e instanceof CrashSimulated;
  if (!crashed) throw e;
}
check(crashed, "expected the simulated crash");
const afterCrash = loadRunState(statePath, plan.planId, ["b001", "b002"]);
console.log(`after crash: b001 ${afterCrash.batches["b001"]!.status}, b002 ${afterCrash.batches["b002"]!.status}`);
check(afterCrash.batches["b001"]!.status === "submitted", "b001 should be left submitted");

// Run 2: resume. b001 must be reconciled, not re-sent.
const b001Signature = afterCrash.batches["b001"]!.signature;
const final = await runPlan({ session: treasury, plan, statePath, concurrency: 2, log });
check(Object.values(final.batches).every((b) => b.status === "confirmed"), "all batches confirmed");
check(final.batches["b001"]!.signature === b001Signature && final.batches["b001"]!.attempts === 1, "b001 was re-sent");
console.log("resume reconciled b001 from its saved signature");

// Second plan: a saved attempt that expired without landing is retried once.
const late = payees[5]!;
const plan2 = await makePlan(`address,amount\n${late.owner},0.003\n`);
const state2Path = join(dir, "plan2.state.json");
saveRunState(
  state2Path,
  updateBatch(newRunState(plan2.planId, ["b001"]), "b001", {
    status: "submitted",
    attempts: 1,
    signature: "1".repeat(64), // never sent
    lastValidBlockHeight: "0", // long expired
  }),
);
const s2 = await runPlan({ session: treasury, plan: plan2, statePath: state2Path, log });
check(s2.batches["b001"]!.status === "confirmed" && s2.batches["b001"]!.attempts === 2, "expired attempt retried once");
expected.set(late.owner, (expected.get(late.owner) ?? 0n) + 3_000_000n);
console.log("expired attempt was retried exactly once");

// Every payee got exactly the planned amount, memos included.
for (const p of payees) {
  await p.sync();
  check(p.balance() === (expected.get(p.owner) ?? 0n), `payee ${p.owner}: ${p.balance()} ≠ ${expected.get(p.owner)}`);
}
const memos: string[] = [];
for (const b of Object.values(final.batches)) {
  if (b.signature !== undefined) memos.push(...(await payees[0]!.receivedMemos(b.signature as Signature)).values());
}
check(memos.includes("Payroll 2026-11") && memos.includes("Bonus"), `payee 0 memos ${JSON.stringify(memos)}`);
check(!existsSync(`${statePath}.tmp`), "state temp file left behind");
console.log("every payee balance matches the plan; payee 0 got both memos");

// Audit bundle for the first pay run: built with the treasury's keys, verified with none.
const auditDir = join(dir, `audit-${plan.planId}`);
const bundle = await buildAudit(treasury, plan, final);
writeAuditBundle(auditDir, bundle);
const checked = await verifyAuditBundle(auditDir, client);
check(checked.payments === 18 && checked.total === BigInt(plan.totals.amount), "audit totals");
console.log(`audit bundle verified: ${checked.payments} payments in ${bundle.batches.length} transactions`);

// Forge one amount and re-sign the manifest hash: only the chain can catch it now.
const csvPath = join(auditDir, "payments.csv");
const forged = readFileSync(csvPath, "utf8").replace(`,${bundle.payments[1]!.amount},`, ",999999999,");
writeFileSync(csvPath, forged);
const manifestPath = join(auditDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.files["payments.csv"] = createHash("sha256").update(forged).digest("hex");
writeFileSync(manifestPath, JSON.stringify(manifest));
let caught = "";
try {
  await verifyAuditBundle(auditDir, client);
} catch (e) {
  if (e instanceof AuditError) caught = e.message;
  else throw e;
}
check(/paid \d+, expected 999999999/.test(caught), `forged amount not caught: ${caught}`);
console.log("forged amount caught against the chain");

// Per-payee proof: payee 3 (paid in b001 with 14 others) proves only their own output.
const employee = payees[3]!;
const b001 = final.batches["b001"]!.signature!;
const slip = (await listPayslips(employee)).find((p) => p.signature === b001);
check(slip !== undefined && slip.memo === "Payroll 2026-11", `payslip ${JSON.stringify(slip)}`);
const proofLink = await provePayslip(employee, b001 as never, cluster);
const shown = await checkProof(client, proofLink);
check(shown.owner === employee.owner && shown.amount === BigInt(slip.amount) && shown.registered, "proof contents");
check(decodeMemo(shown.memo) === "Payroll 2026-11", "proof memo");
console.log(`payee proof verified: ${shown.amount} to ${shown.owner.slice(0, 8)}…, memo "${decodeMemo(shown.memo)}" (${proofLink.length} chars)`);

const expectCode = (fn: () => unknown, codes: string[]) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PaymentProofError && codes.includes(e.code)) return e.code;
    throw e;
  }
  throw new Error(`expected one of ${codes.join(", ")}`);
};
const tx = await fetchShieldedTransaction(client, b001 as never);
const proof = decodePaymentProof(proofLink);
// Point the employee's secret at a co-worker's output: it opens nothing.
const coworker = payees[4]!;
const coworkerSlot = provePayment(coworker.keypair, tx, cluster).outputSlot;
const leaked = expectCode(
  () => verifyPaymentProof({ ...proof, outputSlot: coworkerSlot, recipient: coworker.address }, tx),
  ["DOES_NOT_DECRYPT", "COMMITMENT_MISMATCH"],
);
const tampered = expectCode(
  () => verifyPaymentProof({ ...proof, sharedSecret: proof.sharedSecret.map((b, i) => (i === 5 ? b ^ 1 : b)) }, tx),
  ["DOES_NOT_DECRYPT", "COMMITMENT_MISMATCH"],
);
const stranger = expectCode(() => provePayment(ShieldedKeypair.generate(), tx, cluster), ["NO_SUCH_OUTPUT"]);
console.log(`co-worker's output stays closed (${leaked}); tampered proof fails (${tampered}); non-payee cannot prove (${stranger})`);

console.log("ok: payroll plan, concurrent batches, crash + resume without double payment, expired-attempt retry, audit bundle, per-payee proof");
