use anchor_lang::prelude::*;

#[error_code]
pub enum QlcError {
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("The QLC program is paused")]
    Paused,
    #[msg("Amount must be positive and a multiple of 0.05 QLC")]
    InvalidAmount,
    #[msg("Amount is above the configured limit")]
    AmountAboveLimit,
    #[msg("Newly minted QLC would exceed the current mint window cap")]
    MintWindowCapExceeded,
    #[msg("Member is suspended")]
    MemberSuspended,
    #[msg("Invalid configuration value")]
    InvalidConfig,
    #[msg("Mint decimals, supply or authorities do not match the QLC policy")]
    InvalidMint,
    #[msg("Mint extensions do not match the QLC policy")]
    MintPolicyViolation,
    #[msg("Token account does not belong to this member")]
    WrongTokenAccount,
    #[msg("Spend allowance is missing or too low")]
    AllowanceTooLow,
    #[msg("Charge was already refunded")]
    AlreadyRefunded,
    #[msg("Charge sequence must be greater than the member's last charge sequence")]
    ChargeSequenceUsed,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
