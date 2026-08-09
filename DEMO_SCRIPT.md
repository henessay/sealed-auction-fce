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

**Demo auction.** Auction **#5** is live (seller `0x19f5C3491407291409D812Da48728A35aE3Ce9F3`,
reserve 0.5 FXRP, deadline 2026-08-09 02:50 CEST). If it has expired, recreate
in one command (seller key is in `.env.demo-seller.json`, gitignored):

```bash
RPC=https://coston2-api.flare.network/ext/C/rpc
SPK=$(python3 -c "import json; print(json.load(open('.env.demo-seller.json'))[0]['private_key'])")
NOW=$(cast block latest --field timestamp --rpc-url $RPC)
cast send 0x5a468D17C292C262C4bAa0A953561bF31CDA79a0 \
  "createAuction(string,address,uint64,uint256)" \
  "Flare Summer Signal demo lot — hackathon collectible" \
  0x0b6A3645c240605887a5532109323A3E12273dc7 $((NOW + 1800)) 500000 \
  --private-key "$SPK" --rpc-url $RPC
```

Tip: for a tighter recording, create it with `$((NOW + 300))` (5-minute deadline)
right before the take, so the close happens on camera without waiting.

**Tabs to pre-open (in order):**

| # | Tab | URL |
|---|-----|-----|
| 1 | Frontend | http://localhost:3000 |
| 2 | Diagram slide | `docs/architecture-diagram.svg` (open in browser, F11) |
| 3 | Contract on explorer | https://coston2-explorer.flare.network/address/0x5a468D17C292C262C4bAa0A953561bF31CDA79a0 |
| 4 | Backup: winning bid tx | https://coston2-explorer.flare.network/tx/0x213481bb3c0da61babeb254a4cd4ee73b51d40e59ebf51a9f04567d16f178fd3 |
| 5 | Backup: losing bid tx | https://coston2-explorer.flare.network/tx/0x5fd884eb8497da248ded72c462eba333fedf9041ed52b202b192c7b1e647bec4 |
| 6 | Backup: settle tx | https://coston2-explorer.flare.network/tx/0x2b8c709ea2135d6e649feac34b8f5cf2f2b39ec934d003cbe497e46e0c16426a |

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

**Say:** "SealedAuction is a Flare Confidential Extension. The bid amount is
encrypted in your browser under the TEE's public key. The contract wraps the
ciphertext with `msg.sender` — that's what authenticates the bidder, so nobody
can spoof or replay someone else's ciphertext. The TEE decrypts bids only in
enclave memory, picks the winner after the deadline, and signs the result.
The chain never sees a plaintext bid — only the winner and the clearing price
come out."

## 0:50 — Live: two sealed bids (50s)

**Screen:** tab 1 — frontend.

1. Point at the demo auction card: state **Open**, countdown, reserve, pay
   token **FTestXRP** — "the pay token is FXRP, Flare's bridged XRP FAsset,
   resolved on-chain through the ContractRegistry."
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
transactions from the recorded FXRP end-to-end run (auction #4) — identical
story, calldata is 778 hex chars of ciphertext.

## 1:40 — Close, TEE result, settle (40s)

**Screen:** frontend, then explorer.

1. When the countdown hits zero, click **Close auction** (any wallet). Narrate:
   "anyone can close — the TEE decrypts the bids in memory and picks the
   highest one above reserve."
2. The card shows the TEE result: winner + clearing price. "The losing bid is
   still secret — it was never decrypted anywhere outside the enclave, and it
   never will be published."
3. With the winning (deployer) wallet click **Approve & settle** — two
   MetaMask confirmations (ERC-20 approve, then settle).
4. Open the settle tx: "settle() verified the TEE's secp256k1 signature
   on-chain and moved the FXRP from winner to seller in the same transaction."

**Fallback:** tab 6 — the recorded settle tx (auction #4, 3 FXRP
winner → seller, TEE signature verified on-chain).

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
Extension end to end — on-chain instructions, TEE compute, signed results.
Settlement is in FXRP, resolved dynamically via the ContractRegistry and
AssetManager, which makes it an interoperable-asset product, not just a
confidentiality demo. We're honest about v1: bids live in enclave memory, the
winner pays via allowance instead of a bond, and ties resolve first-come.
The roadmap: production TEE hardware, bid bonds, Secure-Random tie-breaks,
and private reserve prices. Sealed-bid auctions with public-chain settlement —
that's SealedAuction on Flare."

---

## Reference — all demo values

| Item | Value |
|---|---|
| SealedAuction | `0x5a468D17C292C262C4bAa0A953561bF31CDA79a0` |
| Extension ID | 66042 (`0x…101fa`) |
| TEE machine | `0x767F28A6B30EB9528C036378454Da1C2ea11E126` (status 2 = PRODUCTION) |
| FlareTeeManager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| FXRP (FTestXRP, 6 decimals) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| Demo auction #5 seller | `0x19f5C3491407291409D812Da48728A35aE3Ce9F3` |
| Demo auction #5 create tx | `0x797727053f5be961300ae816c27570da23577ba0cc867c88bd31d623adfc32b6` |
| Backup bid txs (auction #4) | `0x5fd884eb…47bec4` (losing), `0x213481bb…178fd3` (winning) |
| Backup settle tx (auction #4) | `0x2b8c709e…16426a` |
