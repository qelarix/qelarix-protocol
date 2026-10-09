use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, ThawAccount},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::QlcError,
    mint_policy::{no_burn_authority, verify_mint_extensions, MintPolicy},
    program::QelarixQlc,
    state::Config,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub operator: Pubkey,
    pub max_delivery_amount: u64,
    pub max_charge_amount: u64,
    pub mint_window_secs: i64,
    pub mint_window_cap: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,

    #[account(mint::token_program = token_program)]
    pub qlc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: program-derived mint authority; the mint must already name it.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: program-derived freeze authority; the mint must already name it.
    #[account(seeds = [MEMBERSHIP_SEED], bump)]
    pub membership_authority: UncheckedAccount<'info>,

    /// CHECK: program-derived owner of the vault.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: program-derived spend delegate.
    #[account(seeds = [SPEND_SEED], bump)]
    pub spend_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = qlc_mint,
        associated_token::authority = vault_authority,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Only the upgrade authority may initialize, so nobody can front-run the first call.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ QlcError::Unauthorized)]
    pub program: Program<'info, QelarixQlc>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ QlcError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn validate_limits(max_delivery: u64, max_charge: u64, window_secs: i64, window_cap: u64) -> Result<()> {
    let stepped = |amount: u64| amount > 0 && amount % AMOUNT_STEP == 0;
    require!(
        stepped(max_delivery)
            && stepped(max_charge)
            && stepped(window_cap)
            && (MIN_MINT_WINDOW_SECS..=MAX_MINT_WINDOW_SECS).contains(&window_secs),
        QlcError::InvalidConfig
    );
    Ok(())
}

pub fn handle_initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(args.operator != Pubkey::default(), QlcError::InvalidConfig);
    validate_limits(args.max_delivery_amount, args.max_charge_amount, args.mint_window_secs, args.mint_window_cap)?;

    let mint = &ctx.accounts.qlc_mint;
    require!(
        mint.decimals == QLC_DECIMALS
            && mint.supply == 0
            && mint.mint_authority == Some(ctx.accounts.mint_authority.key()).into()
            && mint.freeze_authority == Some(ctx.accounts.membership_authority.key()).into(),
        QlcError::InvalidMint
    );
    {
        let mint_info = mint.to_account_info();
        let data = mint_info.try_borrow_data()?;
        verify_mint_extensions(
            &data,
            &MintPolicy {
                mint: &mint.key(),
                pause_authority: &ctx.accounts.admin.key(),
                no_burn_authority: &no_burn_authority(),
            },
        )?;
    }

    // New accounts start frozen; the program admits its own vault.
    let membership_bump = ctx.bumps.membership_authority;
    token_2022::thaw_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        ThawAccount {
            account: ctx.accounts.vault.to_account_info(),
            mint: mint.to_account_info(),
            authority: ctx.accounts.membership_authority.to_account_info(),
        },
        &[&[MEMBERSHIP_SEED, &[membership_bump]]],
    ))?;

    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        operator: args.operator,
        qlc_mint: mint.key(),
        vault: ctx.accounts.vault.key(),
        max_delivery_amount: args.max_delivery_amount,
        max_charge_amount: args.max_charge_amount,
        mint_window_secs: args.mint_window_secs,
        mint_window_cap: args.mint_window_cap,
        mint_window_start: Clock::get()?.unix_timestamp,
        minted_in_window: 0,
        paused: false,
        total_minted: 0,
        total_delivered: 0,
        total_charged: 0,
        total_refunded: 0,
        bump: ctx.bumps.config,
        mint_authority_bump: ctx.bumps.mint_authority,
        membership_bump,
        vault_bump: ctx.bumps.vault_authority,
        spend_bump: ctx.bumps.spend_authority,
    });
    Ok(())
}
