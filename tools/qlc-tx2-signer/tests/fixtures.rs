//! The Rust implementation against independent TypeScript encodings (Codama client, @solana/kit,
//! @solana-program/token-2022): addresses, instruction, message bytes, Ledger hash, mint policy, results.
mod common;

use {
    common::*,
    qlc_tx2_signer::{
        chain::AccountInfo,
        constants::*,
        policy::{config_checks, mint_checks, vault_checks},
        tx2::{initialize_instruction, message_hash, tx2_message},
    },
};

fn ok(checks: &[qlc_tx2_signer::policy::Check]) -> bool {
    checks.iter().all(|c| c.ok)
}

#[test]
fn locked_inputs_and_derived_addresses_match_the_typescript_client() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let d = Derived::new(&e);
    assert_eq!(e.program, fx.address("program"));
    assert_eq!(e.admin, fx.address("admin"));
    assert_eq!(e.operator, fx.address("operator"));
    assert_eq!(e.mint, fx.address("mint"));
    assert_eq!(d.config, fx.address("config"));
    assert_eq!(d.vault, fx.address("vault"));
    assert_eq!(d.mint_authority, fx.address("mintAuthority"));
    assert_eq!(d.membership, fx.address("membershipAuthority"));
    assert_eq!(d.vault_authority, fx.address("vaultAuthority"));
    assert_eq!(d.spend_authority, fx.address("spendAuthority"));
    assert_eq!(d.program_data, fx.address("programData"));
    assert_eq!(d.no_burn, fx.address("noBurnAuthority"));
    assert_eq!(TOKEN_2022, fx.address("token2022"));
    assert_eq!(ASSOCIATED_TOKEN, fx.address("associatedToken"));
    assert_eq!(BPF_LOADER_UPGRADEABLE, fx.address("loader"));
    assert_eq!(
        e.limits,
        Limits {
            max_delivery_amount: 1_000_000,
            max_charge_amount: 10_000,
            mint_window_secs: 86_400,
            mint_window_cap: 2_000_000
        }
    );
    assert_eq!(e.genesis.to_string(), DEVNET_GENESIS);
}

#[test]
fn initialize_instruction_matches_the_codama_client() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let ix = initialize_instruction(&e, &Derived::new(&e));
    assert_eq!(
        INITIALIZE_DISCRIMINATOR.to_vec(),
        fx.bytes(&["initialize", "discriminatorHex"])
    );
    assert_eq!(ix.data, fx.bytes(&["initialize", "dataHex"]));
    let accounts = fx.0["initialize"]["accounts"].as_array().unwrap();
    assert_eq!(ix.accounts.len(), accounts.len());
    for (meta, expected) in ix.accounts.iter().zip(accounts) {
        assert_eq!(
            meta.pubkey.to_string(),
            expected["address"].as_str().unwrap()
        );
        assert_eq!(
            meta.is_signer,
            expected["signer"].as_bool().unwrap(),
            "{}",
            meta.pubkey
        );
        assert_eq!(
            meta.is_writable,
            expected["writable"].as_bool().unwrap(),
            "{}",
            meta.pubkey
        );
    }
}

#[test]
fn message_bytes_and_ledger_hash_match_solana_kit() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let message = tx2_message(&e, &Derived::new(&e), &fx.blockhash());
    assert_eq!(
        message.serialize(),
        fx.bytes(&["message", "hex"]),
        "Rust and @solana/kit must compile the identical TX2 message"
    );
    assert_eq!(message_hash(&message), fx.str(&["message", "hash"]));
}

#[test]
fn mint_policy_agrees_with_every_token_2022_fixture() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let mints = fx.mints();
    assert!(mints.len() >= 27);
    for (name, expect_ok, data) in mints {
        let checks = mint_checks(Some(&account(TOKEN_2022, 1, data)), &e, &d);
        assert_eq!(ok(&checks), expect_ok, "{name}: {checks:?}");
    }
}

#[test]
fn mint_policy_refuses_malformed_accounts() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let good = fx.approved_mint();
    let refuse = |label: &str, owner, data: Vec<u8>| {
        assert!(
            !ok(&mint_checks(Some(&account(owner, 1, data)), &e, &d)),
            "{label}"
        )
    };
    refuse("wrong owner", SYSTEM, good.clone());
    let mut token_account = good.clone();
    token_account[165] = 2;
    refuse("token account type", TOKEN_2022, token_account);
    refuse("truncated", TOKEN_2022, good[..good.len() - 10].to_vec());
    refuse(
        "duplicate DefaultAccountState",
        TOKEN_2022,
        [good.clone(), vec![6, 0, 1, 0, 2]].concat(),
    );
    refuse(
        "unknown extension type 99",
        TOKEN_2022,
        [good.clone(), vec![99, 0, 1, 0, 0]].concat(),
    );
    refuse(
        "trailing bytes",
        TOKEN_2022,
        [good.clone(), vec![1, 2]].concat(),
    );
    let mut padding = good.clone();
    padding[100] = 1;
    refuse("non-zero padding", TOKEN_2022, padding);
    assert!(!ok(&mint_checks(None, &e, &d)), "missing mint");
}

#[test]
fn post_initialize_config_and_vault_match_the_encoders() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let config = fx.bytes(&["config", "accountHex"]);
    let vault = fx.bytes(&["vault", "accountHex"]);
    assert_eq!(config.len(), CONFIG_SIZE);
    assert_eq!(vault.len(), VAULT_SIZE);
    assert_eq!(config[..8], CONFIG_DISCRIMINATOR);
    assert!(ok(&config_checks(
        Some(&account(e.program, rent(CONFIG_SIZE), config.clone())),
        &e,
        &d,
        rent(CONFIG_SIZE)
    )));
    assert!(ok(&vault_checks(
        Some(&account(TOKEN_2022, rent(VAULT_SIZE), vault.clone())),
        &e,
        &d,
        rent(VAULT_SIZE)
    )));

    let tampered = |offset: usize, data: &[u8]| {
        let mut out = data.to_vec();
        out[offset] ^= 1;
        out
    };
    let config_refused = |label: &str, info: AccountInfo| {
        assert!(
            !ok(&config_checks(Some(&info), &e, &d, rent(CONFIG_SIZE))),
            "{label}"
        )
    };
    config_refused(
        "admin",
        account(e.program, rent(CONFIG_SIZE), tampered(8, &config)),
    );
    config_refused(
        "operator",
        account(e.program, rent(CONFIG_SIZE), tampered(40, &config)),
    );
    config_refused(
        "mint",
        account(e.program, rent(CONFIG_SIZE), tampered(72, &config)),
    );
    config_refused(
        "vault",
        account(e.program, rent(CONFIG_SIZE), tampered(104, &config)),
    );
    config_refused(
        "max charge",
        account(e.program, rent(CONFIG_SIZE), tampered(144, &config)),
    );
    config_refused(
        "paused",
        account(e.program, rent(CONFIG_SIZE), tampered(184, &config)),
    );
    config_refused(
        "bump",
        account(e.program, rent(CONFIG_SIZE), tampered(219, &config)),
    );
    config_refused(
        "discriminator",
        account(e.program, rent(CONFIG_SIZE), tampered(0, &config)),
    );
    config_refused("owner", account(SYSTEM, rent(CONFIG_SIZE), config.clone()));
    config_refused(
        "not rent-exempt",
        account(e.program, rent(CONFIG_SIZE) - 1, config.clone()),
    );

    let vault_refused = |label: &str, info: AccountInfo| {
        assert!(
            !ok(&vault_checks(Some(&info), &e, &d, rent(VAULT_SIZE))),
            "{label}"
        )
    };
    let mut frozen = vault.clone();
    frozen[108] = 2;
    vault_refused("frozen", account(TOKEN_2022, rent(VAULT_SIZE), frozen));
    vault_refused(
        "owner field",
        account(TOKEN_2022, rent(VAULT_SIZE), tampered(40, &vault)),
    );
    vault_refused(
        "amount",
        account(TOKEN_2022, rent(VAULT_SIZE), tampered(64, &vault)),
    );
    vault_refused(
        "delegate",
        account(TOKEN_2022, rent(VAULT_SIZE), tampered(72, &vault)),
    );
    vault_refused(
        "close authority",
        account(TOKEN_2022, rent(VAULT_SIZE), tampered(129, &vault)),
    );
    vault_refused(
        "account owner",
        account(SYSTEM, rent(VAULT_SIZE), vault.clone()),
    );
    vault_refused(
        "missing",
        AccountInfo {
            owner: TOKEN_2022,
            lamports: 0,
            data: vec![],
            executable: false,
        },
    );
}

fn runtime_vault() -> Vec<u8> {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/vault-runtime.json"
    ))
    .unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        json["extensionOrder"],
        serde_json::json!([7, 27, 15]),
        "devnet runtime order: ImmutableOwner, PausableAccount, TransferHookAccount"
    );
    let mut bytes = hex(json["accountHex"].as_str().unwrap());
    assert_eq!(bytes[108], 2, "captured before initialize thaws the vault");
    bytes[108] = 1; // initialize thaws the vault; nothing else changes
    bytes
}

/// Rebuilds a token account from its base and a list of (type, value) TLV entries.
fn with_extensions(base: &[u8], entries: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut out = base[..166].to_vec();
    for (kind, value) in entries {
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&(value.len() as u16).to_le_bytes());
        out.extend_from_slice(value);
    }
    out
}

#[test]
fn runtime_vault_from_devnet_simulation_passes_and_matches_the_encoder() {
    let fx = Fixture::load();
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let runtime = runtime_vault();
    assert_eq!(
        runtime,
        fx.bytes(&["vault", "accountHex"]),
        "official encoder output = devnet runtime output (thawed)"
    );
    assert!(ok(&vault_checks(
        Some(&account(TOKEN_2022, rent(VAULT_SIZE), runtime)),
        &e,
        &d,
        rent(VAULT_SIZE)
    )));
}

#[test]
fn vault_extensions_are_compared_as_an_exact_set_in_any_order() {
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let base = runtime_vault();
    let check = |entries: &[(u16, Vec<u8>)]| {
        let data = with_extensions(&base, entries);
        let len = data.len();
        let checks = vault_checks(Some(&account(TOKEN_2022, rent(len), data)), &e, &d, 0);
        checks
            .iter()
            .find(|c| c.name.contains("extensions exactly"))
            .unwrap()
            .ok
    };
    let (immutable, pausable, hook) = ((7u16, vec![]), (27u16, vec![]), (15u16, vec![0u8]));
    for order in [
        [&immutable, &pausable, &hook],
        [&immutable, &hook, &pausable],
        [&pausable, &immutable, &hook],
        [&pausable, &hook, &immutable],
        [&hook, &immutable, &pausable],
        [&hook, &pausable, &immutable],
    ] {
        let entries: Vec<_> = order.iter().map(|e| (*e).clone()).collect();
        assert!(
            check(&entries),
            "order {:?}",
            entries.iter().map(|e| e.0).collect::<Vec<_>>()
        );
    }
    let refused = |label: &str, entries: Vec<(u16, Vec<u8>)>| assert!(!check(&entries), "{label}");
    refused(
        "missing PausableAccount",
        vec![immutable.clone(), hook.clone()],
    );
    refused(
        "duplicate ImmutableOwner",
        vec![
            immutable.clone(),
            immutable.clone(),
            pausable.clone(),
            hook.clone(),
        ],
    );
    refused(
        "extra MemoTransfer",
        vec![
            immutable.clone(),
            pausable.clone(),
            hook.clone(),
            (8, vec![1]),
        ],
    );
    refused(
        "TransferHookAccount transferring",
        vec![immutable.clone(), pausable.clone(), (15, vec![1])],
    );
    refused(
        "CpiGuard instead of PausableAccount",
        vec![immutable.clone(), (11, vec![0]), hook.clone()],
    );
}
