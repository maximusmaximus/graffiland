import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { CONFIG, ROOT_DIR } from '../config.mjs';
import { getDb } from '../db.mjs';

let cachedAbi = null;

function loadContractAbi() {
  if (cachedAbi) return cachedAbi;
  const artifactPath = path.join(ROOT_DIR, 'contracts', 'build', 'GraffilandNFT.json');
  if (fs.existsSync(artifactPath)) {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    cachedAbi = parsed.abi;
    return cachedAbi;
  }
  cachedAbi = [
    'function mintSculpture(address recipient, string calldata metadataURI, bytes32 landParcelId, bytes32 proofOfLocationHash, int32 latE6, int32 lngE6) external returns (uint256)',
    'function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256)',
    'function RESALE_FEE_BPS() external view returns (uint96)',
    'event SculptureMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)'
  ];
  return cachedAbi;
}

export function getChainStatus() {
  const liveReady = Boolean(CONFIG.robinhoodContractAddress && CONFIG.robinhoodRelayerPrivateKey);
  let relayerAddress = '';
  if (CONFIG.robinhoodRelayerPrivateKey) {
    try {
      relayerAddress = new ethers.Wallet(CONFIG.robinhoodRelayerPrivateKey).address;
    } catch {
      relayerAddress = 'INVALID_KEY';
    }
  }
  const royaltyReceiver =
    CONFIG.robinhoodRoyaltyReceiver || relayerAddress || '0x000000000000000000000000000000000000dEaD';

  return {
    network: CONFIG.robinhoodNetwork,
    contractAddress: CONFIG.robinhoodContractAddress || '0x0000000000000000000000000000000000466300',
    liveReady,
    relayerAddress,
    royaltyReceiver,
    resaleFeeBps: CONFIG.resaleFeeBps,
    resaleFeePercent: CONFIG.resaleFeeBps / 100
  };
}

export async function mintOnRobinhoodChain({
  recipientAddress,
  metadataUri,
  parcelBytes32,
  proofHash,
  lat,
  lng
}) {
  const status = getChainStatus();
  const latE6 = Math.round(lat * 1e6);
  const lngE6 = Math.round(lng * 1e6);

  if (status.liveReady) {
    const provider = new ethers.JsonRpcProvider(
      status.network.rpcUrl,
      status.network.chainId
    );
    const relayer = new ethers.Wallet(CONFIG.robinhoodRelayerPrivateKey, provider);
    const contract = new ethers.Contract(
      CONFIG.robinhoodContractAddress,
      loadContractAbi(),
      relayer
    );

    const tx = await contract.mintSculpture(
      recipientAddress,
      metadataUri,
      parcelBytes32,
      proofHash,
      latE6,
      lngE6
    );
    const receipt = await tx.wait();

    let tokenId = '0';
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'SculptureMinted') {
          tokenId = parsed.args.tokenId.toString();
          break;
        }
      } catch {
        // non-matching log
      }
    }

    return {
      simulated: false,
      chainId: status.network.chainId,
      chainName: status.network.name,
      contractAddress: status.contractAddress,
      tokenId,
      txHash: receipt.hash,
      explorerTxUrl: `${status.network.explorerUrl}/tx/${receipt.hash}`,
      royaltyBps: CONFIG.resaleFeeBps,
      royaltyReceiver: status.royaltyReceiver,
      gasSponsoredBy: relayer.address
    };
  }

  // Deterministic simulated mint on Robinhood Chain until ROBINHOOD_CONTRACT_ADDRESS & relayer key are set
  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM sculptures').get();
  const nextTokenId = String((countRow?.c || 0) + 1);
  const txHash = ethers.keccak256(
    ethers.toUtf8Bytes(`${recipientAddress}|${metadataUri}|${proofHash}|${Date.now()}`)
  );

  return {
    simulated: true,
    chainId: status.network.chainId,
    chainName: `${status.network.name} (Simulated Relayer)`,
    contractAddress: status.contractAddress,
    tokenId: nextTokenId,
    txHash,
    explorerTxUrl: `${status.network.explorerUrl}/tx/${txHash}`,
    royaltyBps: CONFIG.resaleFeeBps,
    royaltyReceiver: status.royaltyReceiver,
    gasSponsoredBy: 'Platform Relayer (Simulated)'
  };
}
