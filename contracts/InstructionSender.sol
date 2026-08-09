// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// TODO: Replace local interfaces with imports from flare-smart-contracts-v2 once published as a package.
import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

/// @notice Minimal ERC-20 surface used for winner payment.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SealedAuction
/// @notice Sealed-bid (first-price) auction settled by a Flare Confidential
/// Compute (FCC) TEE extension. Bid amounts are ECIES-encrypted client-side
/// under the TEE public key and reach this contract as opaque ciphertext; the
/// plaintext exists only inside the TEE. After the deadline anyone can close
/// the auction: the TEE compares bids, applies the reserve price, and returns
/// a signed (winner, clearingPrice) result. settle() verifies the TEE
/// signature on-chain (ecrecover against the registered TEE address) and pulls
/// the payment winner → seller in the auction's ERC-20 pay token. Losing bids
/// are never revealed anywhere.
///
/// This contract doubles as the FCC InstructionSender: it owns the extension
/// registration and routes AUCTION/{PLACE_BID,CLOSE_AUCTION} instructions
/// through the Flare TEE Manager diamond.
///
/// v1 limitations (see README): no bid bonds — the winner pays via
/// transferFrom at settle and must keep the allowance in place; TEE bid
/// storage is volatile, so a TEE restart before close cancels the auction.
///
/// DO NOT MODIFY: the registry wiring in the constructor, setExtensionId(),
/// and _getExtensionId().
contract SealedAuction {
    // --- FCC operation identifiers (must match go/internal/config/config.go) ---

    /// @notice Operation type for auction actions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_AUCTION = bytes32("AUCTION");

    /// @notice Command for the sealed-bid PLACE_BID action (ECIES ciphertext).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_PLACE_BID = bytes32("PLACE_BID");

    /// @notice Command for the CLOSE_AUCTION action (winner selection).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_CLOSE_AUCTION = bytes32("CLOSE_AUCTION");

    /// @notice Domain-separation prefix the TEE node signs ActionResult hashes
    /// under: keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, chainId, ActionResult.Hash())),
    /// wrapped with the EIP-191 personal-sign prefix. Must match go-flare-common's
    /// `signing.TEEActionResult` (github.com/flare-foundation/go-flare-common/pkg/signing).
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 private constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    // --- Registries ---

    /// @notice Reference to the TEE extension registry contract.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    /// @notice Reference to the TEE machine registry contract.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves IDs below this
    /// for system/reserved extensions; public extensions are assigned from here up.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    // --- Auction state ---

    enum AuctionState {
        None,
        Open,
        Closing,
        Settled,
        Cancelled
    }

    /// @notice One sealed-bid auction. Amounts are in `payToken` units.
    struct Auction {
        address seller;
        string lot;             // off-chain lot description (demo scope)
        IERC20 payToken;        // ERC-20 used for the winner's payment
        uint64 deadline;        // bidding closes at this unix timestamp
        uint256 reservePrice;   // public; 0 = no reserve
        AuctionState state;
        address winner;         // set at settle
        uint256 clearingPrice;  // set at settle (first-price: the winning bid)
        uint256 bidCount;
    }

    /// @notice ABI payload of a PLACE_BID instruction (decoded by the TEE).
    /// Built on-chain, so `bidder` is authenticated — the TEE trusts it over
    /// whatever the ciphertext claims.
    struct PlaceBidMessage {
        uint256 auctionId;
        address bidder;
        bytes ciphertext;       // ECIES(teePubKey, abi.encode(BidPayload))
    }

    /// @notice ABI payload of a CLOSE_AUCTION instruction (decoded by the TEE).
    struct CloseMessage {
        uint256 auctionId;
        address contractAddr;   // this contract — echoed back so settle() can bind the result
        uint256 reservePrice;
        uint64 deadline;
    }

    /// @notice Contract owner (deployer). Registers the TEE address.
    address public owner;

    /// @notice Registered TEE signing address; settlements must be signed by it.
    address public teeAddress;

    Auction[] public auctions;

    /// @notice Audit trail: keccak256(abi.encode(auctionId, bidder, keccak256(ciphertext))).
    /// Proves a given bidder placed a given ciphertext without revealing amounts.
    mapping(bytes32 => bool) public bidCommitments;

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address payToken,
        uint64 deadline,
        uint256 reservePrice,
        string lot
    );
    /// @notice Emitted per bid. Deliberately carries NO amount.
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, bytes32 commitment, bytes32 instructionId);
    event AuctionClosing(uint256 indexed auctionId, bytes32 instructionId);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 clearingPrice);
    event AuctionCancelled(uint256 indexed auctionId);
    event TeeAddressSet(address indexed teeAddress);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @notice Initializes the contract with registry addresses.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry Address of the TEE machine registry.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        owner = msg.sender;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Register the active TEE signing address (read off TeeMachineRegistry).
    function setTeeAddress(address _teeAddress) external onlyOwner {
        require(_teeAddress != address(0), "zero TEE address");
        teeAddress = _teeAddress;
        emit TeeAddressSet(_teeAddress);
    }

    // --- Auction lifecycle ---

    /// @notice Create an auction. The lot is an off-chain description string
    ///         (demo scope); payment settles in `_payToken`.
    /// @param _lot Human-readable description of what is being sold.
    /// @param _payToken ERC-20 the winner pays in (e.g. FXRP on Coston2).
    /// @param _deadline Unix timestamp after which bidding closes.
    /// @param _reservePrice Minimum winning bid; 0 = no reserve. Public by design (v1).
    function createAuction(
        string calldata _lot,
        IERC20 _payToken,
        uint64 _deadline,
        uint256 _reservePrice
    ) external returns (uint256 auctionId) {
        require(address(_payToken) != address(0), "zero pay token");
        require(_deadline > block.timestamp, "deadline in the past");
        require(bytes(_lot).length > 0, "lot required");

        auctionId = auctions.length;
        auctions.push(Auction({
            seller: msg.sender,
            lot: _lot,
            payToken: _payToken,
            deadline: _deadline,
            reservePrice: _reservePrice,
            state: AuctionState.Open,
            winner: address(0),
            clearingPrice: 0,
            bidCount: 0
        }));

        emit AuctionCreated(auctionId, msg.sender, address(_payToken), _deadline, _reservePrice, _lot);
    }

    /// @notice Submit a sealed bid as ECIES ciphertext. The bid amount never
    ///         appears on-chain — only an opaque ciphertext and a commitment.
    ///         The caller should `approve` this contract on the auction's pay
    ///         token for at least the bid amount, or a winning bid cannot settle.
    /// @param _auctionId The auction to bid on.
    /// @param _ciphertext ECIES ciphertext of the ABI-encoded bid payload
    ///        (auctionId, contractAddr, bidder, amountWei, salt). The TEE
    ///        rejects it unless bidder/auctionId match this transaction.
    function placeBid(uint256 _auctionId, bytes calldata _ciphertext) external payable {
        Auction storage a = _getAuction(_auctionId);
        require(a.state == AuctionState.Open, "auction not open");
        require(block.timestamp < a.deadline, "bidding closed");
        require(_ciphertext.length > 0, "empty ciphertext");

        // The wrapper is what authenticates the bidder: DataFixed carries no
        // tx sender, so the TEE takes msg.sender from here, not the ciphertext.
        bytes memory message = abi.encode(PlaceBidMessage({
            auctionId: _auctionId,
            bidder: msg.sender,
            ciphertext: _ciphertext
        }));

        bytes32 instructionId = _sendInstruction(OP_COMMAND_PLACE_BID, message);

        bytes32 commitment = keccak256(abi.encode(_auctionId, msg.sender, keccak256(_ciphertext)));
        bidCommitments[commitment] = true;
        a.bidCount += 1;

        emit BidPlaced(_auctionId, msg.sender, commitment, instructionId);
    }

    /// @notice Ask the TEE to pick the winner. Callable by anyone once the
    ///         deadline has passed. Re-callable while Closing — the TEE result
    ///         is deterministic, so re-issuing is the recovery path when a
    ///         result expired or was lost.
    function closeAuction(uint256 _auctionId) external payable {
        Auction storage a = _getAuction(_auctionId);
        require(
            a.state == AuctionState.Open || a.state == AuctionState.Closing,
            "auction not closable"
        );
        require(block.timestamp >= a.deadline, "bidding still open");

        a.state = AuctionState.Closing;

        bytes memory message = abi.encode(CloseMessage({
            auctionId: _auctionId,
            contractAddr: address(this),
            reservePrice: a.reservePrice,
            deadline: a.deadline
        }));

        bytes32 instructionId = _sendInstruction(OP_COMMAND_CLOSE_AUCTION, message);
        emit AuctionClosing(_auctionId, instructionId);
    }

    /// @notice Seller cancels a bidless auction before anyone commits funds.
    function cancelAuction(uint256 _auctionId) external {
        Auction storage a = _getAuction(_auctionId);
        require(msg.sender == a.seller, "not seller");
        require(a.state == AuctionState.Open, "auction not open");
        require(a.bidCount == 0, "bids exist");

        a.state = AuctionState.Cancelled;
        emit AuctionCancelled(_auctionId);
    }

    /// @notice Finalize an auction with a TEE-signed CLOSE_AUCTION result.
    /// @dev The TEE node signs `keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, chainId,
    ///      ActionResult.Hash()))` with its registered key using the EIP-191 personal-sign
    ///      prefix. We reconstruct that hash from the result fields the proxy returned and
    ///      recover the signer, requiring it to equal `teeAddress`. `_resultData` is the
    ///      exact bytes the TEE returned in ActionResult.Data:
    ///      abi.encode(address contractAddr, uint256 auctionId, address winner,
    ///      uint256 clearingPrice). A zero winner means no bid met the reserve —
    ///      the auction is cancelled and nothing is paid.
    /// @param _resultData     Raw `ActionResult.Data` (do not re-encode).
    /// @param _actionId       `ActionResult.ID`: the instruction id emitted by
    ///                        `closeAuction` / `sendInstructions`. Binds this settlement to
    ///                        one FCC instruction. Included in `ActionResult.Hash()` as a
    ///                        plain `bytes32` (not hashed again).
    /// @param _submissionTag  `ActionResult.SubmissionTag` from the original action payload
    ///                        (typically `"submit"`). Hashed as `keccak256(bytes(tag))`.
    /// @param _status         `ActionResult.Status`: only `1` (success) is accepted.
    /// @param _signature      ECDSA signature from the registered TEE node over
    ///                        `keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, chainId, resultHash))`
    ///                        where `resultHash` = `keccak256(abi.encodePacked(
    ///                        keccak256(_resultData), _actionId,
    ///                        keccak256(bytes(_submissionTag)), _status))`, wrapped with the
    ///                        EIP-191 `"\x19Ethereum Signed Message:\n32"` prefix.
    function settle(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature
    ) external {
        require(teeAddress != address(0), "TEE address not set");
        require(_status == 1, "TEE reported failure");

        // Reconstruct ActionResult.Hash() = keccak256(keccak256(data) || id || keccak256(tag) || status).
        bytes32 resultHash = keccak256(
            abi.encodePacked(
                keccak256(_resultData),
                _actionId,
                keccak256(bytes(_submissionTag)),
                _status
            )
        );

        // The TEE node signs a domain-separated payload over resultHash, not resultHash
        // directly — see TEE_ACTION_RESULT_PREFIX above.
        bytes32 payloadHash = keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, resultHash));

        address signer = _recover(_ethSigned(payloadHash), _signature);
        require(signer == teeAddress, "bad TEE signature");

        (
            address contractAddr,
            uint256 auctionId,
            address winner,
            uint256 clearingPrice
        ) = abi.decode(_resultData, (address, uint256, address, uint256));
        require(contractAddr == address(this), "result not for this contract");

        Auction storage a = _getAuction(auctionId);
        require(a.state == AuctionState.Closing, "auction not closing");

        if (winner == address(0)) {
            a.state = AuctionState.Cancelled;
            emit AuctionCancelled(auctionId);
            return;
        }

        // Defense-in-depth: the TEE already applied the reserve.
        require(clearingPrice >= a.reservePrice, "below reserve");

        a.state = AuctionState.Settled;
        a.winner = winner;
        a.clearingPrice = clearingPrice;

        // First public reveal: winner and clearing price. Losing bids stay sealed.
        require(a.payToken.transferFrom(winner, a.seller, clearingPrice), "payment failed");

        emit AuctionSettled(auctionId, winner, clearingPrice);
    }

    // --- Views ---

    function auctionCount() external view returns (uint256) {
        return auctions.length;
    }

    // --- Internal ---

    /// @notice Returns the cached extension ID, reverting if not set.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }

    function _getAuction(uint256 _auctionId) internal view returns (Auction storage) {
        require(_auctionId < auctions.length, "no such auction");
        return auctions[_auctionId];
    }

    /// @notice Route an AUCTION instruction to one randomly-assigned TEE.
    function _sendInstruction(bytes32 _opCommand, bytes memory _message) internal returns (bytes32) {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_AUCTION,
            opCommand: _opCommand,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    /// @notice EIP-191 personal-sign hash of a 32-byte digest.
    function _ethSigned(bytes32 _hash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _hash));
    }

    /// @notice Recover the signer of a 65-byte [r||s||v] secp256k1 signature.
    function _recover(bytes32 _digest, bytes calldata _sig) private pure returns (address) {
        require(_sig.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_sig.offset)
            s := calldataload(add(_sig.offset, 32))
            v := byte(0, calldataload(add(_sig.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "bad signature v");
        address signer = ecrecover(_digest, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
