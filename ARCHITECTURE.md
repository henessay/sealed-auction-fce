# SealedAuction — Architecture

Sealed-bid (first-price) auction as a Flare Confidential Extension (FCE) on Coston2.
Bid amounts are ECIES-encrypted client-side and exist in plaintext **only inside the
TEE extension**. On-chain observers, the mempool, and the seller learn nothing about
any bid until settlement — and even then only the winner and the clearing price are
revealed. Losing bids are never revealed anywhere.

Base: `fce-extension-scaffold` (Go, tee-node v0.0.24). Signature scheme and contract
skeleton follow `fce-weather-insurance` (the sacred parts — constructor wiring,
`setExtensionId()`, `_getExtensionId()`, `TEE_ACTION_RESULT` verification — are
copied verbatim, not modified).

## Operations

| Constant | Value | Notes |
|---|---|---|
| OP type | `AUCTION` | one op type for the whole extension |
| Command | `PLACE_BID` | encrypted bid intake |
| Command | `CLOSE_AUCTION` | winner selection |

Declared in three places that must stay byte-identical (`bytes32("AUCTION")` in
Solidity ⇔ `teeutils.ToHash("AUCTION")` in Go):

1. `contracts/SealedAuction.sol` — `OP_TYPE_AUCTION`, `OP_COMMAND_PLACE_BID`, `OP_COMMAND_CLOSE_AUCTION`
2. `go/internal/config/config.go` — `OPTypeAuction`, `OPCommandPlaceBid`, `OPCommandCloseAuction`
3. `go/internal/extension/extension.go` — router `switch` on `ToHash(...)` comparisons

No `F_`-prefixed names; none of the reserved commands (`PAY`, `SIGN`, `VRF`, `REISSUE`, `PROVE`).

## Auction state machine

```
      createAuction(lot, lotKind, lotToken, lotTokenId/lotAmount,
                    payToken, deadline, reservePrice)
                    └─ pulls the lot into escrow; reverts → no auction
                                    │
                                    ▼
   cancelAuction                 ┌──────┐   placeBid × N        (while now < deadline)
   (seller, only while    ◄──────│ Open │◄──────────────
    bidCount == 0)               └──┬───┘
        │                           │ closeAuction        (anyone, now ≥ deadline)
        ▼                           ▼
   ┌───────────┐               ┌─────────┐  closeAuction again = re-issue instruction
   │ Cancelled │               │ Closing │  (allowed; idempotent on-chain, needed if
   └───────────┘               └────┬────┘   the TEE result expired or was lost)
        ▲                           │ settle(signed ActionResult)
        │  winner == address(0)     │
        └───────────────────────────┼─── winner != 0: pull payment, then
                                    ▼
                               ┌─────────┐
                               │ Settled │
                               └─────────┘
```

- **Open** — bids accepted. `placeBid` requires `block.timestamp < deadline`.
- **Closing** — deadline passed, `closeAuction` sent a `CLOSE_AUCTION` instruction.
  Calling it again re-issues the instruction (recovery path); no state is lost on-chain.
- **Settled** — TEE result verified; the atomic swap ran: winner paid `clearingPrice`
  in `payToken` to the seller **and** received the escrowed lot, in one transaction.
- **Cancelled** — either the seller cancelled a bidless auction, or the TEE reported
  no winner (no bids, or no bid ≥ reserve): `winner == address(0), clearingPrice == 0`.
  Either way the escrowed lot is returned to the seller.

One `SealedAuction` contract instance hosts many auctions (`auctionId` = array index).

## Lot escrow

The lot is a real token, not a description. `createAuction` pulls it into the
contract in the same transaction that records the auction:

| Lot kind | Pull on create | Release on settle/cancel |
|---|---|---|
| `LotKind.ERC721` | `transferFrom(seller → contract, tokenId)`, then `ownerOf` is asserted | `transferFrom(contract → winner \| seller)` |
| `LotKind.ERC20` | `transferFrom(seller → contract, amount)`, **balance delta** is stored as `lotAmount` | `transfer(winner \| seller, lotAmount)` |

Design notes:

- **Escrow first, record second.** The pull happens before the auction is pushed
  onto the array, so a failed pull (missing approval, wrong owner) leaves no
  auction behind — bidders can never bid on a lot the contract does not hold.
- **Balance-delta accounting** for ERC-20 lots means a fee-on-transfer token
  escrows exactly what arrived; the winner receives what is actually held.
- **Plain `transferFrom` on release, not `safeTransferFrom`.** A winner contract
  without `onERC721Received` would otherwise be able to block settlement forever.
  The contract still implements `onERC721Received` so lots can be pushed in.
- **`nonReentrant` on every asset-moving entry point**, with terminal state always
  written before the external calls (checks-effects-interactions).
- The description string survives as human-readable metadata next to the token.

## Data flow 1: placeBid

```
Bidder (browser)                     Chain                            TEE extension
────────────────                     ─────                            ─────────────
1. GET /info  ──────────────────────────────────────────────────────► ext-proxy
   ◄─ TEE public key (machineData.publicKey.{x,y})
2. plaintext = abi.encode(BidPayload{
     auctionId, contractAddr, bidder, amountWei, salt })
3. ciphertext = ECIES(teePubKey, plaintext)        // ecies-geth, ephemeral key
4. approve(SealedAuction, amountWei) on payToken   // so settle() can pull payment
5. placeBid(auctionId, ciphertext) {value: fee}
                                     6. require Open && now < deadline
                                     7. store bidCommitment = keccak256(abi.encode(
                                          auctionId, msg.sender, keccak256(ciphertext)))
                                     8. message = abi.encode(PlaceBidMessage{
                                          auctionId, bidder: msg.sender, ciphertext })
                                     9. sendInstructions(AUCTION/PLACE_BID, message)
                                     10. emit BidPlaced(auctionId, bidder, commitment)
                                         // NO amount in the event
                                                                      11. decrypt ciphertext
                                                                          via tee-node /decrypt
                                                                      12. checks (below), then
                                                                          store bid in memory:
                                                                          bids[auctionId] += {bidder,
                                                                          amount, timestamp, seq}
```

**Bidder identity is chain-authenticated.** `DataFixed` carries no tx sender, so the
TEE cannot see `msg.sender` — instead the *contract* wraps the ciphertext as
`abi.encode(auctionId, msg.sender, ciphertext)`. That wrapper is produced on-chain,
so `bidder` cannot be spoofed. The encrypted payload *also* contains `bidder` (and
`auctionId`, `contractAddr`); the TEE rejects the bid unless
`wrapper.bidder == payload.bidder && wrapper.auctionId == payload.auctionId`.
This kills two attacks:

- *Spoofing*: a bidder cannot attribute a bid to someone else (wrapper wins).
- *Ciphertext replay*: copying someone else's on-chain ciphertext and resubmitting it
  as your own bid fails the `wrapper.bidder == payload.bidder` check.

`salt` is random client-side noise so equal amounts never produce equal plaintexts
(defense-in-depth; ECIES is already randomized). Multiple bids from one bidder are all
kept; the highest one competes (re-bidding higher is the "raise" flow).

## Data flow 2: closeAuction → settle

```
Anyone                                Chain                            TEE extension
──────                                ─────                            ─────────────
1. closeAuction(auctionId) {value: fee}
                                      2. require (Open|Closing) && now ≥ deadline
                                      3. message = abi.encode(CloseMessage{
                                           auctionId, contractAddr,
                                           reservePrice, deadline })
                                      4. sendInstructions(AUCTION/CLOSE_AUCTION, msg)
                                      5. emit AuctionClosing(auctionId, instructionId)
                                                                       6. snapshot bids[auctionId],
                                                                          drop bids < reserve,
                                                                          winner = max amount;
                                                                          tie → earliest
                                                                          (timestamp, then seq)
                                                                       7. result = abi.encode(
                                                                          contractAddr, auctionId,
                                                                          winner, clearingPrice)
                                                                       8. tee-node signs ActionResult
7. poll ext-proxy for the signed ActionResult (same polling as weather frontend)
8. settle(resultData, actionId, submissionTag, status, signature)
                                      9.  verify (see below), decode result
                                      10. winner == 0  → state = Cancelled,
                                            lot released back to seller
                                      11. winner != 0 → state = Settled, then the
                                            ATOMIC SWAP in one tx:
                                              a) payToken.transferFrom(
                                                   winner → seller, clearingPrice)
                                              b) lot released contract → winner
                                            either leg reverting reverts both
                                      12. emit AuctionSettled(auctionId, winner,
                                            clearingPrice)   // first public reveal
```

**Atomicity.** There is no window where the seller has been paid but the lot has
not moved, or vice versa: both transfers execute inside `settle()`. If the winner
lacks pay-token balance or allowance, the whole settlement reverts, the lot stays
escrowed and the auction remains in `Closing` — the same signed TEE result can be
replayed later once the winner funds their allowance (covered by
`test_Settle_RevertsWithoutAllowanceAndKeepsLotEscrowed`).

**Signature verification (identical to fce-weather-insurance, unmodified):**

```
resultHash  = keccak256(keccak256(resultData) || actionId || keccak256(tag) || status)
payloadHash = keccak256(abi.encode("TEE_ACTION_RESULT", block.chainid, resultHash))
signer      = ecrecover(EIP-191(payloadHash), signature)
require(signer == teeAddress && status == 1)
```

`teeAddress` is set once by the owner after TEE registration (read from
TeeMachineRegistry — same `extension-post-setup.sh` pattern as weather).
`actionId` binds the result to one instruction (no replay across instructions);
`chainid` in the domain prevents cross-chain replay; `contractAddr` in the result
prevents relaying a result to a different auction contract; the contract also
requires the decoded `auctionId` to be in `Closing` state (no double settle).

## Trust boundary

```
┌─ public (chain, mempool, indexer, anyone) ────────────────────────────────┐
│ auction metadata: lot, seller, payToken, deadline, reservePrice           │
│ bid EXISTENCE: bidder address, bid count, bidCommitment, ciphertext       │
│ after settle: winner, clearingPrice                                       │
├─ TEE extension memory (volatile, plaintext) ──────────────────────────────┤
│ all bid amounts, salts — keyed by auctionId; never persisted, never       │
│ logged, never returned except winner+clearingPrice in the CLOSE result    │
├─ tee-node (same container) ───────────────────────────────────────────────┤
│ ECIES private key (extension calls /decrypt over localhost; the key       │
│ never leaves the node)                                                    │
└───────────────────────────────────────────────────────────────────────────┘
```

Revealed vs hidden:

| Data | On-chain | TEE | Revealed at settle |
|---|---|---|---|
| Bidder addresses | yes (placeBid sender) | yes | — |
| Bid amounts | **never** | plaintext | only the winner's (as clearingPrice) |
| Losing bids | never | plaintext until close | **never** |
| Reserve price | yes (public, v1) | via CloseMessage | — |
| Winner | — | computed | yes |

Note: bidder *participation* is public by design (placeBid is a normal tx). Hiding
participation would need relayer/mixer machinery — out of scope.

**Simulated-TEE caveat:** in `SIMULATED_TEE=true` mode the extension operator can
technically inspect process memory, so bid confidentiality holds only against
on-chain observers, not against the operator. Real confidentiality requires
production TEE hardware (Foundation-operated at this stage). This is a known
property of the simulated mode, not a flaw of the design.

## Payment token (FXRP with WPT fallback)

`payToken` is a **per-auction constructor-level choice**, not a hardcode:
`createAuction(..., payToken)` takes the ERC-20 address. Deployment tooling and the
frontend resolve FXRP dynamically via the FlareContractRegistry → AssetManager route
on Coston2; if the FXRP faucet token misbehaves, we pass the WPT mock
(`0x53192e788991AD96bC180249B15AefB94E597dD1`) instead — a config choice, not a code
change. Settlement pairs `transferFrom(winner → seller, clearingPrice)` with the
escrowed lot moving to the winner in the same transaction.

## Known limitations (v1 — documented in README)

1. **Volatile bid storage.** Bids live in extension process memory. A TEE restart
   between the first bid and closeAuction loses them; closeAuction then yields
   "no winner" → Cancelled. Acceptable for the demo; production would need
   encrypted persistence (e.g. sealed state via Redis) or bid re-submission.
2. **No bid bonds (the lot *is* escrowed).** The seller's side is fully
   collateralized — the lot sits in the contract from creation. The bidder's side
   is not: the winner pays via `transferFrom` at settle, which requires a prior
   `approve`. A winner who revoked approval (or never had funds) makes `settle`
   revert and the auction stalls in `Closing` with the lot safely escrowed (the
   seller can never lose the asset, only time). Production needs bid bonds
   (deposit at placeBid, slash on non-payment). Stated honestly in the README.
3. **Close/late-bid race.** placeBid is on-chain-gated by `deadline`, but instruction
   delivery is asynchronous; a bid mined just before the deadline could reach the TEE
   after a fast closeAuction instruction. Window is small (close is only callable
   after the deadline); v1 accepts it.
4. **First-price only, ties by arrival.** Highest bid wins and pays its own bid;
   tie-break = earlier instruction timestamp, then arrival order. No randomness needed.
   The first-come tie-break creates a slight incentive to bid early, which mildly
   contradicts sealed-bid spirit — acceptable for v1; a Secure Random tie-break is
   the v2 fix.
5. **Reserve price is public.** Keeps CloseMessage chain-authenticated and simple.

## Components & repo layout (after rename skill)

| Piece | Location | Source of pattern |
|---|---|---|
| `SealedAuction` contract (InstructionSender + settlement) | `contracts/InstructionSender.sol` (file name kept — generate-bindings.sh convention, mirrors weather) | weather `InstructionSender.sol` |
| Go config (ops, ports) | `go/internal/config/config.go` | scaffold |
| Handlers: `processPlaceBid`, `processCloseAuction` | `go/internal/extension/` | scaffold router + weather BUY (decrypt) |
| ABI arg specs (BidPayload, PlaceBidMessage, CloseMessage, AuctionResult) | `go/pkg/types/types.go` | weather `pkg/types` |
| Forge tests (mocked TEE sig) | `test/` | weather `WeatherInsurancePrivateBuy.t.sol` + `Mocks.sol` |
| Frontend: auction view + bid form + verify panel | `frontend/` | weather frontend (wagmi/viem, ECIES, polling) |

Winner selection is a pure function `pickWinner(bids, reserve) → (winner, price, ok)`
with table-driven tests: empty set, all below reserve, single bid, tie on amount
(earlier timestamp wins), tie on amount+timestamp (lower seq wins), reserve exactly met.

## Session plan mapping

1. This document (approved before any code).
2. Rename/create via scaffold skills; stub handlers; offline conformance fixtures.
3. Real handlers + table-driven winner tests.
4. `SealedAuction.sol` + forge tests (mocked TEE signature, FXRP `transferFrom` flow,
   reverts: double settle, wrong signer, settle before close, bid after deadline).
5. STOP. Registration happens next session on the reserved ngrok domain
   (`https://exothermally-multiplated-dannie.ngrok-free.dev`) as one uninterrupted run.
