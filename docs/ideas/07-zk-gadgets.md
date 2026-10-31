# 7. zk-gadgets: circuit library + template for SPP ZK programs

**Status:** Selected (hard pick) · **Type:** ZK program infrastructure (Go/gnark + Rust/Pinocchio)

## Problem

"ZK Solana programs" are how Helius Privacy becomes programmable (private escrow, swaps, lending, staking). Writing one today means copying `zolana-examples/escrow-program` and hand-rolling:

1. gnark circuits (Go) that re-implement UTXO hashing, ownership, and conservation checks next to app logic,
2. key setup (`prover/src/bin/setup.rs`) and verifying keys compiled into the program,
3. a Rust prover crate + SDK instruction builders,
4. a Pinocchio program that verifies the proof and CPIs into SPP.

Every team repeats this, and mistakes are dangerous (unconstrained witnesses, missing range checks).

## Solution

### A. `gadgets/` (gnark, Go): audited-style reusable constraints

| Gadget | Purpose |
|---|---|
| `utxo` | Poseidon UTXO commitment matching the zolana spec (domain, owner, asset, amount, blinding, program/policy data) |
| `ownership` | Prove a UTXO is owned by a PDA / owner_hash |
| `conservation` | Sum(inputs) == Sum(outputs) per asset |
| `range` | u64 range checks, `a <= b`, `a < b` |
| `timelock` | Compare against a public slot/timestamp input |
| `threshold` | M-of-N approvals (public keys hashed into public input) |
| `merkle_allowlist` | Membership proof against a public Merkle root |
| `terms` | Commit to escrow terms in `program_data` and bind them in-circuit |

Each gadget has: unit tests, negative tests (proofs that **must** fail), and constraint counts.

### B. `template/`: `cargo generate`-style starter

- Pinocchio program skeleton: proof verification + SPP CPI + PDA escrow authority.
- Circuit `main.go` composing gadgets.
- Setup binary producing proving/verifying keys (marked insecure for dev; a docs page covers the ceremony for production).
- Rust prover + TS/Rust SDK instruction builders.
- Localnet test harness using `zolana dev start`.

### C. Reference programs built on the gadgets
1. **Milestone escrow** (timelock + threshold): proves the library is enough for real apps. Overlaps with [idea 8](08-sealed-bid-milestone-escrow.md).
2. Port the upstream **timelock escrow** onto the gadgets and diff constraint counts against the original.

## Helius primitives used

SPP CPI, PDA-owned UTXOs, `program_data`, UTXO commitment scheme, Groth16 verification onchain, localnet stack.

## MVP

1. Reproduce the upstream escrow circuit; extract `utxo` + `conservation` gadgets and keep its tests passing.
2. Add `range`, `timelock`, `threshold`, each with negative tests.
3. Template that compiles and runs a no-op-plus-timelock program on localnet.
4. Milestone escrow reference program.

## Risks / open questions

- **Spec stability:** UTXO hashing and SPP CPI interfaces may change between alphas (v0.5 → v0.6 already changed program IDs). Pin a tag and track releases.
- **Security:** circuits are easy to under-constrain. Plan for fuzzing/property tests and an external review before anyone uses it with real funds. Explore `qedgen`/formal specs.
- Verifier compute cost on Solana per extra constraint set (benchmark against `escrow-program/BENCHMARK.md`).
- Whether SPP expects ZK programs to supply their own proof *and* an SPP proof (two proofs per tx) or whether these can be combined.
- Licensing: keep compatible with Apache-2.0 upstream.
