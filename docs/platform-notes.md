# Platform notes: Helius Privacy / Solana Rings

Research summary from the Helius Privacy docs (read 2026-10-31). Source of truth: <https://www.helius.dev/docs/privacy> and <https://github.com/helius-labs/zolana>.

## Model

- **Rings** are programmable shielded pools. Private balances are **UTXOs** committed in a state Merkle tree account; balances and amounts are encrypted onchain.
- **Solana Privacy Program (SPP)** verifies Groth16 proofs and executes every private state transition (nullify inputs, create outputs).
- Settlement is a single normal Solana transaction. No sidechain, no sequencer.
- Supported assets: SOL, SPL, Token-2022. Each mint needs an **SPL interface PDA** (escrow), created permissionlessly once; the first deposit can create it inline.

## Privacy levels

| | Asset | Amount | Sender | Recipient |
|---|---|---|---|---|
| Default Ring (permissionless, confidential) | private | private | public | public |
| Custom confidential Ring | private | private | public | public |
| Custom anonymous Ring (relayer submits) | private | private | private | private |

- Deposit from public balance: source, asset, amount **public**.
- Withdraw to public balance: destination, asset, amount **public**.
- Fiat on/off-ramp via a provider's private wallet keeps asset/amount private.
- Memos are encrypted (except on public deposits).

## Keys

Shielded keypair = Ed25519 signing key + X25519 viewing key + nullifier key.

- Derived deterministically: sign the fixed message `"TSPP/derive/v1"` (Solana offchain message v0), HKDF-SHA256 the signature into the nullifier secret (`TSPP/nf_key/ed25519/v1`, 31 B) and viewing secret (`TSPP/view_key/ed25519/x25519/v1`, 32 B).
- **The derivation signature is a master read secret.** Anyone holding it decrypts all history. Wallets must refuse third-party requests to sign it.
- `ShieldedAddress = (signing_pk, nullifier_pk, viewing_pk)`; one Solana address ↔ one shielded address.
- **User Registry program** stores the mapping in a PDA; anyone can check whether an address can receive privately (`isWalletRegistered`).

## Decryption & disclosure

- **Local decryption** (confidential rings only): wallet fetches encrypted outputs from the indexer and decrypts on device.
- **Delegated decryption**: a provider holds the viewing key, syncs for you, and can read everything. It is the only mode for anonymous rings.
- **Transaction viewing key**: the sender can disclose exactly one transaction. This is the basis for receipts (idea 1).
- **Auditor key** (Custom Rings): policy-scoped visibility, separate from delegated sync.

## UTXOs

```rust
struct Utxo {
    domain: u16,
    owner: [u8; 32],            // owner_hash from shielded address
    asset: Address,             // SOL = Address::default()
    amount: u64,
    blinding: [u8; 31],
    program_data: Option<Vec<u8>>,
    policy_data: Option<Vec<u8>>,
    policy_program_id: Option<Address>,
}
```

- Owner may be a keypair **or a PDA**, which is how ZK programs escrow private balances.
- Transfers use fixed **variants** (circuits): 1–49 inputs, 2/4/8/16 outputs (see the utxo concepts page for the matrix). The SDK selects ≤40 inputs, largest first; unused slots are filled with dummy UTXOs.
- **1-input → 16-output** variants exist, so one tx can pay ~15 recipients plus change (relevant to idea 4).
- **Merges** combine same-owner, same-asset UTXOs (up to 52 per merge) and **require no user signature**. They must be enabled at registration (`setMergeEncryption(PoseidonCtrV1)`).
- A balance split across UTXOs can be spent concurrently.

## Infra

- One Helius RPC URL serves Solana RPC + **Photon indexer** + **prover**.
- Indexer can be self-hosted permissionlessly.
- Prover: default is an **attested AWS Nitro enclave**, and the SDK pins a TEE policy (PCR measurements). Local proving is "coming soon" (upstream branch `feat/local-prover`).
- Localnet: `cargo install --git https://github.com/helius-labs/zolana --tag <tag> zolana-cli && zolana dev start` → RPC :8899, indexer :8784, prover :3001.
- Key read methods: `getShieldedTransactionsByTags` (by view tag, which is the sender pubkey in confidential rings), `getShieldedTransactionsBySignature`.

## Performance

- Confidential transfer (2-in/4-out): ~1,279 bytes, ~140k CU.
- One tree ≈ 86 transfers/block ≈ 215 TPS (shared write lock). More trees means more throughput.
- CPI depth limit of 5 applies: ZK program → Custom Ring → SPP.

## ZK programs

As of 0.8, upstream writes ZK programs in a Rust DSL ([`spr-program`](https://crates.io/crates/spr-program), arkworks Groth16): one `circuit` fn runs natively on the client and as R1CS in the prover, and `zolana build-zk-program` generates the keys and the verifier modules the program commits. The reference program is `sdk-tests/timelock-escrow` in `helius-labs/zolana`; [Z0](spikes/z0-zk-dsl.md) builds and runs it.

The older example repo `helius-labs/zolana-examples` still has `escrow-program` with gnark (Go) circuits and `swap-program`, a confidential maker/taker swap.

The program verifies its own proof, then CPIs `transact` into the pool, which verifies the pool proof; both commit to the same `private_tx_hash`. What upstream leaves to each team, multi-party patterns and the wiring around a program, is the gap idea 7 targets.

## SDKs & versions

- TS: `@heliuslabs/zolana` (+ `@solana/kit`). Rust: `zolana-client`, `zolana-interface`, `zolana-program`, `zolana-keypair`, `zolana-transaction`.
- **Version drift:** docs reference `v0.5.0-alpha` and SPP `sppU489D7A4U1exNo1oeMGZtLEofq3a6o2fR7UeoWB6`. The shielded-pool program is now **`ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW`**. Devnet runs **v0.8.0** (finalized ceremony keys, per-tree fees) and only accepts 0.8 clients. **Pin `@heliuslabs/zolana@0.8.0-alpha`** (upgraded from 0.6.0-alpha on 2026-11-05; see [devnet.md](devnet.md)).
- User Registry: the v0.6.0-alpha SDK uses **`regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ`**. The docs list `regyS5rkAcw2YzDJCmTwCTHs2s246FXxbmuRZ42u2PD`, an older deployment; both are deployed on devnet (checked 2026-11-05), and the SDK only talks to `regy3W…`.

## Upstream work in flight (avoid duplicating)

Branches on `zolana-examples`: `feat/sign-with-wallet-adapter`, `feat/local-prover`, `feat/private-klend`, `ananas-block/staking`, `ananas-block/dvp`, `jorrit/feat-min-multisig`, `sergei/private-wallet-node-starter`.

## Open questions

- Exact transaction viewing key format and how a third party verifies it against onchain commitments.
- Whether the indexer exposes a streaming/subscription API or only polling.
- Memo size limits for encrypted memos.
- Proving-key distribution and setup ceremony expectations for third-party ZK programs.
