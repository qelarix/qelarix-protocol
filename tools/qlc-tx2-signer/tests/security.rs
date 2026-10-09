//! Task 09A security matrix: every refusal happens before the Ledger is asked to sign (or before sending), and
//! nothing is ever resent. Mocks only: no Ledger, no network, no key generation.
mod common;

use {
    common::*,
    qlc_tx2_signer::{
        chain::Status,
        constants::*,
        flow::{plan, sign_and_send, Report, Timing},
        tx2::{message_hash, same_except_blockhash, tx2_message, verify_message},
    },
    solana_hash::Hash,
    solana_instruction::{AccountMeta, Instruction},
    solana_message::Message,
    solana_signature::Signature,
    solana_signer::SignerError,
    std::{str::FromStr, time::Duration},
};

const FAST: Timing = Timing {
    poll: Duration::ZERO,
    max_polls: 5,
};

fn failed(report: &Report, fragment: &str) -> bool {
    report.reviewed.is_none()
        && report
            .checks
            .iter()
            .any(|c| !c.ok && (c.name.contains(fragment) || c.detail.contains(fragment)))
}

fn assert_refused(report: Report, fragment: &str) {
    assert!(
        failed(&report, fragment),
        "expected refusal containing {fragment:?}: {:#?}",
        report.checks
    );
}

fn sign(mock: &Mock, ledger: &MockLedger, owner: &mut MockOwner) -> Result<Signature, String> {
    sign_and_send(mock, &mock.expected, ledger, owner, FAST)
}

fn ledger(reply: Result<Signature, SignerError>) -> MockLedger {
    MockLedger::new(ADMIN, reply)
}

// ---------- plan: preconditions ----------

#[test]
fn ready_state_passes_the_plan_with_the_expected_costs() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    let report = plan(&mock, &mock.expected);
    let reviewed = report
        .reviewed
        .unwrap_or_else(|| panic!("{:#?}", report.checks));
    assert_eq!(reviewed.costs.total, rent(222) + rent(179) + 5_000);
    assert_eq!(
        reviewed.costs.recommended_balance(),
        reviewed.costs.total + rent(0)
    );
    assert_eq!(reviewed.message.serialize(), fx.bytes(&["message", "hex"]));
    assert_eq!(reviewed.hash, fx.str(&["message", "hash"]));
    assert_eq!(mock.sim_calls.get(), 1);
}

#[test]
fn wrong_cluster_and_mainnet_are_refused_before_any_other_read() {
    let fx = Fixture::load();
    for genesis in [
        MAINNET_GENESIS,
        "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    ] {
        let mock = Mock::devnet(&fx);
        mock.genesis.set(Hash::from_str(genesis).unwrap());
        let report = plan(&mock, &mock.expected);
        assert_eq!(report.checks.len(), 1, "stops at the cluster check");
        assert_refused(report, "not devnet");
        assert_eq!(mock.sim_calls.get(), 0);
    }
}

#[test]
fn wrong_program_is_refused() {
    let fx = Fixture::load();
    type Mutation = Box<dyn Fn(&Mock)>;
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "program missing",
            Box::new(|m: &Mock| m.set(m.expected.program, None)),
        ),
        (
            "not executable",
            Box::new(|m: &Mock| {
                m.set(
                    m.expected.program,
                    Some(AccountInfoExt::non_executable(&m.derived.program_data)),
                )
            }),
        ),
        (
            "other loader",
            Box::new(|m: &Mock| {
                m.set(
                    m.expected.program,
                    Some(account(SYSTEM, 1, vec![2, 0, 0, 0])),
                )
            }),
        ),
        (
            "ProgramData pointer",
            Box::new(|m: &Mock| m.set(m.expected.program, Some(program_account(&OTHER)))),
        ),
    ];
    for (label, mutate) in cases {
        let mock = Mock::devnet(&fx);
        mutate(&mock);
        assert!(failed(&plan(&mock, &mock.expected), "program:"), "{label}");
    }
    // A message for another program id is refused by the message verifier.
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let other = Expected {
        program: OTHER,
        ..e.clone()
    };
    assert!(verify_message(&tx2_message(&other, &d, &Hash::default()), &e, &d).is_err());
}

struct AccountInfoExt;
impl AccountInfoExt {
    fn non_executable(program_data: &solana_pubkey::Pubkey) -> qlc_tx2_signer::chain::AccountInfo {
        let mut a = program_account(program_data);
        a.executable = false;
        a
    }
}

#[test]
fn wrong_or_missing_upgrade_authority_is_refused() {
    let fx = Fixture::load();
    for authority in [Some(OTHER), None] {
        let mock = Mock::devnet(&fx);
        mock.set(
            mock.derived.program_data,
            Some(program_data_account(authority)),
        );
        assert_refused(plan(&mock, &mock.expected), "upgrade authority");
    }
}

#[test]
fn wrong_or_missing_mint_is_refused() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    mock.set(mock.expected.mint, None);
    assert_refused(plan(&mock, &mock.expected), "TX1 has not created the mint");
    for (name, ok, data) in fx.mints().into_iter().filter(|(_, ok, _)| !ok) {
        assert!(!ok);
        let mock = Mock::devnet(&fx);
        mock.set(
            mock.expected.mint,
            Some(account(TOKEN_2022, rent(508), data)),
        );
        let report = plan(&mock, &mock.expected);
        assert!(failed(&report, "mint:"), "{name}");
        assert_eq!(
            mock.sim_calls.get(),
            0,
            "{name}: no simulation after a failed precondition"
        );
    }
    // A message naming another mint is refused.
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let other = Expected {
        mint: OTHER,
        ..e.clone()
    };
    assert!(verify_message(
        &tx2_message(&other, &Derived::new(&other), &Hash::default()),
        &e,
        &d
    )
    .is_err());
}

#[test]
fn already_initialized_is_refused() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    mock.set(mock.derived.config, Some(mock.sim_config.borrow().clone()));
    assert_refused(plan(&mock, &mock.expected), "already initialized");
    let mock = Mock::devnet(&fx);
    mock.set(mock.derived.vault, Some(mock.sim_vault.borrow().clone()));
    assert_refused(plan(&mock, &mock.expected), "vault exists");
}

#[test]
fn insufficient_admin_funds_are_refused_before_signing() {
    let fx = Fixture::load();
    let total = total_cost();
    for (balance, ok) in [
        (0, false),
        (total - 1, false),
        (total, true),
        (total + 1, false),
        (total + rent(0) - 1, false),
        (total + rent(0), true),
    ] {
        let mock = Mock::devnet(&fx);
        mock.admin_balance(balance);
        let report = plan(&mock, &mock.expected);
        assert_eq!(
            report.reviewed.is_some(),
            ok,
            "balance {balance}: {:#?}",
            report.checks
        );
        if !ok {
            assert!(failed(&report, "funds:"));
            let ledger = ledger(Ok(Signature::default()));
            assert!(sign(&mock, &ledger, &mut MockOwner::new(true)).is_err());
            assert!(ledger.requests.borrow().is_empty(), "Ledger never asked");
        }
    }
}

#[test]
fn changed_fee_is_refused() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    mock.fee.set(10_000);
    assert_refused(plan(&mock, &mock.expected), "fee:");
}

#[test]
fn failed_or_mismatching_simulation_is_refused() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    *mock.sim_errors.borrow_mut() = vec![Some("InstructionError(0, Custom(6003))".into())];
    assert_refused(plan(&mock, &mock.expected), "simulation: succeeds");

    let mock = Mock::devnet(&fx);
    mock.sim_config.borrow_mut().data[40] ^= 1; // operator
    assert_refused(
        plan(&mock, &mock.expected),
        "simulated config: admin, operator",
    );

    let mock = Mock::devnet(&fx);
    mock.sim_vault.borrow_mut().data[108] = 2; // frozen
    assert_refused(plan(&mock, &mock.expected), "simulated vault");
}

// ---------- message invariants ----------

fn base() -> (Expected, Derived, Message) {
    let e = Expected::devnet();
    let d = Derived::new(&e);
    let m = tx2_message(&e, &d, &Hash::new_from_array([3; 32]));
    (e, d, m)
}

#[test]
fn canonical_message_is_accepted() {
    let (e, d, m) = base();
    verify_message(&m, &e, &d).unwrap();
    assert_eq!(m.header.num_required_signatures, 1);
    assert_eq!(m.account_keys[0], ADMIN);
    assert_eq!(m.instructions.len(), 1);
}

#[test]
fn extra_or_malformed_instruction_is_refused() {
    let (e, d, m) = base();
    let ix = qlc_tx2_signer::tx2::initialize_instruction(&e, &d);
    let compute_budget = Instruction::new_with_bytes(
        solana_pubkey::Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        &[3, 1, 0, 0, 0, 0, 0, 0, 0],
        vec![],
    );
    let extra = Message::new_with_blockhash(
        &[compute_budget, ix.clone()],
        Some(&ADMIN),
        &m.recent_blockhash,
    );
    assert!(verify_message(&extra, &e, &d)
        .unwrap_err()
        .contains("2 instructions"));
    let twice =
        Message::new_with_blockhash(&[ix.clone(), ix.clone()], Some(&ADMIN), &m.recent_blockhash);
    assert!(verify_message(&twice, &e, &d).is_err());
    let mut truncated = ix.clone();
    truncated.data.truncate(40);
    assert!(verify_message(
        &Message::new_with_blockhash(&[truncated], Some(&ADMIN), &m.recent_blockhash),
        &e,
        &d
    )
    .unwrap_err()
    .contains("data"));
    let mut extra_account = ix.clone();
    extra_account.accounts.push(AccountMeta::new(OTHER, false));
    assert!(verify_message(
        &Message::new_with_blockhash(&[extra_account], Some(&ADMIN), &m.recent_blockhash),
        &e,
        &d
    )
    .is_err());
}

#[test]
fn changed_account_order_is_refused() {
    let (e, d, m) = base();
    let mut ix = qlc_tx2_signer::tx2::initialize_instruction(&e, &d);
    ix.accounts.swap(3, 4); // mint authority <-> membership authority
    assert!(verify_message(
        &Message::new_with_blockhash(&[ix], Some(&ADMIN), &m.recent_blockhash),
        &e,
        &d
    )
    .unwrap_err()
    .contains("accounts"));
    // Same instruction, compiled account list reordered by hand.
    let mut reordered = m.clone();
    reordered.account_keys.swap(3, 4);
    assert!(verify_message(&reordered, &e, &d).is_err());
}

#[test]
fn changed_instruction_data_is_refused() {
    let (e, d, m) = base();
    for (label, changed) in [
        (
            "operator",
            Expected {
                operator: OTHER,
                ..e.clone()
            },
        ),
        (
            "max charge 50000",
            Expected {
                limits: Limits {
                    max_charge_amount: 50_000,
                    ..e.limits
                },
                ..e.clone()
            },
        ),
        (
            "window",
            Expected {
                limits: Limits {
                    mint_window_secs: 60,
                    ..e.limits
                },
                ..e.clone()
            },
        ),
    ] {
        let message = tx2_message(&changed, &d, &m.recent_blockhash);
        assert!(
            verify_message(&message, &e, &d)
                .unwrap_err()
                .contains("data"),
            "{label}"
        );
    }
    let mut flipped = m.clone();
    flipped.instructions[0].data[0] ^= 1;
    assert!(verify_message(&flipped, &e, &d).is_err());
}

#[test]
fn changed_fee_payer_is_refused() {
    let (e, d, m) = base();
    let ix = qlc_tx2_signer::tx2::initialize_instruction(&e, &d);
    let other_payer = Message::new_with_blockhash(&[ix], Some(&OTHER), &m.recent_blockhash);
    let err = verify_message(&other_payer, &e, &d).unwrap_err();
    assert!(err.contains("fee payer"), "{err}");
}

#[test]
fn changed_blockhash_only_is_permitted_after_full_reverification() {
    let (e, d, m) = base();
    let refreshed = tx2_message(&e, &d, &Hash::new_from_array([9; 32]));
    assert!(same_except_blockhash(&m, &refreshed));
    verify_message(&refreshed, &e, &d).unwrap();
    assert_ne!(
        message_hash(&m),
        message_hash(&refreshed),
        "the hash covers the blockhash"
    );
    let other = tx2_message(
        &Expected {
            operator: OTHER,
            ..e.clone()
        },
        &d,
        &Hash::new_from_array([9; 32]),
    );
    assert!(
        !same_except_blockhash(&m, &other),
        "anything beyond the blockhash is a different message"
    );
}

// ---------- signing sequence ----------

#[test]
fn wrong_ledger_account_is_refused_before_any_sign_request() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    let ledger = MockLedger::new(OTHER, Ok(Signature::default()));
    let mut owner = MockOwner::new(true);
    let err = sign(&mock, &ledger, &mut owner).unwrap_err();
    assert!(err.contains("is not the admin"), "{err}");
    assert!(ledger.requests.borrow().is_empty());
    assert!(owner.confirmed.is_empty(), "the owner is not even asked");
    assert!(mock.sent.borrow().is_empty());
}

#[test]
fn owner_not_confirming_stops_before_the_ledger() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    let ledger = ledger(Ok(Signature::default()));
    let err = sign(&mock, &ledger, &mut MockOwner::new(false)).unwrap_err();
    assert!(err.contains("not confirmed"));
    assert!(ledger.requests.borrow().is_empty());
    assert!(mock.sent.borrow().is_empty());
}

#[test]
fn ledger_rejection_or_disconnect_sends_nothing() {
    let fx = Fixture::load();
    for reply in [
        SignerError::UserCancel("rejected on device".into()),
        SignerError::Connection("device disconnected".into()),
    ] {
        let mock = Mock::devnet(&fx);
        let ledger = ledger(Err(reply));
        let err = sign(&mock, &ledger, &mut MockOwner::new(true)).unwrap_err();
        assert!(
            err.contains("did not sign") && err.contains("Nothing was sent"),
            "{err}"
        );
        assert_eq!(ledger.requests.borrow().len(), 1);
        assert!(mock.sent.borrow().is_empty());
    }
}

#[test]
fn invalid_signature_is_never_sent() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    let ledger = ledger(Ok(Signature::from([7u8; 64])));
    let err = sign(&mock, &ledger, &mut MockOwner::new(true)).unwrap_err();
    assert!(err.contains("does not verify"), "{err}");
    assert!(mock.sent.borrow().is_empty());
}

#[test]
fn the_ledger_signs_exactly_the_refreshed_reverified_message_and_the_hash_shown() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    let ledger = ledger(Ok(Signature::from([7u8; 64])));
    let mut owner = MockOwner::new(true);
    let _ = sign(&mock, &ledger, &mut owner);
    let requests = ledger.requests.borrow();
    assert_eq!(requests.len(), 1);
    let e = Expected::devnet();
    let d = Derived::new(&e);
    // The plan inside sign_and_send used the first blockhash; the refresh used the second.
    let refreshed = tx2_message(&e, &d, &Hash::new_from_array([7; 32]));
    assert_eq!(
        requests[0],
        refreshed.serialize(),
        "signed bytes = refreshed canonical message"
    );
    assert_eq!(
        owner.confirmed,
        vec![message_hash(&refreshed)],
        "the owner confirmed the hash of exactly those bytes"
    );
    assert!(owner.saw(&message_hash(&refreshed)));
    assert!(same_except_blockhash(
        &refreshed,
        &tx2_message(&e, &d, &fx.blockhash())
    ));
}

#[test]
fn state_change_between_plan_and_sign_is_refused() {
    let fx = Fixture::load();
    let mock = Mock::devnet(&fx);
    *mock.sim_errors.borrow_mut() = vec![None, Some("AccountAlreadyInUse".into())];
    let ledger = ledger(Ok(Signature::default()));
    let err = sign(&mock, &ledger, &mut MockOwner::new(true)).unwrap_err();
    assert!(err.contains("state changed"), "{err}");
    assert!(ledger.requests.borrow().is_empty());
}

// The positive end-to-end path needs a signature that verifies, which only a real key can produce. It uses the
// owner's test-only admin identity from QLC_TEST_IDENTITIES_DIR (same rules as scripts/test-identities.ts).
fn test_admin() -> solana_keypair::Keypair {
    use solana_signer::Signer;
    let dir = std::env::var("QLC_TEST_IDENTITIES_DIR").expect(
        "BLOCKED: owner test identity admin.json not provided (set QLC_TEST_IDENTITIES_DIR)",
    );
    let text = std::fs::read_to_string(std::path::Path::new(&dir).join("admin.json"))
        .expect("BLOCKED: admin.json missing in QLC_TEST_IDENTITIES_DIR");
    let bytes: Vec<u8> = serde_json::from_str(&text).expect("admin.json is a JSON byte array");
    assert_eq!(bytes.len(), 64, "admin.json is not a 64-byte keypair file");
    let keypair =
        solana_keypair::Keypair::try_from(&bytes[..]).expect("admin.json is a valid keypair");
    let address = keypair.pubkey().to_string();
    const PRIVILEGED: [&str; 8] = [
        "EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa",
        "B2sGhW5He2nT5zMYSoYRxrvwKdhdthphYT3G6zaUqNoG",
        "4GEGAVHQCwshpv3yC25Xs7ACmWvNpcjTneT56XVD8McL",
        "GJPDitCMWnH3bPYFUJRWwyXdXmErBhwrS5EoYz6JZwmz",
        "6k4gTKg6hLDHfL1y9YWbJsSQm18KE9kMHyYzmT8RxB8j",
        "AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw",
        "4M9QBi82P75sBUE7yEyDQHSRDreP1s2GnPaQGwazbqqm",
        "C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp",
    ];
    const REJECTED_SHA256: [&str; 3] = [
        "5f2b01446e5718212b4326c60dfad2767751717190a47b63d0aaa5823b56c69a",
        "ea25d8fdf2d4ab7ca7b0872dcefb00a9fa6dcabe3be3746ab8636fc4b8be6d0b",
        "576134efe7c3a4fb02400053bc417664a684dea471521fbb5e19723e0390387b",
    ];
    let digest: String = solana_sha256_hasher::hash(address.as_bytes())
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(
        !PRIVILEGED.contains(&address.as_str()) && !REJECTED_SHA256.contains(&digest.as_str()),
        "admin.json is a privileged or rejected identity"
    );
    keypair
}

fn test_admin_mock(fx: &Fixture) -> (Mock, solana_keypair::Keypair) {
    use solana_signer::Signer;
    let keypair = test_admin();
    let mock = Mock::ready(
        fx,
        Expected {
            admin: keypair.pubkey(),
            ..Expected::devnet()
        },
    );
    (mock, keypair)
}

#[test]
fn end_to_end_signs_once_sends_once_confirms_and_verifies() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    let mut owner = MockOwner::new(true);
    let signature = sign_and_send(&mock, &mock.expected, &keypair, &mut owner, FAST)
        .unwrap_or_else(|e| panic!("{e}\n{:#?}", owner.lines));
    let sent = mock.sent.borrow();
    assert_eq!(sent.len(), 1, "sent exactly once");
    assert_eq!(sent[0].signatures, vec![signature]);
    sent[0].verify().unwrap();
    verify_message(&sent[0].message, &mock.expected, &mock.derived).unwrap();
    assert!(
        owner.saw(&format!("TX2 signature (transaction id): {signature}")),
        "signature shown before sending"
    );
    assert!(owner.saw("TX2 confirmed and verified"));
}

#[test]
fn expired_blockhash_before_send_sends_nothing() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    *mock.heights.borrow_mut() = vec![401]; // the refreshed blockhash is valid until 400
    let err = sign_and_send(
        &mock,
        &mock.expected,
        &keypair,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap_err();
    assert!(err.contains("expired before sending"), "{err}");
    assert!(mock.sent.borrow().is_empty());
}

#[test]
fn send_failure_before_acceptance_is_never_retried() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    *mock.send_error.borrow_mut() = Some("RPC error: connection reset".into());
    *mock.statuses.borrow_mut() = vec![Status::NotFound];
    let err = sign_and_send(
        &mock,
        &mock.expected,
        &keypair,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap_err();
    assert!(err.contains("Do not resend"), "{err}");
    assert_eq!(mock.sent.borrow().len(), 1);
}

#[test]
fn landed_but_unconfirmed_in_time_is_never_resent() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    *mock.statuses.borrow_mut() = vec![Status::Pending];
    let err = sign_and_send(
        &mock,
        &mock.expected,
        &keypair,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap_err();
    assert!(
        err.contains("timed out") && err.contains("Do NOT resend"),
        "{err}"
    );
    assert_eq!(mock.sent.borrow().len(), 1);
}

#[test]
fn expired_and_not_found_reports_not_landed_without_resending() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    mock.land_on_send.set(false);
    *mock.statuses.borrow_mut() = vec![Status::NotFound];
    *mock.heights.borrow_mut() = vec![100, 401];
    let err = sign_and_send(
        &mock,
        &mock.expected,
        &keypair,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap_err();
    assert!(err.contains("did not land"), "{err}");
    assert_eq!(mock.sent.borrow().len(), 1);
    assert_eq!(
        mock.status_calls.get(),
        1,
        "one status observation per poll, no duplicate read"
    );
}

#[test]
fn on_chain_failure_is_reported_and_not_retried() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    *mock.statuses.borrow_mut() = vec![Status::Failed("InstructionError(0, Custom(6000))".into())];
    let err = sign_and_send(
        &mock,
        &mock.expected,
        &keypair,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap_err();
    assert!(err.contains("failed on chain"), "{err}");
    assert_eq!(mock.sent.borrow().len(), 1);
}

#[test]
fn confirmed_but_post_verification_failure_stops() {
    let fx = Fixture::load();
    let (mock, keypair) = test_admin_mock(&fx);
    let mut wrong = mock.sim_config.borrow().clone();
    wrong.data[40] ^= 1; // operator differs on chain
    *mock.landed.borrow_mut() = Some((wrong, mock.sim_vault.borrow().clone()));
    let err = sign_and_send(
        &mock,
        &mock.expected,
        &keypair,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap_err();
    assert!(
        err.contains("does not match the approved configuration"),
        "{err}"
    );
}

// ---------- state changes between signing and send ----------

/// Signs with the owner's test identity, but changes chain state while "the Ledger" is signing: the window after
/// the final simulation and the owner's confirmation, before sending.
struct MutatingSigner<'a> {
    inner: &'a solana_keypair::Keypair,
    mock: &'a Mock,
    mutate: &'a dyn Fn(&Mock),
}

impl solana_signer::Signer for MutatingSigner<'_> {
    fn try_pubkey(&self) -> Result<solana_pubkey::Pubkey, SignerError> {
        self.inner.try_pubkey()
    }
    fn try_sign_message(&self, message: &[u8]) -> Result<Signature, SignerError> {
        (self.mutate)(self.mock);
        self.inner.try_sign_message(message)
    }
    fn is_interactive(&self) -> bool {
        true
    }
}

#[test]
fn state_change_between_signing_and_send_stops_with_zero_sends() {
    let fx = Fixture::load();
    let paused_mint = fx
        .mints()
        .into_iter()
        .find(|(name, _, _)| name == "mint paused")
        .unwrap()
        .2;
    type Mutation = Box<dyn Fn(&Mock)>;
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "upgrade authority changed",
            Box::new(|m: &Mock| {
                m.set(
                    m.derived.program_data,
                    Some(program_data_account(Some(OTHER))),
                )
            }),
        ),
        (
            "upgrade authority removed (immutable)",
            Box::new(|m: &Mock| m.set(m.derived.program_data, Some(program_data_account(None)))),
        ),
        (
            "program no longer executable",
            Box::new(|m: &Mock| {
                m.set(
                    m.expected.program,
                    Some(AccountInfoExt::non_executable(&m.derived.program_data)),
                )
            }),
        ),
        (
            "program points at another ProgramData",
            Box::new(|m: &Mock| m.set(m.expected.program, Some(program_account(&OTHER)))),
        ),
        (
            "config created",
            Box::new(|m: &Mock| m.set(m.derived.config, Some(m.sim_config.borrow().clone()))),
        ),
        (
            "vault created",
            Box::new(|m: &Mock| m.set(m.derived.vault, Some(m.sim_vault.borrow().clone()))),
        ),
        (
            "mint no longer passes the policy",
            Box::new(move |m: &Mock| {
                m.set(
                    m.expected.mint,
                    Some(account(
                        TOKEN_2022,
                        rent(508),
                        replace_address(&paused_mint, &ADMIN, &m.expected.admin),
                    )),
                )
            }),
        ),
        (
            "admin drained below the cost",
            Box::new(|m: &Mock| m.admin_balance(total_cost() - 1)),
        ),
    ];
    for (label, mutate) in cases {
        let (mock, keypair) = test_admin_mock(&fx);
        let signer = MutatingSigner {
            inner: &keypair,
            mock: &mock,
            mutate: mutate.as_ref(),
        };
        let mut owner = MockOwner::new(true);
        let err = sign_and_send(&mock, &mock.expected, &signer, &mut owner, FAST).unwrap_err();
        assert!(err.contains("changed after signing"), "{label}: {err}");
        assert!(
            mock.sent.borrow().is_empty(),
            "{label}: nothing may be sent"
        );
        assert!(
            owner.lines.iter().any(|l| l.starts_with("FAIL")),
            "{label}: the failing check is shown"
        );
    }
    // Control: the same signer without a state change sends exactly once.
    let (mock, keypair) = test_admin_mock(&fx);
    let unchanged = |_: &Mock| {};
    let signer = MutatingSigner {
        inner: &keypair,
        mock: &mock,
        mutate: &unchanged,
    };
    sign_and_send(
        &mock,
        &mock.expected,
        &signer,
        &mut MockOwner::new(true),
        FAST,
    )
    .unwrap();
    assert_eq!(mock.sent.borrow().len(), 1);
}
