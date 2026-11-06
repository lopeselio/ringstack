use pinocchio::Address;
use spr_program::ProgramOwner;

use crate::{vault_authority_seeds, ID};

pub fn vault_authority(creator: &Address) -> ProgramOwner {
    ProgramOwner::find(&vault_authority_seeds(creator), &ID)
}
