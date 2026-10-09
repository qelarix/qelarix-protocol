use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, MintToChecked, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::QlcError,
    events::QlcDelivered,
    state::{Config, DeliveryKind, DeliveryReceipt, Member},
};

/// Delivers QLC to a member exactly once per delivery id: vault inventory first, newly minted QLC
/// only for the shortfall (mint on demand + vault reuse). Minting is capped per window.
#[derive(Accounts)]
#[instruction(delivery_id: [u8; 32])]
pub struct Deliver<'info> {
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

    #[account(seeds = [MEMBER_SEED, member.wallet.as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,

    #[account(mut, address = member.token_account @ QlcError::WrongTokenAccount)]
    pub member_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = operator,
        space = 8 + DeliveryReceipt::INIT_SPACE,
        seeds = [DELIVERY_SEED, delivery_id.as_ref()],
        bump
    )]
    pub delivery_receipt: Account<'info, DeliveryReceipt>,

    #[account(mut)]
    pub qlc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program-derived vault owner.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: program-derived mint authority.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump = config.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deliver(ctx: Context<Deliver>, delivery_id: [u8; 32], amount: u64, kind: DeliveryKind) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, QlcError::Paused);
    require!(amount > 0 && amount % AMOUNT_STEP == 0, QlcError::InvalidAmount);
    require!(amount <= config.max_delivery_amount, QlcError::AmountAboveLimit);
    require!(!ctx.accounts.member.suspended, QlcError::MemberSuspended);

    let from_vault = ctx.accounts.vault.amount.min(amount);
    let minted = amount - from_vault;
    let token_program = ctx.accounts.token_program.key();

    if from_vault > 0 {
        token_2022::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.qlc_mint.to_account_info(),
                    to: ctx.accounts.member_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[&[VAULT_SEED, &[config.vault_bump]]],
            ),
            from_vault,
            QLC_DECIMALS,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    if minted > 0 {
        if now >= config.mint_window_start.saturating_add(config.mint_window_secs) {
            config.mint_window_start = now;
            config.minted_in_window = 0;
        }
        let window_total = config.minted_in_window.checked_add(minted).ok_or(QlcError::MathOverflow)?;
        require!(window_total <= config.mint_window_cap, QlcError::MintWindowCapExceeded);
        config.minted_in_window = window_total;
        config.total_minted = config.total_minted.checked_add(minted).ok_or(QlcError::MathOverflow)?;

        token_2022::mint_to_checked(
            CpiContext::new_with_signer(
                token_program,
                MintToChecked {
                    mint: ctx.accounts.qlc_mint.to_account_info(),
                    to: ctx.accounts.member_token_account.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[&[MINT_AUTHORITY_SEED, &[config.mint_authority_bump]]],
            ),
            minted,
            QLC_DECIMALS,
        )?;
    }
    config.total_delivered = config.total_delivered.checked_add(amount).ok_or(QlcError::MathOverflow)?;

    let recipient = ctx.accounts.member.wallet;
    ctx.accounts.delivery_receipt.set_inner(DeliveryReceipt {
        delivery_id,
        recipient,
        kind,
        amount,
        from_vault,
        minted,
        delivered_at: now,
        bump: ctx.bumps.delivery_receipt,
    });

    emit!(QlcDelivered { delivery_id, recipient, kind, amount, from_vault, minted });
    Ok(())
}
