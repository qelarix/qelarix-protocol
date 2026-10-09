#!/usr/bin/env sh
# Downloads the devnet Token-2022 and associated-token-account programs (read-only) so the LiteSVM
# tests run against the same program versions as devnet. Output is git-ignored.
set -eu
cd "$(dirname "$0")/.."
mkdir -p tests/fixtures
solana program dump -u devnet TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb tests/fixtures/spl_token_2022.so
solana program dump -u devnet ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL tests/fixtures/spl_associated_token_account.so
