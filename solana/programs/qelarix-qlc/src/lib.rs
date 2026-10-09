//! Qelarix QLC program.
//!
//! QLC is a Token-2022 credit used inside Qelarix. Every critical authority belongs to this program:
//! the mint authority, the freeze (membership) authority, the vault that receives spent QLC and the
//! delegate members approve for spending. The program only moves QLC under these rules:
//!   - new accounts are frozen; only registered Qelarix members are thawed;
//!   - deliveries are exactly-once per id, use vault inventory first and mint only the shortfall,
//!     and newly minted QLC is capped per window;
//!   - membership needs the wallet's own signature and the operator's;
//!   - charges come from a member's own approved allowance and go to the vault; each charge uses a
//!     strictly increasing per-member sequence (never replayable) and is refunded at most once;
//!   - every amount is a positive multiple of 0.05 QLC;
//!   - there is no burn: the mint's PermissionedBurn authority can never sign.
//! The operator key can only submit these instructions; it holds no token authority.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod mint_policy;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa");

#[program]
pub mod qelarix_qlc {
    use super::*;

    /// One-time setup by the upgrade authority; verifies the QLC mint against the policy.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, args)
    }

    pub fn register_member(ctx: Context<RegisterMember>) -> Result<()> {
        instructions::register_member::handle_register_member(ctx)
    }

    pub fn deliver(ctx: Context<Deliver>, delivery_id: [u8; 32], amount: u64, kind: DeliveryKind) -> Result<()> {
        instructions::deliver::handle_deliver(ctx, delivery_id, amount, kind)
    }

    pub fn charge(ctx: Context<Charge>, seq: u64, amount: u64) -> Result<()> {
        instructions::charge::handle_charge(ctx, seq, amount)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::handle_refund(ctx)
    }

    pub fn close_charge(ctx: Context<CloseCharge>) -> Result<()> {
        instructions::close_charge::handle_close_charge(ctx)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::admin::handle_update_config(ctx, args)
    }

    pub fn set_admin(ctx: Context<SetAdmin>) -> Result<()> {
        instructions::admin::handle_set_admin(ctx)
    }

    pub fn set_member_suspended(ctx: Context<SetMemberSuspended>, suspended: bool) -> Result<()> {
        instructions::admin::handle_set_member_suspended(ctx, suspended)
    }
}
