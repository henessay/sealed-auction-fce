# Demo Video Script — SealedAuction (3 minutes)

Shot-by-shot script for the hackathon demo video. Everything to open, say, and
show, with exact URLs and fallback material if the live flow hiccups.

## Before recording — checklist

**Services** (all must be green before you hit record):

```bash
docker ps                       # 3 containers: extension-tee, ext-proxy, redis
curl -s https://exothermally-multiplated-dannie.ngrok-free.dev/info | head -c 200   # HTTP 200, JSON
cd frontend && npx next start -p 3000    # if not already running
```

**Wallets in MetaMask:**
- Deployer `0x284D5a5731C3Ea22C0E39472d5911FE8Ebb900D7` — holds ~7 FXRP, use it to place the **winning** bid.
- Any second funded account for the **losing** bid (only needs C2FLR for gas; a losing bid never pays anything).

**Demo auction.** Auction **#4** is live on the escrow contract: seller
`0x19f5C3491407291409D812Da48728A35aE3Ce9F3`, lot = **DemoAsset721 #5 held in
escrow**, reserve 0.5 FXRP, deadline 30 minutes from creation
(`0x27afe65e…31c5a5`). If it has expired, recreate it — mint, approve, create
(seller key is in `.env.demo-seller.json`, gitignored):

```bash
RPC=https://coston2-api.flare.network/ext/C/rpc
SA=0x057c49831762029EA82c5644ff9D426D02486EeB
NFT=0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E
FXRP=0x0b6A3645c240605887a5532109323A3E12273dc7
SELLER=$(python3 -c "import json; print(json.load(open('.env.demo-seller.json'))[0]['address'])")
SPK=$(python3 -c "import json; print(json.load(open('.env.demo-seller.json'))[0]['private_key'])")
set -a; source .env; set +a; PK="0x${DEPLOYMENT_PRIVATE_KEY#0x}"

# Coston2 gas is ~650 gwei — keep the seller funded.
cast send $SELLER --value 3000000000000000000 --private-key "$PK" --rpc-url $RPC
# Mint the lot to the seller (deployer owns DemoAsset721), then escrow it.
cast send $NFT "mint(address)" $SELLER --private-key "$PK" --rpc-url $RPC
TOKENID=<id from the Transfer log>
cast send $NFT "approve(address,uint256)" $SA $TOKENID --private-key "$SPK" --rpc-url $RPC
NOW=$(cast block latest --field timestamp --rpc-url $RPC)
cast send $SA "createAuction(string,uint8,address,uint256,uint256,address,uint64,uint256)" \
  "Flare Summer Signal demo lot — tokenized collectible" \
  0 $NFT $TOKENID 0 $FXRP $((NOW + 1800)) 500000 \
  --private-key "$SPK" --rpc-url $RPC
```

You can also do all of this from the browser: the sidebar has a **Mint demo
NFT** button (visible to the DemoAsset721 owner), and the create form runs the
approve step for you.

Tip: for a tighter recording, create it with `$((NOW + 300))` (5-minute deadline)
right before the take, so the close happens on camera without waiting.

**Tabs to pre-open (in order):**

| # | Tab | URL |
|---|-----|-----|
| 1 | Frontend | http://localhost:3000 |
| 2 | Diagram slide | `docs/architecture-diagram.svg` (open in browser, F11) |
| 3 | Contract on explorer | https://coston2-explorer.flare.network/address/0x057c49831762029EA82c5644ff9D426D02486EeB |
| 4 | Backup: winning bid tx | https://coston2-explorer.flare.network/tx/0xab0fd0ac24240295ee8be0ede4aa0b731960a377807125376d65025a98f48741 |
| 5 | Backup: losing bid tx | https://coston2-explorer.flare.network/tx/0xb4550b0ee995b155d45bc7a43b38b2d70416d9a299445cbf3048a81bd161c66c |
| 6 | Backup: settle tx (FXRP → seller **and** NFT → winner) | https://coston2-explorer.flare.network/tx/0x4ca99e3edad1db4064c58409ed9d9100e99bb9d034a660333828ef34b188797e |
| 7 | Demo lot token | https://coston2-explorer.flare.network/address/0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E |

---

## 0:00 — The problem (30s)

**Screen:** a slide or text editor with the annotated calldata below.

**Say:** "On a public blockchain, a normal auction leaks every bid the moment
it's submitted. Here's what a typical `bid(amount)` transaction looks like —
the amount is right there in the calldata, readable by everyone, including
competing bidders watching the mempool."

**Show** (annotated public-auction calldata — this is what any non-confidential
auction publishes):

```
0x598647f8                                                          ← bid(uint256,uint256)
0000000000000000000000000000000000000000000000000000000000000005   ← auctionId = 5
00000000000000000000000000000000000000000000000000000000002dc6c0   ← amount = 3,000,000  ← PUBLIC
```

**Say:** "Everyone sees 3 million. Rivals can outbid you by one unit, snipe at
the deadline, or collude. Sealed-bid auctions fix the economics — but on a
transparent chain you need somewhere private to open the bids. That's what
Flare's Confidential Compute gives us."

## 0:30 — Architecture (20s)

**Screen:** tab 2 — `docs/architecture-diagram.svg`, full screen.

**Say:** "SealedAuction is a Flare Confidential Extension. The seller escrows a
real asset — here an NFT — into the contract when they create the auction, so
bidders know the lot is really there. The bid amount is encrypted in your
browser under the TEE's public key. The contract wraps the ciphertext with
`msg.sender` — that's what authenticates the bidder, so nobody can spoof or
replay someone else's ciphertext. The TEE decrypts bids only in enclave memory,
picks the winner after the deadline, and signs the result. Settlement is an
atomic swap: payment and asset move together or not at all."

## 0:50 — Live: two sealed bids (50s)

**Screen:** tab 1 — frontend.

1. Point at the demo auction card: state **Open**, the green **Lot in escrow**
   badge, the lot link (**SADEMO #5**), countdown, reserve, pay token
   **FTestXRP** — "the lot is an NFT already held by the contract, and the pay
   token is FXRP, Flare's bridged XRP FAsset, resolved on-chain through the
   ContractRegistry." Optionally click the lot link and show `ownerOf` = the
   auction contract.
2. With the **losing** wallet: enter a low amount (e.g. `1`), click **Place
   sealed bid**. Narrate the status line: "encrypting in the browser… TEE
   accepted." 
3. Switch MetaMask to the **deployer**, bid higher (e.g. `2.5`), same flow.
4. Click the tx links (or open both placeBid txs from the explorer contract
   page, tab 3) **side by side**.

**Say:** "Here are both bid transactions on the explorer. The calldata is
opaque ECIES ciphertext — same length, same shape, whether you bid one FXRP or
a million. The amounts appear nowhere. The only public trace is a commitment
hash and who participated."

**Fallback:** if the live flow hiccups, tabs 4 and 5 are two real sealed-bid
transactions from the recorded escrow end-to-end run — identical story,
calldata is 778 hex chars of ciphertext.

## 1:40 — Close, TEE result, settle (40s)

**Screen:** frontend, then explorer.

1. When the countdown hits zero, click **Close auction** (any wallet). Narrate:
   "anyone can close — the TEE decrypts the bids in memory and picks the
   highest one above reserve."
2. The card shows the TEE result: winner + clearing price. "The losing bid is
   still secret — it was never decrypted anywhere outside the enclave, and it
   never will be published."
3. With the winning (deployer) wallet click **Approve & settle** — two
   MetaMask confirmations (ERC-20 approve, then settle). The card then reads
   "**You won SADEMO #5 for … FXRP — the lot is in your wallet.**"
4. Open the settle tx and point at the two token transfers in one transaction:
   "settle() verified the TEE's secp256k1 signature on-chain, then swapped:
   FXRP from winner to seller, and the NFT out of escrow to the winner. Either
   leg failing would revert both — the seller can never be paid without
   delivering, and the buyer can never pay without receiving."

**Fallback:** tab 6 — the recorded settle tx (3 FXRP winner → seller **and**
DemoAsset721 #4 escrow → winner, TEE signature verified on-chain).

## 2:20 — Verify panel (20s)

**Screen:** frontend, right column.

**Say:** "Don't trust — verify. The panel reads the TEE's live `/info`:
extension ID 66042, the enclave code hash, and the machine's registration
status on the FlareTeeManager contract — **PRODUCTION**. Contract and manager
are one click away on the explorer." (Click the contract link, tab 3.)

"On Coston2 the TEE runs in simulated mode — officially supported for judging;
on mainnet the same code hash would be attested by real TEE hardware."

## 2:40 — Recap & roadmap (20s)

**Screen:** back to the diagram or the README.

**Say:** "To recap the Flare integrations: this is a Flare Confidential
Extension end to end — on-chain instructions, TEE compute, signed results. And
it's a real asset trade: an NFT escrowed on-chain, swapped atomically against
FXRP resolved dynamically via the ContractRegistry and AssetManager. That makes
it an interoperable-asset product, not just a confidentiality demo. We're
honest about v1: bids live in enclave memory, the seller's side is escrowed but
the bidder pays via allowance instead of a bond, and ties resolve first-come.
The roadmap: production TEE hardware, bid bonds, Secure-Random tie-breaks,
and private reserve prices. Sealed bids, real settlement — that's SealedAuction
on Flare."

---

## Reference — all demo values

| Item | Value |
|---|---|
| SealedAuction | `0x057c49831762029EA82c5644ff9D426D02486EeB` |
| Extension ID | 66042 (`0x…101fa`) |
| TEE machine | `0x91809e7b666558985093F00eF67565180519a7cC` (status 2 = PRODUCTION) |
| FlareTeeManager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| FXRP (FTestXRP, 6 decimals) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| DemoAsset721 (lot token, symbol SADEMO) | `0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E` |
| Demo auction #4 — seller | `0x19f5C3491407291409D812Da48728A35aE3Ce9F3` |
| Demo auction #4 — lot | DemoAsset721 **#5**, escrowed by the contract |
| Demo auction #4 — create tx | `0x27afe65e328ce0452752e75b2462ca277d31386ae1bd9432a97936487531c5a5` |
| Backup bid txs (escrow run, auction #3) | `0xb4550b0e…61c66c` (losing), `0xab0fd0ac…f48741` (winning) |
| Backup settle tx (escrow run, auction #3) | `0x4ca99e3e…8797e` — FXRP → seller **and** NFT #4 → winner |
