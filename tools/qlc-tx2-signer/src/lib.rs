//! Owner-run Ledger signer for the QLC program's one-time `initialize` (TX2) on Solana devnet.
//!
//! The Ledger is reached only through the official Agave 4.1.2 path (`solana-clap-utils::keypair::signer_from_path`
//! → `solana-remote-wallet`), exactly as the `solana` CLI does; this crate contains no device, USB/HID, APDU or
//! message-encoding code of its own.
pub mod chain;
pub mod cli;
pub mod constants;
pub mod flow;
pub mod policy;
pub mod tx2;
pub mod update;
