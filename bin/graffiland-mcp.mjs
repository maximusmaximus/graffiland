#!/usr/bin/env node
import readline from 'node:readline';
import { ethers } from 'ethers';
import { MCP_TOOLS } from '../shared/mcp/toolSchemas.mjs';

const API_URL = String(
  process.env.GRAFFILAND_API_URL || 'https://graffiland-api.maxinfeld-artshow.workers.dev'
).replace(/\/$/, '');
const PRIVATE_KEY = String(process.env.GRAFFILAND_PRIVATE_KEY || '').trim();
const PAIRING_CODE = String(process.env.GRAFFILAND_PAIRING_CODE || '').trim();
const AGENT_NAME = String(process.env.GRAFFILAND_AGENT_NAME || 'graffiland-mcp-agent').trim();
const AGENT_FRAMEWORK = String(process.env.GRAFFILAND_AGENT_FRAMEWORK || 'mcp-stdio').trim();

const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY) : null;
let cachedToken = String(process.env.GRAFFILAND_AGENT_TOKEN || '').trim();
let authPromise = null;

function writeResponse(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function ensureAgentAuthToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken) return cachedToken;
  if (!wallet) return cachedToken || '';
  if (!forceRefresh && authPromise) return authPromise;

  authPromise = (async () => {
    const chalRes = await fetch(`${API_URL}/api/agents/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: wallet.address })
    });
    const chal = await chalRes.json().catch(() => ({}));
    if (!chalRes.ok || !chal.message || !chal.nonce) {
      throw new Error(chal.error || `Challenge HTTP ${chalRes.status}`);
    }
    const signature = await wallet.signMessage(chal.message);
    const regRes = await fetch(`${API_URL}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: wallet.address,
        nonce: chal.nonce,
        signature,
        name: AGENT_NAME,
        framework: AGENT_FRAMEWORK
      })
    });
    const reg = await regRes.json().catch(() => ({}));
    if (!regRes.ok || !reg.token) {
      throw new Error(reg.error || `Agent register HTTP ${regRes.status}`);
    }
    cachedToken = reg.token;
    return cachedToken;
  })().finally(() => {
    authPromise = null;
  });

  return authPromise;
}

async function callRemoteMcp(rpcPayload, retried = false) {
  const token = await ensureAgentAuthToken(retried);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (PAIRING_CODE) headers['X-Graffiland-Pairing-Code'] = PAIRING_CODE;

  const res = await fetch(`${API_URL}/api/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcPayload)
  });

  if (res.status === 401 && wallet && !retried) {
    cachedToken = '';
    return callRemoteMcp(rpcPayload, true);
  }

  const data = await res.json().catch(() => ({
    jsonrpc: '2.0',
    id: rpcPayload.id ?? null,
    error: { code: -32000, message: `Upstream HTTP ${res.status}` }
  }));
  return data;
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications without an id do not expect a JSON-RPC reply
  if (id === undefined || id === null) {
    if (method && method !== 'notifications/initialized') {
      process.stderr.write(`[graffiland-mcp] notification: ${method}\n`);
    }
    return;
  }

  try {
    if (method === 'initialize') {
      if (wallet && !cachedToken) {
        await ensureAgentAuthToken().catch((err) => {
          process.stderr.write(`[graffiland-mcp] auth warmup deferred: ${err.message}\n`);
        });
      }
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'graffiland-mcp', version: '1.0.0' },
          capabilities: { tools: {} }
        }
      });
      return;
    }

    if (method === 'ping') {
      writeResponse({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      });
      return;
    }

    if (method === 'tools/call') {
      const rpcRes = await callRemoteMcp({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: params || {}
      });
      writeResponse({
        jsonrpc: '2.0',
        id,
        ...(rpcRes.error ? { error: rpcRes.error } : { result: rpcRes.result })
      });
      return;
    }

    writeResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  } catch (err) {
    writeResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err?.message || 'Internal MCP stdio error' }
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    handleRpcMessage(parsed);
  } catch (err) {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` }
    });
  }
});
