#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use pinocchio::cpi::{Seed, Signer};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
use spr_interface::instruction::instruction_data::transact::TransactIxDataRef;
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use spr_program::cpi::{SppTransactAccounts, TransactAccountsError};
use spr_program::program::PdaOwner;
use wincode::{config::DefaultConfig, SchemaReadOwned};

use crate::error::VaultError;

pub struct IxData<'a, A> {
    pub args: A,
    pub private_tx_hash: &'a [u8; 32],
    pub transact: &'a [u8],
}

impl<'a, A: SchemaReadOwned<DefaultConfig, Dst = A>> IxData<'a, A> {
    pub fn parse(data: &'a [u8]) -> Result<Self, ProgramError> {
        let mut transact = data;
        let args = wincode::deserialize_from(&mut transact)
            .map_err(|_| VaultError::InvalidInstructionData)?;
        let private_tx_hash = TransactIxDataRef::from_bytes(transact)
            .map_err(|_| VaultError::InvalidInstructionData)?
            .private_tx_hash;
        Ok(Self {
            args,
            private_tx_hash,
            transact,
        })
    }
}

/// The program's half of the timelock: the circuit binds `unlock` to the
/// vault's committed terms, this checks it against the clock.
#[inline(always)]
pub fn check_unlocked(now: i64, unlock: u64) -> ProgramResult {
    if ringstack_zk_gadgets::timelock::is_unlocked(now, unlock) {
        Ok(())
    } else {
        Err(VaultError::NotYetUnlocked.into())
    }
}

pub struct VaultAuthority {
    address: Address,
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    creator: Address,
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    bump: u8,
}

impl VaultAuthority {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    pub fn find(creator: &Address) -> Self {
        let (address, bump) =
            Address::find_program_address(&crate::vault_authority_seeds(creator), &crate::ID);
        Self {
            address,
            creator: *creator,
            bump,
        }
    }

    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    pub fn find(_creator: &Address) -> Self {
        unimplemented!("VaultAuthority::find requires Solana runtime syscalls")
    }

    pub fn address(&self) -> &Address {
        &self.address
    }

    pub fn owner_hash(&self) -> Result<[u8; 32], VaultError> {
        Ok(*PdaOwner::new(&self.address)
            .map_err(|_| VaultError::HashingFailed)?
            .owner_hash())
    }

    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    #[inline(never)]
    pub fn invoke_transact(&self, spp_accounts: &[AccountView], transact: &[u8]) -> ProgramResult {
        let signer_pdas = [&self.address];
        let spp = SppTransactAccounts::new(spp_accounts, &signer_pdas)
            .map_err(transact_accounts_error)?;
        let bump = [self.bump];
        let seeds = [
            Seed::from(crate::VAULT_AUTHORITY_PDA_SEED),
            Seed::from(self.creator.as_array()),
            Seed::from(&bump),
        ];
        spp.invoke::<16>(transact, &[Signer::from(&seeds)])
    }

    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    pub fn invoke_transact(
        &self,
        _spp_accounts: &[AccountView],
        _transact: &[u8],
    ) -> ProgramResult {
        unimplemented!("VaultAuthority::invoke_transact requires Solana runtime syscalls")
    }
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn transact_accounts_error(error: TransactAccountsError) -> ProgramError {
    match error {
        TransactAccountsError::InvalidSppProgram => VaultError::InvalidShieldedPoolProgram.into(),
        TransactAccountsError::MissingPdaSigner { .. } => VaultError::MissingVaultAuthority.into(),
        TransactAccountsError::NotEnoughAccounts => ProgramError::NotEnoughAccountKeys,
    }
}
