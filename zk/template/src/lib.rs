//! A template SPP ZK program: lock shielded tokens in a vault UTXO owned by a
//! per-creator PDA until a timestamp, then release them back to the creator.
//!
//! Adapted from upstream's `sdk-tests/timelock-escrow` in helius-labs/zolana
//! (Apache-2.0) at tag `rust-sdk-v0.8.0`, to build outside upstream's
//! workspace on the published 0.8.0 crates. Copy this crate to start a program.

#[cfg(any(feature = "circuits", feature = "wasm"))]
pub mod circuits;
#[cfg(all(feature = "circuits", not(feature = "r1cs-export")))]
pub mod client;
pub mod error;
#[cfg(not(feature = "r1cs-export"))]
pub mod instructions;
#[cfg(not(feature = "r1cs-export"))]
pub mod verifier;

use pinocchio::Address;
#[cfg(not(feature = "r1cs-export"))]
use pinocchio::{address::address_eq, error::ProgramError, AccountView, ProgramResult};

#[cfg(not(feature = "r1cs-export"))]
use crate::instructions::{process_lock_ix, process_release_ix};

pub mod tag {
    pub const LOCK: u8 = 0;
    pub const RELEASE: u8 = 1;
}

pub const VAULT_AUTHORITY_PDA_SEED: &[u8] = b"vault_authority";

pub fn vault_authority_seeds(creator: &Address) -> [&[u8]; 2] {
    [VAULT_AUTHORITY_PDA_SEED, creator.as_array()]
}

// On whenever the program is built for Solana, so `zolana build-zk-program`
// alone produces a deployable program; `no-entrypoint` turns it off for a
// crate that only CPIs into this one.
#[cfg(all(
    target_os = "solana",
    not(feature = "no-entrypoint"),
    not(feature = "r1cs-export")
))]
mod entrypoint {
    pinocchio::entrypoint!(crate::process_instruction);
}

pinocchio::address::declare_id!("3bzWnoteJaH7kD6Jron7Lb1ABfQxLGSqcEzRr3Zy6cAi");

#[cfg(not(feature = "r1cs-export"))]
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if !address_eq(program_id, &crate::ID) {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (ix_tag, ix_data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *ix_tag {
        tag::LOCK => process_lock_ix(accounts, ix_data),
        tag::RELEASE => process_release_ix(accounts, ix_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
