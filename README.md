# SealedAuction — Sealed-Bid Auctions as a Flare Confidential Extension

SealedAuction is a trustless asset exchange with sealed bids: the seller escrows
a real token (an NFT or an ERC-20) into the contract, bidders submit amounts that
are ECIES-encrypted in the browser and decrypted only inside a Flare TEE, and
after the deadline the TEE reveals exactly two numbers — the winner and the
clearing price. Settlement is an atomic swap verified against the TEE's
signature: FXRP moves winner → seller and the escrowed lot moves contract →
winner in one transaction, or nothing moves at all.

Built for the **Flare Summer Signal** hackathon on the official
[`fce-extension-scaffold`](https://github.com/flare-foundation) (Go
implementation). Full design: [ARCHITECTURE.md](ARCHITECTURE.md). Demo script:
[DEMO_SCRIPT.md](DEMO_SCRIPT.md).

![Architecture](docs/architecture-diagram.svg)

## Why a TEE and not commit-reveal?

Commit-reveal is the classic trustless answer to sealed bids, and where it
works, it's the right tool. It stops working when you need two things at once:

- **Losers stay private — forever.** In commit-reveal every bidder must
  eventually open their commitment, so all bids become public at reveal time.
  If bid privacy only matters *during* bidding (anti-sniping), commit-reveal
  suffices. If losing bids are commercially sensitive after the auction —
  procurement, OTC blocks, anything repeated against the same counterparties —
  they must never be opened. Here losing bids are decrypted only in enclave
  memory and are never published anywhere.
- **Liveness without reveal games.** A commit-reveal bidder who dislikes the
  outcome can simply refuse to reveal; you patch that with bonds, reveal
  windows, and slashing, and every no-show still delays or distorts the close.
  Here closing needs no cooperation from bidders: anyone calls
  `closeAuction()` once the deadline passes and the TEE ranks whatever it
  holds.

The honest price for this is a trust assumption commit-reveal doesn't have:
you trust the TEE hardware attestation and the registered code hash (and on
Coston2, where the TEE is simulated, you trust the operator — see
[limitations](#honest-v1-limitations)).

## Architecture

```
seller ──approve + createAuction──▶ SealedAuction.sol  ◀── lot (NFT / ERC-20) held in escrow
                                     │
browser ──ECIES(teePubKey, bid)──▶ SealedAuction.sol ──instruction──▶ indexer ─▶ proxy ─▶ TEE
                                     │ wraps ciphertext with msg.sender          decrypt in memory
                                     │ stores commitment only                    pick winner, sign
                                     ◀───────────── settle(signed result) ◀──────────────┘
                                     verify sig, then atomically:
                                       FXRP  winner ─▶ seller
                                       lot   escrow ─▶ winner
```

**The `msg.sender` wrapper trick.** The FCC instruction payload (`DataFixed`)
carries no transaction sender, so a naive design would let anyone submit — or
replay — someone else's ciphertext under their own name. SealedAuction closes
this on-chain: `placeBid` wraps the ciphertext as
`abi.encode(PlaceBidMessage{auctionId, msg.sender, ciphertext})`, and the TEE
accepts a bid only if the *encrypted* payload's bidder equals the wrapper's
chain-authenticated `msg.sender`. Spoofing and ciphertext replay both die on
that check.

**Lot escrow.** `createAuction` pulls the lot into the contract before the
auction is recorded, so a failed pull leaves no auction and nobody ever bids on
a lot the contract does not hold. `settle()` then performs both legs of the swap
in one transaction; if the winner's payment leg reverts, the lot leg reverts with
it and the escrow stays intact. Cancellation and a reserve-not-met result both
return the lot to the seller. ERC-20 lots are accounted by balance delta, so
fee-on-transfer tokens escrow exactly what arrived. See
[ARCHITECTURE.md](ARCHITECTURE.md#lot-escrow) for the design notes, including why
release uses plain `transferFrom` rather than `safeTransferFrom`.

**On-chain footprint per bid:** the ciphertext (calldata) and
`keccak256(abi.encode(auctionId, bidder, keccak256(ciphertext)))` as a
commitment. The `BidPlaced` event deliberately carries no amount.

**Result verification.** The TEE signs
`keccak256(keccak256(data) ‖ actionId ‖ keccak256(tag) ‖ status)` wrapped in a
`TEE_ACTION_RESULT` / chain-id envelope (the same scheme as the official
weather-insurance FCE); `settle()` reconstructs the digest and requires
`ecrecover == teeAddress` before moving funds.

## Live on Coston2

| Component | Address |
|---|---|
| SealedAuction contract (with lot escrow) | [`0x057c49831762029EA82c5644ff9D426D02486EeB`](https://coston2-explorer.flare.network/address/0x057c49831762029EA82c5644ff9D426D02486EeB) |
| DemoAsset721 (demo lot token) | [`0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E`](https://coston2-explorer.flare.network/address/0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E) |
| Extension ID | **66042** (`0x…101fa`) |
| TEE machine (status 2 = PRODUCTION) | `0x91809e7b666558985093F00eF67565180519a7cC` |
| FlareTeeManager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| FXRP — resolved via registry, never hardcoded | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) (FTestXRP, 6 decimals) |
| FlareContractRegistry → AssetManagerFXRP | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` → `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |

**Recorded end-to-end with an escrowed NFT lot** (auction #3 on the escrow
contract — the seller escrows DemoAsset721 #4, two sealed bids from two wallets,
the TEE picks the winner, and settlement swaps FXRP for the NFT atomically):

| Step | Tx |
|---|---|
| Sealed bid (losing — amount not derivable from chain) | [`0xb4550b0e…61c66c`](https://coston2-explorer.flare.network/tx/0xb4550b0ee995b155d45bc7a43b38b2d70416d9a299445cbf3048a81bd161c66c) |
| Sealed bid (winning) | [`0xab0fd0ac…f48741`](https://coston2-explorer.flare.network/tx/0xab0fd0ac24240295ee8be0ede4aa0b731960a377807125376d65025a98f48741) |
| settle() — TEE sig verified; 3 FXRP → seller **and** NFT #4 → winner | [`0x4ca99e3e…8797e`](https://coston2-explorer.flare.network/tx/0x4ca99e3edad1db4064c58409ed9d9100e99bb9d034a660333828ef34b188797e) |

An earlier FXRP-only run (before escrow, on the previous contract
`0x5a468D17…79a0`) is preserved for reference: bids
[`0x5fd884eb…47bec4`](https://coston2-explorer.flare.network/tx/0x5fd884eb8497da248ded72c462eba333fedf9041ed52b202b192c7b1e647bec4)
/ [`0x213481bb…178fd3`](https://coston2-explorer.flare.network/tx/0x213481bb3c0da61babeb254a4cd4ee73b51d40e59ebf51a9f04567d16f178fd3),
settle [`0x2b8c709e…16426a`](https://coston2-explorer.flare.network/tx/0x2b8c709ea2135d6e649feac34b8f5cf2f2b39ec934d003cbe497e46e0c16426a).

Open either bid tx: the calldata is ECIES ciphertext, byte-shaped the same for
any amount. Grep it for the amounts (`0x1e8480`, `0x2dc6c0`) — they are not
there.

## Run it yourself

Prerequisites: Docker, Go 1.25+, Foundry, jq, Node 22+, a funded Coston2 key
([faucet](https://faucet.flare.network/coston2)), FXRP from the Coston2 FAsset
faucet, a **reserved** tunnel domain (named cloudflared or reserved ngrok —
quick tunnels break TEE registration on restart), and **indexer DB
credentials from the Flare team** for the proxy's `[db]` section (this is the
one thing you cannot self-serve).

```bash
cp .env.example .env.coston2         # fill: DEPLOYMENT_PRIVATE_KEY, INITIAL_OWNER,
                                     #       EXT_PROXY_URL=<your tunnel>, SIMULATED_TEE=true,
                                     #       LOCAL_MODE=false, PAY_TOKEN=FXRP
cp config/proxy/extension_proxy.coston2.docker.toml.example \
   config/proxy/extension_proxy.coston2.docker.toml          # fill [db] credentials
./scripts/use-chain.sh coston2

# one uninterrupted run:
./scripts/pre-build.sh               # deploy SealedAuction + mint a fresh EXTENSION_ID
./scripts/start-services.sh --chain coston2
./scripts/post-build.sh              # allow version + governance + register-tee (rRap)
./scripts/test.sh                    # full E2E: 2 sealed bids → close → settle in FXRP

# frontend:
cd frontend && cp .env.local.example .env.local   # set NEXT_PUBLIC_SEALED_AUCTION from config/extension.env
npm install && npm run dev                        # http://localhost:3000
```

Offline checks (no chain needed): `./scripts/test-unit.sh` (Go table tests),
`./scripts/test-conformance.sh` (golden wire fixtures), `forge test` (19
Solidity tests incl. the full signature scheme against `vm.sign`).

## Honest v1 limitations

- **No bid bonds** (the seller's side *is* escrowed). The lot is locked in the
  contract from creation, so the seller can never lose the asset without being
  paid. The bidder's side is uncollateralized: the winner pays via
  `transferFrom` at settle, and a winner who revokes allowance stalls the
  auction in `Closing` (lot safely escrowed, same signed result replayable once
  they fund). Production needs a deposit at `placeBid`, slashed on non-payment.
- **Volatile TEE bid storage.** Bids live in extension process memory; a TEE
  restart between bidding and close loses them and the auction settles as
  cancelled. The UI makes this visible rather than silent: every bid carries a
  live TEE-confirmation badge, and the auction card warns while any bid is
  unconfirmed — so a dying pipeline shows up before the close, not after.
- **First-come tie-break** slightly rewards early bidding; Secure Random is
  the v2 fix.
- **Participation and reserve are public** by design — only amounts are
  sealed.
- **Simulated TEE on Coston2.** With `SIMULATED_TEE=true` (officially
  supported for judging) the operator can technically inspect process memory.
  Real confidentiality requires production TEE hardware attesting the same
  code hash.
- **Seller cannot win their own auction in FXRP** — the FAsset contract
  reverts self-transfers, so settlement to yourself is impossible (arguably a
  feature).

## Roadmap

Production TEE hardware (GCP Confidential Space) → bid bonds so the bidder side
is collateralized like the seller side already is → Secure-Random tie-breaks →
private reserve prices (moved inside the ciphertext) → sealed-state persistence
so bids survive enclave restarts → more lot standards (ERC-1155, FAsset-native
lots) and Vickrey (second-price) settlement.

## What was built vs. reused

**Reused** (standing on official shoulders): the `fce-extension-scaffold`
skeleton — scripts, Docker/compose, tee-node v0.0.24 wiring, conformance
harness, deployment tooling structure; and patterns from the official
`fce-weather-insurance` reference — the TEE result signature scheme in
`settle()`, the ECIES client flow, and the frontend's proxy-route/wagmi/useTx
wiring.

**Built during the hackathon:** the `SealedAuction` contract (auction
lifecycle, lot escrow and atomic swap, commitment scheme, settle
verification), `DemoAsset721` as the demo lot token, the Go extension
(`PLACE_BID`/`CLOSE_AUCTION` handlers, `pickWinner`, the `msg.sender` wrapper
authentication), the FXRP registry resolver, the two-wallet E2E runner, the
test suites (Go table tests, 14 regenerated conformance fixtures, 24 forge
tests), the Next.js frontend (sealed bid form with in-browser ECIES, lot escrow
UI, auction lifecycle, TEE verify panel), and all documentation.

## Field notes from Coston2

Real FAsset settlement broke our mock-tested code three times; each fix is in
the repo and worth knowing before you integrate FXRP:

1. **Anchor deadlines to chain time, not the local clock.** WSL's clock ran
   ~2s ahead of `block.timestamp`; `closeAuction` reverted `bidding still
   open`. The E2E now derives deadlines from the chain head and polls until a
   mined block passes the deadline.
2. **FXRP forbids self-transfers.** `transferFrom(x → x)` reverts with
   `CannotTransferToSelf()` (`0xdad89dca`) — a mock ERC-20 happily allows it.
   Any flow where payer == payee (our first test had seller == winner) must be
   redesigned, not gas-tweaked.
3. **Don't trust `eth_estimateGas` for FAsset transfers.** FXRP's
   reentrancy sentry is gas-sensitive; the estimated limit passes estimation
   and then dies at runtime with `ReentrancySentryOOG`. Pin an explicit gas
   limit with headroom (we use 200k) for direct FXRP transfers.

And two more from building the UI on Coston2:

4. **Coston2's public RPC caps `eth_getLogs` at 30 blocks.** The usual
   browser-side trick for listing an address's NFTs — replaying `Transfer`
   logs — is simply unavailable. The lot picker therefore probes
   `tokenOfOwnerByIndex` first, falls back to an `ownerOf` sweep over
   `nextTokenId()`/`totalSupply()` in a single Multicall3 call, and only then
   asks the Blockscout index. Multicall3 *is* deployed at its canonical address
   on Coston2, but viem's `flareTestnet` chain definition omits it, so the
   address has to be passed explicitly.
5. **A restarted TEE container is a new machine — retire the old one.** In
   simulated mode the node generates a fresh key on boot — in memory only,
   inside tee-node's internal packages, so no docker volume can persist it. A
   Docker restart silently orphans the on-chain registration: the old `teeId`
   still reads `PRODUCTION` while its key no longer exists anywhere.
   `scripts/reconcile-tee.sh` (run automatically by `start-services.sh` on
   coston/coston2) converges this on every boot: it registers the live key if
   needed and pauses our stale machines. Because
   `getRandomTeeIds` round-robins across *all* PRODUCTION machines for the
   extension, instructions then land on the ghost machine and results 404
   forever. Re-run `post-build.sh` to register the new key, then
   `pause(teeId)` the stale one so routing is deterministic again.

---

## Scaffold reference

This repo keeps the scaffold's structure, scripts and three-layer test
strategy. The original scaffold documentation lives in `docs/`:

- [Extension Development Guide](docs/extension-guide.md) ·
  [Extension Container Contract](docs/extension-contract.md) (normative wire
  spec) · [Testing Guide](docs/testing.md) ·
  [InstructionSender Contract](docs/instruction-sender.md) ·
  [Reproducibility](REPRODUCIBILITY.md)
- Ops crib sheet: `pre-build.sh` (deploy + register, writes
  `config/extension.env`) → `start-services.sh [--chain coston2]` (redis +
  proxy + extension containers) → `post-build.sh` (allow version, governance,
  `register-tee -command rRap`) → `test.sh`. Ports: proxy external **6674**,
  extension server 7702, sign port 7701, Redis 6382.
