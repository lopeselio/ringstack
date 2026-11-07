//! Milestone escrow on SPP, the Track Z reference program.
//!
//! A funder locks a private balance in an escrow UTXO owned by their escrow
//! authority PDA. The UTXO's data commits the terms: the payee, an approver set,
//! a threshold M, the tranche paid per milestone and a deadline.
//!
//! - **create**: the funder escrows tokens under those terms.
//! - **release**: before the deadline, M distinct approvers sign; one tranche
//!   goes to the payee and the remainder stays escrowed under the same terms.
//! - **refund**: after the deadline, the funder takes back what is left.
//!
//! Built from the [template](../template) and `ringstack-zk-gadgets`: the
//! approval check is `threshold::assert_threshold` over the *committed* set,
//! and both deadline checks use `timelock`.

#[cfg(any(feature = "circuits", feature = "wasm"))]
pub mod circuits;
pub mod error;
#[cfg(not(feature = "r1cs-export"))]
pub mod instructions;
#[cfg(not(feature = "r1cs-export"))]
pub mod verifier;

use pinocchio::Address;
#[cfg(not(feature = "r1cs-export"))]
use pinocchio::{address::address_eq, error::ProgramError, AccountView, ProgramResult};

#[cfg(not(feature = "r1cs-export"))]
use crate::instructions::{process_create_ix, process_refund_ix, process_release_ix};

pub mod tag {
    pub const CREATE: u8 = 0;
    pub const RELEASE: u8 = 1;
    pub const REFUND: u8 = 2;
}

/// Approver slots in the terms; unused slots are zero.
pub const APPROVERS: usize = 3;

pub const ESCROW_AUTHORITY_PDA_SEED: &[u8] = b"milestone_authority";

pub fn escrow_authority_seeds(funder: &Address) -> [&[u8]; 2] {
    [ESCROW_AUTHORITY_PDA_SEED, funder.as_array()]
}

#[cfg(all(
    target_os = "solana",
    not(feature = "no-entrypoint"),
    not(feature = "r1cs-export")
))]
mod entrypoint {
    pinocchio::entrypoint!(crate::process_instruction);
}

pinocchio::address::declare_id!("2XdkS7kQQcuCXQBhQv634B8PhDqFbpTPecHqMavwtMBR");

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
        tag::CREATE => process_create_ix(accounts, ix_data),
        tag::RELEASE => process_release_ix(accounts, ix_data),
        tag::REFUND => process_refund_ix(accounts, ix_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
