// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRoyaltyRouter {
    function computeFeeSplit(uint256 grossAmount)
        external
        pure
        returns (
            uint256 sellerNet,
            uint256 totalFee,
            uint256 platformFee,
            uint256 agentFee,
            uint256 humanFee
        );

    function depositParcelFee(bytes32 parcelId, address fallbackSteward) external payable;
}

/**
 * @title GraffilandMarketplace
 * @notice Built-in non-custodial escrow Marketplace & Art Quest Bounty Settlement on Robinhood Chain.
 *         Guarantees deterministic 5% Platform + 3% Agent Steward + 2% Human Contributor fees
 *         on every NFT purchase and Quest Bounty payout via GraffilandRoyaltyRouter.
 */
contract GraffilandMarketplace is Ownable, ReentrancyGuard {
    IERC721 public immutable graffilandNft;
    IRoyaltyRouter public immutable royaltyRouter;
    address public relayer;

    struct Listing {
        uint256 tokenId;
        bytes32 parcelId;
        address seller;
        uint256 priceWei;
        bool active;
    }

    struct QuestBounty {
        bytes32 parcelId;
        address sponsor;
        uint256 remainingWei;
        uint256 payoutPerWinnerWei;
        bool active;
    }

    uint256 public nextListingId = 1;
    uint256 public nextBountyId = 1;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => QuestBounty) public bounties;
    mapping(address => uint256) public pendingSellerProceeds;

    event ListingCreated(
        uint256 indexed listingId,
        uint256 indexed tokenId,
        bytes32 indexed parcelId,
        address seller,
        uint256 priceWei
    );
    event ListingCancelled(uint256 indexed listingId);
    event SculptureSold(
        uint256 indexed listingId,
        uint256 indexed tokenId,
        bytes32 indexed parcelId,
        address buyer,
        uint256 grossPriceWei,
        uint256 sellerNetWei,
        uint256 totalFeeWei
    );
    event QuestBountyFunded(
        uint256 indexed bountyId,
        bytes32 indexed parcelId,
        address indexed sponsor,
        uint256 totalWei,
        uint256 payoutPerWinnerWei
    );
    event QuestBountyPaid(
        uint256 indexed bountyId,
        bytes32 indexed parcelId,
        address indexed winner,
        uint256 grossWei,
        uint256 winnerNetWei,
        uint256 totalFeeWei,
        bytes32 polHash
    );
    event SellerProceedsWithdrawn(address indexed seller, uint256 amount);

    modifier onlyRelayerOrOwner() {
        require(msg.sender == relayer || msg.sender == owner(), "Marketplace: unauthorized");
        _;
    }

    constructor(
        address initialOwner,
        address initialRelayer,
        address nftAddress,
        address routerAddress
    ) Ownable(initialOwner) {
        require(nftAddress != address(0), "Marketplace: zero nft");
        require(routerAddress != address(0), "Marketplace: zero router");
        graffilandNft = IERC721(nftAddress);
        royaltyRouter = IRoyaltyRouter(routerAddress);
        relayer = initialRelayer == address(0) ? initialOwner : initialRelayer;
    }

    function listSculpture(uint256 tokenId, bytes32 parcelId, uint256 priceWei) external returns (uint256 listingId) {
        require(priceWei > 0, "Marketplace: zero price");
        require(parcelId != bytes32(0), "Marketplace: invalid parcel");
        require(graffilandNft.ownerOf(tokenId) == msg.sender, "Marketplace: not token owner");
        require(
            graffilandNft.getApproved(tokenId) == address(this) ||
                graffilandNft.isApprovedForAll(msg.sender, address(this)),
            "Marketplace: approve marketplace first"
        );

        listingId = nextListingId++;
        listings[listingId] = Listing({
            tokenId: tokenId,
            parcelId: parcelId,
            seller: msg.sender,
            priceWei: priceWei,
            active: true
        });
        emit ListingCreated(listingId, tokenId, parcelId, msg.sender, priceWei);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "Marketplace: inactive listing");
        require(l.seller == msg.sender || msg.sender == owner(), "Marketplace: not seller");
        l.active = false;
        emit ListingCancelled(listingId);
    }

    function buySculpture(uint256 listingId) external payable nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "Marketplace: inactive listing");
        require(msg.value == l.priceWei, "Marketplace: exact price required");
        require(graffilandNft.ownerOf(l.tokenId) == l.seller, "Marketplace: seller no longer owns token");

        l.active = false;

        (uint256 sellerNet, uint256 totalFee, , , ) = royaltyRouter.computeFeeSplit(msg.value);

        royaltyRouter.depositParcelFee{value: totalFee}(l.parcelId, l.seller);
        graffilandNft.safeTransferFrom(l.seller, msg.sender, l.tokenId);

        (bool sent, ) = payable(l.seller).call{value: sellerNet}("");
        if (!sent) {
            pendingSellerProceeds[l.seller] += sellerNet;
        }

        emit SculptureSold(listingId, l.tokenId, l.parcelId, msg.sender, msg.value, sellerNet, totalFee);
    }

    function fundQuestBounty(bytes32 parcelId, uint256 payoutPerWinnerWei)
        external
        payable
        returns (uint256 bountyId)
    {
        require(parcelId != bytes32(0), "Marketplace: invalid parcel");
        require(msg.value > 0 && payoutPerWinnerWei > 0 && payoutPerWinnerWei <= msg.value, "Marketplace: bad amount");

        bountyId = nextBountyId++;
        bounties[bountyId] = QuestBounty({
            parcelId: parcelId,
            sponsor: msg.sender,
            remainingWei: msg.value,
            payoutPerWinnerWei: payoutPerWinnerWei,
            active: true
        });
        emit QuestBountyFunded(bountyId, parcelId, msg.sender, msg.value, payoutPerWinnerWei);
    }

    function settleQuestBounty(
        uint256 bountyId,
        address humanWinner,
        bytes32 polHash
    ) external onlyRelayerOrOwner nonReentrant {
        QuestBounty storage b = bounties[bountyId];
        require(b.active && b.remainingWei >= b.payoutPerWinnerWei, "Marketplace: bounty exhausted");
        require(humanWinner != address(0), "Marketplace: zero winner");
        require(polHash != bytes32(0), "Marketplace: missing PoL hash");

        uint256 gross = b.payoutPerWinnerWei;
        b.remainingWei -= gross;
        if (b.remainingWei < b.payoutPerWinnerWei) {
            b.active = false;
        }

        (uint256 winnerNet, uint256 totalFee, , , ) = royaltyRouter.computeFeeSplit(gross);
        royaltyRouter.depositParcelFee{value: totalFee}(b.parcelId, b.sponsor);

        (bool sent, ) = payable(humanWinner).call{value: winnerNet}("");
        if (!sent) {
            pendingSellerProceeds[humanWinner] += winnerNet;
        }

        emit QuestBountyPaid(bountyId, b.parcelId, humanWinner, gross, winnerNet, totalFee, polHash);
    }

    function withdrawSellerProceeds() external nonReentrant {
        uint256 amt = pendingSellerProceeds[msg.sender];
        require(amt > 0, "Marketplace: no proceeds");
        pendingSellerProceeds[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amt}("");
        require(ok, "Marketplace: withdraw failed");
        emit SellerProceedsWithdrawn(msg.sender, amt);
    }
}
