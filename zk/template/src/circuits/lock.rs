use spr_keypair::ShieldedAddress;
use spr_program::ZkProgramCircuit;
use spr_program::{
    circuit::{
        Assert, CheckedTransaction, Circuit, ConfidentialTransaction, DataUtxo, PublicInputs,
        TokenUtxos, UtxoTrait,
    },
    conversion::ProofInput,
    CircuitError, TxContext,
};
use spr_transaction::WalletUtxo;

use super::VaultTermsCircuit;

pub const LOCK_TOKEN_INPUTS: usize = 5;

#[derive(Clone, ZkProgramCircuit)]
pub struct Lock {
    pub private: LockPrivateInputs,
    pub public: LockPublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct LockPrivateInputs {
    pub tx_context: TxContext,
    #[max_len(LOCK_TOKEN_INPUTS)]
    pub token_utxos_asset_a: Vec<WalletUtxo>,
    pub unlock: u64,
    pub amount: u64,
}

#[derive(Clone, PublicInputs)]
pub struct LockPublicInputs {
    pub vault_owner: ShieldedAddress,
    pub creator_identity: [u8; 32],
}

impl Circuit for LockCircuit {
    type Output = CheckedTransaction;

    fn circuit(&self) -> Result<Self::Output, CircuitError> {
        let private = &self.private;
        private.amount.assert_not_zero("the vault locks nothing")?;
        let mut tokens = TokenUtxos::new_mut(&private.token_utxos_asset_a)?;
        tokens.owner().key().identity()?.assert_equal(
            &self.public.creator_identity,
            "the signer does not own the vaulted tokens",
        )?;
        let mut vault = DataUtxo::<VaultTermsCircuit>::new_init(&self.public.vault_owner)
            .with_asset(&tokens.asset())?;
        tokens.transfer(&mut vault, &private.amount)?;
        vault.creator = tokens.owner();
        vault.unlock = private.unlock.clone();

        ConfidentialTransaction::new(&private.tx_context, &self.public)
            .with(tokens)
            .with(vault)
            .check()
    }
}
