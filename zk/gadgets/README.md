# zk-gadgets

Building blocks for SPP ZK programs written in upstream's circuit DSL ([`spr-program`](https://crates.io/crates/spr-program) 0.8). The DSL already constrains UTXO hashing, ownership, conservation and range checks, so nothing here rebuilds those. This crate is the layer above. The [Z0 findings](../../docs/spikes/z0-zk-dsl.md) explain why the plan looks like this.

## Gadgets

| Module | Feature | What it proves | Constraints |
|---|---|---|---:|
| `threshold` | `circuit` | At least M distinct approvers from a committed set signed: every signer is an approver, none counted twice, M is not zero | 77 (5 approvers, 3 signer slots) |
| `allowlist` | `circuit` | An identity is a member of a set committed as a Poseidon Merkle root, at an index range-checked to the tree's depth | 1,220 (16 members) |
| `timelock` | none | The program's half: `is_unlocked(now, unlock)` and `is_before(now, deadline)` on the clock's `i64` | n/a (onchain, no circuit) |

Counts are measured and pinned in the tests, so a change in cost shows up in review. For scale, upstream's timelock escrow circuit is 14,880.

### The binding pattern

Most of what goes wrong in a ZK program is a term the circuit and the program disagree on. An unlock time, an approver set or an allowlist root lives in the UTXO's data, and the program enforces it through a public input. The circuit's whole job for that term is one line:

```rust
public.unlock.assert_equal(&terms.unlock, "the unlock time is the committed one")?;
```

There is no gadget for that line, because `assert_equal` already is one. What matters is that every enforced term has the line, a named rule and a negative test. `tests/terms.rs` shows what a prover gets away with without it.

### Contracts

Each gadget states what its caller must do; the tests pin them.

- **`threshold`**: bind the approver set and threshold to committed terms, for example by reading them from the `DataUtxo` being spent. The harness found that the gadget alone leaves unused approver slots unconstrained: once a signer matches one approver, the other slots affect no constraint. A test pins that finding (the gadget alone has a free variable) and the fix (binding the set to a commitment: 450 constraints, none free). The program must fill the public signer slots only from accounts that signed (`solana_owner_identity` of each), zero for an empty slot.
- **`allowlist`**: the root must be a committed term or a public input the program checks. `Allowlist` builds the tree natively with the same `poseidon` gadget evaluated on constants, so a client's roots and paths match the circuit's by construction.
- **`timelock`**: the time must be bound in the circuit (the pattern above) *and* checked by the program. `is_unlocked` is strict and treats a negative clock as locked, the same as upstream's escrow.

## The harness

A circuit can look right and still be unsound. Three ways that happens, and the check that catches each:

| Failure | What goes wrong | Check |
|---|---|---|
| A check that only runs natively | The client refuses bad input, but no constraint was added, so a malicious prover skips the check and the verifier never knows | `assert_refuses` requires the R1CS built from a bad input to be unsatisfiable, not only the native run to fail |
| A missing bound | The gadget accepts too much, like a square root check with no upper bound that passes any smaller root | `assert_refuses` per rule: a negative case for every rule, which must fail with exactly that rule's name |
| A free private variable | A private input no constraint pins down, so the prover can set it to anything | `assert_no_free_variables` perturbs each private variable and reports any the constraints don't notice |

`assert_accepts` passes a valid input natively and in R1CS and returns the constraint count, so tests pin it and a change in cost shows up in review. `assert_refused_by` covers a refusal that is not a named rule, such as `ValueTooLarge` from a range check.

A negative case only counts if the constraints refused it. The harness reports whether the R1CS for an input was satisfied, unsatisfied, or could not be generated at all. It fails a negative case that only reached the last: there, the constraints were never checked.

```rust
use ringstack_zk_gadgets::harness::{assert_accepts, assert_no_free_variables, assert_refuses};

let ok = MyCircuit { amount: 5, limit: 10 };
assert_no_free_variables(&ok);
assert_eq!(assert_accepts(&ok), MY_CIRCUIT_CONSTRAINTS); // pinned, so a cost change shows in review
assert_refuses(&MyCircuit { amount: 11, limit: 10 }, "the amount is within the limit");
```

One blind spot: declaring a typed input (`u64`, `bool`, ...) range-checks it, and the free-variable check counts that as a constraint, so an integer input nothing else uses still looks pinned. Negative cases have to cover what that check cannot see. A test pins this down so it stays documented.

The harness is behind the `harness` feature, so programs built on these gadgets can hold their own circuits to the same bar. `tests/harness.rs` proves the harness itself: it passes a sound integer square root and catches a missing bound, a native-only check, a negative case that breaks a different rule, and an unused input.

## Property tests and Picus

`tests/properties.rs` runs each gadget on random inputs against a plain-Rust model of what it should accept: random approver sets, thresholds and signer slots for `threshold`, random member lists and claimed index/identity pairs (including indices past the tree) for `allowlist`. A case passes only if the native run and the R1CS agree with the model, through `harness::agreement`: a rejected case must leave the R1CS generated and unsatisfied, since one that never generated proves nothing about the constraints. `timelock` has no circuit; its property tests the program-side functions at clocks within a few seconds of the deadline, against wide-integer arithmetic. Mutation runs show they catch real bugs: dropping the duplicate-signer check fails on `[2, 2, 2]`, dropping the allowlist's index range check fails on index 23 in a 16-leaf tree, and making `is_unlocked` inclusive fails at the deadline itself. The counterexamples are kept in `properties.proptest-regressions`, so they run first every time.

For a formal check, `examples/picus_export.rs` writes each gadget in [Picus](https://github.com/Veridise/Picus)'s R1CS format (upstream's `export_picus_r1cs`: proof inputs are Picus inputs, every other wire must be uniquely determined, equality hints are unchecked), and [`zk/scripts/picus.sh`](../scripts/picus.sh) runs Picus on them (with `--all`, on the escrow's circuits too), reading run-picus's exit codes as upstream does and killing a run after 300 s. Natively it runs with Homebrew Racket and z3 (`PICUS_SOLVER=z3`). cvc5 with finite-field support comes in Picus's Docker image, which is x86 only: use `PICUS=zk/scripts/picus-docker.sh` on an x86 machine, or the `picus` workflow, whose inputs set the circuit limit, the per-query timeout, and which circuits run. So far Picus has decided neither gadget; see the [review request](../../docs/security/zk-review-request.md#evidence) for each run's settings and how it ended.

## Build and test

The workspace in [`zk/`](..) pins the same Rust toolchain as upstream (1.98.1); rustup installs it on first use. No Go and no local validator are needed.

```bash
cd zk
cargo test --release --features harness
cargo clippy --release --all-targets --features harness -- -D warnings
```

Release mode matters: arkworks is slow unoptimized.
