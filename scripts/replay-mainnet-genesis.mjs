#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { ROBINHOOD_NETWORKS } from '../shared/constants.mjs';
import {
  buildMainnetRemapSql,
  evaluateMainnetReadiness,
  verifySnapshotIntegrity
} from '../shared/mainnetSnapshot.mjs';

const NFT_GENESIS_ABI = [
  'function mintSculpture(address recipient, string calldata metadataURI, bytes32 landParcelId, bytes32 proofOfLocationHash, int32 latE6, int32 lngE6) external returns (uint256)',
  'function activateLandByHuman(bytes32 landParcelId, address firstHumanArtist, bytes32 proofOfLocationHash) external',
  'event SculptureMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)'
];

function parseArgs(argv) {
  const args = {
    snapshot: path.resolve('snapshots/mainnet-genesis-latest.json'),
    stateFile: path.resolve('snapshots/mainnet-replay-state.json'),
    remapSqlOut: path.resolve('snapshots/mainnet-db-remap.sql'),
    dryRun: true,
    execute: false,
    confirmChain4663: false,
    limit: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--snapshot' && argv[i + 1]) args.snapshot = path.resolve(argv[++i]);
    else if (a === '--state' && argv[i + 1]) args.stateFile = path.resolve(argv[++i]);
    else if (a === '--remap-sql' && argv[i + 1]) args.remapSqlOut = path.resolve(argv[++i]);
    else if (a === '--dry-run') {
      args.dryRun = true;
      args.execute = false;
    } else if (a === '--execute') {
      args.execute = true;
      args.dryRun = false;
    } else if (a === '--confirm-mainnet-chain-4663') {
      args.confirmChain4663 = true;
    } else if (a === '--limit' && argv[i + 1]) {
      args.limit = Math.max(0, Number(argv[++i]) || 0);
    }
  }
  return args;
}

function loadReplayState(stateFile, snapshotSha256, contractAddress) {
  if (fs.existsSync(stateFile)) {
    const existing = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (existing.manifestSha256 && existing.manifestSha256 !== snapshotSha256) {
      throw new Error(
        `Replay state manifestSha256 (${existing.manifestSha256}) does not match snapshot (${snapshotSha256}). Use a fresh --state file.`
      );
    }
    return existing;
  }
  return {
    manifestSha256: snapshotSha256,
    contractAddress: contractAddress || '',
    chainId: ROBINHOOD_NETWORKS.mainnet.chainId,
    mintedBySculptureId: {},
    awakenedParcels: {},
    updatedAt: new Date().toISOString()
  };
}

function saveReplayState(stateFile, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.snapshot)) {
    throw new Error(`Snapshot file not found: ${args.snapshot}. Run "npm run snapshot:testnet" first.`);
  }

  const snapshot = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'));
  const integrity = await verifySnapshotIntegrity(snapshot);
  if (!integrity.valid) {
    throw new Error(`Snapshot integrity check FAILED: ${integrity.reason}`);
  }

  const readiness = evaluateMainnetReadiness(snapshot);
  const eligibleParcels = (snapshot.parcels || []).filter((p) => p.includedForGenesis);
  const eligibleSculptures = eligibleParcels.flatMap((p) => p.sculptures || []);

  console.log(`[mainnet-replay] Verified snapshot SHA-256: ${integrity.manifestSha256}`);
  console.log(
    `[mainnet-replay] Eligible parcels: ${eligibleParcels.length} | Eligible sculptures: ${eligibleSculptures.length}`
  );
  if (!readiness.readyForMainnetGenesis) {
    console.error('[mainnet-replay] Readiness blockers found:');
    for (const b of readiness.blockers) console.error(`  - ${b}`);
    process.exit(1);
  }
  if (readiness.warnings.length > 0) {
    console.log(`[mainnet-replay] Warnings (${readiness.warnings.length}):`);
    for (const w of readiness.warnings) console.log(`  - ${w}`);
  }

  const contractAddress = String(process.env.ROBINHOOD_CONTRACT_ADDRESS || '').trim();
  const net = ROBINHOOD_NETWORKS.mainnet;
  const rpcUrl = process.env.ROBINHOOD_MAINNET_RPC || net.rpcUrl;
  const state = loadReplayState(args.stateFile, integrity.manifestSha256, contractAddress);

  const pendingSculptures = eligibleSculptures.filter((s) => !state.mintedBySculptureId[s.sculptureId]);
  const planned = args.limit > 0 ? pendingSculptures.slice(0, args.limit) : pendingSculptures;

  if (args.dryRun) {
    console.log(`\n[mainnet-replay] DRY RUN — Target: ${net.name} (chainId ${net.chainId}, RPC ${rpcUrl})`);
    console.log(`[mainnet-replay] Contract: ${contractAddress || '<NOT DEPLOYED YET>'}`);
    console.log(
      `[mainnet-replay] Already replayed: ${Object.keys(state.mintedBySculptureId).length} | Remaining to mint: ${planned.length}`
    );
    console.log(
      `[mainnet-replay] Estimated gas units: ${readiness.metrics.estimatedGasUnits.toLocaleString()} | Recommended ETH buffer: >= ${readiness.metrics.recommendedRelayerEthBuffer} ETH\n`
    );
    for (const [idx, s] of planned.entries()) {
      console.log(
        `  ${String(idx + 1).padStart(2, ' ')}. mintSculpture(${s.recipientAddress}, "${s.metadataUri}", ${s.landParcelBytes32.slice(0, 14)}…, ${s.proofHash.slice(0, 14)}…, ${s.latE6}, ${s.lngE6})  // ${s.parcelId} · "${s.title}" (${s.artistHandle || 'artist'})`
      );
    }
    console.log(
      '\n[mainnet-replay] Dry run complete. Zero transactions sent. To execute on mainnet:\n' +
        '  ROBINHOOD_NETWORK=mainnet ROBINHOOD_CONTRACT_ADDRESS=0x... ROBINHOOD_RELAYER_PRIVATE_KEY=0x... \\\n' +
        '  node scripts/replay-mainnet-genesis.mjs --execute --confirm-mainnet-chain-4663'
    );
    return;
  }

  // Live Mainnet Execution Guards
  if (!args.confirmChain4663) {
    throw new Error('Refusing to broadcast Mainnet txs without --confirm-mainnet-chain-4663 flag.');
  }
  if ((process.env.ROBINHOOD_NETWORK || '').toLowerCase() !== 'mainnet') {
    throw new Error('Set ROBINHOOD_NETWORK=mainnet explicitly before running --execute.');
  }
  if (!ethers.isAddress(contractAddress)) {
    throw new Error('Valid ROBINHOOD_CONTRACT_ADDRESS is required for --execute.');
  }
  const relayerKey = String(process.env.ROBINHOOD_RELAYER_PRIVATE_KEY || '').trim();
  if (!relayerKey) {
    throw new Error('ROBINHOOD_RELAYER_PRIVATE_KEY is required for --execute.');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, net.chainId);
  const actualNet = await provider.getNetwork();
  if (Number(actualNet.chainId) !== net.chainId) {
    throw new Error(`RPC chainId mismatch: expected ${net.chainId}, got ${actualNet.chainId}`);
  }

  const wallet = new ethers.Wallet(relayerKey, provider);
  const balWei = await provider.getBalance(wallet.address);
  console.log(
    `[mainnet-replay] Connected to ${net.name} (${net.chainId}) as relayer ${wallet.address} (balance: ${ethers.formatEther(balWei)} ETH)`
  );
  if (balWei === 0n) {
    throw new Error(`Relayer wallet ${wallet.address} has 0 ETH on Robinhood Chain Mainnet.`);
  }

  const contract = new ethers.Contract(contractAddress, NFT_GENESIS_ABI, wallet);
  const iface = new ethers.Interface(NFT_GENESIS_ABI);
  state.contractAddress = contractAddress;

  for (const [idx, s] of planned.entries()) {
    console.log(
      `[mainnet-replay] (${idx + 1}/${planned.length}) Minting "${s.title}" (${s.sculptureId}) -> ${s.recipientAddress} on ${s.parcelId}...`
    );
    const tx = await contract.mintSculpture(
      s.recipientAddress,
      s.metadataUri,
      s.landParcelBytes32,
      s.proofHash,
      s.latE6,
      s.lngE6
    );
    const receipt = await tx.wait(1);
    let tokenId = '';
    for (const log of receipt.logs || []) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'SculptureMinted') {
          tokenId = parsed.args.tokenId.toString();
          break;
        }
      } catch {
        // ignore non-matching logs
      }
    }
    state.mintedBySculptureId[s.sculptureId] = {
      sculptureId: s.sculptureId,
      parcelId: s.parcelId,
      recipientAddress: s.recipientAddress,
      testnetTokenId: s.testnet?.tokenId || '',
      mainnetTokenId: tokenId,
      mainnetTxHash: receipt.hash,
      blockNumber: Number(receipt.blockNumber || 0),
      mintedAt: new Date().toISOString()
    };
    saveReplayState(args.stateFile, state);
    console.log(`  ✓ Minted token #${tokenId || '?'} in tx ${receipt.hash}`);
  }

  // Generate idempotent D1 SQL remap script for seamless cutover
  const mintedRecords = Object.values(state.mintedBySculptureId);
  const sqlText = buildMainnetRemapSql({
    contractAddress,
    chainId: net.chainId,
    chainName: net.name,
    mintedRecords
  });
  fs.writeFileSync(args.remapSqlOut, sqlText, 'utf8');
  console.log(`[mainnet-replay] Wrote D1 remap SQL (${mintedRecords.length} rows): ${args.remapSqlOut}`);
}

main().catch((err) => {
  console.error('[mainnet-replay] Error:', err?.message || err);
  process.exit(1);
});
