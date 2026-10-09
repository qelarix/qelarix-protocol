use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::QlcError,
    events::QlcCharged,
    state::{ChargeReceipt, ChargeStatus, Config, Member},
};

/// Charges a member for a generation from the allowance they approved to the spend delegate.
/// QLC moves from the member's wallet to the vault; nothing is burned or locked. Each charge uses a
/// per-member sequence larger than any used before, so no charge can ever be replayed, even after
/// its receipt was closed.
#[derive(Accounts)]
#[instruction(seq: u64)]
pub struct Charge<'info> {
    #[account(mut)]
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

    #[account(mut, seeds = [MEMBER_SEED, member.wallet.as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,

    #[account(mut, address = member.token_account @ QlcError::WrongTokenAccount)]
    pub member_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = operator,
        space = 8 + ChargeReceipt::INIT_SPACE,
        seeds = [CHARGE_SEED, member.wallet.as_ref(), seq.to_le_bytes().as_ref()],
        bump
    )]
    pub charge_receipt: Account<'info, ChargeReceipt>,

    pub qlc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program-derived spend delegate.
    #[account(seeds = [SPEND_SEED], bump = config.spend_bump)]
    pub spend_authority: UncheckedAccount<'info>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_charge(ctx: Context<Charge>, seq: u64, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, QlcError::Paused);
    require!(amount > 0 && amount % AMOUNT_STEP == 0, QlcError::InvalidAmount);
    require!(amount <= config.max_charge_amount, QlcError::AmountAboveLimit);
    require!(!ctx.accounts.member.suspended, QlcError::MemberSuspended);
    require!(seq > ctx.accounts.member.last_charge_seq, QlcError::ChargeSequenceUsed);

    let source = &ctx.accounts.member_token_account;
    require!(
        source.delegate == Some(ctx.accounts.spend_authority.key()).into() && source.delegated_amount >= amount,
        QlcError::AllowanceTooLow
    );

    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: ctx.accounts.qlc_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.spend_authority.to_account_info(),
            },
            &[&[SPEND_SEED, &[config.spend_bump]]],
        ),
        amount,
        QLC_DECIMALS,
    )?;

    let payer = ctx.accounts.member.wallet;
    ctx.accounts.member.last_charge_seq = seq;
    let config = &mut ctx.accounts.config;
    config.total_charged = config.total_charged.checked_add(amount).ok_or(QlcError::MathOverflow)?;
    ctx.accounts.charge_receipt.set_inner(ChargeReceipt {
        payer,
        seq,
        amount,
        status: ChargeStatus::Charged,
        charged_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.charge_receipt,
    });

    emit!(QlcCharged { payer, seq, amount });
    Ok(())
}
