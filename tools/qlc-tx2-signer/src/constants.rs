//! Locked devnet inputs (Task 08/09/09A) and the addresses derived from them. Public values only.
use {solana_hash::Hash, solana_pubkey::Pubkey, std::str::FromStr};

pub const DEVNET_RPC: &str = "https://api.devnet.solana.com";
pub const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

pub const PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa");
/// Owner Ledger: program upgrade authority, config admin, and (program constraint) the TX2 rent payer.
pub const ADMIN: Pubkey = Pubkey::from_str_const("B2sGhW5He2nT5zMYSoYRxrvwKdhdthphYT3G6zaUqNoG");
pub const OPERATOR: Pubkey = Pubkey::from_str_const("4GEGAVHQCwshpv3yC25Xs7ACmWvNpcjTneT56XVD8McL");
pub const MINT: Pubkey = Pubkey::from_str_const("7CLTFoNMNY8otRNA9zU7G84VPwxCCP4rWVvsZj2vp1Tk");

pub const TOKEN_2022: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");
pub const BPF_LOADER_UPGRADEABLE: Pubkey =
    Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");

// solana/programs/qelarix-qlc/src/constants.rs
pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub const MEMBERSHIP_SEED: &[u8] = b"membership";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SPEND_SEED: &[u8] = b"spend";
pub const NO_BURN_SEED: &[u8] = b"qlc-permanent-no-burn";

/// Anchor discriminators of `initialize` and the `Config` account (generated client, solana/metadata/idl.json).
pub const INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
pub const CONFIG_DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];

/// 8-byte discriminator + `Config::INIT_SPACE`.
pub const CONFIG_SIZE: usize = 222;
/// Vault associated token account for a mint with exactly the QLC extensions: 165 base bytes + account type +
/// ImmutableOwner (4 + 0) + TransferHookAccount (4 + 1) + PausableAccount (4 + 0).
pub const VAULT_SIZE: usize = 179;
/// One signature, no priority fee: the only fee the reviewed TX2 may cost.
pub const LAMPORTS_PER_SIGNATURE: u64 = 5_000;

pub const QLC_DECIMALS: u8 = 2;
pub const METADATA_NAME: &str = "Qelarix Credit";
pub const METADATA_SYMBOL: &str = "QLC";
/// Devnet metadata host (owner lock, Task 09D): the live Qelarix platform, until a reviewed final-domain cutover.
pub const METADATA_URI: &str = "https://qelarix.vercel.app/qlc.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_delivery_amount: u64,
    pub max_charge_amount: u64,
    pub mint_window_secs: i64,
    pub mint_window_cap: u64,
}

/// Owner-approved devnet limits (2026-10-03): 10,000.00 / 100.00 / 24 h / 20,000.00 QLC.
pub const DEVNET_LIMITS: Limits = Limits {
    max_delivery_amount: 1_000_000,
    max_charge_amount: 10_000,
    mint_window_secs: 86_400,
    mint_window_cap: 2_000_000,
};

/// What the signer requires. Production code only ever uses [`Expected::devnet`]; there is no flag to change it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expected {
    pub genesis: Hash,
    pub program: Pubkey,
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub mint: Pubkey,
    pub limits: Limits,
}

impl Expected {
    pub fn devnet() -> Self {
        Self {
            genesis: Hash::from_str(DEVNET_GENESIS).expect("devnet genesis constant"),
            program: PROGRAM_ID,
            admin: ADMIN,
            operator: OPERATOR,
            mint: MINT,
            limits: DEVNET_LIMITS,
        }
    }
}

/// Program-derived addresses and bumps the initialize instruction and its results must use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Derived {
    pub config: Pubkey,
    pub config_bump: u8,
    pub mint_authority: Pubkey,
    pub mint_authority_bump: u8,
    pub membership: Pubkey,
    pub membership_bump: u8,
    pub vault_authority: Pubkey,
    pub vault_bump: u8,
    pub spend_authority: Pubkey,
    pub spend_bump: u8,
    pub vault: Pubkey,
    pub program_data: Pubkey,
    pub no_burn: Pubkey,
}

impl Derived {
    pub fn new(expected: &Expected) -> Self {
        let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed], &expected.program);
        let (config, config_bump) = pda(CONFIG_SEED);
        let (mint_authority, mint_authority_bump) = pda(MINT_AUTHORITY_SEED);
        let (membership, membership_bump) = pda(MEMBERSHIP_SEED);
        let (vault_authority, vault_bump) = pda(VAULT_SEED);
        let (spend_authority, spend_bump) = pda(SPEND_SEED);
        let (vault, _) = Pubkey::find_program_address(
            &[
                vault_authority.as_ref(),
                TOKEN_2022.as_ref(),
                expected.mint.as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        );
        let (program_data, _) =
            Pubkey::find_program_address(&[expected.program.as_ref()], &BPF_LOADER_UPGRADEABLE);
        let (no_burn, _) = Pubkey::find_program_address(&[NO_BURN_SEED], &SYSTEM);
        Self {
            config,
            config_bump,
            mint_authority,
            mint_authority_bump,
            membership,
            membership_bump,
            vault_authority,
            vault_bump,
            spend_authority,
            spend_bump,
            vault,
            program_data,
            no_burn,
        }
    }
}
