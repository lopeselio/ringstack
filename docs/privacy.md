# Privacy limits

What Helius Privacy hides with the default (confidential) ring, and what it does not. These apply to everything in this repo: RingPay, ringd, payroll and the checkout demo.

## Hidden

Amounts and assets of private transfers, memos, which output is change, and which earlier output a spend consumes (nullifiers do not link to commitments).

## Visible to anyone

- **Who transacts with whom.** The sender signs the transaction, and each recipient's output carries a view tag tied to their registered address. A shop address that only receives shop payments reveals "this payer bought here". A payroll run reveals who is on payroll, not how much. Hiding participants needs an anonymous custom ring.
- **Deposits and withdrawals.** Moving funds in or out of the pool is a public transfer with a public amount and address.
- **The user registry.** Which Solana addresses registered for private payments is public; so is a wallet's merge opt-in.
- **Fee payers.** Whoever pays a transaction's fee is public: for example, the fee payer ringd uses for auto-merges links those merges to its operator.
- **That a memo is present.** An output with a memo has a longer ciphertext than one without, so its presence (not its content) is visible.

## Visible to service operators

- **The indexer** (Helius, or whoever runs your Photon) sees which view tags and nullifiers a wallet or ringd polls for. Self-host Photon to avoid this.
- **The prover** sees private inputs inside its attested enclave (see [how the client reaches devnet](devnet.md#how-the-client-reaches-devnet)).
- **RPC providers** see the addresses and signatures you query, like any Solana app.

## Disclosures you make on purpose

- A **receipt** (`ringrcpt1:`) opens every output of one transaction, permanently.
- A **payment proof** (`ringproof1:`) opens one output, permanently.
- An **audit bundle** opens every transaction of one pay run.

## SDK caveat

Until [helius-labs/zolana#543](https://github.com/helius-labs/zolana/issues/543) is resolved, the SDK's built-in transfer, withdraw and merge skip UTXOs that carry a memo. `@ringstack/core`'s `RingSession` spends, withdraws (SOL) and merges them through the lower-level builders.
