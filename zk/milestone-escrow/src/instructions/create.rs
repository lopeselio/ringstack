use pinocchio::{AccountView, ProgramResult};
use spr_account_checks::AccountIterator;
use spr_hasher::primitives::solana_owner_identity;
use spr_program::CompressedProof;
use wincode::{SchemaRead, SchemaWrite};

use crate::{
    error::EscrowError,
    instructions::shared::{EscrowAuthority, IxData},
    verifier::create,
};

pub mod slot {
    pub const CHANGE: usize = 0;
    pub const ESCROW: usize = 1;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct CreateArgs {
    pub proof: CompressedProof,
    /// The viewing key the escrow UTXO is encrypted to (the funder's).
    pub viewing_pubkey: [u8; 33],
}

/// Accounts: funder (signer), then the pool's transact accounts.
#[inline(never)]
pub fn process_create_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    let funder = *iter.next_signer("funder")?.address();
    let funder_identity = solana_owner_identity(funder.as_array()).map_err(EscrowError::from)?;
    let authority = EscrowAuthority::find(&funder);

    let IxData {
        args: CreateArgs {
            proof,
            viewing_pubkey,
        },
        private_tx_hash,
        transact,
    } = IxData::<CreateArgs>::parse(data)?;

    create::Verifier {
        proof: &proof,
        public_inputs: create::PublicInputs {
            escrow_owner: spr_program::verifier::address_hash(
                &authority.owner_hash()?,
                &viewing_pubkey,
            )
            .map_err(EscrowError::from)?,
            funder_identity,
        },
        private_tx_hash,
        transfers: &[],
    }
    .verify()
    .map_err(EscrowError::from)?;

    authority.invoke_transact(iter.remaining()?, transact)
}
