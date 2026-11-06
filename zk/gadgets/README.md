# zk-gadgets

Building blocks for SPP ZK programs written in upstream's circuit DSL ([`spr-program`](https://crates.io/crates/spr-program) 0.8). The DSL already constrains UTXO hashing, ownership, conservation and range checks; this crate is the layer above: binding committed terms to what a program checks, timelocks, M-of-N approvals and allowlists. Those land in Z2; see the [roadmap](../../docs/roadmap.md) and the [Z0 findings](../../docs/spikes/z0-zk-dsl.md) for why the plan looks like this.

What is here now is the harness every gadget is tested with.

## The harness

A circuit can look right and still be unsound. Three ways that happens, and the check that catches each:

| Failure | What goes wrong | Check |
|---|---|---|
| A check that only runs natively | The client refuses bad input, but no constraint was added, so a malicious prover skips the check and the verifier never knows | `assert_refuses` requires the R1CS built from a bad input to be unsatisfiable, not only the native run to fail |
| A missing bound | The gadget accepts too much, like a square root check with no upper bound that passes any smaller root | `assert_refuses` per rule: a negative case for every rule, which must fail with exactly that rule's name |
| A free private variable | A private input no constraint pins down, so the prover can set it to anything | `assert_no_free_variables` perturbs each private variable and reports any the constraints don't notice |

`assert_accepts` passes a valid input natively and in R1CS and returns the constraint count, so tests pin it and a change in cost shows up in review.

```rust
use ringstack_zk_gadgets::harness::{assert_accepts, assert_no_free_variables, assert_refuses};

let ok = MyCircuit { amount: 5, limit: 10 };
assert_no_free_variables(&ok);
assert_eq!(assert_accepts(&ok), MY_CIRCUIT_CONSTRAINTS); // pinned, so a cost change shows in review
assert_refuses(&MyCircuit { amount: 11, limit: 10 }, "the amount is within the limit");
```

One blind spot: declaring a typed input (`u64`, `bool`, ...) range-checks it, and the free-variable check counts that as a constraint, so an integer input nothing else uses still looks pinned. Negative cases have to cover what that check cannot see. A test pins this down so it stays documented.

The harness is behind the `harness` feature, so programs built on these gadgets can hold their own circuits to the same bar. `tests/harness.rs` proves the harness itself: it passes a sound integer square root and catches a missing bound, a native-only check, a negative case that breaks a different rule, and an unused input.

## Build and test

The workspace in [`zk/`](..) pins the same Rust toolchain as upstream (1.98.1); rustup installs it on first use. No Go and no local validator are needed.

```bash
cd zk
cargo test --release --features harness
cargo clippy --release --all-targets --features harness -- -D warnings
```

Release mode matters: arkworks is slow unoptimized.
