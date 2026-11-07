//! Writes the escrow's create, release and refund circuits as Picus R1CS
//! files (`ZkCircuit::export_picus_r1cs`). They are transaction circuits of
//! 6,000 to 16,000 constraints with Poseidon throughout, so expect a solver
//! to time out on them; the gadget exports are the tractable targets.
//!
//!   cargo run --release -p milestone-escrow --features circuits \
//!     --example picus_export -- <out dir>

use std::path::{Path, PathBuf};

use milestone_escrow::circuits::{Create, Refund, Release};
use spr_program::ZkCircuit;

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
    write::<Create>(&dir, "escrow-create");
    write::<Release>(&dir, "escrow-release");
    write::<Refund>(&dir, "escrow-refund");
}
