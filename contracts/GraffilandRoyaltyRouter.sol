// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GraffilandRoyaltyRouter
 * @notice Collects and deterministically splits transaction fees on every GRAFFILAND trade, quest payout,
 *         and secondary sale:
 *         - 5% (500 bps) Platform Treasury
 *         - 3% (300 bps) Agent Land Steward
 *         - 2% (200 bps) Human IRL Contributors (shared pro-rata across qualified parcel artists)
 *         Uses pull-payment vaults so malformed recipient contracts cannot DoS settlements.
 */
contract GraffilandRoyaltyRouter is Ownable, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PLATFORM_BPS = 500; // 5%
    uint256 public constant AGENT_STEWARD_BPS = 300; // 3%
    uint256 public constant HUMAN_POOL_BPS = 200; // 2%
    uint256 public constant TOTAL_FEE_BPS = PLATFORM_BPS + AGENT_STEWARD_BPS + HUMAN_POOL_BPS; // 10%

    address public platformTreasury;
    address public relayer;

    struct ParcelPool {
        address steward;
        address[] contributors;
        uint16[] weightsBps; // sums to 10_000
    }

    mapping(bytes32 => ParcelPool) private _pools;
    mapping(address => uint256) public pendingWithdrawals;

    event ParcelPoolUpdated(bytes32 indexed parcelId, address indexed steward, uint256 contributorCount);
    event FeeDistributed(
        bytes32 indexed parcelId,
        uint256 totalFee,
        uint256 platformAmount,
        uint256 stewardAmount,
        uint256 humanPoolAmount
    );
    event Withdrawn(address indexed beneficiary, uint256 amount);
    event PlatformTreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);

    modifier onlyRelayerOrOwner() {
        require(msg.sender == relayer || msg.sender == owner(), "RoyaltyRouter: unauthorized");
        _;
    }

    constructor(address initialOwner, address initialRelayer, address initialTreasury) Ownable(initialOwner) {
        require(initialTreasury != address(0), "RoyaltyRouter: zero treasury");
        platformTreasury = initialTreasury;
        relayer = initialRelayer == address(0) ? initialOwner : initialRelayer;
    }

    function setPlatformTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "RoyaltyRouter: zero treasury");
        emit PlatformTreasuryUpdated(platformTreasury, newTreasury);
        platformTreasury = newTreasury;
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "RoyaltyRouter: zero relayer");
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function computeFeeSplit(uint256 grossAmount)
        public
        pure
        returns (
            uint256 sellerNet,
            uint256 totalFee,
            uint256 platformFee,
            uint256 agentFee,
            uint256 humanFee
        )
    {
        platformFee = (grossAmount * PLATFORM_BPS) / BPS_DENOMINATOR;
        agentFee = (grossAmount * AGENT_STEWARD_BPS) / BPS_DENOMINATOR;
        humanFee = (grossAmount * HUMAN_POOL_BPS) / BPS_DENOMINATOR;
        totalFee = platformFee + agentFee + humanFee;
        sellerNet = grossAmount - totalFee;
    }

    function setParcelParticipants(
        bytes32 parcelId,
        address steward,
        address[] calldata contributors,
        uint16[] calldata weightsBps
    ) external onlyRelayerOrOwner {
        require(parcelId != bytes32(0), "RoyaltyRouter: invalid parcel");
        require(contributors.length == weightsBps.length, "RoyaltyRouter: length mismatch");

        if (contributors.length > 0) {
            uint256 sum = 0;
            for (uint256 i = 0; i < contributors.length; i++) {
                require(contributors[i] != address(0), "RoyaltyRouter: zero contributor");
                sum += weightsBps[i];
            }
            require(sum == BPS_DENOMINATOR, "RoyaltyRouter: weights must equal 10000");
        }

        ParcelPool storage pool = _pools[parcelId];
        pool.steward = steward;
        pool.contributors = contributors;
        pool.weightsBps = weightsBps;

        emit ParcelPoolUpdated(parcelId, steward, contributors.length);
    }

    function getParcelParticipants(bytes32 parcelId)
        external
        view
        returns (address steward, address[] memory contributors, uint16[] memory weightsBps)
    {
        ParcelPool storage pool = _pools[parcelId];
        return (pool.steward, pool.contributors, pool.weightsBps);
    }

    /**
     * @notice Accepts the 10% total fee (`msg.value`) and allocates 50% (5% of tx) to Platform,
     *         30% (3% of tx) to Agent Steward, and 20% (2% of tx) pro-rata across Human Contributors.
     */
    function depositParcelFee(bytes32 parcelId, address fallbackSteward) external payable nonReentrant {
        require(msg.value > 0, "RoyaltyRouter: zero fee");
        _allocateFee(parcelId, fallbackSteward, msg.value);
    }

    receive() external payable {
        pendingWithdrawals[platformTreasury] += msg.value;
    }

    function _allocateFee(bytes32 parcelId, address fallbackSteward, uint256 totalFee) internal {
        uint256 platformAmount = (totalFee * PLATFORM_BPS) / TOTAL_FEE_BPS;
        uint256 agentAmount = (totalFee * AGENT_STEWARD_BPS) / TOTAL_FEE_BPS;
        uint256 humanPoolAmount = totalFee - platformAmount - agentAmount;

        pendingWithdrawals[platformTreasury] += platformAmount;

        ParcelPool storage pool = _pools[parcelId];
        address stewardAddr = pool.steward != address(0)
            ? pool.steward
            : (fallbackSteward != address(0) ? fallbackSteward : platformTreasury);
        pendingWithdrawals[stewardAddr] += agentAmount;

        uint256 cLen = pool.contributors.length;
        if (cLen == 0) {
            pendingWithdrawals[platformTreasury] += humanPoolAmount;
        } else {
            uint256 allocated = 0;
            for (uint256 i = 0; i < cLen; i++) {
                uint256 share = (i == cLen - 1)
                    ? (humanPoolAmount - allocated)
                    : (humanPoolAmount * pool.weightsBps[i]) / BPS_DENOMINATOR;
                allocated += share;
                pendingWithdrawals[pool.contributors[i]] += share;
            }
        }

        emit FeeDistributed(parcelId, totalFee, platformAmount, agentAmount, humanPoolAmount);
    }

    function withdraw() external nonReentrant {
        uint256 amt = pendingWithdrawals[msg.sender];
        require(amt > 0, "RoyaltyRouter: nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amt}("");
        require(ok, "RoyaltyRouter: transfer failed");
        emit Withdrawn(msg.sender, amt);
    }
}
