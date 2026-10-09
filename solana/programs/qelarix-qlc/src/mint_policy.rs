//! QLC mint extension policy, checked once when the program is initialized.
//!
//! The extension list is read directly from the Token-2022 TLV data, so the check does not depend
//! on which extensions the bundled token interface crate knows about. Exactly these extensions
//! must be present, and nothing else:
//!   DefaultAccountState = Frozen   only the program can admit (thaw) member accounts
//!   PermissionedBurn               authority = the no-burn address: burning is impossible forever
//!   Pausable                       authority = admin, not paused at initialization
//!   TransferHook                   reserved: authority set, no hook program
//!   MetadataPointer + TokenMetadata metadata stored in the mint itself
use anchor_lang::prelude::*;

use crate::{constants::*, error::QlcError};

const EXT_DEFAULT_ACCOUNT_STATE: u16 = 6;
const EXT_TRANSFER_HOOK: u16 = 14;
const EXT_METADATA_POINTER: u16 = 18;
const EXT_TOKEN_METADATA: u16 = 19;
const EXT_PAUSABLE: u16 = 26;
const EXT_PERMISSIONED_BURN: u16 = 28;

const ACCOUNT_STATE_FROZEN: u8 = 2;

pub struct MintPolicy<'a> {
    pub mint: &'a Pubkey,
    pub pause_authority: &'a Pubkey,
    pub no_burn_authority: &'a Pubkey,
}

fn key_at(value: &[u8], offset: usize) -> Option<Pubkey> {
    value.get(offset..offset + 32).map(|bytes| Pubkey::try_from(bytes).unwrap_or_default())
}

pub fn verify_mint_extensions(data: &[u8], policy: &MintPolicy) -> Result<()> {
    require!(
        data.len() > EXTENSIONS_START && data[ACCOUNT_TYPE_OFFSET] == ACCOUNT_TYPE_MINT,
        QlcError::MintPolicyViolation
    );

    let mut seen: u8 = 0;
    let mut offset = EXTENSIONS_START;
    while offset + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        if kind == 0 {
            break;
        }
        let value = data
            .get(offset + 4..offset + 4 + len)
            .ok_or(QlcError::MintPolicyViolation)?;
        let bit = match kind {
            EXT_DEFAULT_ACCOUNT_STATE => {
                require!(value.first() == Some(&ACCOUNT_STATE_FROZEN), QlcError::MintPolicyViolation);
                1
            }
            EXT_PERMISSIONED_BURN => {
                require!(key_at(value, 0).as_ref() == Some(policy.no_burn_authority), QlcError::MintPolicyViolation);
                2
            }
            EXT_PAUSABLE => {
                require!(
                    key_at(value, 0).as_ref() == Some(policy.pause_authority) && value.get(32) == Some(&0),
                    QlcError::MintPolicyViolation
                );
                4
            }
            EXT_TRANSFER_HOOK => {
                let authority = key_at(value, 0).ok_or(QlcError::MintPolicyViolation)?;
                let program = key_at(value, 32).ok_or(QlcError::MintPolicyViolation)?;
                require!(
                    authority != Pubkey::default() && program == Pubkey::default(),
                    QlcError::MintPolicyViolation
                );
                8
            }
            EXT_METADATA_POINTER => {
                require!(key_at(value, 32).as_ref() == Some(policy.mint), QlcError::MintPolicyViolation);
                16
            }
            EXT_TOKEN_METADATA => 32,
            _ => return err!(QlcError::MintPolicyViolation),
        };
        require!(seen & bit == 0, QlcError::MintPolicyViolation);
        seen |= bit;
        offset += 4 + len;
    }
    require!(seen == 0b11_1111, QlcError::MintPolicyViolation);
    Ok(())
}

/// The PermissionedBurn authority every QLC mint must use.
pub fn no_burn_authority() -> Pubkey {
    Pubkey::find_program_address(&[NO_BURN_SEED], &anchor_lang::system_program::ID).0
}
