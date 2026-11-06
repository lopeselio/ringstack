use ringstack_zk_gadgets::{
    allowlist::{Allowlist, MemberPath, NOT_ALLOWED, assert_allowed},
    harness::{assert_accepts, assert_no_free_variables, assert_refused_by, assert_refuses},
};
use spr_program::{
    CircuitError,
    circuit::{Circuit, Field},
    conversion::ProofInput,
};

const DEPTH: usize = 4;

/// Constraints for a 4-level tree (16 members), pinned so a cost change shows in review.
const CONSTRAINTS: usize = 1220;

const fn id(n: u8) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[0] = 0x0f;
    bytes[31] = n;
    bytes
}
const MEMBERS: [[u8; 32]; 5] = [id(1), id(2), id(3), id(4), id(5)];

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

fn tree() -> Allowlist<DEPTH> {
    Allowlist::new(&MEMBERS).expect("tree")
}

fn member(list: &Allowlist<DEPTH>, identity: [u8; 32], index: u32) -> Member {
    let MemberPath { index, siblings } = list.path(index).expect("path");
    Member {
        identity,
        index,
        siblings,
        root: list.root(),
    }
}

#[test]
fn every_member_proves_membership() {
    let list = tree();
    for (index, identity) in MEMBERS.into_iter().enumerate() {
        let inputs = member(&list, identity, index as u32);
        assert_no_free_variables(&inputs);
        assert_eq!(assert_accepts(&inputs), CONSTRAINTS);
    }
}

#[test]
fn an_outsider_is_refused_at_every_index() {
    let list = tree();
    for index in 0..(1u32 << DEPTH) {
        assert_refuses(&member(&list, id(99), index), NOT_ALLOWED);
    }
}

#[test]
fn a_member_at_another_index_is_refused() {
    let list = tree();
    assert_refuses(&member(&list, MEMBERS[0], 1), NOT_ALLOWED);
    // An unused leaf is zero, which no identity hashes to.
    assert_refuses(&member(&list, MEMBERS[0], 7), NOT_ALLOWED);
}

#[test]
fn a_tampered_path_or_root_is_refused() {
    let list = tree();
    for level in 0..DEPTH {
        let mut inputs = member(&list, MEMBERS[2], 2);
        inputs.siblings[level] = Field::from(12345u64);
        assert_refuses(&inputs, NOT_ALLOWED);
    }
    let other = Allowlist::<DEPTH>::new(&MEMBERS[1..]).expect("other tree");
    let mut inputs = member(&list, MEMBERS[2], 2);
    inputs.root = other.root();
    assert_refuses(&inputs, NOT_ALLOWED);
}

#[test]
fn an_index_beyond_the_tree_is_refused() {
    // Index 16 + 3 has the same low bits as 3: without the range check it would
    // reuse member 3's path.
    let list = tree();
    let mut inputs = member(&list, MEMBERS[3], 3);
    inputs.index += 1 << DEPTH;
    assert_refused_by(&inputs, ("CircuitError.ValueTooLarge", None));
}

#[test]
fn the_native_tree_matches_the_circuit_and_refuses_bad_input() {
    let list = tree();
    assert_ne!(
        list.root(),
        Allowlist::<DEPTH>::new(&MEMBERS[..4]).unwrap().root()
    );
    assert_eq!(
        list.root(),
        Allowlist::<DEPTH>::new(&MEMBERS).unwrap().root()
    );
    assert!(list.path(1 << DEPTH).is_none());
    assert!(Allowlist::<DEPTH>::new(&[id(1); 17]).is_err());
    // An identity that is not a field element.
    assert!(Allowlist::<DEPTH>::new(&[[0xff; 32]]).is_err());
}
