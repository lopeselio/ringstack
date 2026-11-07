//! Writes each gadget, wrapped in a minimal circuit, as a Picus R1CS file
//! (`ZkCircuit::export_picus_r1cs`): declared proof inputs are Picus inputs,
//! every other wire must be uniquely determined by them, and equality-test
//! inverse hints are left unchecked, as they are free by design.
//!
//!   cargo run --release -p ringstack-zk-gadgets --features harness \
//!     --example picus_export -- <out dir>

use std::path::{Path, PathBuf};

use ringstack_zk_gadgets::{allowlist::assert_allowed, threshold::assert_threshold};
use spr_program::{
    CircuitError, ZkCircuit,
    circuit::{Assert, Circuit, CircuitVar, Field, poseidon},
    conversion::ProofInput,
};

/// `threshold` over a set bound to a commitment, as its contract requires.
#[derive(Clone, Copy, Debug, ProofInput)]
struct Threshold {
    committed: Field,
    approvers: [[u8; 32]; 5],
    threshold: u16,
    signers: [[u8; 32]; 3],
}

impl Circuit for ThresholdCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        let mut terms: Vec<CircuitVar> = self.approvers.to_vec();
        terms.push(self.threshold.var());
        poseidon(&terms)?.assert_equal(&self.committed, "the approvers are the committed set")?;
        assert_threshold(&self.approvers, &self.threshold, &self.signers).map(|_| ())
    }
}

/// `threshold` alone, Poseidon-free: small enough for an SMT solver.
#[derive(Clone, Copy, Debug, ProofInput)]
struct ThresholdOnly {
    approvers: [[u8; 32]; 5],
    threshold: u16,
    signers: [[u8; 32]; 3],
}

impl Circuit for ThresholdOnlyCircuit {
    type Output = ();
    fn circuit(&self) -> Result<(), CircuitError> {
        assert_threshold(&self.approvers, &self.threshold, &self.signers).map(|_| ())
    }
}

#[derive(Clone, Copy, Debug, ProofInput)]
struct Allowlist {
    identity: [u8; 32],
    index: u32,
    siblings: [Field; 4],
    root: Field,
}

impl Circuit for AllowlistCircuit {
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

fn write<P: ZkCircuit>(dir: &Path, name: &str) {
    let bytes = P::export_picus_r1cs().expect("picus export");
    let path = dir.join(format!("{name}.r1cs"));
    std::fs::write(&path, &bytes).expect("write");
    println!("{} ({} bytes)", path.display(), bytes.len());
}

fn main() {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "target/picus".into()),
    );
    std::fs::create_dir_all(&dir).expect("out dir");
    write::<ThresholdOnly>(&dir, "threshold-only");
    write::<Threshold>(&dir, "threshold-committed");
    write::<Allowlist>(&dir, "allowlist-depth4");
}
