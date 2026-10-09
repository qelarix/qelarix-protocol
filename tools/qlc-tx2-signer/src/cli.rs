//! Strict command-line arguments: unknown, repeated or value-less flags are errors, never ignored.
use crate::constants::DEVNET_RPC;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Read-only: checks, simulation and the expected Message Hash. Never touches the Ledger.
    Plan { url: String },
    /// OWNER MUTATION: Ledger signature, one send, confirmation and post-verification.
    Sign { url: String, ledger: String },
    /// Gate G3, read-only: checks, simulation and Message Hash of update_config({ max_charge_amount: 120000 }).
    ConfigPlan { url: String },
    /// Gate G3, OWNER MUTATION: Ledger signature of that update_config, one send, confirmation and post-check.
    ConfigSign { url: String, ledger: String },
}

pub const USAGE: &str = "usage:\n  qlc-tx2-signer plan [--url <devnet RPC URL>]\n  qlc-tx2-signer sign --ledger usb://ledger?key=<account index> [--url <devnet RPC URL>]   OWNER MUTATION\n  qlc-tx2-signer config-plan [--url <devnet RPC URL>]\n  qlc-tx2-signer config-sign --ledger usb://ledger?key=<account index> [--url <devnet RPC URL>]   OWNER MUTATION (G3)";

/// Only the Agave CLI's own Ledger locator form `usb://ledger?key=<n>` is accepted: no key files, prompts, pubkeys
/// or other wallets can ever reach the signer.
pub fn is_ledger_locator(value: &str) -> bool {
    value
        .strip_prefix("usb://ledger?key=")
        .is_some_and(|index| {
            !index.is_empty() && index.len() <= 4 && index.bytes().all(|b| b.is_ascii_digit())
        })
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or("missing command")?;
    let mut url: Option<String> = None;
    let mut ledger: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        let flag = rest[i].as_str();
        let slot = match flag {
            "--url" => &mut url,
            "--ledger" => &mut ledger,
            other => return Err(format!("unknown argument {other:?}")),
        };
        let value = rest
            .get(i + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or(format!("{flag} has no value"))?;
        if slot.replace(value.clone()).is_some() {
            return Err(format!("{flag} given more than once"));
        }
        i += 2;
    }
    let url = url.unwrap_or_else(|| DEVNET_RPC.to_string());
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(
            "--url must be an http(s) RPC URL (its genesis is verified to be devnet)".into(),
        );
    }
    match command.as_str() {
        "plan" if ledger.is_none() => Ok(Command::Plan { url }),
        "plan" => Err("plan never uses the Ledger; remove --ledger".into()),
        "config-plan" if ledger.is_none() => Ok(Command::ConfigPlan { url }),
        "config-plan" => Err("config-plan never uses the Ledger; remove --ledger".into()),
        "config-sign" => match ledger {
            Some(ledger) if is_ledger_locator(&ledger) => Ok(Command::ConfigSign { url, ledger }),
            Some(other) => Err(format!(
                "--ledger must be usb://ledger?key=<account index>, got {other:?}"
            )),
            None => Err("config-sign needs --ledger usb://ledger?key=<account index>".into()),
        },
        "sign" => match ledger {
            Some(ledger) if is_ledger_locator(&ledger) => Ok(Command::Sign { url, ledger }),
            Some(other) => Err(format!(
                "--ledger must be usb://ledger?key=<account index>, got {other:?}"
            )),
            None => Err("sign needs --ledger usb://ledger?key=<account index>".into()),
        },
        other => Err(format!("unknown command {other:?}")),
    }
}
