//! The binding pattern: a term committed in a UTXO's data, exposed as a public
//! input the program enforces (here an unlock time, checked with
//! `timelock::is_unlocked`). No gadget, one line with a named rule; this test
//! is what makes the line non-optional.

use ringstack_zk_gadgets::{
    harness::{assert_accepts, assert_no_free_variables, assert_refuses},
    timelock::is_unlocked,
};
use spr_program::{
    CircuitError,
    circuit::{Assert, Circuit},
    conversion::ProofInput,
};

const UNLOCK_IS_COMMITTED: &str = "the unlock time is the committed one";

/// `committed` stands for a term decoded from the UTXO's data, `public_unlock`
/// for the public input the program checks against its clock.
#[derive(Clone, Copy, Debug, ProofInput)]
struct Release {
    committed: u64,
    public_unlock: u64,
}

impl Circuit for ReleaseCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        self.public_unlock
            .assert_equal(&self.committed, UNLOCK_IS_COMMITTED)
    }
}

/// The same circuit without the binding line.
#[derive(Clone, Copy, Debug, ProofInput)]
struct UnboundRelease {
    committed: u64,
    public_unlock: u64,
}

impl Circuit for UnboundReleaseCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        Ok(())
    }
}

#[test]
fn the_public_time_must_be_the_committed_one() {
    let ok = Release {
        committed: 1_700_000_000,
        public_unlock: 1_700_000_000,
    };
    assert_no_free_variables(&ok);
    // Almost all of it is the range checks on the two u64 inputs; the
    // binding itself is one constraint.
    assert_eq!(assert_accepts(&ok), 131);
    // A prover claiming an earlier unlock, which the program's clock would accept.
    let early = Release {
        committed: 1_700_000_000,
        public_unlock: 1,
    };
    assert!(is_unlocked(1_000, early.public_unlock));
    assert_refuses(&early, UNLOCK_IS_COMMITTED);
}

#[test]
#[should_panic(expected = "an invalid input was accepted")]
fn without_the_line_any_time_passes() {
    assert_refuses(
        &UnboundRelease {
            committed: 1_700_000_000,
            public_unlock: 1,
        },
        UNLOCK_IS_COMMITTED,
    );
}
