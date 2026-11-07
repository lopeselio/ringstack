# milestone-escrow

Track Z's reference program: a private milestone escrow on SPP, built from the [template](../template) and the [gadgets](../gadgets).

A funder locks a private balance for a payee. Each release pays one tranche when M of N approvers sign by a deadline; after the deadline the funder takes back what is left. Amounts, the payee and the approver set stay private. What is public is that a release happened and which approvers signed it, since they sign the Solana transaction.

| Instruction | Who signs | Circuit proves | Program checks |
|---|---|---|---|
| `create` | funder | the funder owns the inputs; amount and tranche are not zero; tranche ≤ amount; approvers are distinct; 1 ≤ M ≤ approvers listed | the funder's identity; the escrow's address; clock not past the (public) deadline |
| `release` | M approvers (anyone holding the escrow's viewing key builds it and pays the fee) | the escrow's committed terms; the payee and the escrow address match them; `threshold::assert_threshold` over the **committed** approvers; the escrow is not empty; pays `min(tranche, what is left)` | clock not past the deadline; signer identities computed from the accounts that signed |
| `refund` | funder | the funder and deadline match the terms | clock after the deadline (`timelock::is_unlocked`) |

A release re-creates the remainder under the same terms, so the escrow lives in one UTXO until the refund closes it. Releases (and creates) run while `now <= deadline`, the refund once `now > deadline`, so every second belongs to exactly one side; a unit test checks the two program checks are complements.

## Who can see and release the escrow

The escrow UTXO is encrypted to its own viewing key, generated for that escrow. The funder shares it with the payee over any channel, so either can find the escrow and build a release: approvers only sign. A funder who stops cooperating cannot block releases, and the payee can check the committed terms before work starts. The key decrypts only this escrow's UTXOs and spends nothing; spending still needs the approvers' signatures or, after the deadline, the funder's.

## Terms

`EscrowTerms` is the escrow UTXO's data, so its hash binds every field:

| Field | Why it is committed |
|---|---|
| `funder` | Who may refund, and whose authority PDA owns the escrow |
| `escrow_address` | The escrow's own shielded address (PDA plus the escrow's viewing key). A release must re-create the remainder there, so whoever builds a release cannot encrypt it to another key and hide it from the funder, which would block the refund |
| `payee` | The payee's address hash, owner *and* viewing key, so a payout cannot be redirected or encrypted to someone else |
| `approvers`, `threshold` | The approval rule. Taking them from the terms is the `threshold` gadget's contract: on its own the gadget leaves unused approver slots unconstrained |
| `tranche`, `deadline` | Paid per release (the last one pays what is left); releases close and the refund opens at the deadline, which create takes as a public input so the program can refuse one already past |

The approvers' identities are `solana_owner_identity` of each approver's Solana address. At release, the program fills the public signer slots in account order from the transaction's signers, so the client must list the approvers in its proof in the same order as their signer accounts (`approverSlots`).

## Costs

| Circuit | Constraints |
|---|---:|
| create | 16,279 |
| release | 11,813 |
| refund | 6,121 |

For comparison, the template's lock and release are 14,880 and 5,638. Release carries the threshold check, the payee and address checks, and a continuing escrow output.

## Tests

```bash
cd zk
cargo test --release -p milestone-escrow --features harness
```

The circuit tests prove each instruction with the committed keys and verify it as the program does. A release proof is refused when the program saw fewer signers, the same signers in another order, or a later deadline. Every circuit rule has a negative case through the [harness](../gadgets#the-harness), including a signer outside the set, one counted twice, too few signers, a redirected payee, a remainder re-encrypted to another key, and a release from an empty escrow. 700 escrowed at 300 a tranche pays 300, 300, then 100.

## Build, deploy, run on devnet

The same steps as the [template](../template#build), with `-p milestone-escrow`. The keys in `keys/` come from a single-party setup; see the [template's notes](../template#keys-and-what-they-promise) on what that does and does not promise.

```bash
cd zk && mkdir -p target/zk/milestone-escrow && cp milestone-escrow/keys/* target/zk/milestone-escrow/
zolana build-zk-program -p milestone-escrow --single-threaded --wasm-target nodejs
cd .. && solana program deploy zk/target/deploy/milestone_escrow.so \
  --program-id .devnet/milestone-escrow-program.json \
  --keypair .devnet/funder.json --upgrade-authority .devnet/funder.json -u devnet

ZOLANA_NETWORK=devnet ZOLANA_FUNDER_KEYPAIR=.devnet/funder.json \
  pnpm --filter @ringstack/milestone-escrow-client e2e
```

To upgrade a deployed program to a larger binary, extend its account first; the loader refuses an extension under 10,240 bytes:

```bash
solana program extend <PROGRAM_ID> 10240 --keypair .devnet/funder.json -u devnet
```

This repo's deployment is `2XdkS7kQQcuCXQBhQv634B8PhDqFbpTPecHqMavwtMBR`. The e2e passed against it on 2026-11-07 in about 3 minutes 25 seconds, most of it waiting for the deadline:

```
an escrow that is already expired → refused onchain (9006)
created: 9000000 escrowed, 3000000 per milestone, 2 of 3 approvers
release 1 (A, C) → payee has 3000000, 6000000 still escrowed
a proof for A and B signed by A alone → refused onchain (9000)
a refund before the deadline → refused onchain (9005)
release 2 (B, C), sent by the payee → payee has 6000000, 3000000 still escrowed
a release after the deadline → refused onchain (9006)
refund → funder has 6000000 back in the pool; no escrow open
```

## Limits

- Sharing the escrow's viewing key with the payee is the client's job; the program does not carry it. Anyone else given the key can see the escrow's terms and balance.
- After the last tranche, the escrow continues as a zero-value UTXO until the refund closes it; a release from it is refused.
- Three approver slots, fixed by `APPROVERS`. More slots cost more constraints in create and release.
- Not audited. The keys are a single-party setup. Devnet only.
