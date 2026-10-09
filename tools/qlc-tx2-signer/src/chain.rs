//! Everything the signer reads from or sends to the cluster, behind one trait so the tests can use mocks.
use {
    solana_commitment_config::CommitmentConfig,
    solana_hash::Hash,
    solana_message::Message,
    solana_pubkey::Pubkey,
    solana_rpc_client::rpc_client::RpcClient,
    solana_rpc_client_api::config::{
        RpcSendTransactionConfig, RpcSimulateTransactionAccountsConfig,
        RpcSimulateTransactionConfig, UiAccountEncoding, UiTransactionEncoding,
    },
    solana_signature::Signature,
    solana_transaction::Transaction,
};

pub type Res<T> = Result<T, String>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountInfo {
    pub owner: Pubkey,
    pub lamports: u64,
    pub data: Vec<u8>,
    pub executable: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Simulation {
    pub err: Option<String>,
    pub logs: Vec<String>,
    pub units: Option<u64>,
    pub fee: Option<u64>,
    /// Post-simulation state of the requested addresses, in order.
    pub accounts: Vec<Option<AccountInfo>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    NotFound,
    Pending,
    Failed(String),
    Confirmed,
}

pub trait Chain {
    fn genesis_hash(&self) -> Res<Hash>;
    fn account(&self, key: &Pubkey) -> Res<Option<AccountInfo>>;
    fn rent_exempt_minimum(&self, len: usize) -> Res<u64>;
    /// Latest blockhash and the last block height at which it is valid.
    fn latest_blockhash(&self) -> Res<(Hash, u64)>;
    fn block_height(&self) -> Res<u64>;
    fn fee_for_message(&self, message: &Message) -> Res<u64>;
    /// Simulates without signature verification and without replacing the blockhash.
    fn simulate(&self, transaction: &Transaction, accounts: &[Pubkey]) -> Res<Simulation>;
    fn send(&self, transaction: &Transaction) -> Res<Signature>;
    fn status(&self, signature: &Signature) -> Res<Status>;
}

pub struct RpcChain {
    client: RpcClient,
}

impl RpcChain {
    pub fn new(url: &str) -> Self {
        Self {
            client: RpcClient::new_with_commitment(url.to_string(), CommitmentConfig::confirmed()),
        }
    }
}

fn err(e: impl std::fmt::Display) -> String {
    format!("RPC error: {e}")
}

impl Chain for RpcChain {
    fn genesis_hash(&self) -> Res<Hash> {
        self.client.get_genesis_hash().map_err(err)
    }

    fn account(&self, key: &Pubkey) -> Res<Option<AccountInfo>> {
        let response = self
            .client
            .get_account_with_commitment(key, CommitmentConfig::confirmed())
            .map_err(err)?;
        Ok(response.value.map(|a| AccountInfo {
            owner: a.owner,
            lamports: a.lamports,
            data: a.data,
            executable: a.executable,
        }))
    }

    fn rent_exempt_minimum(&self, len: usize) -> Res<u64> {
        self.client
            .get_minimum_balance_for_rent_exemption(len)
            .map_err(err)
    }

    fn latest_blockhash(&self) -> Res<(Hash, u64)> {
        self.client
            .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            .map_err(err)
    }

    fn block_height(&self) -> Res<u64> {
        self.client
            .get_block_height_with_commitment(CommitmentConfig::confirmed())
            .map_err(err)
    }

    fn fee_for_message(&self, message: &Message) -> Res<u64> {
        self.client.get_fee_for_message(message).map_err(err)
    }

    fn simulate(&self, transaction: &Transaction, accounts: &[Pubkey]) -> Res<Simulation> {
        let config = RpcSimulateTransactionConfig {
            sig_verify: false,
            replace_recent_blockhash: false,
            commitment: Some(CommitmentConfig::confirmed()),
            encoding: Some(UiTransactionEncoding::Base64),
            accounts: Some(RpcSimulateTransactionAccountsConfig {
                encoding: Some(UiAccountEncoding::Base64),
                addresses: accounts.iter().map(|a| a.to_string()).collect(),
            }),
            min_context_slot: None,
            inner_instructions: false,
        };
        let result = self
            .client
            .simulate_transaction_with_config(transaction, config)
            .map_err(err)?
            .value;
        let accounts = result
            .accounts
            .unwrap_or_default()
            .into_iter()
            .map(|account| {
                account.and_then(|a| {
                    let decoded = a.to_account()?;
                    Some(AccountInfo {
                        owner: decoded.owner,
                        lamports: decoded.lamports,
                        data: decoded.data,
                        executable: decoded.executable,
                    })
                })
            })
            .collect();
        Ok(Simulation {
            err: result.err.map(|e| format!("{e:?}")),
            logs: result.logs.unwrap_or_default(),
            units: result.units_consumed,
            fee: result.fee,
            accounts,
        })
    }

    fn send(&self, transaction: &Transaction) -> Res<Signature> {
        let config = RpcSendTransactionConfig {
            skip_preflight: false,
            preflight_commitment: Some(CommitmentConfig::confirmed().commitment),
            encoding: Some(UiTransactionEncoding::Base64),
            max_retries: None,
            min_context_slot: None,
        };
        self.client
            .send_transaction_with_config(transaction, config)
            .map_err(err)
    }

    fn status(&self, signature: &Signature) -> Res<Status> {
        let statuses = self
            .client
            .get_signature_statuses(&[*signature])
            .map_err(err)?
            .value;
        Ok(match statuses.into_iter().next().flatten() {
            None => Status::NotFound,
            Some(status) => match status.err {
                Some(e) => Status::Failed(format!("{e:?}")),
                None if status.satisfies_commitment(CommitmentConfig::confirmed()) => {
                    Status::Confirmed
                }
                None => Status::Pending,
            },
        })
    }
}
