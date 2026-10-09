//! LiteSVM harness for the QLC program. Token-2022 and the associated token account program are
//! loaded from devnet dumps (tests/fixtures, fetched by scripts/fetch-test-fixtures.sh) so the tests
//! run against the same program versions as devnet, including PermissionedBurn and Pausable.
#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::{AccountMeta, Instruction}, system_instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token_2022::spl_token_2022::{
        extension::StateWithExtensions,
        state::{Account as TokenAccount, Mint},
    },
    litesvm::{types::FailedTransactionMetadata, LiteSVM},
    qelarix_qlc::{constants::*, state::*, InitializeArgs, UpdateConfigArgs},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    solana_transaction_error::TransactionError,
};

pub const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
pub const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
pub const BPF_LOADER_UPGRADEABLE: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;

pub const MAX_DELIVERY: u64 = 1_000_000; // 10,000.00 QLC
pub const MAX_CHARGE: u64 = 50_000; // 500.00 QLC
pub const WINDOW_SECS: i64 = 86_400;
pub const WINDOW_CAP: u64 = 2_000_000; // 20,000.00 QLC per day

/// Owner test wallets available to one test (wallet-1.json … wallet-3.json).
pub const TEST_WALLETS: usize = 3;

/// Active Qelarix identities with real roles: a test may never sign with one of them. Rejected
/// identities are refused by scripts/qlc-test.ts, which validates the test identities before running.
const PRIVILEGED_IDENTITIES: [&str; 8] = [
    "EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa", // program deploy key
    "B2sGhW5He2nT5zMYSoYRxrvwKdhdthphYT3G6zaUqNoG", // devnet upgrade authority (Ledger)
    "4GEGAVHQCwshpv3yC25Xs7ACmWvNpcjTneT56XVD8McL", // devnet operator
    "GJPDitCMWnH3bPYFUJRWwyXdXmErBhwrS5EoYz6JZwmz", // deploy CLI signer
    "6k4gTKg6hLDHfL1y9YWbJsSQm18KE9kMHyYzmT8RxB8j", // deploy buffer
    "AT52PG96hNNiKQaxhp6Cu29AbK5FzDpHJzKb7jy22wzw", // devnet treasury
    "4M9QBi82P75sBUE7yEyDQHSRDreP1s2GnPaQGwazbqqm", // founder wallet
    "C7pkmggd8mNoc1n9XitK6QP4HzdVGGhFTUrbUfFmo7Hp", // owner Phantom account
];

/// An owner-created, test-only signing identity. Qelarix tests never generate keys: they load
/// `<name>.json` from the folder named by QLC_TEST_IDENTITIES_DIR, and a missing, unreadable or
/// privileged identity stops the test before anything is signed.
pub fn test_identity(name: &str) -> Keypair {
    let dir = std::env::var("QLC_TEST_IDENTITIES_DIR")
        .unwrap_or_else(|_| panic!("QLC_TEST_IDENTITIES_DIR is not set: owner test identity {name}.json is required"));
    let path = std::path::Path::new(&dir).join(format!("{name}.json"));
    let keypair = solana_keypair::read_keypair_file(&path)
        .unwrap_or_else(|_| panic!("owner test identity {} is missing or not a keypair file", path.display()));
    let address = keypair.pubkey().to_string();
    assert!(
        !PRIVILEGED_IDENTITIES.contains(&address.as_str()),
        "{name}.json ({address}) is a privileged Qelarix identity; use a test-only identity"
    );
    keypair
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &qelarix_qlc::id()).0
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

pub fn no_burn_authority() -> Pubkey {
    Pubkey::find_program_address(&[NO_BURN_SEED], &system_program::ID).0
}

pub fn id32(n: u8) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[0] = n;
    id[31] = 0xAB;
    id
}

/// Program error code (Anchor custom errors start at 6000).
pub fn qlc_err(err: qelarix_qlc::error::QlcError) -> u32 {
    6000 + err as u32
}

pub fn custom_code(res: &Result<(), FailedTransactionMetadata>) -> Option<u32> {
    match res {
        Err(e) => match &e.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(()) => None,
    }
}

pub fn assert_custom(res: Result<(), FailedTransactionMetadata>, code: u32) {
    match &res {
        Ok(()) => panic!("expected custom error {code}, transaction succeeded"),
        Err(e) => assert_eq!(custom_code(&res), Some(code), "unexpected error {:?}; logs: {:#?}", e.err, e.meta.logs),
    }
}

pub fn assert_fails(res: Result<(), FailedTransactionMetadata>) {
    assert!(res.is_err(), "expected the transaction to fail");
}

/// Ways to build a mint that violates the QLC policy (for negative tests).
#[derive(Clone, Copy, Default)]
pub struct MintFlaws {
    pub decimals: Option<u8>,
    pub no_permissioned_burn: bool,
    pub burn_authority: Option<Pubkey>,
    pub no_pausable: bool,
    pub hook_program: Option<Pubkey>,
    pub permanent_delegate: bool,
    pub not_frozen_by_default: bool,
    pub mint_authority: Option<Pubkey>,
    pub freeze_authority: Option<Pubkey>,
    pub premint: bool,
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub operator: Keypair,
    pub mint: Pubkey,
    pub config: Pubkey,
    pub mint_authority: Pubkey,
    pub membership: Pubkey,
    pub vault_authority: Pubkey,
    pub spend_authority: Pubkey,
    pub vault: Pubkey,
    /// Identities this environment already uses; each test identity must be distinct.
    used_identities: Vec<Pubkey>,
    next_wallet: usize,
}

impl Env {
    /// Program deployed with `admin` as upgrade authority; no mint yet.
    pub fn deployed() -> Self {
        let mut svm = LiteSVM::new();
        let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures");
        svm.add_program_from_file(TOKEN_2022, format!("{fixtures}/spl_token_2022.so")).expect("run scripts/fetch-test-fixtures.sh");
        svm.add_program_from_file(ATA_PROGRAM, format!("{fixtures}/spl_associated_token_account.so")).expect("run scripts/fetch-test-fixtures.sh");
        let program = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/qelarix_qlc.so"));
        svm.add_program(qelarix_qlc::id(), program).unwrap();

        let admin = test_identity("admin");
        let operator = test_identity("operator");
        assert_ne!(admin.pubkey(), operator.pubkey(), "admin.json and operator.json must be different identities");
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&operator.pubkey(), 100_000_000_000).unwrap();
        set_upgrade_authority(&mut svm, Some(admin.pubkey()));
        let (admin_key, operator_key) = (admin.pubkey(), operator.pubkey());

        let vault_authority = pda(&[VAULT_SEED]);
        Self {
            svm,
            admin,
            operator,
            mint: Pubkey::default(),
            config: pda(&[CONFIG_SEED]),
            mint_authority: pda(&[MINT_AUTHORITY_SEED]),
            membership: pda(&[MEMBERSHIP_SEED]),
            vault_authority,
            spend_authority: pda(&[SPEND_SEED]),
            vault: Pubkey::default(),
            used_identities: vec![admin_key, operator_key],
            next_wallet: 0,
        }
    }

    /// Records an identity and stops if this environment already uses it.
    fn claim_identity(&mut self, name: &str, keypair: &Keypair) {
        assert!(!self.used_identities.contains(&keypair.pubkey()), "{name}.json repeats another test identity; each must be distinct");
        self.used_identities.push(keypair.pubkey());
    }

    /// Deployed + policy-compliant mint + initialized program.
    pub fn ready() -> Self {
        let mut env = Self::deployed();
        env.create_mint(MintFlaws::default());
        env.initialize().unwrap();
        env
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx).map(|_| ())
    }

    /// The next owner test wallet (wallet-1 … wallet-3); a test that needs more stops.
    pub fn new_wallet(&mut self) -> Keypair {
        self.next_wallet += 1;
        assert!(self.next_wallet <= TEST_WALLETS, "this test needs more than {TEST_WALLETS} owner test wallets");
        let name = format!("wallet-{}", self.next_wallet);
        let wallet = test_identity(&name);
        self.claim_identity(&name, &wallet);
        self.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
        wallet
    }

    /// Builds the QLC mint exactly like the setup script: one transaction creates the mint with the
    /// policy extensions and metadata, then hands the mint authority to the program.
    pub fn create_mint(&mut self, flaws: MintFlaws) -> Pubkey {
        assert_eq!(self.mint, Pubkey::default(), "one QLC mint per test environment (owner test identity mint.json)");
        let admin = self.admin.insecure_clone();
        let mint = test_identity("mint");
        self.claim_identity("mint", &mint);
        let m = mint.pubkey();
        let (name, symbol, uri) = ("Qelarix Credit", "QLC", "https://qelarix.test/qlc.json");

        let mut fixed = 166 + (4 + 64); // base + MetadataPointer
        let mut init: Vec<Instruction> = vec![raw(&m, &[&[39, 0], admin.pubkey().as_ref(), m.as_ref()].concat())];
        if !flaws.not_frozen_by_default {
            fixed += 4 + 1;
            init.push(raw(&m, &[28, 0, 2]));
        }
        if !flaws.no_permissioned_burn {
            fixed += 4 + 32;
            let authority = flaws.burn_authority.unwrap_or_else(no_burn_authority);
            init.push(raw(&m, &[&[46, 0], authority.as_ref()].concat()));
        }
        if !flaws.no_pausable {
            fixed += 4 + 33;
            init.push(raw(&m, &[&[44, 0], admin.pubkey().as_ref()].concat()));
        }
        fixed += 4 + 64;
        let hook = flaws.hook_program.unwrap_or_default();
        init.push(raw(&m, &[&[36, 0], admin.pubkey().as_ref(), hook.as_ref()].concat()));
        if flaws.permanent_delegate {
            fixed += 4 + 32;
            init.push(raw(&m, &[&[35], admin.pubkey().as_ref()].concat()));
        }
        let metadata_len = 4 + 32 + 32 + (4 + name.len()) + (4 + symbol.len()) + (4 + uri.len()) + 4;
        let lamports = self.svm.minimum_balance_for_rent_exemption(fixed + metadata_len);

        let freeze = flaws.freeze_authority.unwrap_or(self.membership);
        let decimals = flaws.decimals.unwrap_or(QLC_DECIMALS);
        let mut ixs = vec![system_instruction::create_account(&admin.pubkey(), &m, lamports, fixed as u64, &TOKEN_2022)];
        ixs.extend(init);
        // Mint authority starts with the admin only so the metadata can be initialized in the same
        // transaction; the last instruction hands it to the program.
        let freeze_during_setup = if flaws.premint { admin.pubkey() } else { freeze };
        ixs.push(raw(&m, &[&[20, decimals], admin.pubkey().as_ref(), &[1], freeze_during_setup.as_ref()].concat()));
        let mut metadata = vec![0xd2, 0xe1, 0x1e, 0xa2, 0x58, 0xb8, 0x4d, 0x8d];
        for s in [name, symbol, uri] {
            metadata.extend((s.len() as u32).to_le_bytes());
            metadata.extend(s.as_bytes());
        }
        ixs.push(Instruction {
            program_id: TOKEN_2022,
            accounts: vec![
                AccountMeta::new(m, false),
                AccountMeta::new_readonly(admin.pubkey(), false),
                AccountMeta::new_readonly(m, false),
                AccountMeta::new_readonly(admin.pubkey(), true),
            ],
            data: metadata,
        });
        if flaws.premint {
            let holder = ata(&admin.pubkey(), &m);
            ixs.push(create_ata_ix(&admin.pubkey(), &admin.pubkey(), &m));
            ixs.push(thaw_ix(&holder, &m, &admin.pubkey()));
            ixs.push(token_ix(&amount_data(14, 5, decimals), vec![AccountMeta::new(m, false), AccountMeta::new(holder, false), AccountMeta::new_readonly(admin.pubkey(), true)]));
            ixs.push(set_authority_ix(&m, 1, &freeze, &admin.pubkey()));
        }
        let final_mint_authority = flaws.mint_authority.unwrap_or(self.mint_authority);
        ixs.push(set_authority_ix(&m, 0, &final_mint_authority, &admin.pubkey()));

        self.send(&ixs, &[&admin, &mint]).expect("mint setup");
        self.mint = m;
        self.vault = ata(&self.vault_authority, &m);
        m
    }

    pub fn initialize(&mut self) -> Result<(), FailedTransactionMetadata> {
        let admin = self.admin.insecure_clone();
        let args = InitializeArgs {
            operator: self.operator.pubkey(),
            max_delivery_amount: MAX_DELIVERY,
            max_charge_amount: MAX_CHARGE,
            mint_window_secs: WINDOW_SECS,
            mint_window_cap: WINDOW_CAP,
        };
        let ix = self.initialize_ix(&admin.pubkey(), args);
        self.send(&[ix], &[&admin])
    }

    pub fn initialize_ix(&self, admin: &Pubkey, args: InitializeArgs) -> Instruction {
        Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::Initialize {
                admin: *admin,
                config: self.config,
                qlc_mint: self.mint,
                mint_authority: self.mint_authority,
                membership_authority: self.membership,
                vault_authority: self.vault_authority,
                spend_authority: self.spend_authority,
                vault: self.vault,
                program: qelarix_qlc::id(),
                program_data: pda_of(&[qelarix_qlc::id().as_ref()], &BPF_LOADER_UPGRADEABLE),
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::Initialize { args }.data(),
        }
    }

    pub fn register_ix(&self, operator: &Pubkey, wallet: &Pubkey) -> Instruction {
        Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::RegisterMember {
                operator: *operator,
                config: self.config,
                wallet: *wallet,
                member: pda(&[MEMBER_SEED, wallet.as_ref()]),
                qlc_mint: self.mint,
                member_token_account: ata(wallet, &self.mint),
                membership_authority: self.membership,
                token_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::RegisterMember {}.data(),
        }
    }

    /// Registers a member: the operator and the wallet both sign.
    pub fn register(&mut self, wallet: &Keypair) -> Result<(), FailedTransactionMetadata> {
        let operator = self.operator.insecure_clone();
        let ix = self.register_ix(&operator.pubkey(), &wallet.pubkey());
        self.send(&[ix], &[&operator, wallet])
    }

    pub fn deliver_ix(&self, operator: &Pubkey, wallet: &Pubkey, id: [u8; 32], amount: u64, kind: DeliveryKind) -> Instruction {
        Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::Deliver {
                operator: *operator,
                config: self.config,
                member: pda(&[MEMBER_SEED, wallet.as_ref()]),
                member_token_account: ata(wallet, &self.mint),
                delivery_receipt: pda(&[DELIVERY_SEED, id.as_ref()]),
                qlc_mint: self.mint,
                vault: self.vault,
                vault_authority: self.vault_authority,
                mint_authority: self.mint_authority,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::Deliver { delivery_id: id, amount, kind }.data(),
        }
    }

    pub fn deliver(&mut self, wallet: &Pubkey, id: [u8; 32], amount: u64) -> Result<(), FailedTransactionMetadata> {
        let operator = self.operator.insecure_clone();
        let ix = self.deliver_ix(&operator.pubkey(), wallet, id, amount, DeliveryKind::Purchase);
        self.send(&[ix], &[&operator])
    }

    pub fn charge_pda(wallet: &Pubkey, seq: u64) -> Pubkey {
        pda(&[CHARGE_SEED, wallet.as_ref(), &seq.to_le_bytes()])
    }

    pub fn charge_ix(&self, operator: &Pubkey, wallet: &Pubkey, seq: u64, amount: u64) -> Instruction {
        Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::Charge {
                operator: *operator,
                config: self.config,
                member: pda(&[MEMBER_SEED, wallet.as_ref()]),
                member_token_account: ata(wallet, &self.mint),
                charge_receipt: Self::charge_pda(wallet, seq),
                qlc_mint: self.mint,
                vault: self.vault,
                spend_authority: self.spend_authority,
                token_program: TOKEN_2022,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::Charge { seq, amount }.data(),
        }
    }

    pub fn charge(&mut self, wallet: &Pubkey, seq: u64, amount: u64) -> Result<(), FailedTransactionMetadata> {
        let operator = self.operator.insecure_clone();
        let ix = self.charge_ix(&operator.pubkey(), wallet, seq, amount);
        self.send(&[ix], &[&operator])
    }

    pub fn refund_ix(&self, operator: &Pubkey, wallet: &Pubkey, seq: u64) -> Instruction {
        Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::Refund {
                operator: *operator,
                config: self.config,
                charge_receipt: Self::charge_pda(wallet, seq),
                member: pda(&[MEMBER_SEED, wallet.as_ref()]),
                member_token_account: ata(wallet, &self.mint),
                qlc_mint: self.mint,
                vault: self.vault,
                vault_authority: self.vault_authority,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::Refund {}.data(),
        }
    }

    pub fn refund(&mut self, wallet: &Pubkey, seq: u64) -> Result<(), FailedTransactionMetadata> {
        let operator = self.operator.insecure_clone();
        let ix = self.refund_ix(&operator.pubkey(), wallet, seq);
        self.send(&[ix], &[&operator])
    }

    pub fn close_charge(&mut self, wallet: &Pubkey, seq: u64) -> Result<(), FailedTransactionMetadata> {
        let operator = self.operator.insecure_clone();
        let ix = Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::CloseCharge {
                operator: operator.pubkey(),
                config: self.config,
                charge_receipt: Self::charge_pda(wallet, seq),
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::CloseCharge {}.data(),
        };
        self.send(&[ix], &[&operator])
    }

    pub fn update_config(&mut self, signer: &Keypair, args: UpdateConfigArgs) -> Result<(), FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::UpdateConfig { admin: signer.pubkey(), config: self.config }.to_account_metas(None),
            data: qelarix_qlc::instruction::UpdateConfig { args }.data(),
        };
        self.send(&[ix], &[signer])
    }

    pub fn set_admin(&mut self, admin: &Keypair, new_admin: &Keypair) -> Result<(), FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::SetAdmin { admin: admin.pubkey(), new_admin: new_admin.pubkey(), config: self.config }
                .to_account_metas(None),
            data: qelarix_qlc::instruction::SetAdmin {}.data(),
        };
        self.send(&[ix], &[admin, new_admin])
    }

    pub fn set_suspended(&mut self, signer: &Keypair, wallet: &Pubkey, suspended: bool) -> Result<(), FailedTransactionMetadata> {
        let ix = Instruction {
            program_id: qelarix_qlc::id(),
            accounts: qelarix_qlc::accounts::SetMemberSuspended {
                admin: signer.pubkey(),
                config: self.config,
                member: pda(&[MEMBER_SEED, wallet.as_ref()]),
                member_token_account: ata(wallet, &self.mint),
                qlc_mint: self.mint,
                membership_authority: self.membership,
                token_program: TOKEN_2022,
            }
            .to_account_metas(None),
            data: qelarix_qlc::instruction::SetMemberSuspended { suspended }.data(),
        };
        self.send(&[ix], &[signer])
    }

    /// Member approves the spend delegate for `amount` (one wallet signature).
    pub fn approve(&mut self, wallet: &Keypair, amount: u64) -> Result<(), FailedTransactionMetadata> {
        let ix = token_ix(
            &amount_data(13, amount, QLC_DECIMALS),
            vec![
                AccountMeta::new(ata(&wallet.pubkey(), &self.mint), false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(self.spend_authority, false),
                AccountMeta::new_readonly(wallet.pubkey(), true),
            ],
        );
        self.send(&[ix], &[wallet])
    }

    /// Wallet-native transfer between two QLC accounts (no program involved).
    pub fn transfer(&mut self, from: &Keypair, to_account: &Pubkey, amount: u64) -> Result<(), FailedTransactionMetadata> {
        let ix = token_ix(
            &amount_data(12, amount, QLC_DECIMALS),
            vec![
                AccountMeta::new(ata(&from.pubkey(), &self.mint), false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(*to_account, false),
                AccountMeta::new_readonly(from.pubkey(), true),
            ],
        );
        self.send(&[ix], &[from])
    }

    pub fn balance(&self, account: &Pubkey) -> u64 {
        let data = self.svm.get_account(account).expect("token account").data;
        StateWithExtensions::<TokenAccount>::unpack(&data).unwrap().base.amount
    }

    pub fn token_account(&self, account: &Pubkey) -> TokenAccount {
        let data = self.svm.get_account(account).expect("token account").data;
        StateWithExtensions::<TokenAccount>::unpack(&data).unwrap().base
    }

    pub fn supply(&self) -> u64 {
        let data = self.svm.get_account(&self.mint).unwrap().data;
        StateWithExtensions::<Mint>::unpack(&data).unwrap().base.supply
    }

    pub fn config(&self) -> Config {
        fetch(&self.svm, &self.config)
    }

    pub fn warp_secs(&mut self, secs: i64) {
        let mut clock: anchor_lang::prelude::Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }
}

pub fn fetch<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let account = svm.get_account(address).expect("account missing");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

pub fn pda_of(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn raw(mint: &Pubkey, data: &[u8]) -> Instruction {
    Instruction { program_id: TOKEN_2022, accounts: vec![AccountMeta::new(*mint, false)], data: data.to_vec() }
}

/// Token instruction data laid out as [instruction, u64 amount, decimals].
pub fn amount_data(instruction: u8, amount: u64, decimals: u8) -> Vec<u8> {
    let mut data = vec![instruction];
    data.extend(amount.to_le_bytes());
    data.push(decimals);
    data
}

pub fn token_ix(data: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: TOKEN_2022, accounts, data: data.to_vec() }
}

pub fn thaw_ix(account: &Pubkey, mint: &Pubkey, authority: &Pubkey) -> Instruction {
    token_ix(&[11], vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false), AccountMeta::new_readonly(*authority, true)])
}

pub fn set_authority_ix(owned: &Pubkey, kind: u8, new_authority: &Pubkey, current: &Pubkey) -> Instruction {
    token_ix(&[&[6, kind, 1], new_authority.as_ref()].concat(), vec![AccountMeta::new(*owned, false), AccountMeta::new_readonly(*current, true)])
}

pub fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![1],
    }
}

pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: Option<Pubkey>) {
    let program_data = pda_of(&[qelarix_qlc::id().as_ref()], &BPF_LOADER_UPGRADEABLE);
    let mut account = svm.get_account(&program_data).expect("programdata");
    assert_eq!(&account.data[0..4], &3u32.to_le_bytes(), "not a ProgramData account");
    match authority {
        Some(key) => {
            account.data[12] = 1;
            account.data[13..45].copy_from_slice(key.as_ref());
        }
        None => account.data[12] = 0,
    }
    svm.set_account(program_data, account).unwrap();
}
