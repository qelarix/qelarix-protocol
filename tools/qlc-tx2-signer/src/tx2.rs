//! The one transaction this tool can sign: the QLC program's `initialize`, signed and paid by the admin Ledger.
use {
    crate::constants::*,
    base64::Engine,
    solana_hash::Hash,
    solana_instruction::{AccountMeta, Instruction},
    solana_message::Message,
};

/// Anchor data: discriminator, operator, max delivery, max charge, mint window seconds, mint window cap (Borsh).
pub fn initialize_data(expected: &Expected) -> Vec<u8> {
    let limits = &expected.limits;
    let mut data = Vec::with_capacity(72);
    data.extend_from_slice(&INITIALIZE_DISCRIMINATOR);
    data.extend_from_slice(expected.operator.as_ref());
    data.extend_from_slice(&limits.max_delivery_amount.to_le_bytes());
    data.extend_from_slice(&limits.max_charge_amount.to_le_bytes());
    data.extend_from_slice(&limits.mint_window_secs.to_le_bytes());
    data.extend_from_slice(&limits.mint_window_cap.to_le_bytes());
    data
}

/// Accounts in the order of the program's `Initialize` struct (instructions/initialize.rs).
pub fn initialize_instruction(expected: &Expected, derived: &Derived) -> Instruction {
    Instruction {
        program_id: expected.program,
        accounts: vec![
            AccountMeta::new(expected.admin, true),
            AccountMeta::new(derived.config, false),
            AccountMeta::new_readonly(expected.mint, false),
            AccountMeta::new_readonly(derived.mint_authority, false),
            AccountMeta::new_readonly(derived.membership, false),
            AccountMeta::new_readonly(derived.vault_authority, false),
            AccountMeta::new_readonly(derived.spend_authority, false),
            AccountMeta::new(derived.vault, false),
            AccountMeta::new_readonly(expected.program, false),
            AccountMeta::new_readonly(derived.program_data, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(ASSOCIATED_TOKEN, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: initialize_data(expected),
    }
}

/// The canonical TX2 message for a blockhash: legacy, one instruction, the admin is fee payer and only signer.
pub fn tx2_message(expected: &Expected, derived: &Derived, blockhash: &Hash) -> Message {
    Message::new_with_blockhash(
        &[initialize_instruction(expected, derived)],
        Some(&expected.admin),
        blockhash,
    )
}

/// A message is acceptable only if it is, byte for byte, the canonical TX2 message for its own blockhash.
pub fn verify_message(
    message: &Message,
    expected: &Expected,
    derived: &Derived,
) -> Result<(), String> {
    let canonical = tx2_message(expected, derived, &message.recent_blockhash);
    let mut problems = Vec::new();
    if message.account_keys.first() != Some(&expected.admin) {
        problems.push(format!(
            "fee payer {:?} is not the admin {}",
            message.account_keys.first(),
            expected.admin
        ));
    }
    if message.header != canonical.header {
        problems.push(format!(
            "header {:?} (expected {:?}: the admin is the only signer)",
            message.header, canonical.header
        ));
    }
    if message.instructions.len() != 1 {
        problems.push(format!(
            "{} instructions (expected exactly 1)",
            message.instructions.len()
        ));
    }
    if let Some(ix) = message.instructions.first() {
        let program = message.account_keys.get(ix.program_id_index as usize);
        if program != Some(&expected.program) {
            problems.push(format!(
                "instruction program {program:?} is not the QLC program"
            ));
        }
        if ix.data != canonical.instructions[0].data {
            problems.push("instruction data differs from the reviewed initialize data".into());
        }
        let accounts: Vec<_> = ix
            .accounts
            .iter()
            .map(|i| message.account_keys.get(*i as usize))
            .collect();
        let reviewed: Vec<_> = canonical.instructions[0]
            .accounts
            .iter()
            .map(|i| canonical.account_keys.get(*i as usize))
            .collect();
        if accounts != reviewed {
            problems.push("instruction accounts differ from the reviewed initialize accounts (order or address)".into());
        }
    }
    if message.account_keys != canonical.account_keys {
        problems.push("message account list differs from the canonical TX2 account list".into());
    }
    if message.serialize() != canonical.serialize() {
        problems.push("message bytes differ from the canonical TX2 message".into());
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// True when two messages are identical except for the recent blockhash (the only field a refresh may change).
pub fn same_except_blockhash(a: &Message, b: &Message) -> bool {
    let (mut a, mut b) = (a.clone(), b.clone());
    a.recent_blockhash = Hash::default();
    b.recent_blockhash = Hash::default();
    a.serialize() == b.serialize()
}

/// base58(SHA-256(message bytes)): what the Ledger Solana app shows as "Message Hash" in blind-signing mode.
pub fn message_hash(message: &Message) -> String {
    solana_sha256_hasher::hash(&message.serialize()).to_string()
}

pub fn message_base64(message: &Message) -> String {
    base64::engine::general_purpose::STANDARD.encode(message.serialize())
}
