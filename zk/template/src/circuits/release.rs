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

use super::VaultTerms;

#[derive(Clone, ZkProgramCircuit)]
pub struct Release {
    pub private: ReleasePrivateInputs,
    pub public: ReleasePublicInputs,
}

#[derive(Clone, ProofInput)]
pub struct ReleasePrivateInputs {
    pub tx_context: TxContext,
    pub vault: WalletUtxo,
    pub terms: VaultTerms,
}

#[derive(Clone, PublicInputs)]
pub struct ReleasePublicInputs {
    pub unlock: u64,
    pub creator_identity: [u8; 32],
}

impl Circuit for ReleaseCircuit {
    type Output = CheckedTransaction;

    fn circuit(&self) -> Result<Self::Output, CircuitError> {
        let private = &self.private;
        let mut vault = DataUtxo::new_mut(&private.vault, &private.terms)?.close();
        vault
            .amount()?
            .assert_not_zero("the vault utxo holds nothing")?;
        vault.creator.key().identity()?.assert_equal(
            &self.public.creator_identity,
            "the signer is not the vault creator",
        )?;
        self.public
            .unlock
            .assert_equal(&vault.unlock, "the unlock time is not the vault's")?;
        let mut payout = TokenUtxos::new_init(&vault.creator, &vault.asset());
        vault.transfer_all(&mut payout)?;

        ConfidentialTransaction::new(&private.tx_context, &self.public)
            .with(vault)
            .with(payout)
            .check()
    }
}
