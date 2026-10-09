//! Static guards on the source and manifest, and the strict command line.
use qlc_tx2_signer::cli::{is_ledger_locator, parse, Command};

fn source() -> String {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    let mut all = String::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        // Code only: comment lines are ignored (they may name what the crate deliberately does not contain).
        for line in std::fs::read_to_string(entry.unwrap().path())
            .unwrap()
            .lines()
        {
            if !line.trim_start().starts_with("//") {
                all.push_str(line);
                all.push('\n');
            }
        }
    }
    all
}

#[test]
fn source_has_no_key_generation_and_no_device_code_of_its_own() {
    let src = source();
    for forbidden in [
        "Keypair",
        "keypair_from",
        "generate_",
        "new_rand",
        "from_seed",
        "mnemonic",
        "seed_phrase",
        "write_keypair",
        "read_keypair",
        "hidapi",
        "HidApi",
        "apdu",
        "APDU",
        "0xe0",
        "0xE0",
        "hw-app-solana",
        "LedgerWallet",
        "RemoteWalletManager::new",
        "sign_message(&self.derivation",
    ] {
        assert!(
            !src.contains(forbidden),
            "src/ must not contain {forbidden:?}"
        );
    }
    // The only Ledger entry point is the Agave CLI's own signer resolution.
    assert_eq!(
        src.matches("solana_clap_utils::keypair::signer_from_path")
            .count(),
        1
    );
}

#[test]
fn manifest_pins_the_official_agave_4_1_2_ledger_path() {
    let manifest =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    assert!(manifest.contains(r#"solana-remote-wallet = { version = "=4.1.2", default-features = false, features = ["agave-unstable-api", "linux-static-hidraw"] }"#));
    assert!(manifest.contains(
        r#"solana-clap-utils = { version = "=4.1.2", features = ["agave-unstable-api"] }"#
    ));
    assert!(manifest.contains(r#"solana-rpc-client = { version = "=4.1.2""#));
    assert!(
        manifest.contains("[workspace]"),
        "standalone workspace, never part of solana/"
    );
    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock")).unwrap();
    for name in [
        "solana-remote-wallet",
        "solana-clap-utils",
        "solana-rpc-client",
    ] {
        assert!(
            lock.contains(&format!("name = \"{name}\"\nversion = \"4.1.2\"")),
            "{name} locked at 4.1.2"
        );
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn command_line_is_strict() {
    assert_eq!(
        parse(&args(&["plan"])).unwrap(),
        Command::Plan {
            url: "https://api.devnet.solana.com".into()
        }
    );
    assert_eq!(
        parse(&args(&["sign", "--ledger", "usb://ledger?key=1"])).unwrap(),
        Command::Sign {
            url: "https://api.devnet.solana.com".into(),
            ledger: "usb://ledger?key=1".into()
        }
    );
    for (bad, why) in [
        (vec![], "missing command"),
        (vec!["send"], "unknown command"),
        (vec!["plan", "--keypair", "x.json"], "unknown argument"),
        (
            vec!["plan", "--ledger", "usb://ledger?key=1"],
            "never uses the Ledger",
        ),
        (vec!["plan", "--url"], "no value"),
        (
            vec!["plan", "--url", "https://a", "--url", "https://b"],
            "more than once",
        ),
        (vec!["plan", "--url", "file:///etc/passwd"], "http(s)"),
        (vec!["sign"], "needs --ledger"),
        (
            vec!["sign", "--ledger", "/Users/me/admin.json"],
            "usb://ledger?key=",
        ),
        (vec!["sign", "--ledger", "prompt://"], "usb://ledger?key="),
        (
            vec!["sign", "--ledger", "usb://ledger"],
            "usb://ledger?key=",
        ),
    ] {
        let err = parse(&args(&bad)).unwrap_err();
        assert!(err.contains(why), "{bad:?}: {err}");
    }
    assert!(is_ledger_locator("usb://ledger?key=0"));
    for bad in [
        "usb://ledger/B2sGhW5He2nT5zMYSoYRxrvwKdhdthphYT3G6zaUqNoG?key=1",
        "usb://trezor?key=1",
        "usb://ledger?key=1/2",
        "usb://ledger?key=",
        "usb://ledger?key=12345",
        "usb://ledger?key=1&x=2",
    ] {
        assert!(!is_ledger_locator(bad), "{bad}");
    }
}
