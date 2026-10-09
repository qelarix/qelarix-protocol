use anchor_lang::prelude::*;

use crate::state::DeliveryKind;

#[event]
pub struct MemberRegistered {
    pub wallet: Pubkey,
    pub token_account: Pubkey,
}

#[event]
pub struct QlcDelivered {
    pub delivery_id: [u8; 32],
    pub recipient: Pubkey,
    pub kind: DeliveryKind,
    pub amount: u64,
    pub from_vault: u64,
    pub minted: u64,
}

#[event]
pub struct QlcCharged {
    pub payer: Pubkey,
    pub seq: u64,
    pub amount: u64,
}

#[event]
pub struct QlcRefunded {
    pub payer: Pubkey,
    pub seq: u64,
    pub amount: u64,
}

#[event]
pub struct MemberSuspensionChanged {
    pub wallet: Pubkey,
    pub suspended: bool,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub paused: bool,
}
