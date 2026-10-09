//! qlc-tx2-signer — see docs/qlc-ledger-tx2-signer.md.
//!
//!   qlc-tx2-signer plan [--url <devnet RPC URL>]                                   read-only
//!   qlc-tx2-signer sign --ledger usb://ledger?key=<n> [--url <devnet RPC URL>]    OWNER MUTATION — DO NOT RUN
//!   qlc-tx2-signer config-plan [--url <devnet RPC URL>]                            read-only (gate G3)
//!   qlc-tx2-signer config-sign --ledger usb://ledger?key=<n> [--url <devnet RPC URL>]  OWNER MUTATION (gate G3)
use {
    qlc_tx2_signer::{
        chain::RpcChain,
        cli::{parse, Command, USAGE},
        constants::Expected,
        flow::{plan, sign_and_send, Owner, Timing},
        update::{plan_update, sign_and_send_update},
    },
    solana_signer::Signer,
    std::{
        io::{BufRead, Write},
        process::ExitCode,
    },
};

struct Terminal;

impl Owner for Terminal {
    fn show(&mut self, line: &str) {
        println!("{line}");
    }

    fn confirm_hash(&mut self, hash: &str) -> bool {
        println!("The Ledger will show \"Unrecognized format\" and a \"Message Hash\". Approve on the device only if it equals the hash above.");
        print!("Type the first 8 characters of the Message Hash to ask the Ledger to sign (anything else aborts): ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).is_ok() && line.trim() == &hash[..8]
    }
}

/// The only Ledger entry point: the official Agave 4.1.2 path, identical to the `solana` CLI's signer resolution.
fn ledger_signer(ledger: &str) -> Result<Box<dyn Signer>, String> {
    let matches = clap::App::new("qlc-tx2-signer").get_matches_from(vec!["qlc-tx2-signer"]);
    let mut wallet_manager = None;
    solana_clap_utils::keypair::signer_from_path(
        &matches,
        ledger,
        "admin Ledger",
        &mut wallet_manager,
    )
    .map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(e) => {
            eprintln!("argument: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let expected = Expected::devnet();
    match command {
        Command::Plan { url } => {
            let report = plan(&RpcChain::new(&url), &expected);
            for c in &report.checks {
                println!(
                    "{}  {}  — {}",
                    if c.ok { "PASS" } else { "FAIL" },
                    c.name,
                    c.detail
                );
            }
            if let Some(c) = &report.costs {
                println!("INFO  cost (the admin Ledger pays all: fee payer + program rent payer): fee {} + config rent {} + vault rent {} = {} lamports; admin balance {}; needs exactly {} or at least {} (stays rent-exempt)", c.fee, c.rent_config, c.rent_vault, c.total, c.admin_balance, c.total, c.recommended_balance());
            }
            match report.reviewed {
                Some(reviewed) => {
                    println!(
                        "INFO  TX2 message (base64): {}",
                        qlc_tx2_signer::tx2::message_base64(&reviewed.message)
                    );
                    println!("INFO  Message Hash for this blockhash: {} (sign refreshes the blockhash and prints the final hash)", reviewed.hash);
                    println!("Plan verified (read-only: nothing signed or sent).");
                    ExitCode::SUCCESS
                }
                None => {
                    println!("BLOCKED: TX2 cannot be signed until every check passes. Nothing was signed or sent.");
                    ExitCode::FAILURE
                }
            }
        }
        Command::Sign { url, ledger } => {
            println!("OWNER MUTATION — this command asks the Ledger to sign the QLC initialize transaction (TX2) and sends it once.");
            let chain = RpcChain::new(&url);
            // Read-only plan first: the Ledger is not touched unless every check passes.
            if plan(&chain, &expected).reviewed.is_none() {
                println!("BLOCKED: run `plan` and resolve every FAIL first. The Ledger was not contacted; nothing was signed or sent.");
                return ExitCode::FAILURE;
            }
            let signer = match ledger_signer(&ledger) {
                Ok(signer) => signer,
                Err(e) => {
                    println!("STOP: Ledger not available ({e}). Nothing was signed or sent.");
                    return ExitCode::FAILURE;
                }
            };
            match sign_and_send(
                &chain,
                &expected,
                signer.as_ref(),
                &mut Terminal,
                Timing::default(),
            ) {
                Ok(_) => {
                    println!("Next (read-only): npm run qlc:verify -- --cluster devnet   (must print QLC VERIFIED). Disable blind signing on the Ledger now.");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("{e}");
                    println!("Disable blind signing on the Ledger now.");
                    ExitCode::FAILURE
                }
            }
        }
        Command::ConfigPlan { url } => {
            let report = plan_update(&RpcChain::new(&url), &expected);
            for c in &report.checks {
                println!(
                    "{}  {}  — {}",
                    if c.ok { "PASS" } else { "FAIL" },
                    c.name,
                    c.detail
                );
            }
            match report.reviewed {
                Some(reviewed) => {
                    println!(
                        "INFO  G3 message (base64): {}",
                        qlc_tx2_signer::tx2::message_base64(&reviewed.message)
                    );
                    println!("INFO  Message Hash for this blockhash: {} (config-sign refreshes the blockhash and prints the final hash)", reviewed.hash);
                    println!("INFO  fee {} lamports, paid by the admin", reviewed.fee);
                    println!("G3 plan verified (read-only: nothing signed or sent).");
                    ExitCode::SUCCESS
                }
                None => {
                    println!("BLOCKED: G3 cannot be signed until every check passes. Nothing was signed or sent.");
                    ExitCode::FAILURE
                }
            }
        }
        Command::ConfigSign { url, ledger } => {
            println!("OWNER MUTATION (G3) — this command asks the Ledger to sign update_config(max_charge_amount 10000 -> 120000) and sends it once.");
            let chain = RpcChain::new(&url);
            if plan_update(&chain, &expected).reviewed.is_none() {
                println!("BLOCKED: run `config-plan` and resolve every FAIL first. The Ledger was not contacted; nothing was signed or sent.");
                return ExitCode::FAILURE;
            }
            let signer = match ledger_signer(&ledger) {
                Ok(signer) => signer,
                Err(e) => {
                    println!("STOP: Ledger not available ({e}). Nothing was signed or sent.");
                    return ExitCode::FAILURE;
                }
            };
            match sign_and_send_update(
                &chain,
                &expected,
                signer.as_ref(),
                &mut Terminal,
                Timing::default(),
            ) {
                Ok(_) => {
                    println!("Next (read-only): set DEVNET_LIMITS.maxChargeAmount to 120000 in scripts/qlc-policy.ts, then npm run qlc:verify -- --cluster devnet (must print QLC VERIFIED). Disable blind signing on the Ledger now.");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("{e}");
                    println!("Disable blind signing on the Ledger now.");
                    ExitCode::FAILURE
                }
            }
        }
    }
}
