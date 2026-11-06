//! M-of-N approvals.
//!
//! The approver set and the threshold M are terms committed in a UTXO's data,
//! so they stay private. The identities of the accounts that signed the
//! transaction are public: the program computes them from the transaction's
//! signers (`spr_hasher::primitives::solana_owner_identity`), zero for an
//! empty slot, and passes them as public inputs. The circuit proves that every
//! signer is an approver, that no signer is counted twice, and that at least M
//! signed.
//!
//! Two things the caller must do, or the proof means nothing:
//!
//! - **Bind `approvers` and `threshold` to the committed terms**, for example by
//!   reading them from the `DataUtxo` being spent, whose hash the pool checks.
//!   The gadget alone does not pin them: once a signer matches one approver,
//!   the other slots stop affecting any constraint, so a free-variable check
//!   on the gadget by itself reports them.
//! - **Fill the signer slots only from accounts that actually signed.** That
//!   check is the program's: the circuit trusts its public inputs.

use spr_program::{
    CircuitError,
    circuit::{Assert, CircuitVar, U16, Uint, is_in, zero},
};

pub const ZERO_THRESHOLD: &str = "the threshold is zero";
pub const SIGNER_NOT_APPROVER: &str = "a signer is not one of the approvers";
pub const DUPLICATE_SIGNER: &str = "a signer is counted twice";
pub const BELOW_THRESHOLD: &str = "fewer approvers signed than the threshold";

/// Checks that at least `threshold` distinct `approvers` are among `signers`
/// and returns how many signed.
///
/// - `approvers`: committed identities, zero for an unused slot.
/// - `threshold`: committed M; zero is refused, since it would need nobody.
/// - `signers`: public identities of the accounts that signed, zero for an
///   empty slot. Order does not matter.
///
/// Costs grow with `N * K` for membership and `K²` for distinctness, so keep
/// both small.
#[track_caller]
pub fn assert_threshold<const N: usize, const K: usize>(
    approvers: &[CircuitVar; N],
    threshold: &U16,
    signers: &[CircuitVar; K],
) -> Result<U16, CircuitError> {
    threshold.assert_not_zero(ZERO_THRESHOLD)?;

    let mut present = Vec::with_capacity(K);
    for signer in signers {
        let empty = signer.is_equal(&zero())?;
        is_in(signer, approvers)?
            .or(&empty)
            .assert_true(SIGNER_NOT_APPROVER)?;
        present.push(empty.not());
    }

    for i in 0..K {
        for j in i + 1..K {
            // Two empty slots are equal and fine; two equal signers are not.
            signers[i]
                .is_equal(&signers[j])?
                .and(&present[i])
                .assert_false(DUPLICATE_SIGNER)?;
        }
    }

    let flags: [Uint<1>; K] = core::array::from_fn(|i| Uint::from(present[i].clone()));
    let count: U16 = Uint::sum::<16, K>(&flags);
    threshold.assert_less_or_equal(&count, BELOW_THRESHOLD)?;
    Ok(count)
}
