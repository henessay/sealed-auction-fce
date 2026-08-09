# DoraHacks BUIDL Submission Draft — SealedAuction

Pre-written fields for the Flare Summer Signal submission form. Replace the
two placeholders (GitHub URL, video URL) before submitting.

---

**Project name:** SealedAuction

**One-liner:** Sealed-bid auctions on Flare where bid amounts never touch the
chain — encrypted in the browser, opened only inside a TEE, settled in FXRP.

**Description:**

Public blockchains leak every bid: the amount sits in calldata for rivals to
read, outbid by one unit, or snipe at the deadline. SealedAuction fixes the
auction, not the chain. Bids are ECIES-encrypted in the bidder's browser under
the TEE's public key; the contract wraps each ciphertext with `msg.sender`
(chain-level bidder authentication that kills spoofing and replay) and stores
only a commitment. Plaintext bids exist exclusively inside a Flare Confidential
Extension. After the deadline, anyone closes the auction; the TEE ranks the
bids in enclave memory, applies the reserve, and signs the outcome. `settle()`
verifies that signature on-chain and pulls the winner's FXRP to the seller in
the same transaction. Only two numbers are ever revealed: the winner and the
clearing price. Losing bids are never published — not during the auction, not
after.

Settlement uses FXRP resolved live from the FlareContractRegistry →
AssetManagerFXRP → `fAsset()` — no hardcoded token addresses — making sealed
auctions a native venue for FAssets. The full flow (two sealed bids from two
wallets → TEE winner selection → FXRP settlement) is recorded on Coston2 with
verifiable transaction hashes, and runnable from a browser: MetaMask bidding,
live countdown, close/settle buttons, and a verify panel showing the TEE's
code hash and its PRODUCTION status on the FlareTeeManager.

We are honest about v1: bids live in enclave memory (a TEE restart cancels the
auction), the winner pays via allowance rather than a locked bond, tie-breaks
are first-come, and Coston2 runs the TEE in simulated mode (officially
supported for judging). Roadmap: production TEE hardware, bid bonds,
Secure-Random tie-breaks, private reserve prices, and Vickrey settlement.

**Bounties:**
- **Confidential Compute Apps** (primary) — the product *is* a Flare
  Confidential Extension: on-chain instructions, TEE-side decryption and
  winner selection, signed results verified in `settle()`.
- **Interoperable Asset Products** (secondary) — auctions settle in FXRP,
  resolved dynamically via ContractRegistry/AssetManager; the repo documents
  three field-tested FAsset integration findings (self-transfer ban,
  estimateGas vs. reentrancy sentry, chain-time deadlines).

**Tech stack:** Solidity (Foundry) · Go (TEE extension on
fce-extension-scaffold, tee-node v0.0.24) · Next.js 16 + wagmi/viem +
ecies-geth (browser-side ECIES) · Docker Compose (redis, tee-proxy,
extension) · Coston2 testnet.

**GitHub:** `<GITHUB_REPO_URL>`

**Demo video:** `<VIDEO_URL>`

**Contract addresses (Coston2):**
- SealedAuction: `0x5a468D17C292C262C4bAa0A953561bF31CDA79a0`
- Extension ID: 66042 · TEE machine: `0x767F28A6B30EB9528C036378454Da1C2ea11E126` (PRODUCTION on FlareTeeManager `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`)
- FXRP (resolved): `0x0b6A3645c240605887a5532109323A3E12273dc7`
- Recorded E2E: bids `0x5fd884eb…47bec4` / `0x213481bb…178fd3`, settle `0x2b8c709e…16426a`

**Team:** solo builder.
