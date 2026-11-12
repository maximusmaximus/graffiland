// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GraffilandNFT
 * @notice Location-anchored 3D graffiti sculptures & Virtual Land deeds on Robinhood Chain.
 *         Enforces ERC-2981 secondary resale royalty fixed at 5% (500 bps).
 */
contract GraffilandNFT is ERC721, ERC721URIStorage, ERC721Royalty, Ownable {
    uint96 public constant RESALE_FEE_BPS = 500; // 5.00%

    uint256 private _nextTokenId = 1;
    address public relayer;
    address public defaultRoyaltyReceiver;

    struct VirtualLandRecord {
        bytes32 landParcelId;
        bytes32 proofOfLocationHash;
        int32 latE6;
        int32 lngE6;
        address creator;
        uint64 mintedAt;
    }

    mapping(uint256 => VirtualLandRecord) public landRecords;
    mapping(bytes32 => uint256[]) private _parcelTokens;

    event SculptureMinted(
        uint256 indexed tokenId,
        address indexed recipient,
        bytes32 indexed landParcelId,
        bytes32 proofOfLocationHash,
        string tokenURI,
        int32 latE6,
        int32 lngE6
    );
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event RoyaltyReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);

    modifier onlyRelayerOrOwner() {
        require(msg.sender == relayer || msg.sender == owner(), "GraffilandNFT: unauthorized minter");
        _;
    }

    constructor(
        address initialOwner,
        address initialRelayer,
        address royaltyReceiver
    ) ERC721("GRAFFILAND 3D", "GLAND") Ownable(initialOwner) {
        require(royaltyReceiver != address(0), "GraffilandNFT: zero royalty receiver");
        relayer = initialRelayer == address(0) ? initialOwner : initialRelayer;
        defaultRoyaltyReceiver = royaltyReceiver;
        _setDefaultRoyalty(royaltyReceiver, RESALE_FEE_BPS);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "GraffilandNFT: zero relayer");
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function setDefaultRoyaltyReceiver(address newReceiver) external onlyOwner {
        require(newReceiver != address(0), "GraffilandNFT: zero receiver");
        emit RoyaltyReceiverUpdated(defaultRoyaltyReceiver, newReceiver);
        defaultRoyaltyReceiver = newReceiver;
        _setDefaultRoyalty(newReceiver, RESALE_FEE_BPS);
    }

    /**
     * @notice Gas-sponsored mint called by the platform relayer; transfers ownership immediately to `recipient`.
     */
    function mintSculpture(
        address recipient,
        string calldata metadataURI,
        bytes32 landParcelId,
        bytes32 proofOfLocationHash,
        int32 latE6,
        int32 lngE6
    ) external onlyRelayerOrOwner returns (uint256 tokenId) {
        require(recipient != address(0), "GraffilandNFT: zero recipient");
        require(bytes(metadataURI).length > 0, "GraffilandNFT: empty URI");
        require(landParcelId != bytes32(0), "GraffilandNFT: invalid parcel");
        require(proofOfLocationHash != bytes32(0), "GraffilandNFT: missing proof");

        tokenId = _nextTokenId++;
        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, metadataURI);
        _setTokenRoyalty(tokenId, defaultRoyaltyReceiver, RESALE_FEE_BPS);

        landRecords[tokenId] = VirtualLandRecord({
            landParcelId: landParcelId,
            proofOfLocationHash: proofOfLocationHash,
            latE6: latE6,
            lngE6: lngE6,
            creator: recipient,
            mintedAt: uint64(block.timestamp)
        });
        _parcelTokens[landParcelId].push(tokenId);

        emit SculptureMinted(
            tokenId,
            recipient,
            landParcelId,
            proofOfLocationHash,
            metadataURI,
            latE6,
            lngE6
        );
    }

    function getParcelTokens(bytes32 landParcelId) external view returns (uint256[] memory) {
        return _parcelTokens[landParcelId];
    }

    function totalSupply() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage, ERC721Royalty)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
