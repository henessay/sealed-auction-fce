#!/usr/bin/env python3
"""Regenerate the conformance fixtures in this directory.

The fixtures are committed; this script exists so the hex encodings are derived
rather than hand-written, and so adding a case is a code edit rather than a
manual hex-assembly exercise.

Run with any python3 that has eth-abi installed:
    python3 testdata/conformance/gen_fixtures.py

Each fixture is a single request/response pair asserted against the extension
by scripts/test-conformance.sh. See docs/extension-contract.md.

The suite runs against the extension ALONE — no tee-node, so no /decrypt.
PLACE_BID success therefore cannot be covered here (it needs decryption); it is
covered by Go unit tests with an injected decrypt, and end-to-end by test.sh.
What this suite pins down: the CLOSE_AUCTION result encoding (the bytes
settle() consumes), rejection paths that fire before decryption, and the
HTTP/envelope contract.
"""

from __future__ import annotations

import json
import pathlib

from eth_abi import encode as abi_encode

HERE = pathlib.Path(__file__).parent

ACTION_ID = "0x" + "11" * 32
TEE_ID = "0x" + "22" * 20
VERSION = "0.1.0"

CONTRACT = "0x" + "aa" * 20
ZERO_ADDR = "0x" + "00" * 20


def b32(s: str) -> str:
    b = s.encode("utf-8")
    return "0x" + b.ljust(32, b"\x00").hex()


def to_hex(b: bytes) -> str:
    return "0x" + b.hex()


def action(op_type: str, op_command: str, original: bytes, action_id: str = ACTION_ID) -> dict:
    """Build a POST /action body in the exact shape tee-node sends."""
    data_fixed = {
        "instructionId": action_id,
        "teeId": TEE_ID,
        "timestamp": 1700000000,
        "rewardEpochId": 42,
        "opType": b32(op_type),
        "opCommand": b32(op_command),
        "cosigners": [],
        "cosignersThreshold": 0,
        "originalMessage": to_hex(original),
        "additionalFixedMessage": "0x",
    }
    return {
        "data": {
            "id": action_id,
            "type": "instruction",
            "submissionTag": "submit",
            "message": to_hex(json.dumps(data_fixed).encode("utf-8")),
        },
        "additionalVariableMessages": [],
        "timestamps": [],
        "additionalActionData": "0x",
        "signatures": [],
    }


def place_bid_message(auction_id: int, bidder: str, ciphertext: bytes) -> bytes:
    """ABI tuple matching Solidity PlaceBidMessage {uint256,address,bytes}."""
    return abi_encode(["(uint256,address,bytes)"], [(auction_id, bidder, ciphertext)])


def close_message(auction_id: int, contract: str, reserve: int, deadline: int) -> bytes:
    """ABI tuple matching Solidity CloseMessage {uint256,address,uint256,uint64}."""
    return abi_encode(["(uint256,address,uint256,uint64)"], [(auction_id, contract, reserve, deadline)])


def auction_result(contract: str, auction_id: int, winner: str, price: int) -> bytes:
    """Flat ABI tuple matching settle()'s abi.decode(data,(address,uint256,address,uint256))."""
    return abi_encode(["address", "uint256", "address", "uint256"], [contract, auction_id, winner, price])


def json_msg(obj) -> bytes:
    """Serialize compactly, with no whitespace (byte-exact comparison — tee-node
    hashes and signs ActionResult.data)."""
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


FIXTURES: list[dict] = [
    {
        "name": "01-close-auction-no-bids",
        "description": "CLOSE_AUCTION with no stored bids returns winner=0 (contract cancels)",
        "request": {"method": "POST", "path": "/action",
                    "body": action("AUCTION", "CLOSE_AUCTION", close_message(1, CONTRACT, 0, 1700000000))},
        "expect": {
            "status": 200,
            "json": {
                "id": ACTION_ID,
                "submissionTag": "submit",
                "status": 1,
                "log": "ok",
                "opType": b32("AUCTION"),
                "opCommand": b32("CLOSE_AUCTION"),
                # hexutil.Bytes with no omitempty marshals as "0x", never absent.
                "additionalResultStatus": "0x",
                # Plain string, NOT bytes32 — contract §4.4.
                "version": VERSION,
                "data": to_hex(auction_result(CONTRACT, 1, ZERO_ADDR, 0)),
            },
        },
    },
    {
        "name": "02-close-auction-idempotent",
        "description": "Re-closing the same auction reproduces the identical result (recovery path)",
        "request": {"method": "POST", "path": "/action",
                    "body": action("AUCTION", "CLOSE_AUCTION", close_message(1, CONTRACT, 0, 1700000000))},
        "expect": {
            "status": 200,
            "json_subset": {
                "status": 1,
                "data": to_hex(auction_result(CONTRACT, 1, ZERO_ADDR, 0)),
            },
        },
    },
    {
        "name": "03-place-bid-empty-ciphertext",
        "description": "PLACE_BID with an empty ciphertext is a handler error before decryption",
        "request": {"method": "POST", "path": "/action",
                    "body": action("AUCTION", "PLACE_BID", place_bid_message(2, TEE_ID, b""))},
        "expect": {
            "status": 200,
            "json_subset": {"status": 0, "data": "0x"},
            "log_prefix": "error: ciphertext must not be empty",
        },
    },
    {
        "name": "04-place-bid-malformed-abi",
        "description": "A PLACE_BID originalMessage that is not the ABI wrapper is a handler error",
        "request": {"method": "POST", "path": "/action",
                    "body": action("AUCTION", "PLACE_BID", b"not abi at all")},
        "expect": {"status": 200, "json_subset": {"status": 0}, "log_prefix": "error: "},
    },
    {
        "name": "05-place-bid-after-close",
        "description": "A bid for an already-closed auction is rejected without decryption",
        "request": {"method": "POST", "path": "/action",
                    "body": action("AUCTION", "PLACE_BID", place_bid_message(1, TEE_ID, b"\x01\x02"))},
        "expect": {
            "status": 200,
            "json_subset": {"status": 0},
            "log_prefix": "error: auction 1 already closed",
        },
    },
    {
        "name": "06-unknown-op-type",
        "description": "An unrouted opType is 501 with a plain-text body",
        "request": {"method": "POST", "path": "/action",
                    "body": action("NOT_A_REAL_TYPE", "PLACE_BID", b"")},
        "expect": {"status": 501, "text_contains": "unsupported op type"},
    },
    {
        "name": "07-unknown-op-command",
        "description": "A known opType with an unrouted opCommand is also 501",
        "request": {"method": "POST", "path": "/action",
                    "body": action("AUCTION", "NOT_A_COMMAND", b"")},
        "expect": {"status": 501},
    },
    {
        "name": "08-invalid-action-json",
        "description": "A body that is not JSON is 400",
        "request": {"method": "POST", "path": "/action", "raw_body": "not json at all"},
        "expect": {"status": 400},
    },
    {
        "name": "09-invalid-hex-in-message",
        "description": "A non-hex data.message is 400",
        "request": {
            "method": "POST", "path": "/action",
            "body": {"data": {"id": ACTION_ID, "type": "instruction",
                              "submissionTag": "submit", "message": "0xZZZZ"}},
        },
        "expect": {"status": 400},
    },
    {
        "name": "10-message-not-datafixed",
        "description": "A valid-hex message that is not DataFixed JSON is 400",
        "request": {
            "method": "POST", "path": "/action",
            "body": {"data": {"id": ACTION_ID, "type": "instruction",
                              "submissionTag": "submit", "message": to_hex(b"not json")}},
        },
        "expect": {"status": 400},
    },
    {
        "name": "11-get-action-not-allowed",
        "description": "GET /action is 405",
        "request": {"method": "GET", "path": "/action"},
        "expect": {"status": 405},
    },
    {
        "name": "12-post-state-not-allowed",
        "description": "POST /state is 405",
        "request": {"method": "POST", "path": "/state", "raw_body": ""},
        "expect": {"status": 405},
    },
    {
        "name": "13-unknown-path",
        "description": "An unknown path is 404",
        "request": {"method": "GET", "path": "/does-not-exist"},
        "expect": {"status": 404},
    },
    {
        "name": "14-get-state",
        "description": "GET /state returns bytes32 stateVersion and aggregate counters only",
        "request": {"method": "GET", "path": "/state"},
        "expect": {
            "status": 200,
            "json": {
                # Asymmetric with ActionResult.version by design — contract §4.5.
                "stateVersion": b32(VERSION),
                "state": {
                    # No bid was accepted in this suite; auction 1 was closed.
                    "auctionsTracked": 0,
                    "auctionsClosed": 1,
                    "bidsStored": 0,
                },
            },
        },
    },
]


def main() -> None:
    for old in HERE.glob("*.json"):
        old.unlink()
    index = []
    for f in FIXTURES:
        path = HERE / f"{f['name']}.json"
        path.write_text(json.dumps(f, indent=2) + "\n")
        index.append(f["name"])

    (HERE / "index.json").write_text(json.dumps({"fixtures": index}, indent=2) + "\n")
    print(f"wrote {len(index)} fixtures + index.json to {HERE}")


if __name__ == "__main__":
    main()
