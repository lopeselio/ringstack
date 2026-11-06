use pinocchio::{AccountView, ProgramResult};
use spr_account_checks::AccountIterator;
use spr_hasher::primitives::solana_owner_identity;
use spr_program::CompressedProof;
use wincode::{SchemaRead, SchemaWrite};

use crate::{
    error::VaultError,
    instructions::shared::{IxData, VaultAuthority},
    verifier::lock,
};

pub mod slot {
    pub const SOURCE: usize = 0;
    pub const CHANGE: usize = 0;
    pub const VAULT: usize = 1;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct LockArgs {
    pub proof: CompressedProof,
    pub viewing_pubkey: [u8; 33],
}

#[inline(never)]
pub fn process_lock_ix(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let mut iter = AccountIterator::new(accounts);
    let creator = *iter.next_signer("creator")?.address();
    let creator_identity = solana_owner_identity(creator.as_array()).map_err(VaultError::from)?;
    let vault_authority = VaultAuthority::find(&creator);

    let IxData {
        args: LockArgs {
            proof,
            viewing_pubkey,
        },
        private_tx_hash,
        transact,
    } = IxData::<LockArgs>::parse(data)?;

    lock::Verifier {
        proof: &proof,
        public_inputs: lock::PublicInputs {
            vault_owner: spr_program::verifier::address_hash(
                &vault_authority.owner_hash()?,
                &viewing_pubkey,
            )
            .map_err(VaultError::from)?,
            creator_identity,
        },
        private_tx_hash,
        transfers: &[],
    }
    .verify()
    .map_err(VaultError::from)?;

    let spp_accounts = iter.remaining()?;
    vault_authority.invoke_transact(spp_accounts, transact)
}
