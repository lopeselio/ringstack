/**
 * Audit bundles: selective disclosure of exactly one pay run, for an
 * accountant or auditor.
 *
 *   audit-<planId>/
 *     manifest.json   plan identity, totals, sha256 of every other file
 *     batches.json    per batch: signature, slot, receipt (ringrcpt1:… = that tx's viewing key)
 *     payments.csv    one row per payee, matched to an onchain-verified output
 *     README.txt      how to check it
 *
 * The bundle discloses only the pay run's transactions (each receipt opens one
 * transaction), including the treasury's change outputs. It holds no wallet keys.
 * `verifyAuditBundle` needs nothing but the bundle and network access.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { decodeMemo } from "@ringstack/core/memo";
import { decodeReceipt, encodeReceipt, type Cluster } from "@ringstack/core/receipt";
import {
  fetchShieldedTransaction,
  issueReceipt,
  openReceipt,
  type ShieldedTransactionReader,
} from "@ringstack/core/receipt-open";
import { resolveRegisteredAddress } from "@heliuslabs/zolana/wallet";
import type { RingSession } from "@ringstack/core";
import type { ShieldedAddress } from "@heliuslabs/zolana";
import { address, type Signature } from "@solana/kit";

import { parseCsvRecords } from "./csv.ts";
import type { Plan, PlanPayment } from "./plan.ts";
import type { RunState } from "./state.ts";

export const AUDIT_VERSION = 1;

export interface AuditBatch {
  readonly id: string;
  readonly signature: string;
  readonly slot: string;
  /** `ringrcpt1:…`: decrypts this one transaction. */
  readonly receipt: string;
}

export interface AuditPayment {
  readonly line: number;
  readonly batch: string;
  readonly recipient: string;
  readonly amountUi: string;
  readonly amount: string;
  readonly memo: string;
  readonly signature: string;
  /** Output position within the transaction. */
  readonly outputSlot: number;
  readonly commitment: "verified";
}

export interface AuditManifest {
  readonly version: number;
  readonly planId: string;
  readonly cluster: Cluster;
  readonly treasury: string;
  readonly mint: string;
  readonly decimals: number;
  readonly payees: number;
  readonly total: string;
  readonly batches: number;
  readonly createdAt: string;
  /** sha256 hex of each other file in the bundle. */
  readonly files: Record<string, string>;
}

export interface Audit {
  readonly manifest: Omit<AuditManifest, "files">;
  readonly batches: readonly AuditBatch[];
  readonly payments: readonly AuditPayment[];
}

type Client = ShieldedTransactionReader & Parameters<typeof resolveRegisteredAddress>[0]["rpc"];

export class AuditError extends Error {
  override name = "AuditError";
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Open one batch transaction with its receipt and match every expected
 * payment to an output that is commitment-verified, same amount, same memo.
 * Throws `AuditError` listing every mismatch.
 */
export async function matchBatch(
  client: Client,
  receiptLink: string,
  expected: readonly Pick<PlanPayment, "line" | "recipient" | "amount" | "memo">[],
): Promise<{ signature: string; slot: bigint; matched: { line: number; outputSlot: number }[] }> {
  const receipt = decodeReceipt(receiptLink);
  const tx = await fetchShieldedTransaction(client, receipt.signature);
  const recipients = new Map<string, ShieldedAddress>();
  for (const p of expected) {
    if (recipients.has(p.recipient)) continue;
    const resolved = await resolveRegisteredAddress({ rpc: client, owner: address(p.recipient) });
    if (resolved === undefined) throw new AuditError(`${p.recipient} is no longer registered; cannot check its output`);
    recipients.set(p.recipient, resolved.address);
  }
  const opened = openReceipt(receipt, tx, { knownAddresses: [...recipients.values()] });

  const problems: string[] = [];
  const matched: { line: number; outputSlot: number }[] = [];
  const used = new Set<number>();
  for (const p of expected) {
    const key = recipients.get(p.recipient)!.viewingPublicKey.toBytes();
    const out = opened.outputs.find((o) => !used.has(o.slot) && eq(o.recipientViewingKey.toBytes(), key));
    if (out === undefined) {
      problems.push(`line ${p.line}: no output to ${p.recipient} in ${receipt.signature}`);
      continue;
    }
    used.add(out.slot);
    if (out.commitment !== "verified") problems.push(`line ${p.line}: output ${out.slot} commitment ${out.commitment}`);
    if (out.amount.toString() !== p.amount) problems.push(`line ${p.line}: paid ${out.amount}, expected ${p.amount}`);
    const memo = decodeMemo(out.memo) ?? "";
    if (memo !== (p.memo ?? "")) problems.push(`line ${p.line}: memo ${JSON.stringify(memo)}, expected ${JSON.stringify(p.memo ?? "")}`);
    matched.push({ line: p.line, outputSlot: out.slot });
  }
  if (problems.length > 0) throw new AuditError(problems.join("\n"));
  return { signature: receipt.signature, slot: opened.slot, matched };
}

/** Issue a receipt per batch with the treasury's keys and verify every payment against the chain. */
export async function buildAudit(session: RingSession, plan: Plan, state: RunState, now = new Date()): Promise<Audit> {
  if (plan.treasury !== session.owner) throw new AuditError(`plan is for treasury ${plan.treasury}, not ${session.owner}`);
  const unconfirmed = plan.batches.filter((b) => state.batches[b.id]?.status !== "confirmed").map((b) => b.id);
  if (unconfirmed.length > 0) throw new AuditError(`batches not confirmed yet: ${unconfirmed.join(", ")}; finish the run first`);

  const batches: AuditBatch[] = [];
  const payments: AuditPayment[] = [];
  for (const b of plan.batches) {
    const signature = state.batches[b.id]!.signature as Signature;
    const tx = await fetchShieldedTransaction(session.client, signature);
    const receipt = encodeReceipt(issueReceipt(session.keypair, tx, plan.cluster));
    const { slot, matched } = await matchBatch(session.client, receipt, b.payments);
    batches.push({ id: b.id, signature, slot: slot.toString(), receipt });
    for (const p of b.payments) {
      payments.push({
        line: p.line,
        batch: b.id,
        recipient: p.recipient,
        amountUi: p.amountUi,
        amount: p.amount,
        memo: p.memo ?? "",
        signature,
        outputSlot: matched.find((m) => m.line === p.line)!.outputSlot,
        commitment: "verified",
      });
    }
  }
  payments.sort((a, b) => a.line - b.line);
  return {
    manifest: {
      version: AUDIT_VERSION,
      planId: plan.planId,
      cluster: plan.cluster,
      treasury: plan.treasury,
      mint: plan.mint,
      decimals: plan.decimals,
      payees: plan.totals.payees,
      total: plan.totals.amount,
      batches: plan.batches.length,
      createdAt: now.toISOString(),
    },
    batches,
    payments,
  };
}

// --- files -------------------------------------------------------------------

const COLUMNS = ["line", "batch", "recipient", "amount_ui", "amount", "memo", "signature", "output_slot", "commitment"];

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function paymentsCsv(payments: readonly AuditPayment[]): string {
  const rows = payments.map((p) =>
    [p.line, p.batch, p.recipient, p.amountUi, p.amount, p.memo, p.signature, p.outputSlot, p.commitment]
      .map(csvField)
      .join(","),
  );
  return `${[COLUMNS.join(","), ...rows].join("\n")}\n`;
}

const README = `Payroll audit bundle

This folder discloses exactly one pay run. Each receipt in batches.json opens
one transaction (amounts, memos and the treasury's change); nothing else about
the treasury or the payees' wallets can be decrypted with it.

Files
  manifest.json  plan id, cluster, totals, sha256 of the other files
  batches.json   one entry per transaction, with its receipt
  payments.csv   one row per payee, matched to an onchain-verified output

Check it (no wallet keys needed, only network access):
  pnpm --filter @ringstack/payroll payroll verify-audit --dir <this folder>

This verifies the file hashes, decrypts each transaction with its receipt,
looks every payee up in the user registry, and requires each row to match an
output whose commitment is verified, with the same amount and memo.
Single receipts can also be opened in the RingPay verifier page.
`;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Write the bundle to `dir` (created if missing). Returns the manifest written. */
export function writeAuditBundle(dir: string, audit: Audit): AuditManifest {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {
    "batches.json": `${JSON.stringify(audit.batches, null, 2)}\n`,
    "payments.csv": paymentsCsv(audit.payments),
    "README.txt": README,
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, { mode: 0o600 });
  const manifest: AuditManifest = {
    ...audit.manifest,
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha256(b)])),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function parsePaymentsCsv(text: string): AuditPayment[] {
  const records = parseCsvRecords(text);
  const header = records.shift();
  if (header?.fields.join(",") !== COLUMNS.join(",")) throw new AuditError("payments.csv has an unexpected header");
  return records.map(({ line, fields }) => {
    if (fields.length !== COLUMNS.length) throw new AuditError(`payments.csv line ${line}: expected ${COLUMNS.length} fields`);
    const [l, batch, recipient, amountUi, amount, memo, signature, outputSlot, commitment] = fields as [
      string, string, string, string, string, string, string, string, string,
    ];
    return {
      line: Number(l),
      batch,
      recipient,
      amountUi,
      amount,
      memo,
      signature,
      outputSlot: Number(outputSlot),
      commitment: commitment as "verified",
    };
  });
}

export interface AuditCheck {
  readonly manifest: AuditManifest;
  readonly payments: number;
  readonly total: bigint;
}

/** Everything an auditor runs: file integrity, then every row against the chain. */
export async function verifyAuditBundle(dir: string, client: Client): Promise<AuditCheck> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as AuditManifest;
  if (manifest.version !== AUDIT_VERSION) throw new AuditError(`unsupported audit version ${manifest.version}`);
  const problems: string[] = [];
  const texts: Record<string, string> = {};
  for (const [name, digest] of Object.entries(manifest.files)) {
    texts[name] = readFileSync(join(dir, name), "utf8");
    if (sha256(texts[name]) !== digest) problems.push(`${name} does not match its hash in manifest.json`);
  }
  if (problems.length > 0) throw new AuditError(problems.join("\n"));

  const batches = JSON.parse(texts["batches.json"]!) as AuditBatch[];
  const payments = parsePaymentsCsv(texts["payments.csv"]!);
  for (const b of batches) {
    const rows = payments.filter((p) => p.batch === b.id);
    if (rows.some((p) => p.signature !== b.signature)) problems.push(`${b.id}: rows name a different signature`);
    try {
      const { signature, matched } = await matchBatch(
        client,
        b.receipt,
        rows.map((p) => ({ line: p.line, recipient: p.recipient, amount: p.amount, ...(p.memo ? { memo: p.memo } : {}) })),
      );
      if (signature !== b.signature) problems.push(`${b.id}: receipt is for ${signature}, not ${b.signature}`);
      for (const m of matched) {
        const row = rows.find((p) => p.line === m.line)!;
        if (row.outputSlot !== m.outputSlot) problems.push(`line ${m.line}: output slot ${m.outputSlot}, row says ${row.outputSlot}`);
      }
    } catch (e) {
      problems.push(`${b.id}: ${(e as Error).message}`);
    }
  }
  const total = payments.reduce((s, p) => s + BigInt(p.amount), 0n);
  if (payments.length !== manifest.payees) problems.push(`${payments.length} rows, manifest says ${manifest.payees}`);
  if (total.toString() !== manifest.total) problems.push(`rows total ${total}, manifest says ${manifest.total}`);
  if (batches.length !== manifest.batches) problems.push(`${batches.length} batches, manifest says ${manifest.batches}`);
  if (problems.length > 0) throw new AuditError(problems.join("\n"));
  return { manifest, payments: payments.length, total };
}
