//! Test harness: fixtures from the TypeScript encoders, a mock chain, a mock Ledger and a mock owner.
//! No real Ledger, no network, and no key is ever generated.
#![allow(dead_code)]
use {
    qlc_tx2_signer::{
        chain::{AccountInfo, Chain, Res, Simulation, Status},
        constants::*,
        flow::Owner,
    },
    serde_json::Value,
    solana_hash::Hash,
    solana_message::Message,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_signer::{Signer, SignerError},
    solana_transaction::Transaction,
    std::{
        cell::{Cell, RefCell},
        collections::HashMap,
        str::FromStr,
    },
};

pub struct Fixture(pub Value);

impl Fixture {
    pub fn load() -> Self {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tx2.json"
        ))
        .expect("fixture");
        Self(serde_json::from_str(&text).expect("fixture json"))
    }
    pub fn str(&self, path: &[&str]) -> String {
        let mut v = &self.0;
        for p in path {
            v = &v[*p];
        }
        v.as_str()
            .unwrap_or_else(|| panic!("fixture {path:?}"))
            .to_string()
    }
    pub fn bytes(&self, path: &[&str]) -> Vec<u8> {
        hex(&self.str(path))
    }
    pub fn address(&self, name: &str) -> Pubkey {
        Pubkey::from_str(&self.str(&["addresses", name])).unwrap()
    }
    pub fn mints(&self) -> Vec<(String, bool, Vec<u8>)> {
        self.0["mints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["name"].as_str().unwrap().to_string(),
                    m["ok"].as_bool().unwrap(),
                    hex(m["hex"].as_str().unwrap()),
                )
            })
            .collect()
    }
    pub fn approved_mint(&self) -> Vec<u8> {
        self.mints().into_iter().find(|(_, ok, _)| *ok).unwrap().2
    }
    pub fn blockhash(&self) -> Hash {
        Hash::from_str(&self.str(&["message", "blockhash"])).unwrap()
    }
}

pub fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// Devnet-like rent: (bytes + 128) × 5080 lamports.
pub fn rent(len: usize) -> u64 {
    (len as u64 + 128) * 5_080
}

pub fn total_cost() -> u64 {
    rent(CONFIG_SIZE) + rent(VAULT_SIZE) + LAMPORTS_PER_SIGNATURE
}

/// Replaces every occurrence of one 32-byte address inside account data (used to re-target fixtures to the
/// owner's test admin identity).
pub fn replace_address(data: &[u8], from: &Pubkey, to: &Pubkey) -> Vec<u8> {
    let mut out = data.to_vec();
    let (from, to) = (from.to_bytes(), to.to_bytes());
    let mut i = 0;
    while i + 32 <= out.len() {
        if out[i..i + 32] == from {
            out[i..i + 32].copy_from_slice(&to);
            i += 32;
        } else {
            i += 1;
        }
    }
    out
}

pub fn account(owner: Pubkey, lamports: u64, data: Vec<u8>) -> AccountInfo {
    AccountInfo {
        owner,
        lamports,
        data,
        executable: false,
    }
}

pub fn program_data_account(authority: Option<Pubkey>) -> AccountInfo {
    let mut data = vec![3, 0, 0, 0];
    data.extend_from_slice(&123_456u64.to_le_bytes());
    match authority {
        Some(a) => {
            data.push(1);
            data.extend_from_slice(a.as_ref());
        }
        None => data.extend_from_slice(&[0; 33]),
    }
    data.extend_from_slice(&[0xAB; 64]);
    account(BPF_LOADER_UPGRADEABLE, 10_000_000, data)
}

pub fn program_account(program_data: &Pubkey) -> AccountInfo {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(program_data.as_ref());
    AccountInfo {
        owner: BPF_LOADER_UPGRADEABLE,
        lamports: 1_141_440,
        data,
        executable: true,
    }
}

pub struct Mock {
    pub expected: Expected,
    pub derived: Derived,
    pub genesis: Cell<Hash>,
    pub accounts: RefCell<HashMap<Pubkey, AccountInfo>>,
    pub fee: Cell<u64>,
    /// Successive latest_blockhash results; the last one repeats.
    pub blockhashes: RefCell<Vec<(Hash, u64)>>,
    pub blockhash_calls: Cell<usize>,
    /// Successive block heights; the last one repeats.
    pub heights: RefCell<Vec<u64>>,
    pub height_calls: Cell<usize>,
    /// Post-state the simulation returns for config and vault.
    pub sim_config: RefCell<AccountInfo>,
    pub sim_vault: RefCell<AccountInfo>,
    /// Simulation errors per call (None = success); the last one repeats.
    pub sim_errors: RefCell<Vec<Option<String>>>,
    pub sim_calls: Cell<usize>,
    pub send_error: RefCell<Option<String>>,
    /// Accounts written by a landed TX2 (default: the simulated config and vault).
    pub landed: RefCell<Option<(AccountInfo, AccountInfo)>>,
    pub land_on_send: Cell<bool>,
    /// Successive signature statuses; the last one repeats.
    pub statuses: RefCell<Vec<Status>>,
    pub status_calls: Cell<usize>,
    pub sent: RefCell<Vec<Transaction>>,
}

fn nth<T: Clone>(items: &RefCell<Vec<T>>, calls: &Cell<usize>) -> T {
    let i = calls.get();
    calls.set(i + 1);
    let items = items.borrow();
    items[i.min(items.len() - 1)].clone()
}

impl Mock {
    /// A devnet state in which TX2 is ready: mint created and valid, program not initialized, admin funded.
    pub fn ready(fx: &Fixture, expected: Expected) -> Self {
        let derived = Derived::new(&expected);
        let retarget = |data: Vec<u8>| replace_address(&data, &ADMIN, &expected.admin);
        let mut accounts = HashMap::new();
        accounts.insert(expected.program, program_account(&derived.program_data));
        accounts.insert(
            derived.program_data,
            program_data_account(Some(expected.admin)),
        );
        accounts.insert(
            expected.mint,
            account(TOKEN_2022, rent(508), retarget(fx.approved_mint())),
        );
        accounts.insert(
            expected.admin,
            account(SYSTEM, total_cost() + rent(0) + 1_000_000, vec![]),
        );
        let sim_config = account(
            expected.program,
            rent(CONFIG_SIZE),
            retarget(fx.bytes(&["config", "accountHex"])),
        );
        let sim_vault = account(
            TOKEN_2022,
            rent(VAULT_SIZE),
            fx.bytes(&["vault", "accountHex"]),
        );
        Self {
            genesis: Cell::new(expected.genesis),
            accounts: RefCell::new(accounts),
            fee: Cell::new(LAMPORTS_PER_SIGNATURE),
            blockhashes: RefCell::new(vec![
                (fx.blockhash(), 300),
                (Hash::new_from_array([7; 32]), 400),
            ]),
            blockhash_calls: Cell::new(0),
            heights: RefCell::new(vec![100]),
            height_calls: Cell::new(0),
            sim_config: RefCell::new(sim_config),
            sim_vault: RefCell::new(sim_vault),
            sim_errors: RefCell::new(vec![None]),
            sim_calls: Cell::new(0),
            send_error: RefCell::new(None),
            landed: RefCell::new(None),
            land_on_send: Cell::new(true),
            statuses: RefCell::new(vec![Status::Pending, Status::Confirmed]),
            status_calls: Cell::new(0),
            sent: RefCell::new(vec![]),
            expected,
            derived,
        }
    }
    pub fn devnet(fx: &Fixture) -> Self {
        Self::ready(fx, Expected::devnet())
    }
    pub fn set(&self, key: Pubkey, account: Option<AccountInfo>) {
        match account {
            Some(a) => self.accounts.borrow_mut().insert(key, a),
            None => self.accounts.borrow_mut().remove(&key),
        };
    }
    pub fn admin_balance(&self, lamports: u64) {
        self.set(self.expected.admin, Some(account(SYSTEM, lamports, vec![])));
    }
}

impl Chain for Mock {
    fn genesis_hash(&self) -> Res<Hash> {
        Ok(self.genesis.get())
    }
    fn account(&self, key: &Pubkey) -> Res<Option<AccountInfo>> {
        Ok(self.accounts.borrow().get(key).cloned())
    }
    fn rent_exempt_minimum(&self, len: usize) -> Res<u64> {
        Ok(rent(len))
    }
    fn latest_blockhash(&self) -> Res<(Hash, u64)> {
        Ok(nth(&self.blockhashes, &self.blockhash_calls))
    }
    fn block_height(&self) -> Res<u64> {
        Ok(nth(&self.heights, &self.height_calls))
    }
    fn fee_for_message(&self, _message: &Message) -> Res<u64> {
        Ok(self.fee.get())
    }
    fn simulate(&self, _transaction: &Transaction, accounts: &[Pubkey]) -> Res<Simulation> {
        let err = nth(&self.sim_errors, &self.sim_calls);
        if let Some(err) = err {
            return Ok(Simulation {
                err: Some(err),
                logs: vec!["Program log: AnchorError".into()],
                ..Default::default()
            });
        }
        let balance = self
            .accounts
            .borrow()
            .get(&self.expected.admin)
            .map_or(0, |a| a.lamports);
        let post = |key: &Pubkey| -> Option<AccountInfo> {
            if *key == self.derived.config {
                Some(self.sim_config.borrow().clone())
            } else if *key == self.derived.vault {
                Some(self.sim_vault.borrow().clone())
            } else if *key == self.expected.admin {
                Some(account(SYSTEM, balance - total_cost(), vec![]))
            } else {
                None
            }
        };
        Ok(Simulation {
            err: None,
            logs: vec![],
            units: Some(41_000),
            fee: Some(self.fee.get()),
            accounts: accounts.iter().map(post).collect(),
        })
    }
    fn send(&self, transaction: &Transaction) -> Res<Signature> {
        self.sent.borrow_mut().push(transaction.clone());
        if let Some(e) = self.send_error.borrow().clone() {
            return Err(e);
        }
        if self.land_on_send.get() {
            let (config, vault) = self.landed.borrow().clone().unwrap_or_else(|| {
                (
                    self.sim_config.borrow().clone(),
                    self.sim_vault.borrow().clone(),
                )
            });
            self.set(self.derived.config, Some(config));
            self.set(self.derived.vault, Some(vault));
        }
        Ok(transaction.signatures[0])
    }
    fn status(&self, _signature: &Signature) -> Res<Status> {
        Ok(nth(&self.statuses, &self.status_calls))
    }
}

/// Stands in for the device: records every sign request and answers with a fixed reply. Not a key.
pub struct MockLedger {
    pub pubkey: Pubkey,
    pub reply: Result<Signature, SignerError>,
    pub requests: RefCell<Vec<Vec<u8>>>,
}

impl MockLedger {
    pub fn new(pubkey: Pubkey, reply: Result<Signature, SignerError>) -> Self {
        Self {
            pubkey,
            reply,
            requests: RefCell::new(vec![]),
        }
    }
}

impl Signer for MockLedger {
    fn try_pubkey(&self) -> Result<Pubkey, SignerError> {
        Ok(self.pubkey)
    }
    fn try_sign_message(&self, message: &[u8]) -> Result<Signature, SignerError> {
        self.requests.borrow_mut().push(message.to_vec());
        match &self.reply {
            Ok(signature) => Ok(*signature),
            Err(SignerError::UserCancel(m)) => Err(SignerError::UserCancel(m.clone())),
            Err(SignerError::Connection(m)) => Err(SignerError::Connection(m.clone())),
            Err(_) => Err(SignerError::Custom("mock".into())),
        }
    }
    fn is_interactive(&self) -> bool {
        true
    }
}

/// Records what the owner sees; types the hash prefix only when told to confirm.
pub struct MockOwner {
    pub lines: Vec<String>,
    pub confirm: bool,
    pub confirmed: Vec<String>,
}

impl MockOwner {
    pub fn new(confirm: bool) -> Self {
        Self {
            lines: vec![],
            confirm,
            confirmed: vec![],
        }
    }
    pub fn saw(&self, fragment: &str) -> bool {
        self.lines.iter().any(|l| l.contains(fragment))
    }
}

impl Owner for MockOwner {
    fn show(&mut self, line: &str) {
        self.lines.push(line.to_string());
    }
    fn confirm_hash(&mut self, hash: &str) -> bool {
        self.confirmed.push(hash.to_string());
        self.confirm
    }
}

pub const MAINNET_GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
pub const OTHER: Pubkey = Pubkey::from_str_const("Stake11111111111111111111111111111111111111");
