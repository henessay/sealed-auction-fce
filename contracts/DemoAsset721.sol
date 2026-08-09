// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal ERC-721 receiver hook, checked on safeTransferFrom.
interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title DemoAsset721
/// @notice A deliberately small ERC-721 used as the demo lot ("tokenized
/// asset") in SealedAuction. Minting is owner-only; metadata is a single
/// static URI shared by every token — this stands in for a real RWA or NFT
/// contract, it is not one.
/// @dev Implements the ERC-721 core plus `safeTransferFrom`. No enumeration,
/// no per-token URIs, no royalties.
contract DemoAsset721 {
    string public name = "SealedAuction Demo Asset";
    string public symbol = "SADEMO";

    /// @notice Static metadata for every token id.
    string public constant TOKEN_URI =
        "data:application/json,%7B%22name%22%3A%22SealedAuction%20Demo%20Asset%22%2C%22description%22%3A%22Demo%20lot%20for%20the%20Flare%20sealed-bid%20auction%22%7D";

    address public owner;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    uint256 public nextTokenId = 1;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @notice Mint the next token id to `to`. Owner only.
    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        require(to != address(0), "zero recipient");
        tokenId = nextTokenId++;
        _owners[tokenId] = to;
        _balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC-165 and ERC-721.
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_owners[tokenId] != address(0), "no such token");
        return TOKEN_URI;
    }

    function balanceOf(address account) external view returns (uint256) {
        require(account != address(0), "zero address");
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address holder = _owners[tokenId];
        require(holder != address(0), "no such token");
        return holder;
    }

    function approve(address to, uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        require(msg.sender == holder || _operatorApprovals[holder][msg.sender], "not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_owners[tokenId] != address(0), "no such token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address holder, address operator) external view returns (bool) {
        return _operatorApprovals[holder][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf(tokenId) == from, "wrong from");
        require(to != address(0), "zero recipient");
        require(
            msg.sender == from
                || _tokenApprovals[tokenId] == msg.sender
                || _operatorApprovals[from][msg.sender],
            "not authorized"
        );

        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            bytes4 retval = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            require(retval == IERC721Receiver.onERC721Received.selector, "unsafe recipient");
        }
    }
}
