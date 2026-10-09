//! QLC program tests on LiteSVM with the devnet Token-2022 and ATA programs.
mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_spl::token_2022::spl_token_2022::state::AccountState,
    common::*,
    qelarix_qlc::{constants::*, error::QlcError, state::*, InitializeArgs, UpdateConfigArgs},
    solana_signer::Signer,
};

// ── Initialization and mint policy ───────────────────────────────────────────

#[test]
fn initialize_accepts_policy_mint_and_admits_the_vault() {
    let env = Env::ready();
    let config = env.config();
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.operator, env.operator.pubkey());
    assert_eq!(config.qlc_mint, env.mint);
    assert_eq!(config.vault, env.vault);
    assert_eq!(env.token_account(&env.vault).state, AccountState::Initialized);
    assert_eq!(env.token_account(&env.vault).owner, env.vault_authority);
    assert_eq!(env.supply(), 0);
}

fn rejected_mint(flaws: MintFlaws, expected: QlcError) {
    let mut env = Env::deployed();
    env.create_mint(flaws);
    assert_custom(env.initialize(), qlc_err(expected));
}

#[test]
fn initialize_rejects_wrong_decimals() {
    rejected_mint(MintFlaws { decimals: Some(6), ..Default::default() }, QlcError::InvalidMint);
}

#[test]
fn initialize_rejects_mint_authority_outside_the_program() {
    rejected_mint(MintFlaws { mint_authority: Some(Pubkey::new_unique()), ..Default::default() }, QlcError::InvalidMint);
}

#[test]
fn initialize_rejects_freeze_authority_outside_the_program() {
    rejected_mint(MintFlaws { freeze_authority: Some(Pubkey::new_unique()), ..Default::default() }, QlcError::InvalidMint);
}

#[test]
fn initialize_rejects_preminted_supply() {
    rejected_mint(MintFlaws { premint: true, ..Default::default() }, QlcError::InvalidMint);
}

#[test]
fn initialize_rejects_missing_permissioned_burn() {
    rejected_mint(MintFlaws { no_permissioned_burn: true, ..Default::default() }, QlcError::MintPolicyViolation);
}

#[test]
fn initialize_rejects_a_usable_burn_authority() {
    rejected_mint(MintFlaws { burn_authority: Some(Pubkey::new_unique()), ..Default::default() }, QlcError::MintPolicyViolation);
}

#[test]
fn initialize_rejects_missing_pausable() {
    rejected_mint(MintFlaws { no_pausable: true, ..Default::default() }, QlcError::MintPolicyViolation);
}

#[test]
fn initialize_rejects_an_active_transfer_hook() {
    rejected_mint(MintFlaws { hook_program: Some(Pubkey::new_unique()), ..Default::default() }, QlcError::MintPolicyViolation);
}

#[test]
fn initialize_rejects_permanent_delegate() {
    rejected_mint(MintFlaws { permanent_delegate: true, ..Default::default() }, QlcError::MintPolicyViolation);
}

#[test]
fn initialize_rejects_accounts_that_are_not_frozen_by_default() {
    rejected_mint(MintFlaws { not_frozen_by_default: true, ..Default::default() }, QlcError::MintPolicyViolation);
}

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut env = Env::deployed();
    env.create_mint(MintFlaws::default());
    let stranger = env.new_wallet();
    let args = InitializeArgs {
        operator: env.operator.pubkey(),
        max_delivery_amount: MAX_DELIVERY,
        max_charge_amount: MAX_CHARGE,
        mint_window_secs: WINDOW_SECS,
        mint_window_cap: WINDOW_CAP,
    };
    let ix = env.initialize_ix(&stranger.pubkey(), args);
    assert_custom(env.send(&[ix], &[&stranger]), qlc_err(QlcError::Unauthorized));
}

#[test]
fn initialize_rejects_limits_off_the_0_05_step() {
    let mut env = Env::deployed();
    env.create_mint(MintFlaws::default());
    let admin = env.admin.insecure_clone();
    let args = InitializeArgs {
        operator: env.operator.pubkey(),
        max_delivery_amount: 1_003,
        max_charge_amount: MAX_CHARGE,
        mint_window_secs: WINDOW_SECS,
        mint_window_cap: WINDOW_CAP,
    };
    let ix = env.initialize_ix(&admin.pubkey(), args);
    assert_custom(env.send(&[ix], &[&admin]), qlc_err(QlcError::InvalidConfig));
}

// ── Membership and transfer rules ────────────────────────────────────────────

#[test]
fn register_member_creates_and_thaws_the_account_once() {
    let mut env = Env::ready();
    let user = env.new_wallet();
    let operator_before = env.svm.get_balance(&env.operator.pubkey()).unwrap();
    env.register(&user).unwrap();
    let account = ata(&user.pubkey(), &env.mint);
    assert_eq!(env.token_account(&account).state, AccountState::Initialized);
    assert_eq!(env.token_account(&account).owner, user.pubkey());
    assert!(env.svm.get_balance(&env.operator.pubkey()).unwrap() < operator_before, "Qelarix pays the account rent");
    let member: Member = fetch(&env.svm, &pda(&[MEMBER_SEED, user.pubkey().as_ref()]));
    assert_eq!(member.wallet, user.pubkey());
    assert!(!member.suspended);
    env.register(&user).unwrap(); // idempotent
}

#[test]
fn members_can_transfer_to_members_but_not_to_outside_accounts() {
    let mut env = Env::ready();
    let (alice, bob, outsider) = (env.new_wallet(), env.new_wallet(), env.new_wallet());
    env.register(&alice).unwrap();
    env.register(&bob).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();

    env.transfer(&alice, &ata(&bob.pubkey(), &env.mint), 105).unwrap();
    assert_eq!(env.balance(&ata(&bob.pubkey(), &env.mint)), 105);

    // An outsider can create a QLC account, but it stays frozen: it cannot receive QLC.
    let payer = outsider.insecure_clone();
    let create = create_ata_ix(&payer.pubkey(), &outsider.pubkey(), &env.mint);
    env.send(&[create], &[&payer]).unwrap();
    let outside_account = ata(&outsider.pubkey(), &env.mint);
    assert_eq!(env.token_account(&outside_account).state, AccountState::Frozen);
    assert_fails(env.transfer(&alice, &outside_account, 5));

    // Nobody but the program can thaw it.
    let thaw = thaw_ix(&outside_account, &env.mint, &outsider.pubkey());
    assert_fails(env.send(&[thaw], &[&outsider]));
}

// ── Deliveries: exactly-once, vault reuse, mint on demand ────────────────────

#[test]
fn delivery_mints_only_what_the_vault_cannot_cover() {
    let mut env = Env::ready();
    let (alice, bob) = (env.new_wallet(), env.new_wallet());
    env.register(&alice).unwrap();
    env.register(&bob).unwrap();

    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap(); // empty vault: all minted
    assert_eq!(env.supply(), 1_000);

    env.approve(&alice, 600).unwrap();
    env.charge(&alice.pubkey(), 50, 600).unwrap(); // 6.00 QLC back into the vault
    assert_eq!(env.balance(&env.vault), 600);

    env.deliver(&bob.pubkey(), id32(2), 500).unwrap(); // covered by the vault
    assert_eq!(env.supply(), 1_000, "no new QLC while the vault can cover the delivery");
    assert_eq!(env.balance(&env.vault), 100);

    env.deliver(&bob.pubkey(), id32(3), 300).unwrap(); // 100 from vault + 200 minted
    assert_eq!(env.supply(), 1_200);
    assert_eq!(env.balance(&env.vault), 0);
    assert_eq!(env.balance(&ata(&bob.pubkey(), &env.mint)), 800);

    let receipt: DeliveryReceipt = fetch(&env.svm, &pda(&[DELIVERY_SEED, id32(3).as_ref()]));
    assert_eq!((receipt.amount, receipt.from_vault, receipt.minted), (300, 100, 200));
    assert_eq!(receipt.recipient, bob.pubkey());
    let config = env.config();
    assert_eq!((config.total_minted, config.total_delivered), (1_200, 1_800));
}

#[test]
fn a_delivery_id_can_never_deliver_twice() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(7), 500).unwrap();
    assert_fails(env.deliver(&alice.pubkey(), id32(7), 500));
    assert_eq!(env.balance(&ata(&alice.pubkey(), &env.mint)), 500);
}

#[test]
fn delivery_amounts_follow_the_0_05_step_and_limits() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    assert_custom(env.deliver(&alice.pubkey(), id32(1), 0), qlc_err(QlcError::InvalidAmount));
    assert_custom(env.deliver(&alice.pubkey(), id32(2), 101), qlc_err(QlcError::InvalidAmount));
    assert_custom(env.deliver(&alice.pubkey(), id32(3), MAX_DELIVERY + 5), qlc_err(QlcError::AmountAboveLimit));
    env.deliver(&alice.pubkey(), id32(4), 5).unwrap();
}

#[test]
fn newly_minted_qlc_is_capped_per_window() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(1), MAX_DELIVERY).unwrap();
    env.deliver(&alice.pubkey(), id32(2), MAX_DELIVERY).unwrap();
    assert_custom(env.deliver(&alice.pubkey(), id32(3), 5), qlc_err(QlcError::MintWindowCapExceeded));
    env.warp_secs(WINDOW_SECS);
    env.deliver(&alice.pubkey(), id32(4), 5).unwrap();
}

#[test]
fn only_the_operator_delivers_and_only_to_members() {
    let mut env = Env::ready();
    let (alice, stranger) = (env.new_wallet(), env.new_wallet());
    env.register(&alice).unwrap();
    let ix = env.deliver_ix(&stranger.pubkey(), &alice.pubkey(), id32(1), 5, DeliveryKind::Reward);
    assert_custom(env.send(&[ix], &[&stranger]), qlc_err(QlcError::Unauthorized));
    let non_member = env.new_wallet();
    assert_fails(env.deliver(&non_member.pubkey(), id32(2), 5));
}

// ── Spending: allowance, charge, refund ──────────────────────────────────────

#[test]
fn charge_requires_an_allowance_and_moves_qlc_to_the_vault() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();

    assert_custom(env.charge(&alice.pubkey(), 10, 105), qlc_err(QlcError::AllowanceTooLow));
    env.approve(&alice, 300).unwrap();
    env.charge(&alice.pubkey(), 10, 105).unwrap();
    let account = env.token_account(&ata(&alice.pubkey(), &env.mint));
    assert_eq!((account.amount, account.delegated_amount), (895, 195));
    assert_eq!(env.balance(&env.vault), 105);
    assert_custom(env.charge(&alice.pubkey(), 11, 200), qlc_err(QlcError::AllowanceTooLow));
    assert_fails(env.charge(&alice.pubkey(), 10, 5)); // same sequence
    assert_custom(env.charge(&alice.pubkey(), 12, 7), qlc_err(QlcError::InvalidAmount));
}

#[test]
fn a_charge_is_refunded_at_most_once() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();
    env.approve(&alice, 500).unwrap();
    env.charge(&alice.pubkey(), 20, 250).unwrap();

    env.refund(&alice.pubkey(), 20).unwrap();
    assert_eq!(env.balance(&ata(&alice.pubkey(), &env.mint)), 1_000);
    assert_eq!(env.balance(&env.vault), 0);
    assert_custom(env.refund(&alice.pubkey(), 20), qlc_err(QlcError::AlreadyRefunded));

    env.close_charge(&alice.pubkey(), 20).unwrap();
    assert!(env.svm.get_account(&Env::charge_pda(&alice.pubkey(), 20)).map_or(true, |a| a.lamports == 0));
    assert_fails(env.refund(&alice.pubkey(), 20));
}

#[test]
fn refunds_still_work_while_the_program_is_paused() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();
    env.approve(&alice, 500).unwrap();
    env.charge(&alice.pubkey(), 30, 100).unwrap();

    let admin = env.admin.insecure_clone();
    env.update_config(&admin, UpdateConfigArgs { paused: Some(true), ..Default::default() }).unwrap();
    assert_custom(env.deliver(&alice.pubkey(), id32(2), 5), qlc_err(QlcError::Paused));
    assert_custom(env.charge(&alice.pubkey(), 31, 5), qlc_err(QlcError::Paused));
    env.refund(&alice.pubkey(), 30).unwrap();
    assert_eq!(env.balance(&ata(&alice.pubkey(), &env.mint)), 1_000);
}

// ── No burn ──────────────────────────────────────────────────────────────────

#[test]
fn nobody_can_burn_qlc() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();
    let account = ata(&alice.pubkey(), &env.mint);
    let mint = env.mint;
    let accounts = |extra: Vec<anchor_lang::solana_program::instruction::AccountMeta>| {
        let mut list = vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(account, false),
            anchor_lang::solana_program::instruction::AccountMeta::new(mint, false),
        ];
        list.extend(extra);
        list
    };
    // Plain burn by the holder is rejected by Token-2022 (PermissionedBurn).
    let burn = token_ix(
        &amount_data(15, 5, QLC_DECIMALS),
        accounts(vec![anchor_lang::solana_program::instruction::AccountMeta::new_readonly(alice.pubkey(), true)]),
    );
    assert_fails(env.send(&[burn], &[&alice]));
    // A permissioned burn needs the no-burn authority's signature, which cannot exist.
    let permissioned = token_ix(
        &[&[46u8][..], &amount_data(2, 5, QLC_DECIMALS)].concat(),
        accounts(vec![
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(no_burn_authority(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(alice.pubkey(), true),
        ]),
    );
    assert_fails(env.send(&[permissioned], &[&alice]));
    assert_eq!(env.supply(), 1_000);
    assert!(!no_burn_authority().is_on_curve(), "the no-burn authority has no private key");
}

// ── Pause, suspension and admin ──────────────────────────────────────────────

#[test]
fn token_level_pause_by_the_admin_stops_transfers() {
    let mut env = Env::ready();
    let (alice, bob) = (env.new_wallet(), env.new_wallet());
    env.register(&alice).unwrap();
    env.register(&bob).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();
    let admin = env.admin.insecure_clone();
    let pause = token_ix(&[44, 1], vec![
        anchor_lang::solana_program::instruction::AccountMeta::new(env.mint, false),
        anchor_lang::solana_program::instruction::AccountMeta::new_readonly(admin.pubkey(), true),
    ]);
    env.send(&[pause], &[&admin]).unwrap();
    assert_fails(env.transfer(&alice, &ata(&bob.pubkey(), &env.mint), 5));
    assert_fails(env.deliver(&bob.pubkey(), id32(2), 5));
}

#[test]
fn suspension_freezes_and_reinstatement_thaws() {
    let mut env = Env::ready();
    let (alice, bob) = (env.new_wallet(), env.new_wallet());
    env.register(&alice).unwrap();
    env.register(&bob).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();
    let admin = env.admin.insecure_clone();

    env.set_suspended(&admin, &alice.pubkey(), true).unwrap();
    assert_eq!(env.token_account(&ata(&alice.pubkey(), &env.mint)).state, AccountState::Frozen);
    assert_fails(env.transfer(&alice, &ata(&bob.pubkey(), &env.mint), 5));
    assert_custom(env.deliver(&alice.pubkey(), id32(2), 5), qlc_err(QlcError::MemberSuspended));
    assert_custom(env.register(&alice), qlc_err(QlcError::MemberSuspended));

    let operator = env.operator.insecure_clone();
    assert_custom(env.set_suspended(&operator, &alice.pubkey(), false), qlc_err(QlcError::Unauthorized));
    env.set_suspended(&admin, &alice.pubkey(), false).unwrap();
    env.transfer(&alice, &ata(&bob.pubkey(), &env.mint), 5).unwrap();
}

#[test]
fn admin_controls_are_admin_only_and_handover_needs_both_keys() {
    let mut env = Env::ready();
    let operator = env.operator.insecure_clone();
    assert_custom(
        env.update_config(&operator, UpdateConfigArgs { max_delivery_amount: Some(10), ..Default::default() }),
        qlc_err(QlcError::Unauthorized),
    );
    let admin = env.admin.insecure_clone();
    assert_custom(
        env.update_config(&admin, UpdateConfigArgs { max_charge_amount: Some(12), ..Default::default() }),
        qlc_err(QlcError::InvalidConfig),
    );
    let new_operator = env.new_wallet();
    env.update_config(&admin, UpdateConfigArgs { operator: Some(new_operator.pubkey()), ..Default::default() }).unwrap();
    let user = env.new_wallet();
    assert_custom(env.register(&user), qlc_err(QlcError::Unauthorized)); // old operator retired

    let new_admin = env.new_wallet();
    env.set_admin(&admin, &new_admin).unwrap();
    assert_eq!(env.config().admin, new_admin.pubkey());
    assert_custom(env.update_config(&admin, UpdateConfigArgs { paused: Some(true), ..Default::default() }), qlc_err(QlcError::Unauthorized));
}

// ── Review findings: membership consent and permanent charge replay protection ──

#[test]
fn membership_requires_the_wallet_signature() {
    let mut env = Env::ready();
    let user = env.new_wallet();
    let operator = env.operator.insecure_clone();
    // The operator alone (wallet not signing) cannot admit a wallet.
    let mut ix = env.register_ix(&operator.pubkey(), &user.pubkey());
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == user.pubkey()) {
        meta.is_signer = false;
    }
    assert_custom(env.send(&[ix], &[&operator]), anchor_lang::error::ErrorCode::AccountNotSigner as u32);
    assert!(env.svm.get_account(&pda(&[MEMBER_SEED, user.pubkey().as_ref()])).is_none(), "no member record");
    // A program-derived address (e.g. a DEX pool vault owner) has no key and can never sign.
    let pool_owner = Pubkey::find_program_address(&[b"pool"], &Pubkey::new_unique()).0;
    let mut pool_ix = env.register_ix(&operator.pubkey(), &pool_owner);
    for meta in pool_ix.accounts.iter_mut().filter(|m| m.pubkey == pool_owner) {
        meta.is_signer = false;
    }
    assert_custom(env.send(&[pool_ix], &[&operator]), anchor_lang::error::ErrorCode::AccountNotSigner as u32);
    // With both signatures the wallet becomes a member.
    env.register(&user).unwrap();
    assert_eq!(env.token_account(&ata(&user.pubkey(), &env.mint)).state, AccountState::Initialized);
}

#[test]
fn a_wallet_cannot_admit_itself_without_the_operator() {
    let mut env = Env::ready();
    let user = env.new_wallet();
    let ix = env.register_ix(&user.pubkey(), &user.pubkey());
    assert_custom(env.send(&[ix], &[&user]), qlc_err(QlcError::Unauthorized));
    let other = env.new_wallet();
    let ix = env.register_ix(&other.pubkey(), &user.pubkey());
    assert_custom(env.send(&[ix], &[&other, &user]), qlc_err(QlcError::Unauthorized));
}

#[test]
fn a_charge_sequence_can_never_be_replayed_even_after_close() {
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(1), 1_000).unwrap();
    env.approve(&alice, 1_000).unwrap();

    env.charge(&alice.pubkey(), 1, 100).unwrap();
    let member: Member = fetch(&env.svm, &pda(&[MEMBER_SEED, alice.pubkey().as_ref()]));
    assert_eq!(member.last_charge_seq, 1);
    // Same sequence while the receipt is open.
    assert_fails(env.charge(&alice.pubkey(), 1, 100));
    // Close the receipt (rent recovered); the sequence stays used forever.
    env.close_charge(&alice.pubkey(), 1).unwrap();
    assert!(env.svm.get_account(&Env::charge_pda(&alice.pubkey(), 1)).map_or(true, |a| a.lamports == 0));
    assert_custom(env.charge(&alice.pubkey(), 1, 100), qlc_err(QlcError::ChargeSequenceUsed));
    assert_fails(env.refund(&alice.pubkey(), 1));
    assert_eq!(env.balance(&ata(&alice.pubkey(), &env.mint)), 900, "replays never moved QLC");

    // Sequences only move forward: a lower number after a higher one is refused.
    env.charge(&alice.pubkey(), 5, 100).unwrap();
    assert_custom(env.charge(&alice.pubkey(), 3, 100), qlc_err(QlcError::ChargeSequenceUsed));
    assert_custom(env.charge(&alice.pubkey(), 0, 100), qlc_err(QlcError::ChargeSequenceUsed));
    env.charge(&alice.pubkey(), 6, 100).unwrap();
    assert_eq!(env.balance(&ata(&alice.pubkey(), &env.mint)), 700);
}

#[test]
fn charge_sequences_are_per_member() {
    let mut env = Env::ready();
    let (alice, bob) = (env.new_wallet(), env.new_wallet());
    for user in [&alice, &bob] {
        env.register(user).unwrap();
    }
    env.deliver(&alice.pubkey(), id32(1), 500).unwrap();
    env.deliver(&bob.pubkey(), id32(2), 500).unwrap();
    env.approve(&alice, 500).unwrap();
    env.approve(&bob, 500).unwrap();
    env.charge(&alice.pubkey(), 1, 100).unwrap();
    env.charge(&bob.pubkey(), 1, 100).unwrap();
    assert_eq!(env.balance(&env.vault), 200);
}

#[test]
fn delivery_receipts_are_permanent() {
    // There is no instruction that closes a delivery receipt, so a delivery id stays used forever.
    let mut env = Env::ready();
    let alice = env.new_wallet();
    env.register(&alice).unwrap();
    env.deliver(&alice.pubkey(), id32(9), 100).unwrap();
    env.warp_secs(WINDOW_SECS * 3);
    assert_fails(env.deliver(&alice.pubkey(), id32(9), 100));
    let receipt: DeliveryReceipt = fetch(&env.svm, &pda(&[DELIVERY_SEED, id32(9).as_ref()]));
    assert_eq!(receipt.amount, 100);
}
