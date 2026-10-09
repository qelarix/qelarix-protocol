//! Raw-byte checks of the accounts TX2 depends on and creates. The mint rules are the same as the Task 09
//! policy (scripts/qlc-policy.ts `checkMintTlv`) and the program's `verify_mint_extensions`; the tests run them
//! against accounts encoded by the official Token-2022 and Codama encoders (tests/fixtures/tx2.json).
use {
    crate::{chain::AccountInfo, constants::*},
    solana_pubkey::Pubkey,
};

#[derive(Clone, Debug)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

impl Check {
    pub fn new(name: impl Into<String>, ok: bool, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ok,
            detail: detail.into(),
        }
    }
}

fn key(data: &[u8], offset: usize) -> Option<Pubkey> {
    data.get(offset..offset + 32)
        .map(|bytes| Pubkey::new_from_array(bytes.try_into().unwrap()))
}
fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
}
fn u64_at(data: &[u8], offset: usize) -> Option<u64> {
    data.get(offset..offset + 8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}
fn i64_at(data: &[u8], offset: usize) -> Option<i64> {
    data.get(offset..offset + 8)
        .map(|b| i64::from_le_bytes(b.try_into().unwrap()))
}
fn show(key: Option<Pubkey>) -> String {
    key.map(|k| k.to_string()).unwrap_or_else(|| "none".into())
}

/// The QLC program is an executable upgradeable-loader program whose ProgramData names the admin as upgrade authority.
pub fn program_checks(
    program: Option<&AccountInfo>,
    program_data: Option<&AccountInfo>,
    expected: &Expected,
    derived: &Derived,
) -> Vec<Check> {
    let program_ok = program.is_some_and(|p| {
        p.owner == BPF_LOADER_UPGRADEABLE
            && p.executable
            && p.data.len() == 36
            && u32_at(&p.data, 0) == Some(2)
            && key(&p.data, 4) == Some(derived.program_data)
    });
    let authority = program_data.and_then(|pd| {
        (pd.owner == BPF_LOADER_UPGRADEABLE
            && u32_at(&pd.data, 0) == Some(3)
            && pd.data.get(12) == Some(&1))
        .then(|| key(&pd.data, 13))
        .flatten()
    });
    vec![
        Check::new(
            format!(
                "program: {} is an executable upgradeable program with ProgramData {}",
                expected.program, derived.program_data
            ),
            program_ok,
            match program {
                None => "account not found".into(),
                Some(p) => format!(
                    "owner {}, executable {}, {} bytes",
                    p.owner,
                    p.executable,
                    p.data.len()
                ),
            },
        ),
        Check::new(
            format!("program: upgrade authority = admin {}", expected.admin),
            authority == Some(expected.admin),
            program_data.map_or("ProgramData not found".into(), |_| {
                format!("upgrade authority {}", show(authority))
            }),
        ),
    ]
}

// Token-2022 extension types (spl-token-2022 ExtensionType).
const EXT_DEFAULT_ACCOUNT_STATE: u16 = 6;
const EXT_IMMUTABLE_OWNER: u16 = 7;
const EXT_TRANSFER_HOOK: u16 = 14;
const EXT_TRANSFER_HOOK_ACCOUNT: u16 = 15;
const EXT_METADATA_POINTER: u16 = 18;
const EXT_TOKEN_METADATA: u16 = 19;
const EXT_PAUSABLE: u16 = 26;
const EXT_PAUSABLE_ACCOUNT: u16 = 27;
const EXT_PERMISSIONED_BURN: u16 = 28;
const BASE_END: usize = 165;
const EXTENSIONS_START: usize = 166;

/// Walks a Token-2022 TLV area: (type, value) entries, or an error for a truncated entry or trailing bytes.
fn tlv(data: &[u8]) -> Result<Vec<(u16, &[u8])>, String> {
    let mut entries = Vec::new();
    let mut offset = EXTENSIONS_START;
    while offset + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let length = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        if kind == 0 {
            if data[offset..].iter().any(|b| *b != 0) {
                return Err("non-zero bytes after the TLV terminator".into());
            }
            return Ok(entries);
        }
        let value = data
            .get(offset + 4..offset + 4 + length)
            .ok_or_else(|| format!("truncated extension type {kind}"))?;
        entries.push((kind, value));
        offset += 4 + length;
    }
    if offset != data.len() {
        return Err("trailing bytes after the last extension".into());
    }
    Ok(entries)
}

fn token_metadata(value: &[u8]) -> Option<(Pubkey, Pubkey, String, String, String, u32)> {
    let mut offset = 64;
    let mut text = || {
        let length = u32_at(value, offset)? as usize;
        let bytes = value.get(offset + 4..offset + 4 + length)?;
        offset += 4 + length;
        String::from_utf8(bytes.to_vec()).ok()
    };
    let (name, symbol, uri) = (text()?, text()?, text()?);
    let additional = u32_at(value, offset)?;
    // Nothing may follow the (empty) additional-metadata list.
    if additional == 0 && value.len() != offset + 4 {
        return None;
    }
    Some((
        key(value, 0)?,
        key(value, 32)?,
        name,
        symbol,
        uri,
        additional,
    ))
}

/// The QLC mint: Token-2022 owned, decimals 2, supply 0, program mint and freeze authorities, and exactly the six
/// approved extensions with the approved values (anything else is refused).
pub fn mint_checks(
    mint: Option<&AccountInfo>,
    expected: &Expected,
    derived: &Derived,
) -> Vec<Check> {
    let Some(mint) = mint else {
        return vec![Check::new(
            format!("mint: {} exists", expected.mint),
            false,
            "account not found (TX1 has not created the mint)",
        )];
    };
    let data = &mint.data;
    let is_mint = data.len() > EXTENSIONS_START && data[BASE_END] == 1;
    let mut checks = vec![
        Check::new(
            "mint: owned by Token-2022",
            mint.owner == TOKEN_2022,
            mint.owner.to_string(),
        ),
        Check::new(
            "mint: mint account type with an extension area",
            is_mint,
            format!("{} bytes", data.len()),
        ),
    ];
    if !is_mint {
        return checks;
    }
    let mint_authority = (u32_at(data, 0) == Some(1)).then(|| key(data, 4)).flatten();
    let freeze_authority = (u32_at(data, 46) == Some(1))
        .then(|| key(data, 50))
        .flatten();
    let supply = u64_at(data, 36).unwrap_or(u64::MAX);
    checks.push(Check::new(
        "mint: initialized, decimals 2, supply 0, mint authority = program PDA, freeze authority = membership PDA, zero padding",
        data[45] == 1
            && data[44] == QLC_DECIMALS
            && supply == 0
            && mint_authority == Some(derived.mint_authority)
            && freeze_authority == Some(derived.membership)
            && data[82..BASE_END].iter().all(|b| *b == 0),
        format!("decimals {}, supply {supply}, mint authority {}, freeze authority {}", data[44], show(mint_authority), show(freeze_authority)),
    ));
    let mut problems = Vec::new();
    let mut seen: Vec<u16> = Vec::new();
    match tlv(data) {
        Err(err) => problems.push(err),
        Ok(entries) => {
            for (kind, value) in entries {
                if seen.contains(&kind) {
                    problems.push(format!("duplicate extension type {kind}"));
                }
                seen.push(kind);
                match kind {
                    EXT_DEFAULT_ACCOUNT_STATE if value != [2] => {
                        problems.push("DefaultAccountState is not Frozen".into())
                    }
                    EXT_PERMISSIONED_BURN
                        if value.len() != 32 || key(value, 0) != Some(derived.no_burn) =>
                    {
                        problems
                            .push("PermissionedBurn authority is not the no-burn address".into())
                    }
                    EXT_PAUSABLE
                        if value.len() != 33
                            || key(value, 0) != Some(expected.admin)
                            || value[32] != 0 =>
                    {
                        problems.push(
                            "Pausable authority is not the admin, or the mint is paused".into(),
                        )
                    }
                    EXT_TRANSFER_HOOK
                        if value.len() != 64
                            || key(value, 0) != Some(expected.admin)
                            || key(value, 32) != Some(Pubkey::default()) =>
                    {
                        problems.push(
                            "TransferHook authority is not the admin, or a hook program is set"
                                .into(),
                        )
                    }
                    EXT_METADATA_POINTER
                        if value.len() != 64
                            || key(value, 0) != Some(expected.admin)
                            || key(value, 32) != Some(expected.mint) =>
                    {
                        problems.push(
                            "MetadataPointer does not point at the mint under the admin".into(),
                        )
                    }
                    EXT_TOKEN_METADATA => {
                        let ok = token_metadata(value).is_some_and(
                            |(update, mint, name, symbol, uri, additional)| {
                                update == expected.admin
                                    && mint == expected.mint
                                    && name == METADATA_NAME
                                    && symbol == METADATA_SYMBOL
                                    && uri == METADATA_URI
                                    && additional == 0
                            },
                        );
                        if !ok {
                            problems.push("TokenMetadata does not match".into());
                        }
                    }
                    EXT_DEFAULT_ACCOUNT_STATE
                    | EXT_PERMISSIONED_BURN
                    | EXT_PAUSABLE
                    | EXT_TRANSFER_HOOK
                    | EXT_METADATA_POINTER => {}
                    other => problems.push(format!("forbidden extension type {other}")),
                }
            }
        }
    }
    for (kind, name) in [
        (EXT_DEFAULT_ACCOUNT_STATE, "DefaultAccountState"),
        (EXT_PERMISSIONED_BURN, "PermissionedBurn"),
        (EXT_PAUSABLE, "Pausable"),
        (EXT_TRANSFER_HOOK, "TransferHook"),
        (EXT_METADATA_POINTER, "MetadataPointer"),
        (EXT_TOKEN_METADATA, "TokenMetadata"),
    ] {
        if !seen.contains(&kind) {
            problems.push(format!("missing {name}"));
        }
    }
    checks.push(Check::new(
        "mint: exactly DefaultAccountState(Frozen), PermissionedBurn(no-burn), Pausable(admin, unpaused), TransferHook(admin, none), MetadataPointer(mint), TokenMetadata(locked)",
        problems.is_empty(),
        if problems.is_empty() { "all six extensions as approved".into() } else { problems.join("; ") },
    ));
    checks
}

/// The config account `initialize` creates: exactly the approved admin, operator, mint, vault and limits.
pub fn config_checks(
    config: Option<&AccountInfo>,
    expected: &Expected,
    derived: &Derived,
    min_lamports: u64,
) -> Vec<Check> {
    let Some(config) = config else {
        return vec![Check::new(
            format!("config {} created", derived.config),
            false,
            "account not found",
        )];
    };
    let d = &config.data;
    let bumps = [
        derived.config_bump,
        derived.mint_authority_bump,
        derived.membership_bump,
        derived.vault_bump,
        derived.spend_bump,
    ];
    let totals_zero = (185..217).all(|i| d.get(i) == Some(&0));
    vec![
        Check::new(
            "config: program-owned, 222 bytes, Config discriminator, rent-exempt",
            config.owner == expected.program
                && d.len() == CONFIG_SIZE
                && d.get(0..8) == Some(&CONFIG_DISCRIMINATOR[..])
                && config.lamports >= min_lamports,
            format!(
                "owner {}, {} bytes, {} lamports",
                config.owner,
                d.len(),
                config.lamports
            ),
        ),
        Check::new(
            "config: admin, operator, mint and vault exactly as approved",
            key(d, 8) == Some(expected.admin)
                && key(d, 40) == Some(expected.operator)
                && key(d, 72) == Some(expected.mint)
                && key(d, 104) == Some(derived.vault),
            format!(
                "admin {}, operator {}, mint {}, vault {}",
                show(key(d, 8)),
                show(key(d, 40)),
                show(key(d, 72)),
                show(key(d, 104))
            ),
        ),
        Check::new(
            "config: limits exactly as approved (1000000 / 10000 / 86400 s / 2000000)",
            u64_at(d, 136) == Some(expected.limits.max_delivery_amount)
                && u64_at(d, 144) == Some(expected.limits.max_charge_amount)
                && i64_at(d, 152) == Some(expected.limits.mint_window_secs)
                && u64_at(d, 160) == Some(expected.limits.mint_window_cap),
            format!(
                "{:?} / {:?} / {:?} / {:?}",
                u64_at(d, 136),
                u64_at(d, 144),
                i64_at(d, 152),
                u64_at(d, 160)
            ),
        ),
        Check::new(
            "config: not paused, nothing minted, all totals 0, program bumps",
            d.get(184) == Some(&0)
                && u64_at(d, 176) == Some(0)
                && totals_zero
                && d.get(217..222) == Some(&bumps[..]),
            format!(
                "paused {:?}, minted in window {:?}",
                d.get(184),
                u64_at(d, 176)
            ),
        ),
    ]
}

/// The vault `initialize` creates: the vault authority's QLC associated account, empty, admitted (thawed), no
/// delegate or close authority, and exactly the extensions the runtime adds for the QLC mint: ImmutableOwner,
/// PausableAccount and TransferHookAccount (not transferring), each once, nothing else.
///
/// The TLV order is not a protocol invariant: Token-2022 initializes account extensions in the order of the mint's
/// extensions, after the ATA program's ImmutableOwner. The deployed devnet runtime produces ImmutableOwner,
/// PausableAccount, TransferHookAccount (tests/fixtures/vault-runtime.json, captured by read-only simulation), so
/// the check compares the exact set and values, independent of order.
pub fn vault_checks(
    vault: Option<&AccountInfo>,
    expected: &Expected,
    derived: &Derived,
    min_lamports: u64,
) -> Vec<Check> {
    let Some(vault) = vault else {
        return vec![Check::new(
            format!("vault {} created", derived.vault),
            false,
            "account not found",
        )];
    };
    let d = &vault.data;
    let extensions = if d.len() > EXTENSIONS_START {
        tlv(d).ok()
    } else {
        None
    };
    let extensions_ok = extensions.as_ref().is_some_and(|entries| {
        let mut sorted = entries.clone();
        sorted.sort_by_key(|(kind, _)| *kind);
        sorted
            == [
                (EXT_IMMUTABLE_OWNER, &[][..]),
                (EXT_TRANSFER_HOOK_ACCOUNT, &[0u8][..]),
                (EXT_PAUSABLE_ACCOUNT, &[][..]),
            ]
    });
    vec![
        Check::new(
            "vault: Token-2022 account (179 bytes), rent-exempt",
            vault.owner == TOKEN_2022 && d.len() == VAULT_SIZE && d.get(BASE_END) == Some(&2) && vault.lamports >= min_lamports,
            format!("owner {}, {} bytes, {} lamports", vault.owner, d.len(), vault.lamports),
        ),
        Check::new(
            "vault: QLC mint, owner = vault authority PDA, empty, admitted (not frozen), no delegate, not native, no close authority",
            key(d, 0) == Some(expected.mint)
                && key(d, 32) == Some(derived.vault_authority)
                && u64_at(d, 64) == Some(0)
                && u32_at(d, 72) == Some(0)
                && d.get(108) == Some(&1)
                && u32_at(d, 109) == Some(0)
                && u64_at(d, 121) == Some(0)
                && u32_at(d, 129) == Some(0),
            format!("mint {}, owner {}, state {:?}", show(key(d, 0)), show(key(d, 32)), d.get(108)),
        ),
        Check::new("vault: extensions exactly {ImmutableOwner, PausableAccount, TransferHookAccount(not transferring)}, each once, any order", extensions_ok, format!("{:?}", extensions.map(|e| e.iter().map(|(k, _)| *k).collect::<Vec<_>>()))),
    ]
}
