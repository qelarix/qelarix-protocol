use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::QlcError,
    events::QlcRefunded,
    state::{ChargeReceipt, ChargeStatus, Config, Member},
};

/// Returns a charge from the vault to the member, at most once. Allowed while the program is
/// paused, because it only gives QLC back.
#[derive(Accounts)]
pub struct Refund<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = operator @ QlcError::Unauthorized,
        has_one = qlc_mint,
        has_one = vault
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [CHARGE_SEED, charge_receipt.payer.as_ref(), charge_receipt.seq.to_le_bytes().as_ref()],
        bump = charge_receipt.bump
    )]
    pub charge_receipt: Account<'info, ChargeReceipt>,

    #[account(seeds = [MEMBER_SEED, charge_receipt.payer.as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,

    #[account(mut, address = member.token_account @ QlcError::WrongTokenAccount)]
    pub member_token_account: InterfaceAccount<'info, TokenAccount>,

    pub qlc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program-derived vault owner.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_refund(ctx: Context<Refund>) -> Result<()> {
    let charge_receipt = &ctx.accounts.charge_receipt;
    require!(charge_receipt.status == ChargeStatus::Charged, QlcError::AlreadyRefunded);
    let amount = charge_receipt.amount;

    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.qlc_mint.to_account_info(),
                to: ctx.accounts.member_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[&[VAULT_SEED, &[ctx.accounts.config.vault_bump]]],
        ),
        amount,
        QLC_DECIMALS,
    )?;

    let config = &mut ctx.accounts.config;
    config.total_refunded = config.total_refunded.checked_add(amount).ok_or(QlcError::MathOverflow)?;
    let charge_receipt = &mut ctx.accounts.charge_receipt;
    charge_receipt.status = ChargeStatus::Refunded;

    emit!(QlcRefunded { payer: charge_receipt.payer, seq: charge_receipt.seq, amount });
    Ok(())
}
