#!/usr/bin/env bash
# extension-post-setup.sh — Extension-specific setup that runs AFTER post-build.
#
# This hook runs once the TEE node is live and registered on-chain in
# TeeMachineRegistry. Use it for setup that needs the TEE's on-chain identity
# to already exist — things that couldn't be done in extension-setup.sh because
# the TEE hadn't been registered yet.
#
# Typical uses:
#   - Reading the TEE signing address from TeeMachineRegistry.getActiveTeeMachines
#     and writing it to a contract so withdrawal / authorization signatures can
#     be verified on-chain via ecrecover.
#   - Granting the registered TEE node any extension-specific on-chain roles.
#   - Seeding on-chain state that depends on knowing which TEE is active.
#
# The following variables are available (sourced from .env + config/extension.env):
#
#   INSTRUCTION_SENDER     — your deployed InstructionSender contract address
#   EXTENSION_ID           — your extension's ID on the TeeExtensionRegistry
#   CHAIN_URL              — chain RPC endpoint
#   ADDRESSES_FILE         — path to deployed-addresses.json
#   DEPLOYMENT_PRIVATE_KEY — funded deployer/admin key
#
# Example: read the TEE address and register it with your contract
#
#   TEE_MACHINE_REGISTRY="$(jq -r '.TeeMachineRegistry' "$ADDRESSES_FILE")"
#   tee_addr=$(cast call "$TEE_MACHINE_REGISTRY" \
#       "getActiveTeeMachines(uint256)(address[],string[])" "$EXTENSION_ID" \
#       --rpc-url "$CHAIN_URL" | head -1 | tr -d '[]' | cut -d, -f1 | xargs)
#   cast send "$INSTRUCTION_SENDER" "setTeeAddress(address)" "$tee_addr" \
#       --rpc-url "$CHAIN_URL" --private-key "$DEPLOYMENT_PRIVATE_KEY"
#
# Why this matters:
#   Some on-chain verification requires the TEE's signing address to be known
#   to the contract. Since that address is only derivable after the TEE
#   registers itself, the wiring has to happen here — not in extension-setup.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[extension-post-setup]${NC} $*"; }

# --- Load environment ---
if [[ -f "$PROJECT_DIR/.env" ]]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi
if [[ -f "$PROJECT_DIR/config/extension.env" ]]; then
    source "$PROJECT_DIR/config/extension.env"
fi

log "EXTENSION_ID:       ${EXTENSION_ID:-<not set>}"
log "INSTRUCTION_SENDER: ${INSTRUCTION_SENDER:-<not set>}"
log "CHAIN_URL:          ${CHAIN_URL:-<not set>}"

# --- Sync SealedAuction.teeAddress with the registered TEE machine ---
# settle() verifies the TEE result signature with ecrecover against
# teeAddress; after a machine rotation the contract still trusts the dead
# key and every settlement reverts with "bad TEE signature" until this runs.
# Idempotent: reads before writing.

: "${INSTRUCTION_SENDER:?INSTRUCTION_SENDER not set (config/extension.env)}"
: "${EXTENSION_ID:?EXTENSION_ID not set (config/extension.env)}"
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
ADDRESSES_FILE="${ADDRESSES_FILE:-$PROJECT_DIR/config/coston2/deployed-addresses.json}"
# Resolve relative paths against PROJECT_DIR (not caller's cwd)
[[ "$ADDRESSES_FILE" == /* ]] || ADDRESSES_FILE="$PROJECT_DIR/$ADDRESSES_FILE"

# Machine calls route through the FlareTeeManager diamond, not the standalone
# TeeMachineRegistry (which this deployment does not use).
FLARE_TEE_MANAGER="$(jq -r '.[] | select(.name == "FlareTeeManager") | .address' "$ADDRESSES_FILE")"
[[ -n "$FLARE_TEE_MANAGER" && "$FLARE_TEE_MANAGER" != null ]] \
    || { echo "FlareTeeManager not found in $ADDRESSES_FILE" >&2; exit 1; }

# After reconcile-tee the only active machine for our extension is the live one.
live_tee=$(cast call "$FLARE_TEE_MANAGER" \
    "getActiveTeeMachines(uint256)(address[],string[])" "$EXTENSION_ID" \
    --rpc-url "$CHAIN_URL" | head -1 | tr -d '[]' | cut -d, -f1 | xargs)
[[ -n "$live_tee" && "$live_tee" != "0x0000000000000000000000000000000000000000" ]] \
    || { echo "No active TEE machine for extension $EXTENSION_ID — run reconcile-tee first" >&2; exit 1; }

current_tee=$(cast call "$INSTRUCTION_SENDER" "teeAddress()(address)" --rpc-url "$CHAIN_URL")

if [[ "${live_tee,,}" == "${current_tee,,}" ]]; then
    log "SealedAuction.teeAddress already matches live TEE $live_tee"
else
    log "Updating SealedAuction.teeAddress: $current_tee -> $live_tee"
    cast send "$INSTRUCTION_SENDER" "setTeeAddress(address)" "$live_tee" \
        --rpc-url "$CHAIN_URL" --private-key "$DEPLOYMENT_PRIVATE_KEY" >/dev/null
    log "teeAddress updated"
fi
