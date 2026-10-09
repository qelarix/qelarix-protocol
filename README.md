# Qelarix

**Create beyond imagination. AI video, image and audio, paid per creation on Solana.**

Qelarix is an AI creation platform with 30+ leading models in one clean workspace.
Every creation is paid with **QLC (Qelarix Credit)**, a Token-2022 token on Solana.

Sign in with your wallet, approve a spending limit once, and create.
No password. Failed generations are refunded automatically.

- **Live beta (Solana devnet):** https://qelarix.si
- **Main domain after the beta:** qelarix.ai
- **X:** [@qelarix](https://x.com/qelarix)
- **YouTube:** [@Qelarix](https://www.youtube.com/@Qelarix)
- **TikTok:** [@qelarix_ai](https://www.tiktok.com/@qelarix_ai)

> Qelarix is in public beta on Solana devnet. Devnet QLC has no monetary value.

## Devnet beta

- **500 QLC welcome bonus.** Every new wallet gets 500 QLC to try Qelarix. No purchase needed.
- **Test epochs.** Generation runs in test epochs with a shared budget of 30,000 QLC.
- **Pause and fix.** When the budget is used, generation pauses for everyone. We collect feedback, fix problems and open the next epoch.

---

## Vision

Qelarix is built to become a **creative protocol** for everyone.

- **Fun first.** Creating video, images and audio with AI should feel like play.
- **Learn AI.** Users will learn about models, prompting and creative workflows inside Qelarix.
- **Creator rewards.** Users will be rewarded for their creations and their prompts.
- **Open to builders.** A public API and an MCP server for developers and AI agents.
- **Partner tokens.** Tokens of our partners will be accepted for buying QLC.
- **Simple for everyone.** Clean and easy to use, with or without crypto experience.

## How it works

1. **Sign in with Solana.** Connect a wallet and sign a message. No password.
2. **Get QLC.** New wallets receive the welcome bonus, delivered on chain by the Qelarix program.
3. **Enable spending once.** Approve a QLC spending limit. QLC stays in your wallet until a creation is charged.
4. **Create.** The exact price is charged on chain before the model runs.
5. **Automatic refund.** If a generation fails, the charge is refunded once.

**Supported wallets:** Phantom, Solflare, Backpack

**Pricing:** 1 QLC = $0.03. Every option shows its QLC price before you generate.

## What you can create

### Video
- **Models:** Seedance 2.0, Kling 3.0, Veo 3 / 3.1, Sora 2, Wan, Luma Ray 2, Grok Imagine
- **Modes:** text to video, image to video, first and last frame
- **Audio:** native audio on supported models

### Image
- **Models:** leading text-to-image models
- **Tools:** Relight, Upscale, Image Extension, Text Remover

### Audio
- **Music:** Stability Audio, Lyria 2, ACE-Step, ElevenLabs Music
- **Voice:** ElevenLabs v3, ElevenLabs Multilingual v2

### Video tools
- Upscale
- Extend
- Lip Sync

### Cinema Studio
A full filmmaking workspace, built to make short films and movies.

- **Multi-scene storytelling** with storyboards
- **Scene continuity:** each scene can carry the last frame of the previous one
- **Consistent cast:** characters, style and backgrounds stay the same across scenes
- **Lip sync** for dialogue scenes
- **Film export** up to 8 minutes

## QLC on Solana

QLC is a Token-2022 token. The real balance is the user's on-chain token account.

- **Program-controlled.** The `qelarix_qlc` program holds the mint, freeze, vault and spend authorities. No backend key does.
- **No burn.** Spent QLC returns to the vault and is reused.
- **Capped minting.** New QLC is minted only for a shortfall, within an on-chain cap per time window.
- **Membership.** A wallet becomes a member only with its own signature and the operator's co-signature.
- **Exactly once.** Every delivery has an on-chain receipt. Every charge has a unique sequence number, so it can never be replayed.
- **Safety limits.** The program enforces a maximum per creation and per delivery, and can be paused.
- **Hardware-signed admin.** Admin changes are signed with a hardware wallet.

### Devnet addresses

| | Address |
| --- | --- |
| QLC program | [`EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa`](https://explorer.solana.com/address/EtqwjEQT2ZuEwFZ9RXoPgDbupn7eH8iLyV3cR2ENrwNa?cluster=devnet) |
| QLC mint (Token-2022) | [`7CLTFoNMNY8otRNA9zU7G84VPwxCCP4rWVvsZj2vp1Tk`](https://explorer.solana.com/address/7CLTFoNMNY8otRNA9zU7G84VPwxCCP4rWVvsZj2vp1Tk?cluster=devnet) |
| Program config | [`DfoWpNfC1jCfQEpAYnvqHJ3Z8dcYXEopMZYQioaq1FuZ`](https://explorer.solana.com/address/DfoWpNfC1jCfQEpAYnvqHJ3Z8dcYXEopMZYQioaq1FuZ?cluster=devnet) |

### Payments

One engine handles every payment asset: quote, verify, settle, deliver.

1. The server quotes the exact amount and builds the transaction.
2. The buyer's wallet signs it.
3. The server verifies the finalized transaction on chain and settles it once.
4. The program delivers QLC. A background job retries anything left unconfirmed.

**Assets:** USDC and SOL (verified Pyth price). Partner tokens later, through the same adapters.

**Devnet status:** buying QLC is not enabled yet. The USDC and SOL payment engine is built and tested, but not switched on for the devnet beta. Use the 500 QLC welcome bonus.

- USDC is not switched on as a devnet payment asset.
- The devnet Pyth SOL price is not updated often enough to pass our freshness check.

## Status

| | Devnet | Mainnet |
| --- | --- | --- |
| Wallet sign-in | Live | Planned |
| QLC program and mint | Live | After security audit |
| Pay per creation in QLC | Live (public beta) | Planned |
| 500 QLC welcome bonus | Live | Not planned |
| Buying QLC (USDC / SOL) | Built, not enabled yet | Planned |

## Roadmap

- **Mainnet** after an external security audit and multisig custody
- **Social login** (Google, Apple, X) with embedded Solana wallets
- **Creator rewards** for creations and prompts
- **Learn AI** inside Qelarix
- **Public API and MCP server**, paid in QLC
- **Partner tokens** for buying QLC
- **More models and tools** as they are released

## Repository

| Area | Location | Stack |
| --- | --- | --- |
| Web app and API | `src/` | Next.js 14, TypeScript, Tailwind CSS |
| Database | `supabase/` | Supabase Postgres, migrations with rollbacks |
| On-chain program | `solana/` | Anchor, Token-2022 |
| Scripts | `scripts/` | TypeScript, Node.js |

### Getting started

Requirements: Node.js 20+, npm, a Supabase project, provider API keys.

```bash
npm install
cp .env.local.example .env.local   # fill in your own values
npm run dev                          # http://localhost:3000
```

### Tests and checks

| Command | Covers |
| --- | --- |
| `npm run lint` | Lint |
| `npx tsc --noEmit` | Types |
| `npm run build` | Production build |
| `npm run qlc:test` | QLC program: minting, membership, delivery, charges, refunds, admin |
| `npm run qlc:verify -- --cluster devnet` | Live devnet program and config match the approved policy |
| `npm run check:payments` | Payment engine, settlement, recovery |
| `npm run check:wallet-auth` | Wallet sign-in and sessions |

## Security

- No private keys, seed phrases or API secrets in the repository.
- Payment data from the client is never trusted. Everything is verified on chain.
- Every settlement is idempotent.
- Admin changes are signed with a hardware wallet.
- The QLC program is not audited yet. An audit and multisig custody come before mainnet.

## Contact

- **X:** [@qelarix](https://x.com/qelarix)
- **Email:** contact@pixidigital.io

Qelarix is developed by Pixi Digital.

## License

Copyright (c) 2026 Qelarix. All rights reserved.

Published for transparency, technical review and hackathon evaluation.
No license to use, copy, modify or distribute is granted. See [LICENSE](LICENSE).
