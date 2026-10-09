use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Program administrator (devnet: owner-held key; mainnet: multisig). Cannot mint, burn or
    /// move QLC; manages limits, the operator, pausing and member suspension.
    pub admin: Pubkey,
    /// Relayer key allowed to submit deliveries, charges and refunds, always inside the limits
    /// below, and to co-sign member registration (the member's wallet must sign too).
    pub operator: Pubkey,
    pub qlc_mint: Pubkey,
    pub vault: Pubkey,
    pub max_delivery_amount: u64,
    pub max_charge_amount: u64,
    /// Newly minted QLC is capped per rolling window; vault reuse is not capped.
    pub mint_window_secs: i64,
    pub mint_window_cap: u64,
    pub mint_window_start: i64,
    pub minted_in_window: u64,
    /// Stops registration, deliveries and charges. Refunds stay available.
    pub paused: bool,
    pub total_minted: u64,
    pub total_delivered: u64,
    pub total_charged: u64,
    pub total_refunded: u64,
    pub bump: u8,
    pub mint_authority_bump: u8,
    pub membership_bump: u8,
    pub vault_bump: u8,
    pub spend_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Member {
    pub wallet: Pubkey,
    /// The member's QLC associated token account.
    pub token_account: Pubkey,
    pub suspended: bool,
    pub registered_at: i64,
    /// Highest charge sequence used. A charge must use a larger number, so a sequence can never be
    /// charged twice, even after its receipt was closed.
    pub last_charge_seq: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum DeliveryKind {
    Purchase,
    Reward,
    Grant,
    Campaign,
}

/// One receipt per delivery id: a delivery can never be executed twice.
#[account]
#[derive(InitSpace)]
pub struct DeliveryReceipt {
    pub delivery_id: [u8; 32],
    pub recipient: Pubkey,
    pub kind: DeliveryKind,
    pub amount: u64,
    pub from_vault: u64,
    pub minted: u64,
    pub delivered_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ChargeStatus {
    Charged,
    Refunded,
}

/// Open while a generation is in progress; refunded at most once, closed when final. Its sequence
/// stays used forever through `Member::last_charge_seq`.
#[account]
#[derive(InitSpace)]
pub struct ChargeReceipt {
    pub payer: Pubkey,
    pub seq: u64,
    pub amount: u64,
    pub status: ChargeStatus,
    pub charged_at: i64,
    pub bump: u8,
}
