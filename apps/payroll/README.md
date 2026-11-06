# Private payroll

Pay a list of people privately from a treasury: amounts and memos are encrypted, and up to 15 payees share one transaction.

```
payroll.csv ──plan──▶ plan.json (review) ──run──▶ plan.state.json ──audit──▶ audit-<planId>/ (for the accountant)
```

## Use

```bash
export ZOLANA_NETWORK=devnet              # API_KEY in the root .env (see docs/devnet.md)

pnpm --filter @ringstack/payroll payroll plan  --csv payroll.csv --keypair treasury.json --out plan.json
pnpm --filter @ringstack/payroll payroll split --keypair treasury.json --parts 2   # optional, for concurrency
pnpm --filter @ringstack/payroll payroll run   --plan plan.json --keypair treasury.json --concurrency 2
pnpm --filter @ringstack/payroll payroll status --plan plan.json
pnpm --filter @ringstack/payroll payroll audit  --plan plan.json --keypair treasury.json   # after the run
pnpm --filter @ringstack/payroll payroll verify-audit --dir audit-<planId>               # what the accountant runs

# Payees (each from their own wallet)
pnpm --filter @ringstack/payroll payroll payslips --keypair employee.json                # incoming payments
pnpm --filter @ringstack/payroll payroll prove --keypair employee.json --signature <sig> # → ringproof1:…
pnpm --filter @ringstack/payroll payroll verify-proof ringproof1:…                       # anyone, no keys
```

`payroll.csv`:

```csv
address,amount,memo
GNhaRndM8JGXUhsfgWXGR7XdcWnioBbuZueyaJ2zsYsD,1250.50,Payroll 2026-11
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU,980,
```

`amount` is in UI units of the plan's mint (`--mint`, SOL by default). `memo` is optional, up to 32 bytes, and is encrypted to the payee. RFC 4180 quoting, `#` comment lines and blank lines are fine.

## plan

- Validates every row, collecting all errors before failing.
- Checks each payee in the user registry. **Unregistered payees are skipped and listed**: paying them would be a public withdrawal.
- Batches in CSV order, up to 15 payees per transaction (`--max-per-batch`). The same payee never appears twice in one batch.
- Pre-flight notes: treasury balance shortfall, and whether batches can run concurrently (one UTXO per batch; suggests `split`).
- `plan.json` carries a `planId` hash of its contents. `run` refuses a plan that was edited afterwards.

## run

- **Concurrent batches.** Each round gives every pending batch (up to `--concurrency`) its own disjoint treasury UTXOs and sends them in parallel. Change from one round funds the next, so a single-UTXO treasury still finishes, one batch at a time.
- **Resume without double payment.** Before a batch is sent, its signature and blockhash expiry are written to `plan.state.json`. On restart a `submitted` batch is checked onchain:
  - landed → `confirmed`, never re-sent;
  - failed, or its blockhash expired without landing → back to `pending` and retried (it can never land now);
  - otherwise → wait until one of the above.
- `status` shows each batch's state and signature. Rerunning a finished plan does nothing.

## audit

Builds a bundle that discloses exactly one pay run, for an accountant or auditor:

| File | Contents |
|---|---|
| `manifest.json` | Plan id, cluster, treasury, mint, totals, and the SHA-256 of every other file |
| `batches.json` | One entry per transaction: signature, slot, and its receipt (`ringrcpt1:…`, that transaction's viewing key) |
| `payments.csv` | One row per payee: CSV line, batch, recipient, amount, memo, signature, output slot, `verified` |
| `README.txt` | How to check it |

- `audit` needs the treasury keypair (it derives each transaction's key) and refuses to run before every batch is confirmed. While building, it checks every payment against the chain.
- `verify-audit` needs **no keys**, only the bundle and network access. It checks the file hashes, decrypts each transaction with its receipt, looks every payee up in the user registry, and requires each row to match an output whose commitment is verified, with the same amount and memo. Editing a row is caught even if the manifest hash is updated to match.
- **What it discloses:** the pay run's transactions and nothing else: no wallet keys, no other treasury history. That includes the treasury's change outputs, which reveal how much the spent UTXOs held.
- **Limits:** recipients are matched through their *current* registry record, so a payee who later rotates their viewing key can no longer be matched. Individual receipts also open in the [verifier](../verifier).

## Per-payee proof

An employee proves their own pay from their own wallet, revealing nothing about co-workers paid in the same transaction ([spec](../../spec/payment-proof.md)):

- `payslips` lists the wallet's incoming payments (signature, amount, memo).
- `prove --signature <sig>` writes a `ringproof1:` link (277 characters). Add `--verifier-url` to get a link to the verifier page.
- `verify-proof <link>`, or the [verifier page](../verifier), checks it with no keys: the amount, asset and memo match the payee's onchain output, and the payee's registry record carries the proof's keys.

The proof discloses one X25519 shared secret that opens only that payee's output in that one transaction. Pointed at a co-worker's output it decrypts nothing, which the e2e checks.

| | Audit bundle | Per-payee proof |
|---|---|---|
| Made by | Treasury | Payee |
| Opens | Every output of the pay run | One output |
| For | Accountant, auditor | Landlord, bank, lender |

## Privacy notes

- Amounts and memos are encrypted. The treasury and the payees are visible as transaction participants, so observers can see *who* is on payroll, not *how much*.
- **One transaction key opens a whole batch.** That is why batch receipts live in the audit bundle (for someone entitled to see the whole run) rather than going to each payee. Payees prove their own pay with a per-payee proof instead.
- **Memos** travel as encrypted transaction messages, so payees receive plain UTXOs that any SDK wallet spends. A payee's wallet reads the memo from the transaction (`RingSession.receivedMemos`); wallets that ignore messages still get the funds, just not the memo.

## Check on devnet

```bash
ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json pnpm --filter @ringstack/payroll e2e
```

This covers 17 payees plus one unregistered, one payee paid twice, memos, a 2-UTXO treasury run with concurrency 2, a simulated crash after a batch lands (the rerun reconciles it from the saved signature), a saved attempt that expired (retried once), exact final balances for every payee, an audit bundle that verifies with no keys and catches a forged amount even when the manifest hash is updated to match, and a per-payee proof from a 15-payee batch that cannot open a co-worker's output.
