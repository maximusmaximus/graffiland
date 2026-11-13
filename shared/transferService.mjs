import { ethers } from 'ethers';
import { serializeSculptureRow } from './sculpture.mjs';
import { buildTransferAuthMessage, ERC721_TRANSFER_ABI } from './transferMessage.mjs';

export { buildTransferAuthMessage, ERC721_TRANSFER_ABI };

class TransferError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export function normalizeEvmAddress(raw) {
  const val = String(raw || '').trim();
  if (!ethers.isAddress(val)) {
    throw new TransferError('Invalid destination EVM wallet address.', 400);
  }
  const checksummed = ethers.getAddress(val);
  if (checksummed === ethers.ZeroAddress) {
    throw new TransferError('Destination cannot be the zero address.', 400);
  }
  return checksummed;
}

export async function listSculptureTransfers(db, sculptureId) {
  const rows = await db.all(
    `SELECT id, sculpture_id, from_address, to_address, token_id, tx_hash, simulated, method, transferred_by_sub, created_at
     FROM sculpture_transfers
     WHERE sculpture_id = ?
     ORDER BY created_at DESC`,
    [sculptureId]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    sculptureId: r.sculpture_id,
    fromAddress: r.from_address,
    toAddress: r.to_address,
    tokenId: r.token_id,
    txHash: r.tx_hash,
    simulated: Boolean(r.simulated),
    method: r.method,
    createdAt: r.created_at
  }));
}

async function getHydratedSculptureRow(db, sculptureId) {
  return db.get(
    `SELECT s.*,
      (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
      (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
      (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue
     FROM sculptures s
     WHERE s.id = ?`,
    [sculptureId]
  );
}

function resolveChainRpc(chainCfg) {
  return chainCfg?.rpcUrl || chainCfg?.network?.rpcUrl || '';
}

function isLiveContractDeployed(sculpture, chainCfg) {
  const ready = Boolean(chainCfg?.liveChainReady ?? chainCfg?.liveReady);
  const rpcUrl = resolveChainRpc(chainCfg);
  return Boolean(
    ready &&
      rpcUrl &&
      sculpture &&
      !sculpture.simulated_chain &&
      sculpture.contract_address &&
      !/^0x0{40}$/i.test(sculpture.contract_address)
  );
}

export async function transferSculptureNft(
  db,
  { sculptureId, callerUser, toAddress, txHash, signature, decryptEmbeddedPrivateKey, chainCfg }
) {
  if (!callerUser) {
    throw new TransferError('Google sign-in required.', 401);
  }
  const dest = normalizeEvmAddress(toAddress);
  const sculpture = await getHydratedSculptureRow(db, sculptureId);
  if (!sculpture || (sculpture.hidden && !callerUser.is_admin)) {
    throw new TransferError('Sculpture not found.', 404);
  }

  const fromAddress = ethers.getAddress(sculpture.recipient_address);
  if (fromAddress.toLowerCase() === dest.toLowerCase()) {
    throw new TransferError('NFT is already owned by that destination address.', 400);
  }

  const live = isLiveContractDeployed(sculpture, chainCfg);
  const now = new Date().toISOString();
  let finalTxHash = String(txHash || '').trim();
  let simulated = !live;
  let method = 'embedded-simulated';

  if (finalTxHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(finalTxHash)) {
      throw new TransferError('Invalid transaction hash format.', 400);
    }
    if (!live) {
      throw new TransferError(
        'Transaction hash verification requires an active Robinhood Chain contract deployment.',
        400
      );
    }
    const provider = new ethers.JsonRpcProvider(resolveChainRpc(chainCfg), sculpture.chain_id);
    const receipt = await provider.getTransactionReceipt(finalTxHash);
    if (!receipt || receipt.status !== 1) {
      throw new TransferError('On-chain transfer receipt not confirmed yet.', 409);
    }
    const contract = new ethers.Contract(sculpture.contract_address, ERC721_TRANSFER_ABI, provider);
    const onChainOwner = ethers.getAddress(await contract.ownerOf(sculpture.token_id));
    if (onChainOwner.toLowerCase() !== dest.toLowerCase()) {
      throw new TransferError(
        `On-chain owner (${onChainOwner}) does not match destination (${dest}).`,
        400
      );
    }
    method = 'external-tx-verified';
    simulated = false;
  } else if (live) {
    const holdsEmbedded =
      callerUser.wallet_address &&
      callerUser.wallet_address.toLowerCase() === fromAddress.toLowerCase();
    if (!holdsEmbedded) {
      throw new TransferError(
        'This NFT is held by an external wallet. Execute safeTransferFrom from that wallet and submit its transaction hash.',
        403
      );
    }
    const privateKey = await decryptEmbeddedPrivateKey(callerUser);
    const provider = new ethers.JsonRpcProvider(resolveChainRpc(chainCfg), sculpture.chain_id);
    const signer = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(signer.address);
    if (balance === 0n) {
      throw new TransferError(
        'Your embedded wallet holds 0 native gas tokens on Robinhood Chain. Fund it or export your key into MetaMask to run safeTransferFrom directly.',
        409,
        {
          needsGas: true,
          walletAddress: signer.address,
          contractAddress: sculpture.contract_address,
          tokenId: sculpture.token_id,
          chainId: sculpture.chain_id
        }
      );
    }
    const contract = new ethers.Contract(sculpture.contract_address, ERC721_TRANSFER_ABI, signer);
    const tx = await contract['safeTransferFrom(address,address,uint256)'](
      fromAddress,
      dest,
      sculpture.token_id
    );
    const receipt = await tx.wait();
    finalTxHash = receipt.hash;
    method = 'embedded-onchain';
    simulated = false;
  } else {
    // Simulated / pre-mainnet mode: verify either Google-linked embedded wallet custody or EIP-191 external signature
    const holdsEmbedded =
      callerUser.wallet_address &&
      callerUser.wallet_address.toLowerCase() === fromAddress.toLowerCase();

    if (signature) {
      const msg = buildTransferAuthMessage({
        sculptureId,
        tokenId: sculpture.token_id,
        fromAddress,
        toAddress: dest,
        contractAddress: sculpture.contract_address,
        chainId: sculpture.chain_id
      });
      let recovered;
      try {
        recovered = ethers.verifyMessage(msg, signature);
      } catch {
        throw new TransferError('Invalid wallet signature.', 401);
      }
      if (recovered.toLowerCase() !== fromAddress.toLowerCase()) {
        throw new TransferError(
          `Signature belongs to ${recovered}, not current owner ${fromAddress}.`,
          403
        );
      }
      method = 'external-signed-sim';
    } else if (!holdsEmbedded) {
      throw new TransferError(
        `Only the current NFT owner (${fromAddress}) can authorize a transfer.`,
        403
      );
    }

    finalTxHash = ethers.keccak256(
      ethers.toUtf8Bytes(`transfer:${sculptureId}:${sculpture.token_id}:${fromAddress}:${dest}:${now}`)
    );
    simulated = true;
  }

  const transferId = globalThis.crypto.randomUUID();
  await db.run(
    `INSERT INTO sculpture_transfers (
      id, sculpture_id, from_address, to_address, token_id, tx_hash, simulated, method, transferred_by_sub, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transferId,
      sculptureId,
      fromAddress,
      dest,
      String(sculpture.token_id),
      finalTxHash,
      simulated ? 1 : 0,
      method,
      callerUser.id,
      now
    ]
  );

  await db.run('UPDATE sculptures SET recipient_address = ? WHERE id = ?', [dest, sculptureId]);

  const updated = await getHydratedSculptureRow(db, sculptureId);
  const transfers = await listSculptureTransfers(db, sculptureId);
  return {
    transfer: {
      id: transferId,
      sculptureId,
      fromAddress,
      toAddress: dest,
      tokenId: String(sculpture.token_id),
      txHash: finalTxHash,
      simulated,
      method,
      createdAt: now
    },
    sculpture: serializeSculptureRow(updated, {
      includeAdminFields: Boolean(callerUser.is_admin),
      includeVoxels: true,
      transfers
    })
  };
}

export async function syncSculptureOwnership(db, { sculptureId, chainCfg, callerUser = null }) {
  const sculpture = await getHydratedSculptureRow(db, sculptureId);
  if (!sculpture || (sculpture.hidden && !callerUser?.is_admin)) {
    throw new TransferError('Sculpture not found.', 404);
  }

  const currentRecorded = ethers.getAddress(sculpture.recipient_address);
  if (!isLiveContractDeployed(sculpture, chainCfg)) {
    const transfers = await listSculptureTransfers(db, sculptureId);
    return {
      synced: false,
      simulated: true,
      changed: false,
      ownerAddress: currentRecorded,
      transfers,
      sculpture: serializeSculptureRow(sculpture, {
        includeAdminFields: Boolean(callerUser?.is_admin),
        includeVoxels: true,
        transfers
      })
    };
  }

  const provider = new ethers.JsonRpcProvider(resolveChainRpc(chainCfg), sculpture.chain_id);
  const contract = new ethers.Contract(sculpture.contract_address, ERC721_TRANSFER_ABI, provider);
  const onChainOwner = ethers.getAddress(await contract.ownerOf(sculpture.token_id));
  let changed = false;

  if (onChainOwner.toLowerCase() !== currentRecorded.toLowerCase()) {
    changed = true;
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO sculpture_transfers (
        id, sculpture_id, from_address, to_address, token_id, tx_hash, simulated, method, transferred_by_sub, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'chain-sync', ?, ?)`,
      [
        globalThis.crypto.randomUUID(),
        sculptureId,
        currentRecorded,
        onChainOwner,
        String(sculpture.token_id),
        `sync:${sculpture.contract_address}:${sculpture.token_id}:${Date.now()}`,
        callerUser?.id || 'system-sync',
        now
      ]
    );
    await db.run('UPDATE sculptures SET recipient_address = ? WHERE id = ?', [
      onChainOwner,
      sculptureId
    ]);
  }

  const updated = await getHydratedSculptureRow(db, sculptureId);
  const transfers = await listSculptureTransfers(db, sculptureId);
  return {
    synced: true,
    simulated: false,
    changed,
    ownerAddress: onChainOwner,
    transfers,
    sculpture: serializeSculptureRow(updated, {
      includeAdminFields: Boolean(callerUser?.is_admin),
      includeVoxels: true,
      transfers
    })
  };
}
