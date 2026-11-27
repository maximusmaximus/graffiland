// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GraffilandLandDeed
 * @notice Dedicated ERC-721 collection for permanent, awakened SPRAY.LAND Virtual Land Deeds
 *         on Robinhood Chain. Separate from individual 3D Artwork NFTs (GraffilandNFT) so
 *         land ownership, curation control, and the 3% Land Steward royalty stream can transfer
 *         cleanly between humans and autonomous AI agents while collaborative artworks remain
 *         owned by their respective creators/collectors.
 */
contract GraffilandLandDeed is ERC721, ERC721Enumerable, ERC721URIStorage, ERC721Royalty, Ownable {
    uint96 public constant RESALE_FEE_BPS = 500; // 5.00% Platform base fee
    uint96 public constant AGENT_STEWARD_FEE_BPS = 300; // 3.00% Land Steward fee
    uint96 public constant HUMAN_CONTRIBUTOR_FEE_BPS = 200; // 2.00% Human Contributor pool
    uint96 public constant TOTAL_TX_FEE_BPS = 1000; // 10.00% Combined split via GraffilandRoyaltyRouter

    uint256 private _nextTokenId = 1;
    address public relayer;
    address public defaultRoyaltyReceiver;
    address public royaltyRouter;
    string private _contractMetadataURI =
        "https://graffiland-api.maxinfeld-artshow.workers.dev/api/contract/land-deeds.json";

    struct LandDeedRecord {
        bytes32 landParcelId;
        bytes32 proofOfLocationHash;
        int32 latE6;
        int32 lngE6;
        address originalSteward;
        uint64 mintedAt;
    }

    mapping(uint256 => LandDeedRecord) public deedRecords;
    mapping(bytes32 => uint256) public parcelTokenId;

    event LandDeedMinted(
        uint256 indexed tokenId,
        address indexed recipient,
        bytes32 indexed landParcelId,
        bytes32 proofOfLocationHash,
        string tokenURI,
        int32 latE6,
        int32 lngE6
    );
    event LandDeedTransferred(
        uint256 indexed tokenId,
        bytes32 indexed landParcelId,
        address indexed from,
        address to
    );
    event RoyaltyRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event RoyaltyReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);
    event ContractURIUpdated();

    modifier onlyRelayerOrOwner() {
        require(msg.sender == relayer || msg.sender == owner(), "GraffilandLandDeed: unauthorized minter");
        _;
    }

    constructor(
        address initialOwner,
        address initialRelayer,
        address royaltyReceiver
    ) ERC721("SPRAY.LAND Virtual Land Deeds", "SLAND") Ownable(initialOwner) {
        require(royaltyReceiver != address(0), "GraffilandLandDeed: zero royalty receiver");
        relayer = initialRelayer == address(0) ? initialOwner : initialRelayer;
        defaultRoyaltyReceiver = royaltyReceiver;
        _setDefaultRoyalty(royaltyReceiver, RESALE_FEE_BPS);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "GraffilandLandDeed: zero relayer");
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function setDefaultRoyaltyReceiver(address newReceiver) external onlyOwner {
        require(newReceiver != address(0), "GraffilandLandDeed: zero receiver");
        emit RoyaltyReceiverUpdated(defaultRoyaltyReceiver, newReceiver);
        defaultRoyaltyReceiver = newReceiver;
        _setDefaultRoyalty(newReceiver, RESALE_FEE_BPS);
    }

    function setRoyaltyRouter(address newRouter) external onlyOwner {
        emit RoyaltyRouterUpdated(royaltyRouter, newRouter);
        royaltyRouter = newRouter;
    }

    function contractURI() external view returns (string memory) {
        return _contractMetadataURI;
    }

    function setContractURI(string calldata newContractURI) external onlyOwner {
        _contractMetadataURI = newContractURI;
        emit ContractURIUpdated();
    }

    /**
     * @notice Mints the unique ERC-721 Land Deed NFT for a permanent / awakened parcel.
     *         Enforces strictly one deed token per `landParcelId`.
     */
    function mintLandDeed(
        address recipient,
        bytes32 landParcelId,
        string calldata metadataURI,
        bytes32 proofOfLocationHash,
        int32 latE6,
        int32 lngE6
    ) external onlyRelayerOrOwner returns (uint256 tokenId) {
        require(recipient != address(0), "GraffilandLandDeed: zero recipient");
        require(landParcelId != bytes32(0), "GraffilandLandDeed: invalid parcel");
        require(parcelTokenId[landParcelId] == 0, "GraffilandLandDeed: parcel already minted");
        require(bytes(metadataURI).length > 0, "GraffilandLandDeed: empty URI");
        require(proofOfLocationHash != bytes32(0), "GraffilandLandDeed: missing proof");

        tokenId = _nextTokenId++;
        parcelTokenId[landParcelId] = tokenId;
        deedRecords[tokenId] = LandDeedRecord({
            landParcelId: landParcelId,
            proofOfLocationHash: proofOfLocationHash,
            latE6: latE6,
            lngE6: lngE6,
            originalSteward: recipient,
            mintedAt: uint64(block.timestamp)
        });

        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, metadataURI);

        if (royaltyRouter != address(0)) {
            _setTokenRoyalty(tokenId, royaltyRouter, TOTAL_TX_FEE_BPS);
        } else {
            _setTokenRoyalty(tokenId, defaultRoyaltyReceiver, RESALE_FEE_BPS);
        }

        emit LandDeedMinted(
            tokenId,
            recipient,
            landParcelId,
            proofOfLocationHash,
            metadataURI,
            latE6,
            lngE6
        );
    }

    /**
     * @notice Updates a Land Deed's metadata URI (e.g. after renaming or curating art), emitting ERC-4906 MetadataUpdate.
     */
    function updateLandURI(uint256 tokenId, string calldata newURI) external {
        address tokenOwner = ownerOf(tokenId);
        require(
            msg.sender == tokenOwner || msg.sender == relayer || msg.sender == owner(),
            "GraffilandLandDeed: unauthorized metadata updater"
        );
        require(bytes(newURI).length > 0, "GraffilandLandDeed: empty URI");
        _setTokenURI(tokenId, newURI);
    }

    function ownerOfParcel(bytes32 landParcelId) external view returns (address) {
        uint256 tokenId = parcelTokenId[landParcelId];
        if (tokenId == 0) return address(0);
        return _ownerOf(tokenId);
    }

    function tokensOfOwner(address ownerAddr) external view returns (uint256[] memory tokenIds) {
        uint256 count = balanceOf(ownerAddr);
        tokenIds = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            tokenIds[i] = tokenOfOwnerByIndex(ownerAddr, i);
        }
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        address previousOwner = super._update(to, tokenId, auth);
        if (previousOwner != address(0) && to != address(0)) {
            bytes32 parcelId = deedRecords[tokenId].landParcelId;
            if (parcelId != bytes32(0)) {
                emit LandDeedTransferred(tokenId, parcelId, previousOwner, to);
            }
        }
        return previousOwner;
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
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
        override(ERC721, ERC721Enumerable, ERC721URIStorage, ERC721Royalty)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
