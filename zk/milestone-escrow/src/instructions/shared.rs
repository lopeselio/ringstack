#[cfg(any(target_os = "solana", target_arch = "bpf"))]
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use pinocchio::cpi::{Seed, Signer};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
use spr_interface::instruction::instruction_data::transact::TransactIxDataRef;
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use spr_program::cpi::{SppTransactAccounts, TransactAccountsError};
use spr_program::program::PdaOwner;
use wincode::{config::DefaultConfig, SchemaReadOwned};

use crate::error::EscrowError;

pub struct IxData<'a, A> {
    pub args: A,
    pub private_tx_hash: &'a [u8; 32],
    pub transact: &'a [u8],
}

impl<'a, A: SchemaReadOwned<DefaultConfig, Dst = A>> IxData<'a, A> {
    pub fn parse(data: &'a [u8]) -> Result<Self, ProgramError> {
        let mut transact = data;
        let args = wincode::deserialize_from(&mut transact)
            .map_err(|_| EscrowError::InvalidInstructionData)?;
        let private_tx_hash = TransactIxDataRef::from_bytes(transact)
            .map_err(|_| EscrowError::InvalidInstructionData)?
            .private_tx_hash;
        Ok(Self {
            args,
            private_tx_hash,
            transact,
        })
    }
}

/// Releases close at the deadline: allowed while `now < deadline`.
#[inline(always)]
pub fn check_before_deadline(now: i64, deadline: u64) -> ProgramResult {
    if ringstack_zk_gadgets::timelock::is_before(now, deadline) {
        Ok(())
    } else {
        Err(EscrowError::Expired.into())
    }
}

/// Refunds open after the deadline: allowed once `now > deadline`.
#[inline(always)]
pub fn check_after_deadline(now: i64, deadline: u64) -> ProgramResult {
    if ringstack_zk_gadgets::timelock::is_unlocked(now, deadline) {
        Ok(())
    } else {
        Err(EscrowError::NotExpired.into())
    }
}

pub struct EscrowAuthority {
    address: Address,
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    funder: Address,
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    bump: u8,
}

impl EscrowAuthority {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    pub fn find(funder: &Address) -> Self {
        let (address, bump) =
            Address::find_program_address(&crate::escrow_authority_seeds(funder), &crate::ID);
        Self {
            address,
            funder: *funder,
            bump,
        }
    }

    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    pub fn find(_funder: &Address) -> Self {
        unimplemented!("EscrowAuthority::find requires Solana runtime syscalls")
    }

    pub fn address(&self) -> &Address {
        &self.address
    }

    pub fn owner_hash(&self) -> Result<[u8; 32], EscrowError> {
        Ok(*PdaOwner::new(&self.address)
            .map_err(|_| EscrowError::HashingFailed)?
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
            Seed::from(crate::ESCROW_AUTHORITY_PDA_SEED),
            Seed::from(self.funder.as_array()),
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
        unimplemented!("EscrowAuthority::invoke_transact requires Solana runtime syscalls")
    }
}

#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn transact_accounts_error(error: TransactAccountsError) -> ProgramError {
    match error {
        TransactAccountsError::InvalidSppProgram => EscrowError::InvalidShieldedPoolProgram.into(),
        TransactAccountsError::MissingPdaSigner { .. } => {
            EscrowError::MissingEscrowAuthority.into()
        }
        TransactAccountsError::NotEnoughAccounts => ProgramError::NotEnoughAccountKeys,
    }
}
