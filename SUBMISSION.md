# DoraHacks BUIDL Submission Draft — SealedAuction

Pre-written fields for the Flare Summer Signal submission form. Replace the
two placeholders (GitHub URL, video URL) before submitting.

---

**Project name:** SealedAuction

**One-liner:** Trustless asset exchange on Flare with sealed bids — the lot sits
in escrow, bid amounts never touch the chain, and settlement swaps FXRP for the
asset atomically.

**Description:**

Public blockchains leak every bid: the amount sits in calldata for rivals to
read, outbid by one unit, or snipe at the deadline. SealedAuction fixes the
auction, not the chain. The seller escrows a real asset — an NFT or an ERC-20 —
into the contract when creating the auction, so bidders are always bidding on
something the contract provably holds. Bids are ECIES-encrypted in the bidder's
browser under the TEE's public key; the contract wraps each ciphertext with
`msg.sender` (chain-level bidder authentication that kills spoofing and replay)
and stores only a commitment. Plaintext bids exist exclusively inside a Flare
Confidential Extension. After the deadline, anyone closes the auction; the TEE
ranks the bids in enclave memory, applies the reserve, and signs the outcome.
`settle()` verifies that signature on-chain and executes both legs of the swap
in one transaction: FXRP from winner to seller, escrowed lot from contract to
winner — either leg failing reverts the whole settlement. Only two numbers are
ever revealed: the winner and the clearing price. Losing bids are never
published — not during the auction, not after.

Settlement uses FXRP resolved live from the FlareContractRegistry →
AssetManagerFXRP → `fAsset()` — no hardcoded token addresses — making sealed
auctions a native venue for FAssets — an NFT changing hands against bridged XRP,
with the confidential price discovery in between. The full flow (escrow an NFT →
two sealed bids from two wallets → TEE winner selection → atomic FXRP-for-NFT
settlement) is recorded on Coston2 with verifiable transaction hashes, and
runnable from a browser: mint a demo asset, escrow it, bid from MetaMask, watch
the countdown, close, settle — plus a verify panel showing the TEE's code hash
and its PRODUCTION status on the FlareTeeManager.

We are honest about v1: bids live in enclave memory (a TEE restart cancels the
auction), the seller's side is escrowed but the bidder's is not (the winner pays
via allowance rather than a locked bond), tie-breaks are first-come, and Coston2
runs the TEE in simulated mode (officially supported for judging). Roadmap:
production TEE hardware, bid bonds, Secure-Random tie-breaks, private reserve
prices, and Vickrey settlement.

**Bounties:**
- **Confidential Compute Apps** (primary) — the product *is* a Flare
  Confidential Extension: on-chain instructions, TEE-side decryption and
  winner selection, signed results verified in `settle()`.
- **Interoperable Asset Products** (secondary) — a real asset (ERC-721 or
  ERC-20) is escrowed and swapped atomically against FXRP, resolved dynamically
  via ContractRegistry/AssetManager; the repo documents field-tested FAsset
  integration findings (self-transfer ban, estimateGas vs. reentrancy sentry,
  chain-time deadlines).

**Tech stack:** Solidity (Foundry) · Go (TEE extension on
fce-extension-scaffold, tee-node v0.0.24) · Next.js 16 + wagmi/viem +
ecies-geth (browser-side ECIES) · Docker Compose (redis, tee-proxy,
extension) · Coston2 testnet.

**GitHub:** `<GITHUB_REPO_URL>`

**Demo video:** `<VIDEO_URL>`

**Contract addresses (Coston2):**
- SealedAuction: `0x057c49831762029EA82c5644ff9D426D02486EeB`
- DemoAsset721 (demo lot): `0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E`
- Extension ID: 66042 · TEE machine: `0x91809e7b666558985093F00eF67565180519a7cC` (PRODUCTION on FlareTeeManager `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`)
- FXRP (resolved): `0x0b6A3645c240605887a5532109323A3E12273dc7`
- Recorded E2E with escrowed NFT: bids `0xb4550b0e…61c66c` / `0xab0fd0ac…f48741`, settle (FXRP → seller + NFT → winner) `0x4ca99e3e…8797e`

**Team:** solo builder.
