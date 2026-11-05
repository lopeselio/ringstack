# leakscan

Measures how linkable the shielded pool's public side is, and warns you before a withdrawal that would link back to you.

Deposits into the pool and withdrawals out of it are public: anyone can see the address and the amount. Payments inside the pool are not. leakscan reads those public deposits and withdrawals from the pool's transactions over ordinary RPC and scores each withdrawal on three signals:

| Signal | Meaning |
|---|---|
| Unique amount | Exactly one deposit of the same amount in the previous 7 days, so the amount alone points to it |
| Round trip | The withdrawal goes to an address that deposited into the pool |
| Reused recipient | The address already received a withdrawal, which ties the two together |

The published output is **aggregate only**: counts and distributions, with no addresses and no transaction signatures. The [pool leak report](https://lopeselio.github.io/ringstack/leaks/) is built from it and rescanned daily.

## CLI

```bash
# Fetch new deposits and withdrawals into a local cache (it holds addresses: keep it local)
ZOLANA_NETWORK=devnet pnpm --filter @ringstack/leakscan leakscan scan --days 7

# Write aggregate stats
pnpm --filter @ringstack/leakscan leakscan stats --out stats.json

# Before withdrawing: check a planned withdrawal against your own deposits
pnpm --filter @ringstack/leakscan leakscan advise \
  --amount 1.2 --recipient <address> --mine <your deposit address>,<another>
```

`scan` is incremental: it stops at the newest transaction it already has, so daily runs only fetch the day's activity. A first 3-day devnet scan examined about 15,000 transactions in 8 minutes. `advise` exits with code 1 when the risk is high, and runs entirely on your machine, so your addresses never leave it.

## Library

```ts
import { adviseWithdrawal, analyze, classify, httpRpc, scan } from "@ringstack/leakscan";

const advice = adviseWithdrawal(events, {
  amount: 1_200_000_000n,
  recipient: "…",
  myDepositAddresses: ["…"],
});
// { risk: "high", warnings: [{ code: "UNIQUE_AMOUNT", message: "…" }], suggestions: ["…"] }
```

`classify` turns one `getTransaction` result into a public event: a deposit when the pool's SOL vault balance rises (attributed to the signer that paid it), or a withdrawal when it falls (attributed to the account credited with exactly that amount). Private transfers and merges leave the vault untouched and produce no event.

## Limits

- **SOL only for now.** SPL token deposits and withdrawals move token vaults instead and are not counted yet.
- **"Linked" is not proof.** It means a public signal connects two events, not that they share an owner. A determined observer has more signals than these three, such as timing correlation, fee payers and off-chain data, so the report understates what is possible.
- **Devnet activity is mostly tests**, including this project's own CI, so the numbers demonstrate the method rather than describe real users.
