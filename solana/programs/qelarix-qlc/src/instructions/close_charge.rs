use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::QlcError,
    state::{ChargeReceipt, Config},
};

/// Closes a charge receipt once its generation is final (succeeded, or refunded) and returns the
/// rent to the operator. A closed charge can no longer be refunded, and its sequence can never be
/// charged again (`Member::last_charge_seq` only grows).
#[derive(Accounts)]
pub struct CloseCharge<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = operator @ QlcError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        close = operator,
        seeds = [CHARGE_SEED, charge_receipt.payer.as_ref(), charge_receipt.seq.to_le_bytes().as_ref()],
        bump = charge_receipt.bump
    )]
    pub charge_receipt: Account<'info, ChargeReceipt>,
}

pub fn handle_close_charge(_ctx: Context<CloseCharge>) -> Result<()> {
    Ok(())
}
