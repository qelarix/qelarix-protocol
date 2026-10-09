use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, spl_token_2022::state::AccountState, ThawAccount},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::QlcError,
    events::MemberRegistered,
    state::{Config, Member},
};

/// Admits a Qelarix wallet: records the member, creates its QLC account if missing (Qelarix pays
/// the rent) and thaws it. Idempotent. Membership needs two signatures: the wallet itself (its consent;
/// program-owned accounts such as DEX pools can never sign) and the operator (Qelarix vouches that the
/// wallet has a Qelarix account and sponsors the rent). Neither key can create a member alone.
#[derive(Accounts)]
pub struct RegisterMember<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = operator @ QlcError::Unauthorized,
        has_one = qlc_mint
    )]
    pub config: Account<'info, Config>,

    /// The member's wallet; must sign.
    pub wallet: Signer<'info>,

    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, wallet.key().as_ref()],
        bump
    )]
    pub member: Account<'info, Member>,

    pub qlc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = operator,
        associated_token::mint = qlc_mint,
        associated_token::authority = wallet,
        associated_token::token_program = token_program
    )]
    pub member_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program-derived freeze authority.
    #[account(seeds = [MEMBERSHIP_SEED], bump = config.membership_bump)]
    pub membership_authority: UncheckedAccount<'info>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_member(ctx: Context<RegisterMember>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, QlcError::Paused);

    let wallet = ctx.accounts.wallet.key();
    let token_account = ctx.accounts.member_token_account.key();
    let member = &mut ctx.accounts.member;
    if member.wallet == Pubkey::default() {
        member.set_inner(Member {
            wallet,
            token_account,
            suspended: false,
            registered_at: Clock::get()?.unix_timestamp,
            last_charge_seq: 0,
            bump: ctx.bumps.member,
        });
    }
    require!(!member.suspended, QlcError::MemberSuspended);
    require_keys_eq!(member.token_account, token_account, QlcError::WrongTokenAccount);

    if ctx.accounts.member_token_account.state == AccountState::Frozen {
        token_2022::thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            ThawAccount {
                account: ctx.accounts.member_token_account.to_account_info(),
                mint: ctx.accounts.qlc_mint.to_account_info(),
                authority: ctx.accounts.membership_authority.to_account_info(),
            },
            &[&[MEMBERSHIP_SEED, &[config.membership_bump]]],
        ))?;
    }

    emit!(MemberRegistered { wallet, token_account });
    Ok(())
}
