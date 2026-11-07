//! Each gadget against a plain-Rust model of what it should accept, on random
//! inputs. A case passes only when the native run *and* the R1CS alone agree
//! with the model, so a check that holds natively but adds no constraint fails
//! here even when every hand-written case missed it.

use std::collections::HashSet;

use proptest::prelude::*;
use ringstack_zk_gadgets::{
    allowlist::{Allowlist, assert_allowed},
    harness::r1cs_accepts,
    threshold::assert_threshold,
    timelock::{is_before, is_unlocked},
};
use spr_program::{
    CircuitError, ZkCircuit,
    circuit::{Assert, Circuit, Field},
    conversion::ProofInput,
};

const N: usize = 5;
const K: usize = 3;
const DEPTH: usize = 4;

/// Identities small enough to be field elements: a high byte under the
/// modulus's, then the pool index.
fn id(n: u8) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    if n != 0 {
        bytes[0] = 0x0f;
        bytes[31] = n;
    }
    bytes
}

/// Both the native run and the R1CS must reach `expected`.
fn agrees<P: ZkCircuit>(inputs: &P, expected: bool) -> Result<(), TestCaseError> {
    let native = inputs.check_constraints().is_ok();
    let r1cs = r1cs_accepts(inputs);
    prop_assert_eq!(native, expected, "native run disagrees with the model");
    prop_assert_eq!(r1cs, expected, "R1CS disagrees with the model");
    Ok(())
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct Approve {
    approvers: [[u8; 32]; N],
    threshold: u16,
    signers: [[u8; 32]; K],
    count: u16,
}

impl Circuit for ApproveCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        let count = assert_threshold(&self.approvers, &self.threshold, &self.signers)?;
        count.assert_equal(&self.count, "the count is reported")
    }
}

/// The model: M is not zero, every signer is an approver or empty, no signer
/// counts twice, and at least M signed. Returns how many signed.
fn threshold_model(approvers: &[u8], threshold: u16, signers: &[u8]) -> (bool, u16) {
    let set: HashSet<u8> = approvers.iter().copied().filter(|&a| a != 0).collect();
    let present: Vec<u8> = signers.iter().copied().filter(|&s| s != 0).collect();
    let distinct: HashSet<u8> = present.iter().copied().collect();
    let count = present.len() as u16;
    let ok = threshold != 0
        && present.iter().all(|s| set.contains(s))
        && distinct.len() == present.len()
        && count >= threshold;
    (ok, count)
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct Member {
    identity: [u8; 32],
    index: u32,
    siblings: [Field; DEPTH],
    root: Field,
}

impl Circuit for MemberCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        assert_allowed(
            &self.identity,
            &self.index.var(),
            &self.siblings,
            &self.root,
        )
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(160))]

    /// Identities come from a pool of 8 (0 is the empty slot), so random sets
    /// and signer lists hit members, outsiders, empties and repeats often.
    #[test]
    fn threshold_accepts_exactly_what_the_model_accepts(
        approvers in prop::array::uniform5(0u8..8),
        threshold in 0u16..5,
        signers in prop::array::uniform3(0u8..8),
    ) {
        let (ok, count) = threshold_model(&approvers, threshold, &signers);
        let inputs = Approve {
            approvers: approvers.map(id),
            threshold,
            signers: signers.map(id),
            count,
        };
        agrees(&inputs, ok)?;
    }

    /// Up to 16 members of a 16-leaf tree; the prover claims some identity at
    /// some index, sometimes past the tree.
    #[test]
    fn allowlist_accepts_exactly_the_member_at_its_index(
        members in prop::collection::vec(1u8..40, 1..=16),
        claimed in 1u8..40,
        index in 0u32..24,
        pick_member in any::<bool>(),
    ) {
        let identities: Vec<[u8; 32]> = members.iter().map(|&m| id(m)).collect();
        let list = Allowlist::<DEPTH>::new(&identities).expect("tree");
        // Half the cases claim whoever is really at a valid index.
        let (identity, index) = if pick_member {
            let i = index % members.len() as u32;
            (members[i as usize], i)
        } else {
            (claimed, index)
        };
        let ok = (index as usize) < members.len() && members[index as usize] == identity;
        // A path for an index past the tree does not exist; reuse its low bits.
        let path = list.path(index % (1 << DEPTH)).expect("path");
        let inputs = Member { identity: id(identity), index, siblings: path.siblings, root: list.root() };
        agrees(&inputs, ok)?;
    }

    #[test]
    fn timelock_splits_every_clock_at_the_deadline(now in any::<i64>(), deadline in 0u64..u64::MAX) {
        prop_assert_ne!(is_unlocked(now, deadline), is_before(now, deadline + 1));
        prop_assert_eq!(is_unlocked(now, deadline), now >= 0 && now as u64 > deadline);
    }
}
