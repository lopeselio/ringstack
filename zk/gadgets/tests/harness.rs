//! The harness itself: it must pass sound gadgets and catch each kind of
//! broken one. The square-root gadgets follow `spr-program`'s external gadget
//! tests (Apache-2.0).

use ringstack_zk_gadgets::harness::{
    assert_accepts, assert_no_free_variables, assert_refuses, r1cs_accepts,
};
use spr_program::{
    CircuitError,
    circuit::{Circuit, CircuitVar, Field, U32, U64, U128, value},
    conversion::ProofInput,
};

const ISQRT: &str = "the root is the integer square root";
const POSITIVE: &str = "the value is positive";
const SMALL: &str = "the value is below 100";

/// `root² <= value < (root + 1)²`.
#[track_caller]
fn assert_isqrt(value: &U64, root: &U32) -> Result<(), CircuitError> {
    root.mul::<64>(root).assert_less_or_equal(value, ISQRT)?;
    let next = root.add::<33>(&U32::constant(1)?);
    U128::from(value.clone()).assert_less_than(&next.mul::<128>(&next), ISQRT)
}

/// Broken: no upper bound, so any smaller root passes too.
#[track_caller]
fn assert_isqrt_without_upper_bound(value: &U64, root: &U32) -> Result<(), CircuitError> {
    root.mul::<64>(root).assert_less_or_equal(value, ISQRT)
}

/// Broken: checks the value it can read natively and adds no constraint, so a
/// prover skips it. `value` fails on an R1CS variable, which hides the check.
fn assert_positive_natively_only(var: &CircuitVar) -> Result<(), CircuitError> {
    match value(var) {
        Ok(v) if v == Field::from(0u64) => Err(CircuitError::rule_broken(POSITIVE)),
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct Isqrt {
    value: u64,
    root: u32,
}

impl Circuit for IsqrtCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        assert_isqrt(&self.value, &self.root)
    }
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct WeakIsqrt {
    value: u64,
    root: u32,
}

impl Circuit for WeakIsqrtCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        assert_isqrt_without_upper_bound(&self.value, &self.root)
    }
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct NativeOnly {
    value: Field,
}

impl Circuit for NativeOnlyCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        assert_positive_natively_only(&self.value)
    }
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct TwoRules {
    value: u64,
}

impl Circuit for TwoRulesCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        self.value.assert_not_zero(POSITIVE)?;
        self.value.assert_less_than(&U64::constant(100)?, SMALL)
    }
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct UnusedInput {
    value: u64,
    ignored: Field,
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct UnusedRangedInput {
    value: u64,
    ignored: u64,
}

impl Circuit for UnusedRangedInputCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        self.value.assert_not_zero(POSITIVE)
    }
}

impl Circuit for UnusedInputCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        self.value.assert_not_zero(POSITIVE)
    }
}

#[test]
fn a_sound_gadget_passes_every_check() {
    let counts = [0u64, 1, 15, 16, 17, u64::MAX].map(|value| {
        let inputs = Isqrt {
            value,
            root: u32::try_from(value.isqrt()).unwrap(),
        };
        assert_no_free_variables(&inputs);
        assert_accepts(&inputs)
    });
    // One shape for every input: the count does not depend on the values.
    assert!(
        counts.iter().all(|&n| n == counts[0] && n > 0),
        "{counts:?}"
    );
    for root in [3, 5] {
        assert_refuses(&Isqrt { value: 17, root }, ISQRT);
    }
}

#[test]
#[should_panic(expected = "an invalid input was accepted")]
fn a_missing_bound_is_caught_by_a_negative_case() {
    assert_refuses(&WeakIsqrt { value: 17, root: 3 }, ISQRT);
}

#[test]
#[should_panic(expected = "adds no constraint")]
fn a_check_that_only_runs_natively_is_caught() {
    let zero = NativeOnly {
        value: Field::from(0u64),
    };
    // Natively it looks right...
    assert!(r1cs_accepts(&zero));
    // ...and the harness refuses to believe it.
    assert_refuses(&zero, POSITIVE);
}

#[test]
#[should_panic(expected = "refused for another reason")]
fn a_negative_case_that_breaks_another_rule_is_caught() {
    // Zero breaks POSITIVE before SMALL is ever reached.
    assert_refuses(&TwoRules { value: 0 }, SMALL);
}

#[test]
fn each_rule_of_a_two_rule_circuit_has_its_own_negative_case() {
    assert_accepts(&TwoRules { value: 42 });
    assert_refuses(&TwoRules { value: 0 }, POSITIVE);
    assert_refuses(&TwoRules { value: 100 }, SMALL);
}

#[test]
#[should_panic(expected = "private variables no constraint pins down")]
fn an_input_no_constraint_uses_is_caught() {
    assert_no_free_variables(&UnusedInput {
        value: 7,
        ignored: Field::from(3u64),
    });
}

#[test]
fn an_unused_integer_input_is_not_reported_free() {
    // The known limit: declaring a u64 range-checks it, and that check counts
    // as a constraint, so an integer input nothing else uses looks pinned.
    // Negative cases have to cover what the free-variable check cannot.
    assert_no_free_variables(&UnusedRangedInput {
        value: 7,
        ignored: 3,
    });
}
