use ringstack_zk_gadgets::{
    harness::{assert_accepts, assert_no_free_variables, assert_refuses},
    threshold::{
        BELOW_THRESHOLD, DUPLICATE_SIGNER, SIGNER_NOT_APPROVER, ZERO_THRESHOLD, assert_threshold,
    },
};
use spr_program::{
    CircuitError,
    circuit::{Assert, Circuit, CircuitVar, Field, U16, constant, poseidon, value},
    conversion::{ProofInput, field},
};

const N: usize = 5;
const K: usize = 3;

/// Constraints for 5 approvers and 3 signer slots, including the commitment
/// to the approver set (the gadget alone is 77), pinned so a cost change shows
/// in review.
const CONSTRAINTS: usize = 450;
const SET_IS_COMMITTED: &str = "the approvers are the committed set";

const fn id(n: u8) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[0] = 0x0f; // a high byte, so identities are not small numbers
    bytes[31] = n;
    bytes
}
const NONE: [u8; 32] = [0; 32];
const A: [u8; 32] = id(1);
const B: [u8; 32] = id(2);
const C: [u8; 32] = id(3);
const OUTSIDER: [u8; 32] = id(9);
/// Three approvers and two unused slots.
const APPROVERS: [[u8; 32]; N] = [A, B, C, NONE, NONE];

/// As a program uses it: the approver set and threshold come from committed
/// terms (here a Poseidon commitment standing in for the escrow UTXO's data
/// hash), and the signers are what the program saw sign.
#[derive(Clone, Copy, Debug, ProofInput)]
struct Approve {
    committed: Field,
    approvers: [[u8; 32]; N],
    threshold: u16,
    signers: [[u8; 32]; K],
    /// How many signed, as the gadget counts it.
    count: u16,
}

impl Circuit for ApproveCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        let mut terms: Vec<CircuitVar> = self.approvers.to_vec();
        terms.push(self.threshold.var());
        poseidon(&terms)?.assert_equal(&self.committed, SET_IS_COMMITTED)?;
        let count = assert_threshold(&self.approvers, &self.threshold, &self.signers)?;
        count.assert_equal(&self.count, "the count is reported")
    }
}

fn commitment(approvers: &[[u8; 32]; N], threshold: u16) -> Field {
    let mut terms: Vec<CircuitVar> = approvers
        .iter()
        .map(|a| constant(field(a, "approver").unwrap()))
        .collect();
    terms.push(constant(u64::from(threshold)));
    value(&poseidon(&terms).unwrap()).unwrap()
}

fn approve(threshold: u16, signers: [[u8; 32]; K], count: u16) -> Approve {
    Approve {
        committed: commitment(&APPROVERS, threshold),
        approvers: APPROVERS,
        threshold,
        signers,
        count,
    }
}

#[test]
fn enough_distinct_approvers_pass_in_any_order() {
    for (threshold, signers, count) in [
        (2, [A, B, NONE], 2),
        (2, [NONE, C, A], 2),
        (3, [C, A, B], 3),
        (1, [NONE, NONE, B], 1),
        (1, [A, B, C], 3),
    ] {
        let inputs = approve(threshold, signers, count);
        assert_no_free_variables(&inputs);
        assert_eq!(assert_accepts(&inputs), CONSTRAINTS, "{signers:?}");
    }
}

#[test]
fn a_zero_threshold_is_refused() {
    assert_refuses(&approve(0, [A, NONE, NONE], 1), ZERO_THRESHOLD);
}

#[test]
fn a_signer_outside_the_set_is_refused() {
    assert_refuses(&approve(2, [A, OUTSIDER, NONE], 2), SIGNER_NOT_APPROVER);
}

#[test]
fn an_approver_counted_twice_is_refused() {
    assert_refuses(&approve(2, [A, A, NONE], 2), DUPLICATE_SIGNER);
    assert_refuses(&approve(2, [B, NONE, B], 2), DUPLICATE_SIGNER);
}

#[test]
fn too_few_approvers_are_refused() {
    assert_refuses(&approve(2, [A, NONE, NONE], 1), BELOW_THRESHOLD);
    assert_refuses(&approve(3, [A, B, NONE], 2), BELOW_THRESHOLD);
    // Empty slots count for nothing, even though the set has empty slots too.
    assert_refuses(&approve(1, [NONE, NONE, NONE], 0), BELOW_THRESHOLD);
}

#[test]
fn a_prover_cannot_swap_in_another_approver_set() {
    // OUTSIDER is not an approver; a prover who rewrites an unused slot to
    // admit them breaks the commitment.
    let mut inputs = approve(2, [A, OUTSIDER, NONE], 2);
    inputs.approvers[4] = OUTSIDER;
    assert_refuses(&inputs, SET_IS_COMMITTED);
}

#[test]
fn the_count_is_the_number_of_distinct_signers() {
    assert_refuses(&approve(1, [A, B, NONE], 3), "the count is reported");
}

#[test]
fn constraints_do_not_depend_on_the_inputs() {
    let first = assert_accepts(&approve(1, [A, NONE, NONE], 1));
    let full = assert_accepts(&approve(3, [A, B, C], 3));
    assert_eq!((first, full), (CONSTRAINTS, CONSTRAINTS));
    // Sanity: U16 is what the threshold enters as.
    let _: fn(&[_; N], &U16, &[_; K]) -> _ = assert_threshold::<N, K>;
}

/// The gadget with nothing binding its approver set.
#[derive(Clone, Copy, Debug, ProofInput)]
struct Unbound {
    approvers: [[u8; 32]; N],
    threshold: u16,
    signers: [[u8; 32]; K],
}

impl Circuit for UnboundCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        assert_threshold(&self.approvers, &self.threshold, &self.signers).map(|_| ())
    }
}

#[test]
fn the_gadget_alone_leaves_unused_approver_slots_free() {
    // Why the caller must bind the set: on its own, the unused slot (variable 4,
    // the last approver) affects no constraint once A and B have matched.
    let inputs = Unbound {
        approvers: APPROVERS,
        threshold: 2,
        signers: [A, B, NONE],
    };
    assert_eq!(assert_accepts(&inputs), 77);
    let report = spr_program::testing::check_private_variables(&inputs).expect("report");
    let free: Vec<usize> = report.free.iter().map(|f| f.variable).collect();
    assert_eq!(free, vec![4]);
}
