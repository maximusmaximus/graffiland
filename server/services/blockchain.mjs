import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import {
  createLowNoiseJsonRpcProvider,
  extractTokenIdFromLogs,
  fetchReceiptFromBlockscoutExplorer,
  sendMintTxResilient,
  waitForTxReceiptResilient
} from '../../shared/chainRpc.mjs';
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
    'function updateTokenURI(uint256 tokenId, string calldata newURI) external',
    'function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256)',
    'function RESALE_FEE_BPS() external view returns (uint96)',
    'event SculptureMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)',
    'event MetadataUpdate(uint256 _tokenId)'
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
  lng,
  selfPaidGas = false,
  agentTxHash = ''
}) {
  const status = getChainStatus();
  const latE6 = Math.round(lat * 1e6);
  const lngE6 = Math.round(lng * 1e6);

  if (selfPaidGas) {
    const chainTxRequest = {
      method: 'mintAgentStage',
      contractAddress: status.contractAddress,
      chainId: status.network.chainId,
      network: status.network.name,
      from: recipientAddress,
      args: [metadataUri, parcelBytes32, proofHash, latE6, lngE6]
    };
    if (status.liveReady && agentTxHash && /^0x[0-9a-fA-F]{64}$/.test(agentTxHash)) {
      const iface = new ethers.Interface(loadContractAbi());
      let receipt = null;
      let tokenId = '0';
      let receiptFrom = '';
      try {
        const provider = createLowNoiseJsonRpcProvider(status.network.rpcUrl, status.network.chainId);
        receipt = await provider.getTransactionReceipt(agentTxHash);
        if (receipt) {
          receiptFrom = String(receipt.from || '');
          tokenId = extractTokenIdFromLogs(receipt.logs || [], iface);
        }
      } catch {
        receipt = null;
      }
      if (!receipt && status.network.explorerUrl) {
        const expReceipt = await fetchReceiptFromBlockscoutExplorer({
          explorerUrl: status.network.explorerUrl,
          txHash: agentTxHash,
          contractInterface: iface
        });
        if (expReceipt?.confirmed && !expReceipt.reverted) {
          receipt = { status: 1, hash: expReceipt.hash || agentTxHash };
          receiptFrom = String(expReceipt.from || '');
          tokenId = expReceipt.tokenId || '0';
        }
      }
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Agent self-paid gas tx ${agentTxHash} was not confirmed on chain.`);
      }
      if (receiptFrom && receiptFrom.toLowerCase() !== String(recipientAddress || '').toLowerCase()) {
        throw new Error(`Agent self-paid gas tx ${agentTxHash} was not sent from agent wallet ${recipientAddress}.`);
      }
      return {
        simulated: false,
        gasSponsored: false,
        gasPaidBy: 'agent',
        chainId: status.network.chainId,
        chainName: status.network.name,
        contractAddress: status.contractAddress,
        tokenId,
        txHash: receipt.hash,
        explorerTxUrl: `${status.network.explorerUrl}/tx/${receipt.hash}`,
        royaltyBps: CONFIG.resaleFeeBps,
        royaltyReceiver: status.royaltyReceiver,
        gasSponsoredBy: recipientAddress,
        chainTxRequest
      };
    }

    const db = getDb();
    const countRow = db.prepare('SELECT COUNT(*) AS c FROM sculptures').get();
    const nextTokenId = String((countRow?.c || 0) + 1);
    const txHash =
      agentTxHash && /^0x[0-9a-fA-F]{64}$/.test(agentTxHash)
        ? agentTxHash
        : ethers.keccak256(
            ethers.toUtf8Bytes(`agent-self-gas:${recipientAddress}|${metadataUri}|${proofHash}|${Date.now()}`)
          );
    return {
      simulated: true,
      gasSponsored: false,
      gasPaidBy: 'agent',
      chainId: status.network.chainId,
      chainName: `${status.network.name} (Agent Self-Paid Gas)`,
      contractAddress: status.contractAddress,
      tokenId: nextTokenId,
      txHash,
      explorerTxUrl: `${status.network.explorerUrl}/tx/${txHash}`,
      royaltyBps: CONFIG.resaleFeeBps,
      royaltyReceiver: status.royaltyReceiver,
      gasSponsoredBy: `Agent Wallet (${recipientAddress})`,
      chainTxRequest
    };
  }

  if (status.liveReady) {
    const minted = await sendMintTxResilient({
      rpcUrl: status.network.rpcUrl,
      chainId: status.network.chainId,
      networkName: status.network.name,
      explorerUrl: status.network.explorerUrl,
      privateKey: CONFIG.robinhoodRelayerPrivateKey,
      contractAddress: CONFIG.robinhoodContractAddress,
      abi: loadContractAbi(),
      args: [recipientAddress, metadataUri, parcelBytes32, proofHash, latE6, lngE6]
    });

    return {
      simulated: false,
      chainId: status.network.chainId,
      chainName: status.network.name,
      contractAddress: status.contractAddress,
      tokenId: minted.tokenId,
      txHash: minted.txHash,
      explorerTxUrl: `${status.network.explorerUrl}/tx/${minted.txHash}`,
      royaltyBps: CONFIG.resaleFeeBps,
      royaltyReceiver: status.royaltyReceiver,
      gasSponsoredBy: minted.relayerAddress || status.relayerAddress,
      ...(minted.receiptPending ? { receiptPending: true } : {})
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

export async function emitMetadataUpdateOnChain({ tokenId, metadataUri }) {
  const status = getChainStatus();
  if (status.liveReady && tokenId && /^\d+$/.test(String(tokenId))) {
    try {
      const provider = createLowNoiseJsonRpcProvider(
        status.network.rpcUrl,
        status.network.chainId
      );
      const relayer = new ethers.Wallet(CONFIG.robinhoodRelayerPrivateKey, provider);
      const contract = new ethers.Contract(
        status.contractAddress,
        loadContractAbi(),
        relayer
      );
      const tx = await contract.updateTokenURI(BigInt(tokenId), metadataUri);
      const receipt = await waitForTxReceiptResilient({
        provider,
        txHash: tx.hash,
        explorerUrl: status.network.explorerUrl,
        contractInterface: contract.interface,
        maxWaitMs: 8000
      });
      return {
        simulated: false,
        erc4906Emitted: true,
        txHash: receipt.hash || tx.hash
      };
    } catch {
      // Older deployed contract instances without updateTokenURI still serve dynamic /api/tokens/{id}.json
    }
  }
  return {
    simulated: true,
    erc4906Emitted: true,
    txHash: ethers.keccak256(
      ethers.toUtf8Bytes(`erc4906:${status.contractAddress}:${tokenId}:${metadataUri}:${Date.now()}`)
    )
  };
}
