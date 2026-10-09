use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, spl_token_2022::state::AccountState, FreezeAccount, ThawAccount},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::QlcError,
    events::{ConfigUpdated, MemberSuspensionChanged},
    instructions::initialize::validate_limits,
    state::{Config, Member},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct UpdateConfigArgs {
    pub operator: Option<Pubkey>,
    pub max_delivery_amount: Option<u64>,
    pub max_charge_amount: Option<u64>,
    pub mint_window_secs: Option<i64>,
    pub mint_window_cap: Option<u64>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ QlcError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(operator) = args.operator {
        require!(operator != Pubkey::default(), QlcError::InvalidConfig);
        config.operator = operator;
    }
    let max_delivery = args.max_delivery_amount.unwrap_or(config.max_delivery_amount);
    let max_charge = args.max_charge_amount.unwrap_or(config.max_charge_amount);
    let window_secs = args.mint_window_secs.unwrap_or(config.mint_window_secs);
    let window_cap = args.mint_window_cap.unwrap_or(config.mint_window_cap);
    validate_limits(max_delivery, max_charge, window_secs, window_cap)?;
    config.max_delivery_amount = max_delivery;
    config.max_charge_amount = max_charge;
    config.mint_window_secs = window_secs;
    config.mint_window_cap = window_cap;
    if let Some(paused) = args.paused {
        config.paused = paused;
    }
    emit!(ConfigUpdated { admin: config.admin, operator: config.operator, paused: config.paused });
    Ok(())
}

/// Hands the admin role over. Both keys sign, so a mistyped address cannot lock the program.
#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,
    pub new_admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ QlcError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn handle_set_admin(ctx: Context<SetAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.new_admin.key();
    emit!(ConfigUpdated { admin: config.admin, operator: config.operator, paused: config.paused });
    Ok(())
}

/// Suspends (freezes) or reinstates (thaws) a member's QLC account. Reserved for abuse and
/// compliance cases; normal members are never frozen.
#[derive(Accounts)]
pub struct SetMemberSuspended<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ QlcError::Unauthorized, has_one = qlc_mint)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [MEMBER_SEED, member.wallet.as_ref()], bump = member.bump)]
    pub member: Account<'info, Member>,

    #[account(mut, address = member.token_account @ QlcError::WrongTokenAccount)]
    pub member_token_account: InterfaceAccount<'info, TokenAccount>,

    pub qlc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: program-derived freeze authority.
    #[account(seeds = [MEMBERSHIP_SEED], bump = config.membership_bump)]
    pub membership_authority: UncheckedAccount<'info>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_set_member_suspended(ctx: Context<SetMemberSuspended>, suspended: bool) -> Result<()> {
    let frozen = ctx.accounts.member_token_account.state == AccountState::Frozen;
    let seeds: &[&[&[u8]]] = &[&[MEMBERSHIP_SEED, &[ctx.accounts.config.membership_bump]]];
    let account = ctx.accounts.member_token_account.to_account_info();
    let mint = ctx.accounts.qlc_mint.to_account_info();
    let authority = ctx.accounts.membership_authority.to_account_info();
    let program = ctx.accounts.token_program.key();

    if suspended && !frozen {
        token_2022::freeze_account(CpiContext::new_with_signer(program, FreezeAccount { account, mint, authority }, seeds))?;
    } else if !suspended && frozen {
        token_2022::thaw_account(CpiContext::new_with_signer(program, ThawAccount { account, mint, authority }, seeds))?;
    }

    let member = &mut ctx.accounts.member;
    member.suspended = suspended;
    emit!(MemberSuspensionChanged { wallet: member.wallet, suspended });
    Ok(())
}
