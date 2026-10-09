//! The read-only plan and the owner signing sequence. Every check fails closed; nothing is retried blindly.
use {
    crate::{
        chain::{Chain, Status},
        constants::*,
        policy::{config_checks, mint_checks, program_checks, vault_checks, Check},
        tx2::{message_base64, message_hash, same_except_blockhash, tx2_message, verify_message},
    },
    solana_message::Message,
    solana_signature::Signature,
    solana_signer::Signer,
    solana_transaction::Transaction,
    std::time::Duration,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Costs {
    /// Rent the program makes the admin pay (`payer = admin`): config and vault accounts.
    pub rent_config: u64,
    pub rent_vault: u64,
    /// Transaction fee, also paid by the admin (fee payer): one signature, no priority fee.
    pub fee: u64,
    pub total: u64,
    /// Minimum balance of a 0-byte account. Conservative signer policy: the admin must end at 0 or at least this
    /// (a runtime rule in Agave v4.1.2; see docs/qlc-ledger-tx2-signer.md for the source evidence).
    pub rent_exempt_floor: u64,
    pub admin_balance: u64,
}

impl Costs {
    /// Funding that leaves the admin rent-exempt after TX2.
    pub fn recommended_balance(&self) -> u64 {
        self.total + self.rent_exempt_floor
    }
}

#[derive(Clone, Debug)]
pub struct Reviewed {
    pub message: Message,
    pub hash: String,
    pub last_valid_block_height: u64,
    pub costs: Costs,
}

#[derive(Debug)]
pub struct Report {
    pub checks: Vec<Check>,
    pub reviewed: Option<Reviewed>,
    /// Live costs, reported even when blocked so the owner knows the funding TX2 will need.
    pub costs: Option<Costs>,
}

fn all_ok(checks: &[Check]) -> bool {
    checks.iter().all(|c| c.ok)
}

/// Live fee for the exact message, live rent for the accounts TX2 creates, and the admin's balance.
fn read_costs(chain: &dyn Chain, expected: &Expected, message: &Message) -> Result<Costs, String> {
    let (rent_config, rent_vault, fee) = (
        chain.rent_exempt_minimum(CONFIG_SIZE)?,
        chain.rent_exempt_minimum(VAULT_SIZE)?,
        chain.fee_for_message(message)?,
    );
    Ok(Costs {
        rent_config,
        rent_vault,
        fee,
        total: rent_config + rent_vault + fee,
        rent_exempt_floor: chain.rent_exempt_minimum(0)?,
        admin_balance: chain.account(&expected.admin)?.map_or(0, |a| a.lamports),
    })
}

/// Fee, balance, simulation and simulated-result checks for one exact message.
fn message_checks(
    chain: &dyn Chain,
    expected: &Expected,
    derived: &Derived,
    message: &Message,
) -> (Vec<Check>, Option<Costs>) {
    let mut checks = Vec::new();
    let costs = match read_costs(chain, expected, message) {
        Ok(costs) => costs,
        Err(e) => {
            return (
                vec![Check::new(
                    "costs: read live fee, rent and admin balance",
                    false,
                    e,
                )],
                None,
            )
        }
    };
    let Costs {
        rent_config,
        rent_vault,
        fee,
        total,
        rent_exempt_floor: floor,
        admin_balance: balance,
    } = costs.clone();
    checks.push(Check::new(
        "fee: exactly one signature (5000 lamports), no priority fee",
        fee == LAMPORTS_PER_SIGNATURE,
        format!("{fee} lamports"),
    ));
    checks.push(Check::new(
        format!("funds: admin pays fee + config rent + vault rent = {total} lamports and stays rent-exempt or empty"),
        balance >= total && (balance == total || balance - total >= floor),
        format!(
            "admin balance {balance}; needs exactly {total} or at least {} (fee {fee} + config rent {rent_config} + vault rent {rent_vault} + rent-exempt floor {floor})",
            total + floor
        ),
    ));
    if !all_ok(&checks) {
        checks.push(Check::new(
            "simulation",
            false,
            "not run: a prerequisite failed",
        ));
        return (checks, Some(costs));
    }
    match chain.simulate(
        &Transaction::new_unsigned(message.clone()),
        &[derived.config, derived.vault, expected.admin],
    ) {
        Err(e) => checks.push(Check::new(
            "simulation: succeeds (signature verification off, nothing signed or sent)",
            false,
            e,
        )),
        Ok(simulation) => {
            checks.push(Check::new(
                "simulation: succeeds (signature verification off, nothing signed or sent)",
                simulation.err.is_none(),
                match &simulation.err {
                    None => format!("{} CU", simulation.units.unwrap_or_default()),
                    Some(e) => format!(
                        "{e} | {}",
                        simulation
                            .logs
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
            if simulation.err.is_none() {
                let account = |i: usize| simulation.accounts.get(i).cloned().flatten();
                checks.push(Check::new(
                    "simulation: fee = 5000 lamports",
                    simulation.fee.is_none_or(|f| f == fee),
                    format!("{:?}", simulation.fee),
                ));
                for c in config_checks(account(0).as_ref(), expected, derived, rent_config)
                    .into_iter()
                    .chain(vault_checks(
                        account(1).as_ref(),
                        expected,
                        derived,
                        rent_vault,
                    ))
                {
                    checks.push(Check {
                        name: format!("simulated {}", c.name),
                        ..c
                    });
                }
                let admin_after = account(2).map_or(0, |a| a.lamports);
                checks.push(Check::new(
                    "simulation: admin pays exactly fee + rent",
                    admin_after == balance - total,
                    format!("admin {balance} → {admin_after} lamports"),
                ));
            }
        }
    }
    (checks, Some(costs))
}

/// Read-only plan: every precondition, the canonical TX2 message, its simulation and its Ledger "Message Hash".
pub fn plan(chain: &dyn Chain, expected: &Expected) -> Report {
    let derived = Derived::new(expected);
    let mut checks = Vec::new();
    let stop = |mut checks: Vec<Check>, name: &str, detail: String| {
        checks.push(Check::new(name, false, detail));
        Report {
            checks,
            reviewed: None,
            costs: None,
        }
    };
    match chain.genesis_hash() {
        Ok(genesis) if genesis == expected.genesis => checks.push(Check::new(
            "cluster: RPC genesis is Solana devnet",
            true,
            genesis.to_string(),
        )),
        Ok(genesis) => {
            return stop(
                checks,
                "cluster: RPC genesis is Solana devnet",
                format!("{genesis}: not devnet (mainnet and every other cluster are refused)"),
            )
        }
        Err(e) => return stop(checks, "cluster: RPC genesis is Solana devnet", e),
    }
    let accounts = (|| -> Result<_, String> {
        Ok((
            chain.account(&expected.program)?,
            chain.account(&derived.program_data)?,
            chain.account(&expected.mint)?,
            chain.account(&derived.config)?,
            chain.account(&derived.vault)?,
        ))
    })();
    let (program, program_data, mint, config, vault) = match accounts {
        Ok(accounts) => accounts,
        Err(e) => {
            return stop(
                checks,
                "accounts: read program, ProgramData, mint, config and vault",
                e,
            )
        }
    };
    checks.extend(program_checks(
        program.as_ref(),
        program_data.as_ref(),
        expected,
        &derived,
    ));
    checks.extend(mint_checks(mint.as_ref(), expected, &derived));
    checks.push(Check::new(
        format!(
            "stage: initialize (config {} does not exist yet)",
            derived.config
        ),
        config.is_none(),
        if config.is_some() {
            "config exists: the program is already initialized; TX2 must never be sent again"
        } else {
            "absent"
        },
    ));
    checks.push(Check::new(
        format!("stage: vault {} does not exist yet", derived.vault),
        vault.is_none(),
        if vault.is_some() {
            "vault exists"
        } else {
            "absent"
        },
    ));
    let (blockhash, last_valid_block_height) = match chain.latest_blockhash() {
        Ok(latest) => latest,
        Err(e) => return stop(checks, "blockhash: latest", e),
    };
    let message = tx2_message(expected, &derived, &blockhash);
    let verified = verify_message(&message, expected, &derived);
    checks.push(Check::new(
        "message: exactly the reviewed initialize, one instruction, admin is the only signer and fee payer",
        verified.is_ok(),
        verified.err().unwrap_or_else(|| format!("{} bytes, blockhash {blockhash}", message.serialize().len())),
    ));
    if !all_ok(&checks) {
        checks.push(Check::new(
            "simulation",
            false,
            "not run: a prerequisite failed",
        ));
        return Report {
            checks,
            reviewed: None,
            costs: read_costs(chain, expected, &message).ok(),
        };
    }
    let (more, costs) = message_checks(chain, expected, &derived, &message);
    checks.extend(more);
    let reviewed = (all_ok(&checks) && costs.is_some()).then(|| Reviewed {
        hash: message_hash(&message),
        message,
        last_valid_block_height,
        costs: costs.clone().unwrap(),
    });
    Report {
        checks,
        reviewed,
        costs,
    }
}

/// Critical state re-read immediately before sending a signed TX2 (closes the window between the last simulation,
/// the owner's confirmation and the Ledger signature): program executable with the expected ProgramData, upgrade
/// authority still the admin, mint still passing the policy, config and vault still absent, admin still funded.
fn pre_send_checks(
    chain: &dyn Chain,
    expected: &Expected,
    derived: &Derived,
    costs: &Costs,
) -> Vec<Check> {
    let read = (|| -> Result<_, String> {
        Ok((
            chain.account(&expected.program)?,
            chain.account(&derived.program_data)?,
            chain.account(&expected.mint)?,
            chain.account(&derived.config)?,
            chain.account(&derived.vault)?,
            chain.account(&expected.admin)?.map_or(0, |a| a.lamports),
        ))
    })();
    let (program, program_data, mint, config, vault, balance) = match read {
        Ok(state) => state,
        Err(e) => {
            return vec![Check::new(
                "pre-send: re-read program, ProgramData, mint, config, vault and admin",
                false,
                e,
            )]
        }
    };
    let mut checks = program_checks(program.as_ref(), program_data.as_ref(), expected, derived);
    checks.extend(mint_checks(mint.as_ref(), expected, derived));
    checks.push(Check::new(
        "pre-send: config still absent (stage initialize)",
        config.is_none(),
        if config.is_some() {
            "config exists"
        } else {
            "absent"
        },
    ));
    checks.push(Check::new(
        "pre-send: vault still absent",
        vault.is_none(),
        if vault.is_some() {
            "vault exists"
        } else {
            "absent"
        },
    ));
    checks.push(Check::new(
        "pre-send: admin still funded (exactly the cost, or the cost + rent-exempt floor)",
        balance >= costs.total
            && (balance == costs.total || balance - costs.total >= costs.rent_exempt_floor),
        format!("admin balance {balance}"),
    ));
    checks
}

/// The owner at the keyboard: sees every line and must type the start of the Message Hash before the Ledger is asked.
pub trait Owner {
    fn show(&mut self, line: &str);
    fn confirm_hash(&mut self, hash: &str) -> bool;
}

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub poll: Duration,
    pub max_polls: u32,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(2),
            max_polls: 60,
        }
    }
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
pub fn sign_and_send(
    chain: &dyn Chain,
    expected: &Expected,
    signer: &dyn Signer,
    owner: &mut dyn Owner,
    timing: Timing,
) -> Result<Signature, String> {
    let derived = Derived::new(expected);
    let report = plan(chain, expected);
    show_checks(owner, &report.checks);
    let Some(reviewed) = report.reviewed else {
        return Err("STOP: the plan failed; nothing was signed or sent".into());
    };
    // The Ledger account must be the admin before the device is asked to sign anything.
    let ledger = signer.try_pubkey().map_err(|e| {
        format!("STOP: could not read the Ledger public key ({e}); nothing was signed")
    })?;
    if ledger != expected.admin {
        return Err(format!("STOP: the Ledger account {ledger} is not the admin {}; nothing was signed (check the ?key= index)", expected.admin));
    }
    owner.show(&format!("PASS  Ledger account = admin {ledger}"));

    // Fresh blockhash: the new message must equal the reviewed one except the blockhash, then be re-verified and re-simulated.
    let (blockhash, last_valid_block_height) = chain
        .latest_blockhash()
        .map_err(|e| format!("STOP: {e}; nothing was signed"))?;
    let message = tx2_message(expected, &derived, &blockhash);
    if !same_except_blockhash(&reviewed.message, &message) {
        return Err("STOP: the refreshed message differs from the reviewed message beyond the blockhash; nothing was signed".into());
    }
    verify_message(&message, expected, &derived)
        .map_err(|e| format!("STOP: refreshed message refused: {e}; nothing was signed"))?;
    let (checks, costs) = message_checks(chain, expected, &derived, &message);
    show_checks(owner, &checks);
    if !all_ok(&checks) {
        return Err("STOP: the refreshed message failed its checks or simulation (state changed since the plan); nothing was signed".into());
    }
    let costs = costs.expect("costs present when checks pass");
    let hash = message_hash(&message);
    owner.show(&format!(
        "TX2 message (base64, for the independent check): {}",
        message_base64(&message)
    ));
    owner.show(&format!("Signer and fee payer: {} | cost {} lamports (fee {} + rent {} + {}) | valid until block height {last_valid_block_height}", expected.admin, costs.total, costs.fee, costs.rent_config, costs.rent_vault));
    owner.show(&format!(
        "Message Hash (must equal the Ledger screen): {hash}"
    ));
    if !owner.confirm_hash(&hash) {
        return Err("STOP: not confirmed by the owner; nothing was signed".into());
    }

    let bytes = message.serialize();
    let signature = signer
        .try_sign_message(&bytes)
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

    // Never send a message whose blockhash may already have expired, or into state that changed after signing.
    let height = chain
        .block_height()
        .map_err(|e| format!("STOP: {e}; nothing was sent"))?;
    if height > last_valid_block_height {
        return Err(format!("STOP: the blockhash expired before sending (block height {height} > {last_valid_block_height}); nothing was sent. Rerun from the start"));
    }
    let pre_send = pre_send_checks(chain, expected, &derived, &costs);
    if !all_ok(&pre_send) {
        show_checks(owner, &pre_send);
        return Err("STOP: chain state changed after signing (see the FAIL lines); nothing was sent. Run the read-only plan".into());
    }

    owner.show(&format!("TX2 signature (transaction id): {signature}"));
    match chain.send(&transaction) {
        Ok(sent) if sent == signature => owner.show("sent once; waiting for confirmation (never resent by this tool)"),
        Ok(sent) => return Err(format!("STOP: the RPC returned signature {sent}, expected {signature}. Do not resend; check both read-only")),
        Err(e) => {
            let status = chain.status(&signature);
            if status != Ok(Status::Confirmed) {
                return Err(format!(
                    "STOP: sending failed ({e}); status {status:?}. Do not resend. Run the plan read-only: if the config is still absent once block height {last_valid_block_height} has passed, TX2 did not land and the whole command may be rerun"
                ));
            }
        }
    }
    // One status observation per poll. The block height is read first: if it was already past the blockhash's last
    // valid height and the signature is still not found afterwards, every block that could contain TX2 was already
    // confirmed when the status was read, so TX2 did not land.
    let mut confirmed = false;
    for _ in 0..timing.max_polls {
        let height = chain.block_height().ok();
        match chain.status(&signature) {
            Ok(Status::Confirmed) => {
                confirmed = true;
                break;
            }
            Ok(Status::Failed(e)) => return Err(format!("STOP: TX2 failed on chain ({e}); it changed nothing (atomic). Run the plan read-only before anything else")),
            Ok(Status::NotFound) if height.is_some_and(|h| h > last_valid_block_height) => {
                return Err(format!(
                    "STOP: the blockhash expired and TX2 {signature} was not found: it did not land. Confirm with the read-only plan (config absent) before rerunning from the start"
                ));
            }
            Ok(Status::NotFound) | Ok(Status::Pending) | Err(_) => {}
        }
        std::thread::sleep(timing.poll);
    }
    if !confirmed {
        return Err(format!(
            "STOP: confirmation timed out; TX2 {signature} may still land. Do NOT resend. Check the signature and run the read-only verifier"
        ));
    }

    let (config, vault) = match (chain.account(&derived.config), chain.account(&derived.vault)) {
        (Ok(config), Ok(vault)) => (config, vault),
        (Err(e), _) | (_, Err(e)) => return Err(format!("STOP: TX2 confirmed but the post-check could not read the accounts ({e}). Do not resend; run the read-only verifier")),
    };
    let post: Vec<Check> = config_checks(config.as_ref(), expected, &derived, costs.rent_config)
        .into_iter()
        .chain(vault_checks(
            vault.as_ref(),
            expected,
            &derived,
            costs.rent_vault,
        ))
        .collect();
    show_checks(owner, &post);
    if !all_ok(&post) {
        return Err(format!("STOP: TX2 {signature} confirmed but the result does not match the approved configuration. Do not continue; escalate"));
    }
    owner.show(&format!("TX2 confirmed and verified: {signature}"));
    Ok(signature)
}
