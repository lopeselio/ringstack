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
    instructions::shared::{check_after_deadline, EscrowAuthority, IxData},
    verifier::refund,
};

pub mod slot {
    pub const ESCROW: usize = 0;
    pub const PAYOUT: usize = 0;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct RefundArgs {
    pub proof: CompressedProof,
    pub deadline: u64,
}

/// Accounts: payer (signer, writable), funder (signer), then the pool's
/// transact accounts.
#[inline(never)]
pub fn process_refund_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    iter.next_signer_mut("payer")?;
    let funder = *iter.next_signer("funder")?.address();
    let funder_identity = solana_owner_identity(funder.as_array()).map_err(EscrowError::from)?;

    let IxData {
        args: RefundArgs { proof, deadline },
        private_tx_hash,
        transact,
    } = IxData::<RefundArgs>::parse(data)?;

    check_after_deadline(Clock::get()?.unix_timestamp, deadline)?;

    refund::Verifier {
        proof: &proof,
        public_inputs: refund::PublicInputs {
            deadline,
            funder_identity,
        },
        private_tx_hash,
        transfers: &[],
    }
    .verify()
    .map_err(EscrowError::from)?;

    EscrowAuthority::find(&funder).invoke_transact(iter.remaining()?, transact)
}
