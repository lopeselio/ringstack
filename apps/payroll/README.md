# Private payroll

Pay a list of people privately from a treasury: amounts and memos are encrypted, and up to 15 payees share one transaction.

```
payroll.csv ──plan──▶ plan.json (review) ──run──▶ batches confirmed, plan.state.json
```

## Use

```bash
export ZOLANA_NETWORK=localnet            # or devnet with API_KEY (see .env.example)

pnpm --filter @ringstack/payroll payroll plan  --csv payroll.csv --keypair treasury.json --out plan.json
pnpm --filter @ringstack/payroll payroll split --keypair treasury.json --parts 2   # optional, for concurrency
pnpm --filter @ringstack/payroll payroll run   --plan plan.json --keypair treasury.json --concurrency 2
pnpm --filter @ringstack/payroll payroll status --plan plan.json
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
- Pre-flight notes: treasury balance shortfall, whether batches can run concurrently (one UTXO per batch; suggests `split`), and the memo spendability caveat below.
- `plan.json` carries a `planId` hash of its contents. `run` refuses a plan that was edited afterwards.

## run

- **Concurrent batches.** Each round gives every pending batch (up to `--concurrency`) its own disjoint treasury UTXOs and sends them in parallel. Change from one round funds the next, so a single-UTXO treasury still finishes, one batch at a time.
- **Resume without double payment.** Before a batch is sent, its signature and blockhash expiry are written to `plan.state.json`. On restart a `submitted` batch is checked onchain:
  - landed → `confirmed`, never re-sent;
  - failed, or its blockhash expired without landing → back to `pending` and retried (it can never land now);
  - otherwise → wait until one of the above.
- `status` shows each batch's state and signature. Rerunning a finished plan does nothing.

## Privacy notes

- Amounts and memos are encrypted. The treasury and the payees are visible as transaction participants, so observers can see *who* is on payroll, not *how much*.
- **One transaction key opens a whole batch.** A RingPay-style receipt for a batch transaction would show every payee in it. Per-payee receipts therefore need a different design (next roadmap item).
- **Memo payments and SDK wallets:** until [helius-labs/zolana#543](https://github.com/helius-labs/zolana/issues/543) is fixed, the SDK's built-in transfer, withdraw and merge skip UTXOs that carry a memo. Payees need a wallet that spends them through the lower-level builder (such as `RingSession` in `@ringstack/core`). Leave `memo` empty if that is a problem.

## Check on localnet

```bash
./scripts/localnet.sh && pnpm --filter @ringstack/payroll e2e
```

This covers 17 payees plus one unregistered, one payee paid twice, memos, a 2-UTXO treasury run with concurrency 2, a simulated crash after a batch lands (the rerun reconciles it from the saved signature), a saved attempt that expired (retried once), and exact final balances for every payee.
