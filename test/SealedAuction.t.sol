// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { SealedAuction, IERC20 } from "../contracts/InstructionSender.sol";
import { ITeeExtensionRegistry } from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../contracts/interfaces/ITeeMachineRegistry.sol";
import { MockERC20, MockTeeExtensionRegistry, MockTeeMachineRegistry } from "./Mocks.sol";

contract SealedAuctionTest is Test {
    SealedAuction internal auctionHouse;
    MockTeeExtensionRegistry internal extensionRegistry;
    MockTeeMachineRegistry internal machineRegistry;
    MockERC20 internal token;

    uint256 internal constant TEE_PK = 0xA11CE;
    address internal teeSigner;

    address internal seller = makeAddr("seller");
    address internal bidder1 = makeAddr("bidder1");
    address internal bidder2 = makeAddr("bidder2");

    uint64 internal deadline;

    function setUp() public {
        extensionRegistry = new MockTeeExtensionRegistry();
        machineRegistry = new MockTeeMachineRegistry();
        token = new MockERC20();
        teeSigner = vm.addr(TEE_PK);

        auctionHouse = new SealedAuction(
            ITeeExtensionRegistry(address(extensionRegistry)),
            ITeeMachineRegistry(address(machineRegistry))
        );
        extensionRegistry.setInstructionsSender(address(auctionHouse));
        auctionHouse.setExtensionId();
        auctionHouse.setTeeAddress(teeSigner);

        deadline = uint64(block.timestamp + 1 days);

        token.mint(bidder1, 1_000 ether);
        token.mint(bidder2, 1_000 ether);
    }

    // --- helpers ---

    function createAuction(uint256 reserve) internal returns (uint256) {
        vm.prank(seller);
        return auctionHouse.createAuction("A rare artifact", IERC20(address(token)), deadline, reserve);
    }

    /// Mirrors the TEE node's ActionResult signing scheme (go-flare-common signing.TEEActionResult).
    function signResult(
        bytes memory resultData,
        bytes32 actionId,
        string memory tag,
        uint8 status,
        uint256 pk
    ) internal view returns (bytes memory sig) {
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(tag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, resultHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function closeResult(uint256 auctionId, address winner, uint256 price) internal view returns (bytes memory) {
        return abi.encode(address(auctionHouse), auctionId, winner, price);
    }

    function settleWith(bytes memory resultData, uint256 pk) internal {
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, pk);
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
    }

    function bidAndClose(uint256 auctionId) internal {
        vm.prank(bidder1);
        auctionHouse.placeBid(auctionId, hex"c1c1c1");
        vm.warp(deadline);
        auctionHouse.closeAuction(auctionId);
    }

    function auctionState(uint256 auctionId) internal view returns (SealedAuction.AuctionState st) {
        (,,,,, st,,,) = auctionHouse.auctions(auctionId);
    }

    // --- createAuction / placeBid / cancel ---

    function test_CreateAuction() public {
        uint256 id = createAuction(10 ether);
        assertEq(id, 0);
        assertEq(auctionHouse.auctionCount(), 1);
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Open);
    }

    function test_CreateAuction_RevertsOnPastDeadline() public {
        vm.warp(deadline + 1);
        vm.prank(seller);
        vm.expectRevert("deadline in the past");
        auctionHouse.createAuction("lot", IERC20(address(token)), deadline, 0);
    }

    function test_PlaceBid_EmitsCommitmentWithoutAmount() public {
        uint256 id = createAuction(0);
        bytes memory ciphertext = hex"deadbeef01";
        bytes32 commitment = keccak256(abi.encode(id, bidder1, keccak256(ciphertext)));

        vm.prank(bidder1);
        vm.expectEmit(true, true, false, false);
        emit SealedAuction.BidPlaced(id, bidder1, commitment, bytes32(0));
        auctionHouse.placeBid(id, ciphertext);

        assertTrue(auctionHouse.bidCommitments(commitment));
        // The instruction message wraps (auctionId, msg.sender, ciphertext).
        bytes memory expected = abi.encode(
            SealedAuction.PlaceBidMessage({ auctionId: id, bidder: bidder1, ciphertext: ciphertext })
        );
        assertEq(extensionRegistry.lastMessage(), expected);
        assertEq(extensionRegistry.lastOpCommand(), auctionHouse.OP_COMMAND_PLACE_BID());
    }

    function test_PlaceBid_RevertsAfterDeadline() public {
        uint256 id = createAuction(0);
        vm.warp(deadline);
        vm.prank(bidder1);
        vm.expectRevert("bidding closed");
        auctionHouse.placeBid(id, hex"01");
    }

    function test_PlaceBid_RevertsOnEmptyCiphertext() public {
        uint256 id = createAuction(0);
        vm.prank(bidder1);
        vm.expectRevert("empty ciphertext");
        auctionHouse.placeBid(id, "");
    }

    function test_CancelAuction_OnlyBidlessAndSeller() public {
        uint256 id = createAuction(0);

        vm.prank(bidder1);
        vm.expectRevert("not seller");
        auctionHouse.cancelAuction(id);

        vm.prank(seller);
        auctionHouse.cancelAuction(id);
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Cancelled);

        // A cancelled auction takes no bids.
        vm.prank(bidder1);
        vm.expectRevert("auction not open");
        auctionHouse.placeBid(id, hex"01");
    }

    function test_CancelAuction_RevertsWithBids() public {
        uint256 id = createAuction(0);
        vm.prank(bidder1);
        auctionHouse.placeBid(id, hex"01");
        vm.prank(seller);
        vm.expectRevert("bids exist");
        auctionHouse.cancelAuction(id);
    }

    // --- closeAuction ---

    function test_CloseAuction_RevertsBeforeDeadline() public {
        uint256 id = createAuction(0);
        vm.expectRevert("bidding still open");
        auctionHouse.closeAuction(id);
    }

    function test_CloseAuction_SendsCloseMessageAndIsRecallable() public {
        uint256 id = createAuction(5 ether);
        vm.warp(deadline);
        auctionHouse.closeAuction(id);
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Closing);

        bytes memory expected = abi.encode(
            SealedAuction.CloseMessage({
                auctionId: id,
                contractAddr: address(auctionHouse),
                reservePrice: 5 ether,
                deadline: deadline
            })
        );
        assertEq(extensionRegistry.lastMessage(), expected);

        // Recovery path: re-close while Closing is allowed.
        auctionHouse.closeAuction(id);
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Closing);
    }

    // --- settle: happy path ---

    function test_Settle_PaysWinnerToSeller() public {
        uint256 id = createAuction(10 ether);
        bidAndClose(id);

        vm.prank(bidder1);
        token.approve(address(auctionHouse), 42 ether);

        settleWith(closeResult(id, bidder1, 42 ether), TEE_PK);

        assertTrue(auctionState(id) == SealedAuction.AuctionState.Settled);
        (,,,,,, address winner, uint256 price,) = auctionHouse.auctions(id);
        assertEq(winner, bidder1);
        assertEq(price, 42 ether);
        assertEq(token.balanceOf(seller), 42 ether);
        assertEq(token.balanceOf(bidder1), 1_000 ether - 42 ether);
    }

    function test_Settle_ZeroWinnerCancels() public {
        uint256 id = createAuction(10 ether);
        bidAndClose(id);

        settleWith(closeResult(id, address(0), 0), TEE_PK);

        assertTrue(auctionState(id) == SealedAuction.AuctionState.Cancelled);
        assertEq(token.balanceOf(seller), 0);
    }

    // --- settle: reverts ---

    function test_Settle_RevertsOnWrongSigner() public {
        uint256 id = createAuction(0);
        bidAndClose(id);

        bytes memory resultData = closeResult(id, bidder1, 1 ether);
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, 0xBAD);
        vm.expectRevert("bad TEE signature");
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
    }

    function test_Settle_RevertsOnTamperedData() public {
        uint256 id = createAuction(0);
        bidAndClose(id);

        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(closeResult(id, bidder1, 1 ether), actionId, "submit", 1, TEE_PK);
        // Same signature, inflated price — must not verify.
        vm.expectRevert("bad TEE signature");
        auctionHouse.settle(closeResult(id, bidder1, 999 ether), actionId, "submit", 1, sig);
    }

    function test_Settle_RevertsOnFailureStatus() public {
        uint256 id = createAuction(0);
        bidAndClose(id);

        bytes memory resultData = closeResult(id, bidder1, 1 ether);
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 0, TEE_PK);
        vm.expectRevert("TEE reported failure");
        auctionHouse.settle(resultData, actionId, "submit", 0, sig);
    }

    function test_Settle_RevertsBeforeClose() public {
        uint256 id = createAuction(0);
        vm.prank(bidder1);
        auctionHouse.placeBid(id, hex"01");

        // Auction is still Open — even a validly-signed result must not settle.
        bytes memory resultData = closeResult(id, bidder1, 1 ether);
        bytes memory sig = signResult(resultData, bytes32(uint256(1)), "submit", 1, TEE_PK);
        vm.expectRevert("auction not closing");
        auctionHouse.settle(resultData, bytes32(uint256(1)), "submit", 1, sig);
    }

    function test_Settle_RevertsOnDoubleSettle() public {
        uint256 id = createAuction(0);
        bidAndClose(id);

        vm.prank(bidder1);
        token.approve(address(auctionHouse), 5 ether);
        bytes memory resultData = closeResult(id, bidder1, 5 ether);
        settleWith(resultData, TEE_PK);

        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, TEE_PK);
        vm.expectRevert("auction not closing");
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
    }

    function test_Settle_RevertsForOtherContract() public {
        uint256 id = createAuction(0);
        bidAndClose(id);

        bytes memory resultData = abi.encode(address(0xDEAD), id, bidder1, 1 ether);
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, TEE_PK);
        vm.expectRevert("result not for this contract");
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
    }

    function test_Settle_RevertsBelowReserve() public {
        uint256 id = createAuction(10 ether);
        bidAndClose(id);

        bytes memory resultData = closeResult(id, bidder1, 9 ether);
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, TEE_PK);
        vm.expectRevert("below reserve");
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
    }

    function test_Settle_RevertsWithoutAllowance() public {
        uint256 id = createAuction(0);
        bidAndClose(id);

        // Winner never approved — the v1 no-bid-bonds limitation surfaces here.
        bytes memory resultData = closeResult(id, bidder1, 5 ether);
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, TEE_PK);
        vm.expectRevert("allowance");
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
    }
}
