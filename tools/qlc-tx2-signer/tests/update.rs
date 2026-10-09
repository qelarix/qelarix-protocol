//! Gate G3 (update_config max_charge_amount 10000 -> 120000): exact bytes, read-only plan and refusal paths.
//! A mock chain and a mock Ledger only: no network, no device, and no key is ever generated or read.
use {
    qlc_tx2_signer::{
        chain::{AccountInfo, Chain, Res, Simulation, Status},
        constants::*,
        flow::{Owner, Timing},
        update::*,
    },
    solana_hash::Hash,
    solana_message::Message,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_signer::{Signer, SignerError},
    solana_transaction::Transaction,
    std::{cell::RefCell, collections::HashMap, str::FromStr},
};

fn config_bytes(expected: &Expected, derived: &Derived, max_charge: u64, paused: u8) -> Vec<u8> {
    let mut d = Vec::with_capacity(CONFIG_SIZE);
    d.extend_from_slice(&CONFIG_DISCRIMINATOR);
    d.extend_from_slice(expected.admin.as_ref());
    d.extend_from_slice(expected.operator.as_ref());
    d.extend_from_slice(expected.mint.as_ref());
    d.extend_from_slice(derived.vault.as_ref());
    d.extend_from_slice(&expected.limits.max_delivery_amount.to_le_bytes());
    d.extend_from_slice(&max_charge.to_le_bytes());
    d.extend_from_slice(&expected.limits.mint_window_secs.to_le_bytes());
    d.extend_from_slice(&expected.limits.mint_window_cap.to_le_bytes());
    d.extend_from_slice(&1_700_000_000i64.to_le_bytes()); // mint_window_start
    d.extend_from_slice(&500u64.to_le_bytes()); // minted_in_window
    d.push(paused);
    for total in [50_000u64, 50_000, 1_200, 400] {
        d.extend_from_slice(&total.to_le_bytes());
    }
    d.extend_from_slice(&[
        derived.config_bump,
        derived.mint_authority_bump,
        derived.membership_bump,
        derived.vault_bump,
        derived.spend_bump,
    ]);
    assert_eq!(d.len(), CONFIG_SIZE);
    d
}

struct Mock {
    genesis: Hash,
    accounts: RefCell<HashMap<Pubkey, AccountInfo>>,
    sim_config: RefCell<Option<AccountInfo>>,
    sim_error: RefCell<Option<String>>,
    sent: RefCell<Vec<Transaction>>,
}

impl Mock {
    fn ready(expected: &Expected) -> Self {
        let derived = Derived::new(expected);
        let mut accounts = HashMap::new();
        let mut program = vec![2, 0, 0, 0];
        program.extend_from_slice(derived.program_data.as_ref());
        accounts.insert(
            expected.program,
            AccountInfo {
                owner: BPF_LOADER_UPGRADEABLE,
                lamports: 1,
                data: program,
                executable: true,
            },
        );
        let mut pd = vec![3, 0, 0, 0];
        pd.extend_from_slice(&1u64.to_le_bytes());
        pd.push(1);
        pd.extend_from_slice(expected.admin.as_ref());
        accounts.insert(
            derived.program_data,
            AccountInfo {
                owner: BPF_LOADER_UPGRADEABLE,
                lamports: 1,
                data: pd,
                executable: false,
            },
        );
        let config = AccountInfo {
            owner: expected.program,
            lamports: 2_436_000,
            data: config_bytes(expected, &derived, CURRENT_MAX_CHARGE, 0),
            executable: false,
        };
        accounts.insert(derived.config, config.clone());
        accounts.insert(
            expected.admin,
            AccountInfo {
                owner: SYSTEM,
                lamports: 50_000_000,
                data: vec![],
                executable: false,
            },
        );
        let mut after = config;
        after.data = config_bytes(expected, &derived, TARGET_MAX_CHARGE, 0);
        Self {
            genesis: expected.genesis,
            accounts: RefCell::new(accounts),
            sim_config: RefCell::new(Some(after)),
            sim_error: RefCell::new(None),
            sent: RefCell::new(vec![]),
        }
    }
}

impl Chain for Mock {
    fn genesis_hash(&self) -> Res<Hash> {
        Ok(self.genesis)
    }
    fn account(&self, key: &Pubkey) -> Res<Option<AccountInfo>> {
        Ok(self.accounts.borrow().get(key).cloned())
    }
    fn rent_exempt_minimum(&self, len: usize) -> Res<u64> {
        Ok((len as u64 + 128) * 5_080)
    }
    fn latest_blockhash(&self) -> Res<(Hash, u64)> {
        Ok((Hash::new_from_array([7; 32]), 1_000))
    }
    fn block_height(&self) -> Res<u64> {
        Ok(900)
    }
    fn fee_for_message(&self, _: &Message) -> Res<u64> {
        Ok(LAMPORTS_PER_SIGNATURE)
    }
    fn simulate(&self, _: &Transaction, _: &[Pubkey]) -> Res<Simulation> {
        Ok(Simulation {
            err: self.sim_error.borrow().clone(),
            logs: vec![],
            units: Some(4_000),
            fee: Some(5_000),
            accounts: vec![self.sim_config.borrow().clone()],
        })
    }
    fn send(&self, t: &Transaction) -> Res<Signature> {
        self.sent.borrow_mut().push(t.clone());
        Ok(t.signatures[0])
    }
    fn status(&self, _: &Signature) -> Res<Status> {
        Ok(Status::Confirmed)
    }
}

/// A Ledger that reports a public key and records every signing request (it never produces a valid signature).
struct MockLedger {
    pubkey: Pubkey,
    requests: RefCell<usize>,
}
impl Signer for MockLedger {
    fn try_pubkey(&self) -> Result<Pubkey, SignerError> {
        Ok(self.pubkey)
    }
    fn try_sign_message(&self, _: &[u8]) -> Result<Signature, SignerError> {
        *self.requests.borrow_mut() += 1;
        Ok(Signature::default())
    }
    fn is_interactive(&self) -> bool {
        true
    }
}
struct MockOwner {
    confirm: bool,
}
impl Owner for MockOwner {
    fn show(&mut self, _: &str) {}
    fn confirm_hash(&mut self, _: &str) -> bool {
        self.confirm
    }
}

#[test]
fn instruction_data_is_exactly_max_charge_some_120000_and_everything_else_none() {
    let mut expected = UPDATE_CONFIG_DISCRIMINATOR.to_vec();
    expected.extend_from_slice(&[0, 0, 1]);
    expected.extend_from_slice(&120_000u64.to_le_bytes());
    expected.extend_from_slice(&[0, 0, 0]);
    assert_eq!(update_config_data(), expected);
    // sha256("global:update_config")[..8], identical to the generated TypeScript client.
    assert_eq!(
        UPDATE_CONFIG_DISCRIMINATOR,
        [29, 158, 252, 191, 10, 83, 219, 99]
    );
    assert_eq!((CURRENT_MAX_CHARGE, TARGET_MAX_CHARGE), (10_000, 120_000));
}

#[test]
fn message_has_the_admin_as_only_signer_and_fee_payer_and_two_accounts() {
    let expected = Expected::devnet();
    let derived = Derived::new(&expected);
    let m = update_message(&expected, &derived, &Hash::new_from_array([1; 32]));
    assert_eq!(m.account_keys[0], expected.admin);
    assert_eq!(m.header.num_required_signatures, 1);
    assert_eq!(m.instructions.len(), 1);
    let ix = &update_config_instruction(&expected, &derived);
    assert_eq!(ix.accounts.len(), 2);
    assert!(ix.accounts[0].is_signer && !ix.accounts[1].is_signer && ix.accounts[1].is_writable);
    assert_eq!(ix.accounts[1].pubkey, derived.config);
    assert!(verify_update_message(&m, &expected, &derived).is_ok());
}

#[test]
fn plan_passes_on_the_approved_state() {
    let expected = Expected::devnet();
    let report = plan_update(&Mock::ready(&expected), &expected);
    for c in &report.checks {
        assert!(c.ok, "{}: {}", c.name, c.detail);
    }
    assert!(report.reviewed.is_some());
}

#[test]
fn plan_refuses_another_cluster() {
    let expected = Expected::devnet();
    let mut mock = Mock::ready(&expected);
    mock.genesis = Hash::from_str("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").unwrap();
    assert!(plan_update(&mock, &expected).reviewed.is_none());
}

#[test]
fn plan_refuses_when_g3_is_already_applied_or_the_admin_differs() {
    let expected = Expected::devnet();
    let derived = Derived::new(&expected);
    let mock = Mock::ready(&expected);
    mock.accounts
        .borrow_mut()
        .get_mut(&derived.config)
        .unwrap()
        .data = config_bytes(&expected, &derived, TARGET_MAX_CHARGE, 0);
    assert!(plan_update(&mock, &expected).reviewed.is_none());
    let mock = Mock::ready(&expected);
    mock.accounts
        .borrow_mut()
        .get_mut(&derived.config)
        .unwrap()
        .data[8] ^= 1;
    assert!(plan_update(&mock, &expected).reviewed.is_none());
}

#[test]
fn plan_refuses_a_simulated_result_that_touches_anything_else() {
    let expected = Expected::devnet();
    let derived = Derived::new(&expected);
    let mock = Mock::ready(&expected);
    mock.sim_config.borrow_mut().as_mut().unwrap().data =
        config_bytes(&expected, &derived, TARGET_MAX_CHARGE, 1); // paused flipped
    assert!(plan_update(&mock, &expected).reviewed.is_none());
    let mock = Mock::ready(&expected);
    mock.sim_config.borrow_mut().as_mut().unwrap().data =
        config_bytes(&expected, &derived, 50_000, 0); // wrong cap
    assert!(plan_update(&mock, &expected).reviewed.is_none());
    let mock = Mock::ready(&expected);
    *mock.sim_error.borrow_mut() = Some("InvalidConfig".into());
    assert!(plan_update(&mock, &expected).reviewed.is_none());
}

#[test]
fn wrong_ledger_account_or_no_owner_confirmation_never_signs_or_sends() {
    let expected = Expected::devnet();
    let mock = Mock::ready(&expected);
    let other = MockLedger {
        pubkey: expected.operator,
        requests: RefCell::new(0),
    };
    let err = sign_and_send_update(
        &mock,
        &expected,
        &other,
        &mut MockOwner { confirm: true },
        Timing::default(),
    )
    .unwrap_err();
    assert!(err.contains("is not the admin"), "{err}");
    assert_eq!(*other.requests.borrow(), 0);
    let admin = MockLedger {
        pubkey: expected.admin,
        requests: RefCell::new(0),
    };
    let err = sign_and_send_update(
        &mock,
        &expected,
        &admin,
        &mut MockOwner { confirm: false },
        Timing::default(),
    )
    .unwrap_err();
    assert!(err.contains("not confirmed"), "{err}");
    assert_eq!(*admin.requests.borrow(), 0);
    assert!(mock.sent.borrow().is_empty());
}

#[test]
fn a_signature_that_does_not_verify_is_never_sent() {
    let expected = Expected::devnet();
    let mock = Mock::ready(&expected);
    let admin = MockLedger {
        pubkey: expected.admin,
        requests: RefCell::new(0),
    };
    let err = sign_and_send_update(
        &mock,
        &expected,
        &admin,
        &mut MockOwner { confirm: true },
        Timing::default(),
    )
    .unwrap_err();
    assert!(err.contains("does not verify"), "{err}");
    assert_eq!(*admin.requests.borrow(), 1);
    assert!(mock.sent.borrow().is_empty());
}
