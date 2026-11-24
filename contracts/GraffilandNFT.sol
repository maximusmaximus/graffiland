// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GraffilandNFT
 * @notice Location-anchored 3D sculptures & Agentic-First Virtual Land Deeds on Robinhood Chain.
 *         Supports standard ERC-721 transfers, ERC-721 Enumerable, ERC-4906 metadata updates,
 *         EIP-7572 collection contractURI, dormant agent land leases, and ERC-2981 royalty splits:
 *         5% Platform + 3% Agent Steward + 2% Human Contributors (10% total via GraffilandRoyaltyRouter).
 */
contract GraffilandNFT is ERC721, ERC721Enumerable, ERC721URIStorage, ERC721Royalty, Ownable {
    uint96 public constant RESALE_FEE_BPS = 500; // 5.00% Platform base fee
    uint96 public constant AGENT_STEWARD_FEE_BPS = 300; // 3.00% Agent Steward fee
    uint96 public constant HUMAN_CONTRIBUTOR_FEE_BPS = 200; // 2.00% Human Contributor pool
    uint96 public constant TOTAL_TX_FEE_BPS = 1000; // 10.00% Combined split across Platform + Agent + Human

    uint256 private _nextTokenId = 1;
    address public relayer;
    address public defaultRoyaltyReceiver;
    address public royaltyRouter;
    string private _contractMetadataURI = "https://graffiland-api.maxinfeld-artshow.workers.dev/api/contract/metadata.json";

    struct VirtualLandRecord {
        bytes32 landParcelId;
        bytes32 proofOfLocationHash;
        int32 latE6;
        int32 lngE6;
        address creator;
        uint64 mintedAt;
    }

    struct LandLease {
        address steward;
        int32 latE6;
        int32 lngE6;
        uint64 claimedAt;
        uint64 expiresAt;
        uint64 awakenedAt;
        address awakenedBy;
        bool exists;
        bool awakened;
    }

    mapping(uint256 => VirtualLandRecord) public landRecords;
    mapping(bytes32 => uint256[]) private _parcelTokens;
    mapping(bytes32 => LandLease) public landLeases;

    /// @notice Max simultaneous dormant (unawakened) leases a steward can hold when self-claiming.
    uint256 public maxDormantLeasesPerSteward = 3;
    mapping(address => uint256) public activeDormantLeases;

    event SculptureMinted(
        uint256 indexed tokenId,
        address indexed recipient,
        bytes32 indexed landParcelId,
        bytes32 proofOfLocationHash,
        string tokenURI,
        int32 latE6,
        int32 lngE6
    );
    event DormantLandClaimed(
        bytes32 indexed landParcelId,
        address indexed steward,
        int32 latE6,
        int32 lngE6,
        uint64 expiresAt
    );
    event LandAwakened(
        bytes32 indexed landParcelId,
        address indexed steward,
        address indexed firstHumanArtist,
        bytes32 proofOfLocationHash
    );
    event DormantLandReleased(bytes32 indexed landParcelId, address indexed previousSteward);
    event RoyaltyRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event RoyaltyReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);
    event ContractURIUpdated();
    event MaxDormantLeasesUpdated(uint256 previousMax, uint256 newMax);

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

    function setRoyaltyRouter(address newRouter) external onlyOwner {
        emit RoyaltyRouterUpdated(royaltyRouter, newRouter);
        royaltyRouter = newRouter;
    }

    function setMaxDormantLeasesPerSteward(uint256 newMax) external onlyOwner {
        require(newMax > 0, "GraffilandNFT: zero max leases");
        emit MaxDormantLeasesUpdated(maxDormantLeasesPerSteward, newMax);
        maxDormantLeasesPerSteward = newMax;
    }

    function _releaseDormantSlot(address steward) private {
        if (activeDormantLeases[steward] > 0) {
            activeDormantLeases[steward] -= 1;
        }
    }

    function contractURI() external view returns (string memory) {
        return _contractMetadataURI;
    }

    function setContractURI(string calldata newContractURI) external onlyOwner {
        _contractMetadataURI = newContractURI;
        emit ContractURIUpdated();
    }

    /**
     * @notice Allows autonomous agents (paying their own gas) or relayer to claim an unoccupied parcel
     *         with a Dormant Lease TTL. Unawakened parcels release after `expiresAt`.
     */
    function claimDormantLand(
        bytes32 landParcelId,
        address steward,
        int32 latE6,
        int32 lngE6,
        uint64 ttlSeconds
    ) external {
        require(
            msg.sender == steward || msg.sender == relayer || msg.sender == owner(),
            "GraffilandNFT: unauthorized steward claim"
        );
        require(landParcelId != bytes32(0), "GraffilandNFT: invalid parcel");
        require(steward != address(0), "GraffilandNFT: zero steward");
        require(ttlSeconds >= 1 hours && ttlSeconds <= 30 days, "GraffilandNFT: invalid TTL");

        LandLease storage existing = landLeases[landParcelId];
        if (existing.exists) {
            require(!existing.awakened && block.timestamp > existing.expiresAt, "GraffilandNFT: parcel active");
            // Do NOT reopen the previous steward's consumed slot when a lease expires without a human visitor.
            emit DormantLandReleased(landParcelId, existing.steward);
        }

        // Self-claims are capped per steward so one wallet cannot squat unlimited parcels.
        // The relayer/owner path is gated off-chain by the API's slot accounting.
        if (msg.sender == steward && msg.sender != relayer && msg.sender != owner()) {
            require(
                activeDormantLeases[steward] < maxDormantLeasesPerSteward,
                "GraffilandNFT: dormant lease limit"
            );
        }
        activeDormantLeases[steward] += 1;

        uint64 expiresAt = uint64(block.timestamp) + ttlSeconds;
        landLeases[landParcelId] = LandLease({
            steward: steward,
            latE6: latE6,
            lngE6: lngE6,
            claimedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            awakenedAt: 0,
            awakenedBy: address(0),
            exists: true,
            awakened: false
        });

        emit DormantLandClaimed(landParcelId, steward, latE6, lngE6, expiresAt);
    }

    /**
     * @notice Permanently awakens a dormant parcel when a verified IRL human places artwork on it.
     */
    function activateLandByHuman(
        bytes32 landParcelId,
        address firstHumanArtist,
        bytes32 proofOfLocationHash
    ) external onlyRelayerOrOwner {
        require(firstHumanArtist != address(0), "GraffilandNFT: zero human artist");
        require(proofOfLocationHash != bytes32(0), "GraffilandNFT: missing proof");
        LandLease storage lease = landLeases[landParcelId];
        require(lease.exists, "GraffilandNFT: parcel not leased");
        require(!lease.awakened, "GraffilandNFT: already awakened");
        require(block.timestamp <= lease.expiresAt, "GraffilandNFT: lease expired");

        lease.awakened = true;
        lease.awakenedAt = uint64(block.timestamp);
        lease.awakenedBy = firstHumanArtist;
        _releaseDormantSlot(lease.steward);

        emit LandAwakened(landParcelId, lease.steward, firstHumanArtist, proofOfLocationHash);
    }

    function releaseExpiredLand(bytes32 landParcelId) external {
        LandLease storage lease = landLeases[landParcelId];
        require(lease.exists && !lease.awakened, "GraffilandNFT: not dormant");
        require(block.timestamp > lease.expiresAt, "GraffilandNFT: lease still active");
        address prev = lease.steward;
        // Free mint slots do NOT reopen when a dormant land expires without a human user.
        delete landLeases[landParcelId];
        emit DormantLandReleased(landParcelId, prev);
    }

    /**
     * @notice Self-funded stage/sculpture mint called directly by an AI agent steward (agent pays own gas).
     */
    function mintAgentStage(
        string calldata metadataURI,
        bytes32 landParcelId,
        bytes32 proofOfLocationHash,
        int32 latE6,
        int32 lngE6
    ) external returns (uint256 tokenId) {
        // Only the parcel's current steward may self-mint onto it; otherwise anyone could attach
        // unlimited tokens (and fake proof hashes) to any parcel, bloating getParcelTokens().
        LandLease storage lease = landLeases[landParcelId];
        require(lease.exists && lease.steward == msg.sender, "GraffilandNFT: not parcel steward");
        require(lease.awakened || block.timestamp <= lease.expiresAt, "GraffilandNFT: lease expired");
        return _mintSculptureInternal(msg.sender, metadataURI, landParcelId, proofOfLocationHash, latE6, lngE6);
    }

    /**
     * @notice Gas-sponsored mint called by platform relayer for IRL human artists; transfers ERC-721 custody immediately to `recipient`.
     *         Routes ERC-2981 10% total royalties (5% Platform + 3% Agent + 2% Human) through `royaltyRouter` when set.
     */
    function mintSculpture(
        address recipient,
        string calldata metadataURI,
        bytes32 landParcelId,
        bytes32 proofOfLocationHash,
        int32 latE6,
        int32 lngE6
    ) external onlyRelayerOrOwner returns (uint256 tokenId) {
        return _mintSculptureInternal(recipient, metadataURI, landParcelId, proofOfLocationHash, latE6, lngE6);
    }

    function _mintSculptureInternal(
        address recipient,
        string calldata metadataURI,
        bytes32 landParcelId,
        bytes32 proofOfLocationHash,
        int32 latE6,
        int32 lngE6
    ) internal returns (uint256 tokenId) {
        require(recipient != address(0), "GraffilandNFT: zero recipient");
        require(bytes(metadataURI).length > 0, "GraffilandNFT: empty URI");
        require(landParcelId != bytes32(0), "GraffilandNFT: invalid parcel");
        require(proofOfLocationHash != bytes32(0), "GraffilandNFT: missing proof");

        tokenId = _nextTokenId++;
        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, metadataURI);

        if (royaltyRouter != address(0)) {
            _setTokenRoyalty(tokenId, royaltyRouter, TOTAL_TX_FEE_BPS);
        } else {
            _setTokenRoyalty(tokenId, defaultRoyaltyReceiver, RESALE_FEE_BPS);
        }

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

    /**
     * @notice Updates tokenURI after an owner/contributor revision or rollback, emitting ERC-4906 MetadataUpdate.
     *         Owners can pay their own gas directly, or the relayer may submit for mobile humans.
     */
    function updateTokenURI(uint256 tokenId, string calldata newURI) external {
        address tokenOwner = ownerOf(tokenId);
        require(
            msg.sender == tokenOwner || msg.sender == relayer || msg.sender == owner(),
            "GraffilandNFT: unauthorized metadata updater"
        );
        require(bytes(newURI).length > 0, "GraffilandNFT: empty URI");
        _setTokenURI(tokenId, newURI);
    }

    function getParcelTokens(bytes32 landParcelId) external view returns (uint256[] memory) {
        return _parcelTokens[landParcelId];
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
        return super._update(to, tokenId, auth);
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
