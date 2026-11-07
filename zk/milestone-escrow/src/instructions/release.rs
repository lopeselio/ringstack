use pinocchio::{
    sysvars::{clock::Clock, Sysvar},
    AccountView, ProgramResult,
};
use spr_account_checks::AccountIterator;
use spr_hasher::primitives::solana_owner_identity;
use spr_program::CompressedProof;
use wincode::{SchemaRead, SchemaWrite};

use crate::{
    error::EscrowError,
    instructions::shared::{check_not_expired, EscrowAuthority, IxData},
    verifier::release,
    APPROVERS,
};

pub mod slot {
    pub const ESCROW: usize = 0;
    pub const PAYOUT: usize = 1;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct ReleaseArgs {
    pub proof: CompressedProof,
    pub deadline: u64,
    /// How many approver signer accounts follow the funder.
    pub approver_count: u8,
}

/// Accounts: payer (signer, writable), funder, `approver_count` approvers
/// (signers), then the pool's transact accounts.
#[inline(never)]
pub fn process_release_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    iter.next_signer_mut("payer")?;
    let funder = *iter.next_account("funder")?.address();
    let funder_identity = solana_owner_identity(funder.as_array()).map_err(EscrowError::from)?;

    let IxData {
        args:
            ReleaseArgs {
                proof,
                deadline,
                approver_count,
            },
        private_tx_hash,
        transact,
    } = IxData::<ReleaseArgs>::parse(data)?;

    // The clock first: a late release costs no proof verification.
    check_not_expired(Clock::get()?.unix_timestamp, deadline)?;

    let count = usize::from(approver_count);
    if count > APPROVERS {
        return Err(EscrowError::TooManyApprovers.into());
    }
    // Who actually signed this transaction, as the circuit sees them.
    let mut signers = [[0u8; 32]; APPROVERS];
    for slot in signers.iter_mut().take(count) {
        let approver = iter.next_signer("approver")?.address();
        *slot = solana_owner_identity(approver.as_array()).map_err(EscrowError::from)?;
    }

    release::Verifier {
        proof: &proof,
        public_inputs: release::PublicInputs {
            deadline,
            funder_identity,
            signers,
        },
        private_tx_hash,
        transfers: &[],
    }
    .verify()
    .map_err(EscrowError::from)?;

    EscrowAuthority::find(&funder).invoke_transact(iter.remaining()?, transact)
}
