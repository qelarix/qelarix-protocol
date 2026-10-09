use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
/// Mint authority of the QLC mint.
#[constant]
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
/// Freeze authority of the QLC mint: thaws member accounts, freezes suspended members.
#[constant]
pub const MEMBERSHIP_SEED: &[u8] = b"membership";
/// Owner of the QLC vault: spent QLC comes back here and is reused for deliveries.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
/// Delegate that members approve for generation spending.
#[constant]
pub const SPEND_SEED: &[u8] = b"spend";
#[constant]
pub const MEMBER_SEED: &[u8] = b"member";
#[constant]
pub const DELIVERY_SEED: &[u8] = b"delivery";
#[constant]
pub const CHARGE_SEED: &[u8] = b"charge";
/// The mint's PermissionedBurn authority is the address derived from this seed under the System
/// Program. The System Program never signs for derived addresses, so no burn can ever be authorized.
#[constant]
pub const NO_BURN_SEED: &[u8] = b"qlc-permanent-no-burn";

pub const QLC_DECIMALS: u8 = 2;
/// Every QLC amount the program moves is a multiple of 0.05 QLC (5 base units).
pub const AMOUNT_STEP: u64 = 5;

pub const MIN_MINT_WINDOW_SECS: i64 = 60;
pub const MAX_MINT_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

/// Token-2022 layout: extension data starts after the 165-byte base area and the account-type byte.
pub const EXTENSIONS_START: usize = 166;
pub const ACCOUNT_TYPE_OFFSET: usize = 165;
pub const ACCOUNT_TYPE_MINT: u8 = 1;
