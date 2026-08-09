// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { SealedAuction, IERC20 } from "../contracts/InstructionSender.sol";
import { DemoAsset721 } from "../contracts/DemoAsset721.sol";
import { ITeeExtensionRegistry } from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../contracts/interfaces/ITeeMachineRegistry.sol";
import { MockERC20, MockTeeExtensionRegistry, MockTeeMachineRegistry } from "./Mocks.sol";

contract SealedAuctionTest is Test {
    SealedAuction internal auctionHouse;
    MockTeeExtensionRegistry internal extensionRegistry;
    MockTeeMachineRegistry internal machineRegistry;
    MockERC20 internal token;
    DemoAsset721 internal asset;
    MockERC20 internal lotToken;

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
        lotToken = new MockERC20();
        asset = new DemoAsset721();
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

    /// Mints an NFT to the seller and approves the auction house for it.
    function mintLot() internal returns (uint256 tokenId) {
        tokenId = asset.mint(seller);
        vm.prank(seller);
        asset.approve(address(auctionHouse), tokenId);
    }

    /// Default auction: a fresh ERC-721 lot escrowed on creation.
    function createAuction(uint256 reserve) internal returns (uint256 id) {
        uint256 tokenId = mintLot();
        vm.prank(seller);
        id = auctionHouse.createAuction(
            "A rare artifact",
            SealedAuction.LotKind.ERC721,
            address(asset),
            tokenId,
            0,
            IERC20(address(token)),
            deadline,
            reserve
        );
    }

    function createErc20LotAuction(uint256 lotAmount, uint256 reserve) internal returns (uint256 id) {
        lotToken.mint(seller, lotAmount);
        vm.startPrank(seller);
        lotToken.approve(address(auctionHouse), lotAmount);
        id = auctionHouse.createAuction(
            "A pile of tokens",
            SealedAuction.LotKind.ERC20,
            address(lotToken),
            0,
            lotAmount,
            IERC20(address(token)),
            deadline,
            reserve
        );
        vm.stopPrank();
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
        (,,,,,,,,, st,,,) = auctionHouse.auctions(auctionId);
    }

    function auctionOutcome(uint256 auctionId) internal view returns (address winner, uint256 price) {
        (,,,,,,,,,, winner, price,) = auctionHouse.auctions(auctionId);
    }

    function lotTokenId(uint256 auctionId) internal view returns (uint256 id) {
        (,,,, id,,,,,,,,) = auctionHouse.auctions(auctionId);
    }

    // --- createAuction: escrow ---

    function test_CreateAuction_EscrowsErc721Lot() public {
        uint256 id = createAuction(10 ether);
        assertEq(id, 0);
        assertEq(auctionHouse.auctionCount(), 1);
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Open);

        // The lot left the seller and is held by the auction house.
        assertEq(asset.ownerOf(lotTokenId(id)), address(auctionHouse));
        assertEq(asset.balanceOf(seller), 0);
        assertEq(asset.balanceOf(address(auctionHouse)), 1);
    }

    function test_CreateAuction_EscrowsErc20Lot() public {
        uint256 id = createErc20LotAuction(250 ether, 0);

        assertEq(lotToken.balanceOf(address(auctionHouse)), 250 ether);
        assertEq(lotToken.balanceOf(seller), 0);
        (,,,,, uint256 lotAmount,,,,,,,) = auctionHouse.auctions(id);
        assertEq(lotAmount, 250 ether);
    }

    function test_CreateAuction_RevertsWithoutLotApproval() public {
        uint256 tokenId = asset.mint(seller); // no approve
        vm.prank(seller);
        vm.expectRevert("not authorized");
        auctionHouse.createAuction(
            "unapproved",
            SealedAuction.LotKind.ERC721,
            address(asset),
            tokenId,
            0,
            IERC20(address(token)),
            deadline,
            0
        );
        // No auction was recorded.
        assertEq(auctionHouse.auctionCount(), 0);
    }

    function test_CreateAuction_RevertsOnPastDeadline() public {
        uint256 tokenId = mintLot();
        vm.warp(deadline + 1);
        vm.prank(seller);
        vm.expectRevert("deadline in the past");
        auctionHouse.createAuction(
            "lot",
            SealedAuction.LotKind.ERC721,
            address(asset),
            tokenId,
            0,
            IERC20(address(token)),
            deadline,
            0
        );
    }

    function test_CreateAuction_RevertsOnZeroErc20LotAmount() public {
        vm.prank(seller);
        vm.expectRevert("zero lot amount");
        auctionHouse.createAuction(
            "empty",
            SealedAuction.LotKind.ERC20,
            address(lotToken),
            0,
            0,
            IERC20(address(token)),
            deadline,
            0
        );
    }

    // --- placeBid / cancel ---

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

    function test_CancelAuction_ReturnsLotToSeller() public {
        uint256 id = createAuction(0);
        uint256 tokenId = lotTokenId(id);

        vm.prank(bidder1);
        vm.expectRevert("not seller");
        auctionHouse.cancelAuction(id);

        vm.prank(seller);
        auctionHouse.cancelAuction(id);
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Cancelled);
        assertEq(asset.ownerOf(tokenId), seller);

        // A cancelled auction takes no bids.
        vm.prank(bidder1);
        vm.expectRevert("auction not open");
        auctionHouse.placeBid(id, hex"01");
    }

    function test_CancelAuction_ReturnsErc20Lot() public {
        uint256 id = createErc20LotAuction(120 ether, 0);
        vm.prank(seller);
        auctionHouse.cancelAuction(id);
        assertEq(lotToken.balanceOf(seller), 120 ether);
        assertEq(lotToken.balanceOf(address(auctionHouse)), 0);
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

    // --- settle: atomic swap ---

    function test_Settle_SwapsLotForPaymentAtomically() public {
        uint256 id = createAuction(10 ether);
        uint256 tokenId = lotTokenId(id);
        bidAndClose(id);

        vm.prank(bidder1);
        token.approve(address(auctionHouse), 42 ether);

        settleWith(closeResult(id, bidder1, 42 ether), TEE_PK);

        assertTrue(auctionState(id) == SealedAuction.AuctionState.Settled);
        (address winner, uint256 price) = auctionOutcome(id);
        assertEq(winner, bidder1);
        assertEq(price, 42 ether);

        // Both legs landed in the same transaction.
        assertEq(token.balanceOf(seller), 42 ether);
        assertEq(token.balanceOf(bidder1), 1_000 ether - 42 ether);
        assertEq(asset.ownerOf(tokenId), bidder1);
        assertEq(asset.balanceOf(address(auctionHouse)), 0);
    }

    function test_Settle_SwapsErc20Lot() public {
        uint256 id = createErc20LotAuction(300 ether, 0);
        bidAndClose(id);

        vm.prank(bidder1);
        token.approve(address(auctionHouse), 7 ether);
        settleWith(closeResult(id, bidder1, 7 ether), TEE_PK);

        assertEq(lotToken.balanceOf(bidder1), 300 ether);
        assertEq(lotToken.balanceOf(address(auctionHouse)), 0);
        assertEq(token.balanceOf(seller), 7 ether);
    }

    function test_Settle_ZeroWinnerCancelsAndReturnsLot() public {
        uint256 id = createAuction(10 ether);
        uint256 tokenId = lotTokenId(id);
        bidAndClose(id);

        settleWith(closeResult(id, address(0), 0), TEE_PK);

        assertTrue(auctionState(id) == SealedAuction.AuctionState.Cancelled);
        assertEq(token.balanceOf(seller), 0);
        // Reserve not met — the seller keeps the asset.
        assertEq(asset.ownerOf(tokenId), seller);
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

    /// The payment leg failing must roll the lot leg back too — the escrow is
    /// intact and the auction can still be settled later.
    function test_Settle_RevertsWithoutAllowanceAndKeepsLotEscrowed() public {
        uint256 id = createAuction(0);
        uint256 tokenId = lotTokenId(id);
        bidAndClose(id);

        // Winner never approved — the v1 no-bid-bonds limitation surfaces here.
        bytes memory resultData = closeResult(id, bidder1, 5 ether);
        bytes32 actionId = extensionRegistry.lastInstructionId();
        bytes memory sig = signResult(resultData, actionId, "submit", 1, TEE_PK);
        vm.expectRevert("allowance");
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);

        assertEq(asset.ownerOf(tokenId), address(auctionHouse));
        assertTrue(auctionState(id) == SealedAuction.AuctionState.Closing);

        // Once the winner approves, the same result settles cleanly.
        vm.prank(bidder1);
        token.approve(address(auctionHouse), 5 ether);
        auctionHouse.settle(resultData, actionId, "submit", 1, sig);
        assertEq(asset.ownerOf(tokenId), bidder1);
        assertEq(token.balanceOf(seller), 5 ether);
    }
}
