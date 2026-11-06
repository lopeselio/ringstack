//! Membership in a set committed as a Poseidon Merkle root.
//!
//! The set is a binary tree of `DEPTH` levels with `2^DEPTH` leaves. A member's
//! leaf is `poseidon([identity])` and an inner node is `poseidon([left,
//! right])`; the two arities use different Poseidon parameters, so a leaf can
//! never pass for an inner node. Unused leaves are zero, which no identity
//! hashes to.
//!
//! The root is what a program or a UTXO term commits to. The prover supplies
//! the member's index and the sibling hashes along its path; the circuit
//! recomputes the root. The index is range-checked to `DEPTH` bits, so a path
//! cannot be longer than the tree.
//!
//! [`Allowlist`] builds the same tree natively, with the same `poseidon`
//! gadget evaluated on constants, so the client's roots and paths match the
//! circuit's by construction.

use spr_program::{
    CircuitError,
    circuit::{Assert, CircuitVar, Field, constant, poseidon, value},
    conversion::field,
};

pub const NOT_ALLOWED: &str = "the address is not on the allowlist";

/// The leaf a member's identity occupies.
#[track_caller]
pub fn leaf(identity: &CircuitVar) -> Result<CircuitVar, CircuitError> {
    poseidon(core::slice::from_ref(identity))
}

/// The root of the tree a `leaf` at `index` belongs to, given its siblings
/// from the bottom up. Refuses an index that does not fit in `DEPTH` bits.
#[track_caller]
pub fn root<const DEPTH: usize>(
    leaf: &CircuitVar,
    index: &CircuitVar,
    siblings: &[CircuitVar; DEPTH],
) -> Result<CircuitVar, CircuitError> {
    let bits = index.to_bits_le::<DEPTH>()?;
    let mut node = leaf.clone();
    for (is_right, sibling) in bits.iter().zip(siblings) {
        let left = is_right.select(sibling, &node);
        let right = is_right.select(&node, sibling);
        node = poseidon(&[left, right])?;
    }
    Ok(node)
}

/// Asserts that `identity` is the member at `index` of the tree with `root`.
#[track_caller]
pub fn assert_allowed<const DEPTH: usize>(
    identity: &CircuitVar,
    index: &CircuitVar,
    siblings: &[CircuitVar; DEPTH],
    expected_root: &CircuitVar,
) -> Result<(), CircuitError> {
    root(&leaf(identity)?, index, siblings)?.assert_equal(expected_root, NOT_ALLOWED)
}

/// The tree, built natively for the client.
#[derive(Clone, Debug)]
pub struct Allowlist<const DEPTH: usize> {
    /// `levels[0]` holds the leaves, `levels[DEPTH]` the root.
    levels: Vec<Vec<Field>>,
}

/// What the prover passes for one member.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberPath<const DEPTH: usize> {
    pub index: u32,
    pub siblings: [Field; DEPTH],
}

impl<const DEPTH: usize> Allowlist<DEPTH> {
    /// Builds the tree over 32-byte identities, in order. Refuses more members
    /// than leaves, and an identity that is not a field element.
    pub fn new(identities: &[[u8; 32]]) -> Result<Self, CircuitError> {
        const { assert!(DEPTH >= 1 && DEPTH <= 32, "an allowlist has 1 to 32 levels") };
        if identities.len() > 1usize << DEPTH {
            return Err(CircuitError::rule_broken(
                "the allowlist has more members than leaves",
            ));
        }
        let mut leaves = vec![Field::from(0u64); 1 << DEPTH];
        for (slot, identity) in leaves.iter_mut().zip(identities) {
            *slot = native_hash(&[field(identity, "an allowlist identity")?])?;
        }
        let mut levels = vec![leaves];
        for _ in 0..DEPTH {
            let below = levels.last().expect("a level");
            let level = below
                .chunks(2)
                .map(native_hash)
                .collect::<Result<Vec<_>, _>>()?;
            levels.push(level);
        }
        Ok(Self { levels })
    }

    pub fn root(&self) -> Field {
        self.levels[DEPTH][0]
    }

    /// The path for the member at `index`.
    pub fn path(&self, index: u32) -> Option<MemberPath<DEPTH>> {
        let mut position = usize::try_from(index).ok()?;
        if position >= self.levels[0].len() {
            return None;
        }
        let siblings = core::array::from_fn(|level| {
            let sibling = self.levels[level][position ^ 1];
            position >>= 1;
            sibling
        });
        Some(MemberPath { index, siblings })
    }
}

/// Poseidon on native values: the circuit gadget evaluated on constants.
fn native_hash(inputs: &[Field]) -> Result<Field, CircuitError> {
    let vars: Vec<CircuitVar> = inputs.iter().map(|&f| constant(f)).collect();
    value(&poseidon(&vars)?)
}
