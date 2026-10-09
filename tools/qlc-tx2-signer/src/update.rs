//! Gate G3: the admin Ledger raises the QLC program's per-charge cap with `update_config`.
//!
//! The only change this module can build is `update_config({ max_charge_amount: Some(120000) })` with every other
//! field `None` (unchanged). It refuses any other cluster, program, admin, current value or result, simulates
//! before the Ledger is asked, and checks the account after confirmation. It never sends twice.
use {
    crate::{
        chain::{Chain, Status},
        constants::*,
        flow::{Owner, Timing},
        policy::{program_checks, Check},
        tx2::{message_base64, message_hash, same_except_blockhash},
    },
    solana_hash::Hash,
    solana_instruction::{AccountMeta, Instruction},
    solana_message::Message,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_signer::Signer,
    solana_transaction::Transaction,
};

/// Anchor discriminator of `update_config` (sha256("global:update_config")[..8]; equals the generated client).
pub const UPDATE_CONFIG_DISCRIMINATOR: [u8; 8] = [29, 158, 252, 191, 10, 83, 219, 99];
/// Current approved devnet cap: 100.00 QLC (QLC has 2 decimals).
pub const CURRENT_MAX_CHARGE: u64 = 10_000;
/// Owner-approved G3 cap: 1,200.00 QLC. Covers every configured generation cost (generation-billing-check).
pub const TARGET_MAX_CHARGE: u64 = 120_000;

// Config account layout (8-byte discriminator + Config fields, solana/programs/qelarix-qlc/src/state.rs).
const OFF_ADMIN: usize = 8;
const OFF_OPERATOR: usize = 40;
const OFF_MINT: usize = 72;
const OFF_VAULT: usize = 104;
const OFF_MAX_DELIVERY: usize = 136;
const OFF_MAX_CHARGE: usize = 144;
const OFF_WINDOW_SECS: usize = 152;
const OFF_WINDOW_CAP: usize = 160;
const OFF_PAUSED: usize = 184;
const OFF_BUMPS: usize = 217;

fn pubkey_at(d: &[u8], o: usize) -> Option<Pubkey> {
    d.get(o..o + 32)
        .map(|b| Pubkey::new_from_array(b.try_into().unwrap()))
}
fn u64_at(d: &[u8], o: usize) -> Option<u64> {
    d.get(o..o + 8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}
fn i64_at(d: &[u8], o: usize) -> Option<i64> {
    d.get(o..o + 8)
        .map(|b| i64::from_le_bytes(b.try_into().unwrap()))
}

/// Borsh `UpdateConfigArgs`: operator None, max_delivery None, max_charge Some(target), window_secs None,
/// window_cap None, paused None.
pub fn update_config_data() -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 1 + 1 + 9 + 1 + 1 + 1);
    data.extend_from_slice(&UPDATE_CONFIG_DISCRIMINATOR);
    data.push(0); // operator: None
    data.push(0); // max_delivery_amount: None
    data.push(1); // max_charge_amount: Some
    data.extend_from_slice(&TARGET_MAX_CHARGE.to_le_bytes());
    data.push(0); // mint_window_secs: None
    data.push(0); // mint_window_cap: None
    data.push(0); // paused: None
    data
}

/// Accounts in the order of the program's `UpdateConfig` struct: admin (signer), config (writable).
pub fn update_config_instruction(expected: &Expected, derived: &Derived) -> Instruction {
    Instruction {
        program_id: expected.program,
        accounts: vec![
            AccountMeta::new_readonly(expected.admin, true),
            AccountMeta::new(derived.config, false),
        ],
        data: update_config_data(),
    }
}

/// The canonical G3 message: legacy, one instruction, the admin Ledger is fee payer and only signer.
pub fn update_message(expected: &Expected, derived: &Derived, blockhash: &Hash) -> Message {
    Message::new_with_blockhash(
        &[update_config_instruction(expected, derived)],
        Some(&expected.admin),
        blockhash,
    )
}

/// A message is acceptable only if it is, byte for byte, the canonical G3 message for its own blockhash.
pub fn verify_update_message(
    message: &Message,
    expected: &Expected,
    derived: &Derived,
) -> Result<(), String> {
    let canonical = update_message(expected, derived, &message.recent_blockhash);
    if message.account_keys.first() != Some(&expected.admin) {
        return Err(format!(
            "fee payer {:?} is not the admin {}",
            message.account_keys.first(),
            expected.admin
        ));
    }
    if message.instructions.len() != 1 {
        return Err(format!(
            "{} instructions (expected exactly 1)",
            message.instructions.len()
        ));
    }
    if message.serialize() != canonical.serialize() {
        return Err("message bytes differ from the canonical update_config message".into());
    }
    Ok(())
}

/// The fields G3 must never touch, read from a config account.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Fixed {
    admin: Option<Pubkey>,
    operator: Option<Pubkey>,
    mint: Option<Pubkey>,
    vault: Option<Pubkey>,
    max_delivery: Option<u64>,
    window_secs: Option<i64>,
    window_cap: Option<u64>,
    paused: Option<u8>,
    bumps: Option<Vec<u8>>,
}

fn fixed(d: &[u8]) -> Fixed {
    Fixed {
        admin: pubkey_at(d, OFF_ADMIN),
        operator: pubkey_at(d, OFF_OPERATOR),
        mint: pubkey_at(d, OFF_MINT),
        vault: pubkey_at(d, OFF_VAULT),
        max_delivery: u64_at(d, OFF_MAX_DELIVERY),
        window_secs: i64_at(d, OFF_WINDOW_SECS),
        window_cap: u64_at(d, OFF_WINDOW_CAP),
        paused: d.get(OFF_PAUSED).copied(),
        bumps: d.get(OFF_BUMPS..OFF_BUMPS + 5).map(|b| b.to_vec()),
    }
}

/// The live config must be the approved one: program-owned, admin = the Ledger admin, the approved operator, mint,
/// vault and limits, with the cap still at 100.00 QLC (G3 not yet applied).
fn current_config_checks(
    config: Option<&crate::chain::AccountInfo>,
    expected: &Expected,
    derived: &Derived,
) -> Vec<Check> {
    let Some(config) = config else {
        return vec![Check::new(
            format!("config {} exists", derived.config),
            false,
            "account not found",
        )];
    };
    let d = &config.data;
    let limits = &expected.limits;
    vec![
        Check::new(
            "config: program-owned, 222 bytes, Config discriminator",
            config.owner == expected.program
                && d.len() == CONFIG_SIZE
                && d.get(0..8) == Some(&CONFIG_DISCRIMINATOR[..]),
            format!("owner {}, {} bytes", config.owner, d.len()),
        ),
        Check::new(
            "config: admin, operator, mint and vault exactly as approved",
            pubkey_at(d, OFF_ADMIN) == Some(expected.admin)
                && pubkey_at(d, OFF_OPERATOR) == Some(expected.operator)
                && pubkey_at(d, OFF_MINT) == Some(expected.mint)
                && pubkey_at(d, OFF_VAULT) == Some(derived.vault),
            format!(
                "admin {:?}, operator {:?}",
                pubkey_at(d, OFF_ADMIN),
                pubkey_at(d, OFF_OPERATOR)
            ),
        ),
        Check::new(
            "config: other limits exactly as approved (1000000 / 86400 s / 2000000), not paused",
            u64_at(d, OFF_MAX_DELIVERY) == Some(limits.max_delivery_amount)
                && i64_at(d, OFF_WINDOW_SECS) == Some(limits.mint_window_secs)
                && u64_at(d, OFF_WINDOW_CAP) == Some(limits.mint_window_cap)
                && d.get(OFF_PAUSED) == Some(&0),
            format!(
                "{:?} / {:?} / {:?}, paused {:?}",
                u64_at(d, OFF_MAX_DELIVERY),
                i64_at(d, OFF_WINDOW_SECS),
                u64_at(d, OFF_WINDOW_CAP),
                d.get(OFF_PAUSED)
            ),
        ),
        Check::new(
            format!(
                "stage: max_charge_amount is {CURRENT_MAX_CHARGE} (100.00 QLC), G3 not applied yet"
            ),
            u64_at(d, OFF_MAX_CHARGE) == Some(CURRENT_MAX_CHARGE),
            format!("max_charge_amount {:?}", u64_at(d, OFF_MAX_CHARGE)),
        ),
    ]
}

/// After G3 (simulated or confirmed): the cap is the target and every field G3 must not touch is unchanged.
fn result_checks(
    before: &[u8],
    after: Option<&crate::chain::AccountInfo>,
    label: &str,
) -> Vec<Check> {
    let Some(after) = after else {
        return vec![Check::new(
            format!("{label}: config readable"),
            false,
            "account not found",
        )];
    };
    vec![
        Check::new(
            format!("{label}: max_charge_amount = {TARGET_MAX_CHARGE} (1,200.00 QLC)"),
            u64_at(&after.data, OFF_MAX_CHARGE) == Some(TARGET_MAX_CHARGE),
            format!("{:?}", u64_at(&after.data, OFF_MAX_CHARGE)),
        ),
        Check::new(
            format!("{label}: admin, operator, mint, vault, other limits, paused flag and bumps unchanged"),
            fixed(&after.data) == fixed(before) && after.data.len() == CONFIG_SIZE,
            if fixed(&after.data) == fixed(before) { "unchanged".to_string() } else { format!("{:?} -> {:?}", fixed(before), fixed(&after.data)) },
        ),
    ]
}

fn all_ok(checks: &[Check]) -> bool {
    checks.iter().all(|c| c.ok)
}

#[derive(Clone, Debug)]
pub struct ReviewedUpdate {
    pub message: Message,
    pub hash: String,
    pub last_valid_block_height: u64,
    pub fee: u64,
    pub config_before: Vec<u8>,
}

#[derive(Debug)]
pub struct UpdateReport {
    pub checks: Vec<Check>,
    pub reviewed: Option<ReviewedUpdate>,
}

/// Fee, admin balance, simulation and simulated-result checks for one exact message.
fn update_message_checks(
    chain: &dyn Chain,
    expected: &Expected,
    derived: &Derived,
    message: &Message,
    config_before: &[u8],
) -> (Vec<Check>, u64) {
    let mut checks = Vec::new();
    let (fee, floor, balance) = match (|| -> Result<_, String> {
        Ok((
            chain.fee_for_message(message)?,
            chain.rent_exempt_minimum(0)?,
            chain.account(&expected.admin)?.map_or(0, |a| a.lamports),
        ))
    })() {
        Ok(v) => v,
        Err(e) => {
            return (
                vec![Check::new(
                    "costs: read live fee and admin balance",
                    false,
                    e,
                )],
                0,
            )
        }
    };
    checks.push(Check::new(
        "fee: exactly one signature (5000 lamports), no priority fee",
        fee == LAMPORTS_PER_SIGNATURE,
        format!("{fee} lamports"),
    ));
    checks.push(Check::new(
        "funds: admin pays the fee and stays rent-exempt or empty",
        balance >= fee && (balance == fee || balance - fee >= floor),
        format!("admin balance {balance}; fee {fee}; rent-exempt floor {floor}"),
    ));
    if !all_ok(&checks) {
        checks.push(Check::new(
            "simulation",
            false,
            "not run: a prerequisite failed",
        ));
        return (checks, fee);
    }
    match chain.simulate(
        &Transaction::new_unsigned(message.clone()),
        &[derived.config],
    ) {
        Err(e) => checks.push(Check::new(
            "simulation: succeeds (signature verification off, nothing signed or sent)",
            false,
            e,
        )),
        Ok(sim) => {
            checks.push(Check::new(
                "simulation: succeeds (signature verification off, nothing signed or sent)",
                sim.err.is_none(),
                match &sim.err {
                    None => format!("{} CU", sim.units.unwrap_or_default()),
                    Some(e) => format!(
                        "{e} | {}",
                        sim.logs
                            .iter()
                            .rev()
                            .take(3)
                            .rev()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(" | ")
                    ),
                },
            ));
            if sim.err.is_none() {
                let after = sim.accounts.first().cloned().flatten();
                checks.extend(result_checks(config_before, after.as_ref(), "simulated"));
            }
        }
    }
    (checks, fee)
}

/// Read-only G3 plan: devnet, program, current config, the canonical message, its simulation and Message Hash.
pub fn plan_update(chain: &dyn Chain, expected: &Expected) -> UpdateReport {
    let derived = Derived::new(expected);
    let mut checks = Vec::new();
    let stop = |mut checks: Vec<Check>, name: &str, detail: String| {
        checks.push(Check::new(name, false, detail));
        UpdateReport {
            checks,
            reviewed: None,
        }
    };
    match chain.genesis_hash() {
        Ok(g) if g == expected.genesis => checks.push(Check::new(
            "cluster: RPC genesis is Solana devnet",
            true,
            g.to_string(),
        )),
        Ok(g) => {
            return stop(
                checks,
                "cluster: RPC genesis is Solana devnet",
                format!("{g}: not devnet (every other cluster is refused)"),
            )
        }
        Err(e) => return stop(checks, "cluster: RPC genesis is Solana devnet", e),
    }
    let read = (|| -> Result<_, String> {
        Ok((
            chain.account(&expected.program)?,
            chain.account(&derived.program_data)?,
            chain.account(&derived.config)?,
        ))
    })();
    let (program, program_data, config) = match read {
        Ok(v) => v,
        Err(e) => return stop(checks, "accounts: read program, ProgramData and config", e),
    };
    checks.extend(program_checks(
        program.as_ref(),
        program_data.as_ref(),
        expected,
        &derived,
    ));
    checks.extend(current_config_checks(config.as_ref(), expected, &derived));
    let (blockhash, last_valid_block_height) = match chain.latest_blockhash() {
        Ok(v) => v,
        Err(e) => return stop(checks, "blockhash: latest", e),
    };
    let message = update_message(expected, &derived, &blockhash);
    let verified = verify_update_message(&message, expected, &derived);
    checks.push(Check::new(
        "message: exactly update_config({ max_charge_amount: 120000 }), one instruction, admin is the only signer and fee payer",
        verified.is_ok(),
        verified.err().unwrap_or_else(|| format!("{} bytes, blockhash {blockhash}", message.serialize().len())),
    ));
    if !all_ok(&checks) {
        checks.push(Check::new(
            "simulation",
            false,
            "not run: a prerequisite failed",
        ));
        return UpdateReport {
            checks,
            reviewed: None,
        };
    }
    let config_before = config.map(|c| c.data).unwrap_or_default();
    let (more, fee) = update_message_checks(chain, expected, &derived, &message, &config_before);
    checks.extend(more);
    let reviewed = all_ok(&checks).then(|| ReviewedUpdate {
        hash: message_hash(&message),
        message,
        last_valid_block_height,
        fee,
        config_before,
    });
    UpdateReport { checks, reviewed }
}

fn show_checks(owner: &mut dyn Owner, checks: &[Check]) {
    for c in checks {
        owner.show(&format!(
            "{}  {}  — {}",
            if c.ok { "PASS" } else { "FAIL" },
            c.name,
            c.detail
        ));
    }
}

/// OWNER MUTATION: refresh, re-verify, ask the Ledger to sign, send once, confirm, verify the result.
pub fn sign_and_send_update(
    chain: &dyn Chain,
    expected: &Expected,
    signer: &dyn Signer,
    owner: &mut dyn Owner,
    timing: Timing,
) -> Result<Signature, String> {
    let derived = Derived::new(expected);
    let report = plan_update(chain, expected);
    show_checks(owner, &report.checks);
    let Some(reviewed) = report.reviewed else {
        return Err("STOP: the plan failed; nothing was signed or sent".into());
    };
    let ledger = signer.try_pubkey().map_err(|e| {
        format!("STOP: could not read the Ledger public key ({e}); nothing was signed")
    })?;
    if ledger != expected.admin {
        return Err(format!("STOP: the Ledger account {ledger} is not the admin {}; nothing was signed (check the ?key= index)", expected.admin));
    }
    owner.show(&format!("PASS  Ledger account = admin {ledger}"));

    let (blockhash, last_valid_block_height) = chain
        .latest_blockhash()
        .map_err(|e| format!("STOP: {e}; nothing was signed"))?;
    let message = update_message(expected, &derived, &blockhash);
    if !same_except_blockhash(&reviewed.message, &message) {
        return Err("STOP: the refreshed message differs from the reviewed message beyond the blockhash; nothing was signed".into());
    }
    verify_update_message(&message, expected, &derived)
        .map_err(|e| format!("STOP: refreshed message refused: {e}; nothing was signed"))?;
    let config_now = chain
        .account(&derived.config)
        .map_err(|e| format!("STOP: {e}; nothing was signed"))?;
    let current = current_config_checks(config_now.as_ref(), expected, &derived);
    if !all_ok(&current) {
        show_checks(owner, &current);
        return Err("STOP: the config changed since the plan; nothing was signed".into());
    }
    let config_before = config_now.map(|c| c.data).unwrap_or_default();
    let (checks, fee) = update_message_checks(chain, expected, &derived, &message, &config_before);
    show_checks(owner, &checks);
    if !all_ok(&checks) {
        return Err(
            "STOP: the refreshed message failed its checks or simulation; nothing was signed"
                .into(),
        );
    }
    let hash = message_hash(&message);
    owner.show(&format!(
        "G3 message (base64, for the independent check): {}",
        message_base64(&message)
    ));
    owner.show(&format!("Change: max_charge_amount {CURRENT_MAX_CHARGE} -> {TARGET_MAX_CHARGE} (100.00 -> 1,200.00 QLC); nothing else changes. Fee {fee} lamports, paid by the admin. Valid until block height {last_valid_block_height}"));
    owner.show(&format!(
        "Message Hash (must equal the Ledger screen): {hash}"
    ));
    if !owner.confirm_hash(&hash) {
        return Err("STOP: not confirmed by the owner; nothing was signed".into());
    }

    let signature = signer
        .try_sign_message(&message.serialize())
        .map_err(|e| format!("STOP: the Ledger did not sign ({e}): rejected, locked or disconnected. Nothing was sent; rerun from the start"))?;
    let transaction = Transaction {
        signatures: vec![signature],
        message,
    };
    transaction.verify().map_err(|e| {
        format!(
            "STOP: the returned signature does not verify for the admin ({e}); nothing was sent"
        )
    })?;

    let height = chain
        .block_height()
        .map_err(|e| format!("STOP: {e}; nothing was sent"))?;
    if height > last_valid_block_height {
        return Err(format!("STOP: the blockhash expired before sending (block height {height} > {last_valid_block_height}); nothing was sent. Rerun from the start"));
    }
    let pre_send = current_config_checks(
        chain
            .account(&derived.config)
            .map_err(|e| format!("STOP: {e}; nothing was sent"))?
            .as_ref(),
        expected,
        &derived,
    );
    if !all_ok(&pre_send) {
        show_checks(owner, &pre_send);
        return Err("STOP: the config changed after signing; nothing was sent. Run the read-only config-plan".into());
    }

    owner.show(&format!("G3 signature (transaction id): {signature}"));
    match chain.send(&transaction) {
        Ok(sent) if sent == signature => owner.show("sent once; waiting for confirmation (never resent by this tool)"),
        Ok(sent) => return Err(format!("STOP: the RPC returned signature {sent}, expected {signature}. Do not resend; check both read-only")),
        Err(e) => {
            let status = chain.status(&signature);
            if status != Ok(Status::Confirmed) {
                return Err(format!("STOP: sending failed ({e}); status {status:?}. Do not resend. Run config-plan read-only: if max_charge_amount is still 10000 once block height {last_valid_block_height} has passed, G3 did not land and the command may be rerun"));
            }
        }
    }
    let mut confirmed = false;
    for _ in 0..timing.max_polls {
        let height = chain.block_height().ok();
        match chain.status(&signature) {
            Ok(Status::Confirmed) => {
                confirmed = true;
                break;
            }
            Ok(Status::Failed(e)) => return Err(format!("STOP: G3 failed on chain ({e}); it changed nothing (atomic). Run config-plan read-only")),
            Ok(Status::NotFound) if height.is_some_and(|h| h > last_valid_block_height) => {
                return Err(format!("STOP: the blockhash expired and G3 {signature} was not found: it did not land. Confirm with config-plan before rerunning"));
            }
            _ => {}
        }
        std::thread::sleep(timing.poll);
    }
    if !confirmed {
        return Err(format!("STOP: confirmation timed out; G3 {signature} may still land. Do NOT resend. Check the signature and run the read-only verifier"));
    }
    let after = chain.account(&derived.config).map_err(|e| format!("STOP: G3 confirmed but the config could not be read ({e}). Do not resend; run the verifier"))?;
    let post = result_checks(&config_before, after.as_ref(), "confirmed");
    show_checks(owner, &post);
    if !all_ok(&post) {
        return Err(format!("STOP: G3 {signature} confirmed but the result does not match the approved change. Do not continue; escalate"));
    }
    owner.show(&format!("G3 confirmed and verified: {signature}"));
    Ok(signature)
}
