#!/usr/bin/env -S node --import tsx
/**
 * Private payroll.
 *
 *   payroll plan  --csv payroll.csv --keypair treasury.json [--mint <mint>] [--out plan.json] [--max-per-batch 15]
 *   payroll run   --plan plan.json --keypair treasury.json [--concurrency 2]
 *   payroll status --plan plan.json
 *   payroll split --keypair treasury.json --parts <n> [--mint <mint>]
 *   payroll audit --plan plan.json --keypair treasury.json [--out audit-<planId>]
 *   payroll verify-audit --dir audit-<planId>
 *   payroll payslips --keypair employee.json                          (payee: list incoming payments)
 *   payroll prove --keypair employee.json --signature <sig> [--output-slot n] [--verifier-url url]
 *   payroll verify-proof <ringproof1:…>                               (anyone: check a payee's proof)
 *
 * Network from ZOLANA_* env (see .env.example). Run state lives next to the
 * plan as <plan>.state.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { SOL_MINT, createSprClient, fetchAssetMetadata, initializePoseidon } from "@heliuslabs/spr";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";
import { RingSession, clientConfigFromEnv, decodeMemo, loadShieldedKeypair, spendableUtxos } from "@ringstack/core";
import type { Cluster } from "@ringstack/core/receipt";
import { address, type Signature } from "@solana/kit";

import { buildAudit, verifyAuditBundle, writeAuditBundle } from "./audit.ts";
import { parsePayrollCsv } from "./csv.ts";
import { checkProof, formatAmount, listPayslips, provePayslip } from "./payslip.ts";
import { buildPlan, loadPlan, type Plan } from "./plan.ts";
import { runPlan } from "./run.ts";
import { loadRunState } from "./state.ts";

const USAGE = `usage:
  payroll plan   --csv payroll.csv --keypair treasury.json [--mint <mint>] [--out plan.json] [--max-per-batch 15]
  payroll run    --plan plan.json --keypair treasury.json [--concurrency 2]
  payroll status --plan plan.json
  payroll split  --keypair treasury.json --parts <n> [--mint <mint>]
  payroll audit  --plan plan.json --keypair treasury.json [--out audit-<planId>]
  payroll verify-audit --dir audit-<planId>
  payroll payslips --keypair employee.json
  payroll prove --keypair employee.json --signature <sig> [--output-slot n] [--verifier-url url]
  payroll verify-proof <ringproof1:…>`;

const cluster = (process.env["ZOLANA_NETWORK"]?.trim() || "localnet") as Cluster;

async function openSession(keypairPath: string): Promise<RingSession> {
  await initializePoseidon();
  const client = await createSprClient(clientConfigFromEnv());
  return RingSession.open(client, await loadShieldedKeypair(keypairPath));
}

function ui(base: string | bigint, decimals: number): string {
  const s = BigInt(base).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

async function plan(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      csv: { type: "string" },
      keypair: { type: "string" },
      mint: { type: "string", default: SOL_MINT },
      out: { type: "string", default: "plan.json" },
      "max-per-batch": { type: "string", default: "15" },
    },
  });
  if (!values.csv || !values.keypair) throw new Error(USAGE);
  const session = await openSession(values.keypair);
  const mint = address(values.mint);
  const decimals = mint === SOL_MINT ? 9 : (await fetchAssetMetadata(session.client, mint)).decimals;
  const csvText = readFileSync(values.csv, "utf8");

  const built = await buildPlan({
    rows: parsePayrollCsv(csvText),
    csvText,
    cluster,
    treasury: session.owner,
    mint,
    decimals,
    maxPerBatch: Number(values["max-per-batch"]),
    isRegistered: (owner) => isWalletRegistered({ rpc: session.client, owner: address(owner) }),
  });

  // Pre-flight.
  const notes: string[] = [];
  const utxos = spendableUtxos(session.wallet, mint);
  const balance = utxos.reduce((s, e) => s + e.utxo.amount, 0n);
  const total = BigInt(built.totals.amount);
  if (balance < total) {
    notes.push(`Treasury holds ${ui(balance, decimals)}, the plan pays ${ui(total, decimals)}: deposit ${ui(total - balance, decimals)} more before running.`);
  }
  if (built.batches.length > 1 && utxos.length < built.batches.length) {
    notes.push(
      `Treasury has ${utxos.length} spendable UTXO(s) for ${built.batches.length} batches, so batches will run one after another. ` +
        `To run them concurrently: payroll split --keypair <treasury> --parts ${built.batches.length}`,
    );
  }
  if (built.skipped.length > 0) {
    notes.push(`${built.skipped.length} payee(s) are not registered for private payments and were skipped.`);
  }
  const result: Plan = { ...built, notes };
  writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`plan ${result.planId} → ${values.out}`);
  console.log(`  ${result.totals.payees} payees, ${ui(result.totals.amount, decimals)} total, ${result.totals.batches} batch(es) on ${cluster}`);
  for (const b of result.batches) console.log(`  ${b.id}: ${b.payments.length} payees, ${ui(b.total, decimals)}`);
  for (const s of result.skipped) console.log(`  skipped line ${s.line}: ${s.recipient} (${s.reason})`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (balance < total) process.exitCode = 1;
}

async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: "string", default: "plan.json" },
      keypair: { type: "string" },
      concurrency: { type: "string", default: "2" },
    },
  });
  if (!values.keypair) throw new Error(USAGE);
  const p = loadPlan(readFileSync(values.plan, "utf8"));
  if (p.cluster !== cluster) throw new Error(`plan is for ${p.cluster}; ZOLANA_NETWORK is ${cluster}`);
  const session = await openSession(values.keypair);
  const state = await runPlan({
    session,
    plan: p,
    statePath: `${values.plan.replace(/\.json$/, "")}.state.json`,
    concurrency: Number(values.concurrency),
    log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
  });
  const done = Object.values(state.batches).filter((b) => b.status === "confirmed").length;
  console.log(`${done}/${p.batches.length} batches confirmed`);
}

function status(args: string[]) {
  const { values } = parseArgs({ args, options: { plan: { type: "string", default: "plan.json" } } });
  const p = loadPlan(readFileSync(values.plan, "utf8"));
  const state = loadRunState(
    `${values.plan.replace(/\.json$/, "")}.state.json`,
    p.planId,
    p.batches.map((b) => b.id),
  );
  for (const b of p.batches) {
    const s = state.batches[b.id]!;
    console.log(
      `${b.id}  ${s.status.padEnd(9)}  ${b.payments.length} payees  ${ui(b.total, p.decimals)}  ${s.signature ?? ""}${s.lastError ? `  (${s.lastError})` : ""}`,
    );
  }
}

async function split(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { keypair: { type: "string" }, parts: { type: "string" }, mint: { type: "string", default: SOL_MINT } },
  });
  if (!values.keypair || !values.parts) throw new Error(USAGE);
  const session = await openSession(values.keypair);
  const tx = await session.split(Number(values.parts), { asset: address(values.mint) });
  console.log(`split into ${values.parts}: ${tx.signature}`);
}

const statePathFor = (planPath: string) => `${planPath.replace(/\.json$/, "")}.state.json`;

async function audit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { plan: { type: "string", default: "plan.json" }, keypair: { type: "string" }, out: { type: "string" } },
  });
  if (!values.keypair) throw new Error(USAGE);
  const p = loadPlan(readFileSync(values.plan, "utf8"));
  const state = loadRunState(statePathFor(values.plan), p.planId, p.batches.map((b) => b.id));
  const session = await openSession(values.keypair);
  const bundle = await buildAudit(session, p, state);
  const dir = values.out ?? `audit-${p.planId}`;
  writeAuditBundle(dir, bundle);
  console.log(`wrote ${dir}/: ${bundle.payments.length} payments in ${bundle.batches.length} transaction(s), all verified onchain`);
  console.log("It discloses this pay run's transactions only. Share it with your accountant; it holds no wallet keys.");
}

async function verifyAudit(args: string[]) {
  const { values } = parseArgs({ args, options: { dir: { type: "string" } } });
  if (!values.dir) throw new Error(USAGE);
  await initializePoseidon();
  const client = await createSprClient(clientConfigFromEnv());
  const check = await verifyAuditBundle(values.dir, client);
  if (check.manifest.cluster !== cluster) throw new Error(`bundle is for ${check.manifest.cluster}; ZOLANA_NETWORK is ${cluster}`);
  console.log(
    `ok: ${check.payments} payments, ${ui(check.total, check.manifest.decimals)} total, ` +
      `${check.manifest.batches} transaction(s) on ${check.manifest.cluster}; every row matches a verified onchain output`,
  );
}

async function payslips(args: string[]) {
  const { values } = parseArgs({ args, options: { keypair: { type: "string" } } });
  if (!values.keypair) throw new Error(USAGE);
  const session = await openSession(values.keypair);
  const slips = await listPayslips(session);
  if (slips.length === 0) console.log("no incoming payments yet");
  for (const p of slips) {
    console.log(`${p.signature}  slot ${p.slot}  ${formatAmount(BigInt(p.amount), p.asset)}${p.memo ? `  "${p.memo}"` : ""}`);
  }
}

async function prove(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      keypair: { type: "string" },
      signature: { type: "string" },
      "output-slot": { type: "string" },
      "verifier-url": { type: "string" },
    },
  });
  if (!values.keypair || !values.signature) throw new Error(USAGE);
  const session = await openSession(values.keypair);
  const link = await provePayslip(
    session,
    values.signature as Signature,
    cluster,
    values["output-slot"] === undefined ? undefined : Number(values["output-slot"]),
  );
  console.log(link);
  if (values["verifier-url"]) console.log(`${values["verifier-url"].replace(/#.*$/, "")}#${link}`);
  console.error("This proves your output only. It reveals nothing about anyone else paid in the same transaction.");
}

async function verifyProof(args: string[]) {
  const link = args[0];
  if (!link) throw new Error(USAGE);
  await initializePoseidon();
  const client = await createSprClient(clientConfigFromEnv());
  const c = await checkProof(client, link);
  if (c.cluster !== cluster) throw new Error(`proof is for ${c.cluster}; ZOLANA_NETWORK is ${cluster}`);
  const memo = decodeMemo(c.memo);
  console.log(`ok: ${formatAmount(c.amount, c.mint)} paid to ${c.owner}`);
  console.log(`  transaction ${c.signature} (slot ${c.slot}, output ${c.outputSlot})`);
  if (memo !== undefined) console.log(`  memo "${memo}"`);
  if (c.feePayer !== undefined) console.log(`  fee paid by ${c.feePayer}`);
  console.log(
    c.registered
      ? "  the payee's registry record matches this proof's keys"
      : "  note: the payee's current registry record does not carry this proof's viewing key",
  );
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "plan") await plan(rest);
  else if (cmd === "run") await run(rest);
  else if (cmd === "status") status(rest);
  else if (cmd === "split") await split(rest);
  else if (cmd === "audit") await audit(rest);
  else if (cmd === "verify-audit") await verifyAudit(rest);
  else if (cmd === "payslips") await payslips(rest);
  else if (cmd === "prove") await prove(rest);
  else if (cmd === "verify-proof") await verifyProof(rest);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
