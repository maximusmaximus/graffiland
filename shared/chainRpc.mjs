import { ethers } from 'ethers';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SCULPTURE_MINTED_TOPIC = '0x12c9ec7a1d125a1ca82558158573c715cba8260d417457476843bbb9da31e5a5';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveRpcUrlCandidates(rpcUrlSpec = '') {
  const parts = String(rpcUrlSpec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const url of parts) {
    if (!out.includes(url)) out.push(url);
    // Secondary Robinhood public path if primary root URL is specified
    if (/^https:\/\/rpc\.testnet\.chain\.robinhood\.com\/?$/i.test(url)) {
      const alt = 'https://rpc.testnet.chain.robinhood.com/rpc';
      if (!out.includes(alt)) out.push(alt);
    }
  }
  return out;
}

export function isRpcRateLimitError(err) {
  const text = `${err?.message || ''} ${err?.shortMessage || ''} ${JSON.stringify(err?.info || {})}`.toLowerCase();
  return (
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('599 client escalated') ||
    text.includes('exceeded maximum retry limit')
  );
}

export function formatChainRpcError(err, networkName = 'Robinhood Chain') {
  if (!err) return new Error(`${networkName} RPC error.`);
  if (isRpcRateLimitError(err)) {
    /** @type {any} */
    const clean = new Error(
      `${networkName} RPC is temporarily rate-limited (429). Please wait 30–60 seconds and try again.`
    );
    clean.statusCode = 503;
    clean.extra = { code: 'RPC_RATE_LIMITED', retryAfterSec: 60 };
    return clean;
  }
  const msg = String(err?.message || '');
  if (
    msg.includes('code=SERVER_ERROR') ||
    msg.includes('code=NETWORK_ERROR') ||
    msg.includes('code=TIMEOUT') ||
    msg.length > 260
  ) {
    const shortMsg = String(err?.shortMessage || err?.reason || '').trim();
    const summary =
      shortMsg && shortMsg.length <= 180
        ? `${networkName} RPC error: ${shortMsg}`
        : `${networkName} RPC is temporarily unavailable. Please retry in a moment.`;
    /** @type {any} */
    const clean = new Error(summary);
    clean.statusCode = 503;
    clean.extra = { code: 'RPC_UNAVAILABLE' };
    return clean;
  }
  return err;
}

export function createLowNoiseJsonRpcProvider(rpcUrl, chainId) {
  const req = new ethers.FetchRequest(rpcUrl);
  // Keep throttle retries small so a 60s RPC rate-limit window isn't hammered
  req.setThrottleParams({ maxAttempts: 3, slotInterval: 1000 });
  const network = ethers.Network.from(Number(chainId));
  return new ethers.JsonRpcProvider(req, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    pollingInterval: 2500
  });
}

export function extractTokenIdFromLogs(logs = [], contractInterface = null) {
  for (const log of logs || []) {
    if (contractInterface && Array.isArray(log?.topics) && log?.data !== undefined) {
      try {
        const parsed = contractInterface.parseLog({
          topics: log.topics.filter(Boolean),
          data: log.data || '0x'
        });
        if (parsed?.name === 'SculptureMinted' && parsed?.args?.tokenId !== undefined) {
          return parsed.args.tokenId.toString();
        }
        if (parsed?.name === 'Transfer' && parsed?.args?.tokenId !== undefined) {
          return parsed.args.tokenId.toString();
        }
      } catch {
        // try raw/decoded fallbacks
      }
    }
    // Blockscout decoded log shape
    if (Array.isArray(log?.decoded?.parameters)) {
      const tokParam = log.decoded.parameters.find((p) => p?.name === 'tokenId' && p?.value);
      if (tokParam && /^\d+$/.test(String(tokParam.value))) {
        return String(tokParam.value);
      }
    }
    const topics = Array.isArray(log?.topics) ? log.topics.filter(Boolean) : [];
    if (topics.length >= 2 && String(topics[0]).toLowerCase() === SCULPTURE_MINTED_TOPIC) {
      try {
        return BigInt(topics[1]).toString();
      } catch {
        // ignore
      }
    }
    if (topics.length >= 4 && String(topics[0]).toLowerCase() === TRANSFER_TOPIC) {
      try {
        return BigInt(topics[3]).toString();
      } catch {
        // ignore
      }
    }
  }
  return '0';
}

export async function fetchReceiptFromBlockscoutExplorer({
  explorerUrl = '',
  txHash = '',
  contractInterface = null,
  fetchFn = globalThis.fetch
}) {
  const base = String(explorerUrl || '').replace(/\/$/, '');
  if (!base || !txHash || typeof fetchFn !== 'function') return null;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
    try {
      const txRes = await fetchFn(`${base}/api/v2/transactions/${encodeURIComponent(txHash)}`, {
        headers: { Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!txRes.ok) return null;
      const txData = await txRes.json().catch(() => null);
      if (!txData) return null;
      const txStatus = String(txData.status || '').toLowerCase();
      const txResult = String(txData.result || '').toLowerCase();
      if (txStatus === 'error' || txResult.includes('revert')) {
        return {
          confirmed: true,
          reverted: true,
          hash: txData.hash || txHash,
          from: txData.from?.hash || '',
          tokenId: '0',
          source: 'explorer'
        };
      }
      if (txStatus !== 'ok' && txResult !== 'success') {
        return null;
      }
      let tokenId = '0';
      const logsRes = await fetchFn(
        `${base}/api/v2/transactions/${encodeURIComponent(txHash)}/logs`,
        {
          headers: { Accept: 'application/json' },
          ...(controller ? { signal: controller.signal } : {})
        }
      ).catch(() => null);
      if (logsRes && logsRes.ok) {
        const logsData = await logsRes.json().catch(() => null);
        tokenId = extractTokenIdFromLogs(logsData?.items || [], contractInterface);
      }
      return {
        confirmed: true,
        reverted: false,
        hash: txData.hash || txHash,
        from: txData.from?.hash || '',
        tokenId,
        source: 'explorer'
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function waitForTxReceiptResilient({
  provider,
  txHash,
  explorerUrl = '',
  contractInterface = null,
  maxWaitMs = 15000,
  initialDelayMs = 1200,
  pollIntervalMs = 2000,
  fetchFn = globalThis.fetch,
  sleepFn = defaultSleep
}) {
  const startedAt = Date.now();
  let rpcRateLimited = false;

  if (initialDelayMs > 0) {
    await sleepFn(initialDelayMs);
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!rpcRateLimited && provider && typeof provider.getTransactionReceipt === 'function') {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
          if (receipt.status === 0) {
            throw new Error(`On-chain transaction ${txHash} reverted.`);
          }
          const tokenId = extractTokenIdFromLogs(receipt.logs || [], contractInterface);
          return {
            confirmed: true,
            receiptPending: false,
            hash: receipt.hash || txHash,
            from: receipt.from || '',
            tokenId,
            source: 'rpc'
          };
        }
      } catch (err) {
        if (String(err?.message || '').includes('reverted')) throw err;
        if (isRpcRateLimitError(err)) {
          // Stop hitting the rate-limited RPC and switch immediately to Blockscout Explorer API
          rpcRateLimited = true;
        }
      }
    }

    // Fallback to Blockscout Explorer API whenever RPC is rate-limited or hasn't returned a receipt yet
    if (explorerUrl && (rpcRateLimited || attempt >= 1)) {
      const explorerReceipt = await fetchReceiptFromBlockscoutExplorer({
        explorerUrl,
        txHash,
        contractInterface,
        fetchFn
      });
      if (explorerReceipt?.reverted) {
        throw new Error(`On-chain transaction ${txHash} reverted.`);
      }
      if (explorerReceipt?.confirmed) {
        return {
          confirmed: true,
          receiptPending: false,
          hash: explorerReceipt.hash || txHash,
          from: explorerReceipt.from || '',
          tokenId: explorerReceipt.tokenId || '0',
          source: 'explorer'
        };
      }
    }

    if (Date.now() - startedAt >= maxWaitMs) break;
    await sleepFn(pollIntervalMs);
  }

  // Never discard an already-broadcast on-chain transaction when receipt lookup is rate-limited
  return {
    confirmed: false,
    receiptPending: true,
    hash: txHash,
    from: '',
    tokenId: '0',
    source: 'pending'
  };
}

export async function sendMintTxResilient({
  rpcUrl,
  chainId,
  networkName = 'Robinhood Chain',
  explorerUrl = '',
  privateKey,
  contractAddress,
  abi,
  args = [],
  fetchFn = globalThis.fetch,
  sleepFn = defaultSleep,
  providerFactory = createLowNoiseJsonRpcProvider
}) {
  const candidates = resolveRpcUrlCandidates(rpcUrl);
  if (candidates.length === 0) {
    throw new Error(`No RPC URL configured for ${networkName}.`);
  }

  let broadcastTx = null;
  let activeProvider = null;
  let activeContract = null;
  let relayerAddress = '';
  let lastErr = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidateUrl = candidates[i];
    try {
      const provider = providerFactory(candidateUrl, chainId);
      const relayer = new ethers.Wallet(privateKey, provider);
      relayerAddress = relayer.address;
      const contract = new ethers.Contract(contractAddress, abi, relayer);
      const tx = await contract.mintSculpture(...args);
      broadcastTx = tx;
      activeProvider = provider;
      activeContract = contract;
      break;
    } catch (err) {
      lastErr = err;
      if (isRpcRateLimitError(err) && i + 1 < candidates.length) {
        await sleepFn(1200);
        continue;
      }
      // Single gentle retry on the final candidate if hit by transient pre-broadcast 429
      if (isRpcRateLimitError(err) && i + 1 === candidates.length) {
        await sleepFn(2000);
        try {
          const provider = providerFactory(candidateUrl, chainId);
          const relayer = new ethers.Wallet(privateKey, provider);
          relayerAddress = relayer.address;
          const contract = new ethers.Contract(contractAddress, abi, relayer);
          const tx = await contract.mintSculpture(...args);
          broadcastTx = tx;
          activeProvider = provider;
          activeContract = contract;
          lastErr = null;
          break;
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
      break;
    }
  }

  if (!broadcastTx?.hash) {
    throw formatChainRpcError(lastErr, networkName);
  }

  const receiptInfo = await waitForTxReceiptResilient({
    provider: activeProvider,
    txHash: broadcastTx.hash,
    explorerUrl,
    contractInterface: activeContract?.interface || new ethers.Interface(abi),
    fetchFn,
    sleepFn
  });

  return {
    txHash: receiptInfo.hash || broadcastTx.hash,
    tokenId: receiptInfo.tokenId || '0',
    receiptPending: Boolean(receiptInfo.receiptPending),
    receiptSource: receiptInfo.source,
    relayerAddress
  };
}
