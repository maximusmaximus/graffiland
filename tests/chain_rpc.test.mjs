import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ethers } from 'ethers';
import {
  extractTokenIdFromLogs,
  fetchReceiptFromBlockscoutExplorer,
  formatChainRpcError,
  isRpcRateLimitError,
  resolveRpcUrlCandidates,
  waitForTxReceiptResilient
} from '../shared/chainRpc.mjs';

const RAW_429_ETHERS_MSG =
  'exceeded maximum retry limit (request={ }, response={ }, error=null, info={ "requestUrl": "https://rpc.testnet.chain.robinhood.com", "responseBody": "{\\"jsonrpc\\":\\"2.0\\",\\"error\\":{\\"code\\":429,\\"message\\":\\"Rate Limit Hit, limit will reset in 60 seconds\\"}}", "responseStatus": "599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests; exceeded maximum retry limit)" }, code=SERVER_ERROR, version=6.17.0)';

const NFT_IFACE = new ethers.Interface([
  'event SculptureMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

describe('Resilient Robinhood Chain RPC & Receipt Handling (shared/chainRpc.mjs)', () => {
  test('resolveRpcUrlCandidates expands comma-separated RPCs and secondary Robinhood /rpc path', () => {
    assert.deepEqual(resolveRpcUrlCandidates('https://rpc.testnet.chain.robinhood.com'), [
      'https://rpc.testnet.chain.robinhood.com',
      'https://rpc.testnet.chain.robinhood.com/rpc'
    ]);
    assert.deepEqual(
      resolveRpcUrlCandidates('https://custom.rpc.example/v2/key, https://rpc.testnet.chain.robinhood.com'),
      [
        'https://custom.rpc.example/v2/key',
        'https://rpc.testnet.chain.robinhood.com',
        'https://rpc.testnet.chain.robinhood.com/rpc'
      ]
    );
  });

  test('formatChainRpcError turns raw ethers 429 JSON dumps into concise HTTP 503 RPC_RATE_LIMITED errors', () => {
    const rawErr = new Error(RAW_429_ETHERS_MSG);
    assert.equal(isRpcRateLimitError(rawErr), true);
    const formatted = formatChainRpcError(rawErr, 'Robinhood Chain Testnet');
    assert.equal(formatted.statusCode, 503);
    assert.equal(formatted.extra?.code, 'RPC_RATE_LIMITED');
    assert.equal(formatted.extra?.retryAfterSec, 60);
    assert.ok(formatted.message.includes('rate-limited (429)'));
    assert.ok(formatted.message.length < 130, `Expected concise error, got ${formatted.message.length} chars`);
  });

  test('waitForTxReceiptResilient falls back to Blockscout Explorer API when RPC hits 429 during receipt wait', async () => {
    const txHash = '0xa6ed393e5b075374606396050f6b89b325ee9185b240faa3cd4f049d09ccfd72';
    let rpcCalls = 0;
    const mockProvider = {
      getTransactionReceipt: async () => {
        rpcCalls += 1;
        throw new Error(RAW_429_ETHERS_MSG);
      }
    };
    const mockFetch = async (url) => {
      if (String(url).endsWith('/logs')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                topics: [
                  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                  '0x0000000000000000000000000000000000000000000000000000000000000000',
                  '0x00000000000000000000000066e681150eef6ac5aae1edc9edc5133ec38e0fe5',
                  '0x0000000000000000000000000000000000000000000000000000000000000016'
                ],
                data: '0x'
              }
            ]
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          hash: txHash,
          status: 'ok',
          from: { hash: '0x98dE28a74A9263A9ca58E4fff8Bc561a35205675' }
        })
      };
    };

    const res = await waitForTxReceiptResilient({
      provider: mockProvider,
      txHash,
      explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
      contractInterface: NFT_IFACE,
      initialDelayMs: 0,
      pollIntervalMs: 0,
      fetchFn: mockFetch,
      sleepFn: async () => {}
    });

    assert.equal(rpcCalls, 1, 'Should stop hammering rate-limited RPC immediately after first 429');
    assert.equal(res.confirmed, true);
    assert.equal(res.receiptPending, false);
    assert.equal(res.source, 'explorer');
    assert.equal(res.tokenId, '22');
    assert.equal(res.hash, txHash);
  });

  test('waitForTxReceiptResilient never discards an already-broadcast tx if both RPC and Explorer are unavailable', async () => {
    const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const res = await waitForTxReceiptResilient({
      provider: {
        getTransactionReceipt: async () => {
          throw new Error(RAW_429_ETHERS_MSG);
        }
      },
      txHash,
      explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
      contractInterface: NFT_IFACE,
      maxWaitMs: 5,
      initialDelayMs: 0,
      pollIntervalMs: 0,
      fetchFn: async () => ({ ok: false, status: 503 }),
      sleepFn: async () => {}
    });
    assert.equal(res.confirmed, false);
    assert.equal(res.receiptPending, true);
    assert.equal(res.hash, txHash);
    assert.equal(res.tokenId, '0');
  });

  test('waitForTxReceiptResilient throws cleanly on reverted on-chain transactions', async () => {
    const txHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
    await assert.rejects(
      () =>
        waitForTxReceiptResilient({
          provider: {
            getTransactionReceipt: async () => ({ status: 0, hash: txHash, logs: [] })
          },
          txHash,
          explorerUrl: '',
          initialDelayMs: 0,
          sleepFn: async () => {}
        }),
      /reverted/i
    );

    const expReverted = await fetchReceiptFromBlockscoutExplorer({
      explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
      txHash,
      fetchFn: async () => ({ ok: true, json: async () => ({ status: 'error', hash: txHash }) })
    });
    assert.equal(expReverted?.reverted, true);
  });

  test('extractTokenIdFromLogs supports Blockscout decoded logs and raw SculptureMinted/Transfer topics', () => {
    assert.equal(
      extractTokenIdFromLogs([
        { decoded: { parameters: [{ name: 'tokenId', value: '42' }] } }
      ]),
      '42'
    );
    assert.equal(
      extractTokenIdFromLogs([
        {
          topics: [
            '0x12c9ec7a1d125a1ca82558158573c715cba8260d417457476843bbb9da31e5a5',
            '0x0000000000000000000000000000000000000000000000000000000000000016'
          ]
        }
      ]),
      '22'
    );
  });
});
