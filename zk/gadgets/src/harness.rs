//! The checks every gadget in this crate is held to, exported so programs built
//! on the gadgets can hold their own circuits to the same bar.
//!
//! A circuit is easy to get wrong in ways a happy-path test never sees: a
//! check that holds when the client runs it natively but adds no constraint,
//! so a malicious prover skips it; a private input no constraint pins down; a
//! negative case that fails for some other reason than the rule under test.
//! Each helper here closes one of those gaps:
//!
//! - [`assert_accepts`]: a valid input passes natively and in R1CS, and
//!   returns the constraint count, so tests can pin it.
//! - [`assert_refuses`]: an invalid input fails natively with exactly the
//!   named rule, *and* the R1CS built from it is unsatisfiable.
//! - [`assert_no_free_variables`]: every private variable is pinned by some
//!   constraint, found by perturbing each one (`check_private_variables`).
//!   A typed input (`u64`, `bool`, ...) is range-checked when it is declared,
//!   and that check counts, so an integer input nothing else uses still looks
//!   pinned. Negative cases have to cover what this check cannot see.
//!
//! Modelled on the external gadget tests in `spr-program` 0.8.

use spr_program::{
    ProverError, ZkCircuit,
    circuit::{Circuit, ConstraintSystem},
    conversion::Allocator,
    testing::{FreeVariable, check_private_variables},
};

/// What refused an input: the error's name and the rule it broke, if any.
pub type Refusal = (&'static str, Option<&'static str>);

/// The name `check_constraints` reports for a broken rule.
pub const RULE_BROKEN: &str = "CircuitError.RuleBroken";

pub fn refusal(error: ProverError) -> Refusal {
    (error.name(), error.broken_rule())
}

/// Whether the R1CS alone accepts `inputs`: constraints generated from
/// variables, no native run. A native refusal returns before any constraint is
/// checked, so this is the only way to see that the constraints, which are all
/// a verifier relies on, refuse the input too.
pub fn r1cs_accepts<P: ZkCircuit>(inputs: &P) -> bool {
    let cs = ConstraintSystem::new_ref();
    let instance = match inputs.instantiate(&Allocator::R1cs(cs.clone())) {
        Ok(instance) => instance,
        Err(_) => return false,
    };
    match instance.circuit() {
        Ok(_) => cs.is_satisfied().expect("R1CS satisfaction"),
        Err(_) => false,
    }
}

/// A valid input: passes natively and in R1CS. Returns the constraint count.
#[track_caller]
pub fn assert_accepts<P: ZkCircuit>(inputs: &P) -> usize {
    let constraints = inputs
        .check_constraints()
        .unwrap_or_else(|error| panic!("a valid input was refused: {error}"));
    assert!(
        r1cs_accepts(inputs),
        "a valid input does not satisfy the R1CS"
    );
    constraints
}

/// An invalid input: refused natively by exactly `rule`, and unsatisfiable in
/// R1CS. A refusal by another rule fails the test, because it means the rule
/// under test was never reached.
#[track_caller]
pub fn assert_refuses<P: ZkCircuit>(inputs: &P, rule: &'static str) {
    match inputs.check_constraints() {
        Ok(_) => panic!("an invalid input was accepted; expected the rule {rule:?}"),
        Err(error) => assert_eq!(
            refusal(error),
            (RULE_BROKEN, Some(rule)),
            "refused for another reason than the rule under test"
        ),
    }
    assert!(
        !r1cs_accepts(inputs),
        "refused natively but the R1CS accepts it: the rule {rule:?} adds no constraint"
    );
}

/// No private variable of a valid input is left free.
#[track_caller]
pub fn assert_no_free_variables<P: ZkCircuit>(inputs: &P) {
    let report = check_private_variables(inputs).expect("private variable report");
    assert_eq!(
        report.free,
        Vec::<FreeVariable>::new(),
        "private variables no constraint pins down"
    );
}
