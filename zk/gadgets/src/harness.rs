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

/// What the R1CS alone makes of `inputs`: constraints generated from
/// variables, no native run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum R1cs {
    /// The constraints are satisfied.
    Satisfied,
    /// The constraints were generated and the witness breaks one: the
    /// refusal a verifier relies on.
    Unsatisfied,
    /// Generating the constraints failed for this witness, so they were never
    /// checked. A negative case that ends here proves nothing about the
    /// constraints; test it by tampering a valid witness instead
    /// (`spr_program::testing::check_tampered`).
    GenerationFailed,
}

/// Generates the R1CS for `inputs` and checks it. A native refusal returns
/// before any constraint is checked, so this is the only way to see that the
/// constraints, which are all a verifier relies on, refuse the input too.
pub fn r1cs(inputs: &impl ZkCircuit) -> R1cs {
    let cs = ConstraintSystem::new_ref();
    let Ok(instance) = inputs.instantiate(&Allocator::R1cs(cs.clone())) else {
        return R1cs::GenerationFailed;
    };
    if instance.circuit().is_err() {
        return R1cs::GenerationFailed;
    }
    if cs.is_satisfied().expect("R1CS satisfaction") {
        R1cs::Satisfied
    } else {
        R1cs::Unsatisfied
    }
}

/// Whether the R1CS alone accepts `inputs`.
pub fn r1cs_accepts<P: ZkCircuit>(inputs: &P) -> bool {
    r1cs(inputs) == R1cs::Satisfied
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

/// An invalid input: refused natively by exactly `rule`, and the R1CS built
/// from it is unsatisfied. A refusal by another rule fails the test, because
/// it means the rule under test was never reached.
#[track_caller]
pub fn assert_refuses<P: ZkCircuit>(inputs: &P, rule: &'static str) {
    assert_refused_by(inputs, (RULE_BROKEN, Some(rule)));
}

/// [`assert_refuses`] for a refusal that is not a named rule, such as
/// `("CircuitError.ValueTooLarge", None)` from a range check on an input.
#[track_caller]
pub fn assert_refused_by<P: ZkCircuit>(inputs: &P, expected: Refusal) {
    match inputs.check_constraints() {
        Ok(_) => panic!("an invalid input was accepted; expected {expected:?}"),
        Err(error) => assert_eq!(
            refusal(error),
            expected,
            "refused for another reason than the rule under test"
        ),
    }
    match r1cs(inputs) {
        R1cs::Unsatisfied => {}
        R1cs::Satisfied => {
            panic!("refused natively but the R1CS accepts it: {expected:?} adds no constraint")
        }
        R1cs::GenerationFailed => panic!(
            "the R1CS for this input could not be generated, so its constraints were never \
             checked; tamper a valid witness instead"
        ),
    }
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
