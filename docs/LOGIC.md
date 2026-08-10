# SealedAuction — action logic

Ground truth for what each role may do in each state. Derived from
`contracts/InstructionSender.sol` (contract `SealedAuction`); the frontend is
required to match this document exactly. If the two disagree, the contract wins
and both this file and the UI are wrong.

## States

The contract has four states (`AuctionState`). The UI needs two more
distinctions, which are **not** on-chain: whether a `Closing` auction already
has a TEE result, and whether that result names a winner.

| UI state | On-chain | How the UI recognises it |
|---|---|---|
| **Open** | `Open` (1), `block.timestamp < deadline` | bidding window |
| **Open · expired** | `Open` (1), past deadline | nobody has closed it yet |
| **Closing · awaiting TEE** | `Closing` (2), no result for the last `AuctionClosing` instruction | result 404s / times out |
| **AwaitingSettle** | `Closing` (2), TEE result with `winner != 0` | decoded result |
| **NoWinner** | `Closing` (2), TEE result with `winner == 0` | decoded result |
| **Settled** | `Settled` (3) | terminal |
| **Cancelled** | `Cancelled` (4) | terminal — reached by seller cancel *or* by settling a NoWinner result |

## Roles

Resolved against the connected wallet:

- **seller** — `auction.seller`
- **bidder** — has a `BidPlaced` log on this auction
- **winner** — matches the TEE result's winner (before settle) or
  `auction.winner` (after)
- **stranger** — anyone else, including a disconnected visitor

## Presentation rules

Correct permissions are not enough — a card must read as *my* next step:

1. **At most one bright button per card**, and only for the action expected
   from the connected wallet. Everything else is secondary/outline or hidden.
2. **Role badge** on every card: *You are the seller* / *You bid here* /
   *You won* / nothing.
3. **One state line** under the title saying what happens next and who acts.
   No scattered hints.
4. **Explanations live in tooltips** (ⓘ), never as paragraphs under buttons.
5. **Protocol-open actions that are not this wallet's job** go into a collapsed
   `advanced` row, so they exist without competing for attention.

## Matrix

`✓` primary, bright · `○` visible but secondary/outline · `~` collapsed under
`advanced` · `✗ (reason)` visible but disabled with that reason · `—` not
rendered.

### Open (before deadline)

| Action | seller | bidder | winner | stranger | Why |
|---|---|---|---|---|---|
| Place sealed bid | ✗ (seller cannot bid: FXRP rejects self-transfers, so a seller-won auction could never settle) | ✓ (bid again — bids are independent) | n/a | ✓ | `placeBid` requires `Open` and `now < deadline`; the contract does not bar the seller, but FAsset settlement would revert `CannotTransferToSelf` |
| Close auction | — | — | n/a | — | `closeAuction` requires `now >= deadline`; the UI shows the countdown instead of a dead button |
| Cancel auction | ~ while `bidCount == 0` | — | — | — | `cancelAuction` is `msg.sender == seller` and `bidCount == 0`; it is a fallback, never the headline |
| Settle | — | — | — | — | needs a TEE result |

### Open · expired (past deadline, nobody closed)

| Action | seller | bidder | winner | stranger | Why |
|---|---|---|---|---|---|
| Place sealed bid | — | — | — | — | `bidding closed` |
| Close auction | ✓ | ✓ | n/a | ○ | `closeAuction` is permissionless by design: the outcome is decided by the TEE, not by the caller. Outline for strangers because finishing someone else's auction is allowed but not their job |
| Cancel auction | ~ if `bidCount == 0` | — | — | — | there is no deadline check in `cancelAuction`, so a bidless auction can still be pulled back |
| Settle | — | — | — | — | needs a TEE result |

### Closing · awaiting TEE

| Action | seller | bidder | winner | stranger | Why |
|---|---|---|---|---|---|
| Re-run close (recovery) | ✓ | ✓ | n/a | ○ | `closeAuction` accepts `Closing` again on purpose: the TEE result is deterministic, so re-issuing is the fix for a lost/expired result |
| Settle | — | — | — | — | no result to submit yet |

### AwaitingSettle (result names a winner)

| Action | seller | bidder | winner | stranger | Why |
|---|---|---|---|---|---|
| Approve & settle | ~ | ~ | ✓ | ~ | `settle` has **no caller restriction**, but it pulls `payToken` from the winner via allowance, so it reverts until the winner approves. Only the winner gets a bright button; everyone else sees the state line *"waiting for the winner (0x…) to approve & settle"* and finds `Settle (advanced)` in the collapsed row. The card reads the winner's allowance to say whether it would succeed now |
| Re-run close | — | — | — | — | the contract still allows it, but the result is already in hand, so the UI drops the button |
| Cancel auction | — | — | — | — | `cancelAuction` requires `Open` |

### NoWinner (result with `winner == 0`)

| Action | seller | bidder | winner | stranger | Why |
|---|---|---|---|---|---|
| Settle (return lot) | ✓ | ○ | n/a | ○ | same permissionless `settle`; the zero-winner branch pays nobody and releases the lot back to the seller. No allowance is involved, so it cannot fail on funds — bright for the seller, who gets the lot back |

Reached when the reserve was not met, when every bid was invalid, or when the
TEE never saw the bids (restarted enclave). All three look identical on-chain.

### Settled / Cancelled

No actions. The card collapses to one compact row: lot, final price and winner
(or *no winner — lot returned*), role badge, and the settle/cancel transaction.

## Failure modes the UI must name

| Situation | Contract behaviour | Required UI |
|---|---|---|
| Winner has not approved the pay token | `settle` reverts on `transferFrom` | approve step runs first for the winner; for anyone else, say the winner must approve |
| Winner is also the seller (FXRP) | `transferFrom(x → x)` reverts `CannotTransferToSelf` | prevented up front: the seller cannot bid |
| Reserve not met | TEE returns `winner == 0` | NoWinner card, "settling returns the lot to the seller" |
| Zero bids at deadline | close returns `winner == 0`; or the seller cancels without closing | both paths offered |
| TEE result lost / expired | `Closing` accepts `closeAuction` again | "Re-run close (recovery)" |
| Bid mined, TEE never answered | commitment on-chain, no result | per-bid `TEE pending` badge + warning that unconfirmed bids are ignored at close |
| RPC rate limit | n/a | "network is busy — retrying", never a raw provider dump |
