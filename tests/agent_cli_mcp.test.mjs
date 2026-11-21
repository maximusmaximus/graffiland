import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { ethers } from 'ethers';

const execFileAsync = promisify(execFile);

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-cli-mcp-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'cli-mcp.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');

let server;
let baseUrl;
const stdioWallet = ethers.Wallet.createRandom();

before(async () => {
  const { server: srv } = createAppServer({ publishRateLimit: 100, mcpRateLimit: 300 });
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup lock
  }
});

describe('GRAFFILAND Stdio MCP Server, CLI & Agent Discovery', () => {
  test('Discovery endpoints /llms.txt and /.well-known/agent.json advertise 5%/3%/2% & stdio MCP', async () => {
    const llmsRes = await fetch(`${baseUrl}/llms.txt`);
    assert.equal(llmsRes.status, 200);
    const llmsText = await llmsRes.text();
    assert.ok(llmsText.includes('GRAFFILAND'));
    assert.ok(llmsText.includes('5% (500 bps)'));
    assert.ok(llmsText.includes('3% (300 bps)'));
    assert.ok(llmsText.includes('2% (200 bps)'));
    assert.ok(llmsText.includes('graffiland-mcp'));
    assert.ok(llmsText.includes('validate_3d_model_url'));
    assert.ok(llmsText.includes('get_parcel_share_link'));

    const cardRes = await fetch(`${baseUrl}/.well-known/agent.json`);
    assert.equal(cardRes.status, 200);
    const card = await cardRes.json();
    assert.equal(card.name, 'GRAFFILAND Protocol');
    assert.equal(card.economics.platformBps, 500);
    assert.equal(card.economics.agentStewardBps, 300);
    assert.equal(card.economics.humanContributorBps, 200);
    assert.ok(card.capabilities.mcpToolsCount >= 22);
    assert.ok(card.endpoints.validateModelUrl.endsWith('/api/models/validate-url'));
    assert.equal(card.stdioMcp.args[0], 'graffiland-mcp');
  });

  test('Local stdio bin/graffiland-mcp.mjs executes autonomous initialize -> scout -> claim -> batch_build -> telemetry', async () => {
    const child = spawn(process.execPath, ['bin/graffiland-mcp.mjs'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        GRAFFILAND_API_URL: baseUrl,
        GRAFFILAND_PRIVATE_KEY: stdioWallet.privateKey,
        GRAFFILAND_AGENT_NAME: 'Stdio Bot 9000'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    });

    let nextId = 1;
    function sendRpc(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout waiting for stdio MCP response id=${id} (${method})`));
        }, 10000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    try {
      const init = await sendRpc('initialize', {});
      assert.equal(init.result.protocolVersion, '2025-03-26');
      assert.equal(init.result.serverInfo.name, 'graffiland-mcp');

      const tools = await sendRpc('tools/list', {});
      const names = tools.result.tools.map((t) => t.name);
      for (const expected of [
        'agent_profile',
        'scout_lands',
        'claim_land',
        'generate_voxel_prefab',
        'batch_build_land',
        'create_art_quest',
        'get_land_telemetry',
        'validate_3d_model_url',
        'update_land_volume',
        'update_land_settings',
        'set_sculpture_visibility',
        'get_parcel_share_link'
      ]) {
        assert.ok(names.includes(expected), `${expected} registered in stdio MCP tools/list`);
      }

      const scout = await sendRpc('tools/call', {
        name: 'scout_lands',
        arguments: { lat: 40.7128, lng: -74.006, statusFilter: 'unclaimed' }
      });
      const candidateParcel = scout.result.structuredContent.parcels[0].parcelId;
      assert.ok(candidateParcel.startsWith('GLAND-'));

      const claim = await sendRpc('tools/call', {
        name: 'claim_land',
        arguments: { parcelId: candidateParcel, customName: 'SoHo Cyber Plinth' }
      });
      assert.equal(claim.result.structuredContent.claimed, true);
      assert.equal(claim.result.structuredContent.status, 'dormant');

      const batch = await sendRpc('tools/call', {
        name: 'batch_build_land',
        arguments: {
          parcelId: candidateParcel,
          items: [{ prefab: 'totem', title: 'NYC Steward Totem', accentColor: '#ffd166' }],
          quest: {
            title: 'SoHo Hologram Challenge',
            prompt: 'Place a glowing gold or neon voxel sculpture near our totem.',
            bountyEth: 0.25
          }
        }
      });
      assert.equal(batch.result.structuredContent.builtCount, 1);
      assert.equal(batch.result.structuredContent.quest.bountyEth, 0.25);

      const telem = await sendRpc('tools/call', {
        name: 'get_land_telemetry',
        arguments: { parcelId: candidateParcel }
      });
      assert.equal(telem.result.structuredContent.steward.status, 'dormant');
      assert.equal(telem.result.structuredContent.layers.stewardStageCount, 1);

      const share = await sendRpc('tools/call', {
        name: 'get_parcel_share_link',
        arguments: { parcelId: candidateParcel }
      });
      assert.equal(share.result.structuredContent.parcelId, candidateParcel);
      assert.equal(share.result.structuredContent.slug, 'soho-cyber-plinth');
      assert.ok(share.result.structuredContent.shareUrl.includes('slug=soho-cyber-plinth'));
      assert.ok(share.result.structuredContent.directionsUrl.includes('google.com/maps/dir'));
    } finally {
      rl.close();
      child.kill();
    }
  });

  test('CLI bin/graffiland.mjs executes prefab, scout, and parcel telemetry commands', async () => {
    const prefabOut = await execFileAsync(process.execPath, [
      'bin/graffiland.mjs',
      'prefab',
      '--type',
      'beacon',
      '--accent',
      '#00f5d4'
    ]);
    const prefabJson = JSON.parse(prefabOut.stdout);
    assert.equal(prefabJson.prefab, 'beacon');
    assert.ok(Array.isArray(prefabJson.voxels) && prefabJson.voxels.length >= 3);

    const scoutOut = await execFileAsync(
      process.execPath,
      ['bin/graffiland.mjs', 'scout', '--lat', '40.7128', '--lng', '-74.006', '--status', 'all'],
      { env: { ...process.env, GRAFFILAND_API_URL: baseUrl } }
    );
    const scoutJson = JSON.parse(scoutOut.stdout);
    assert.ok(scoutJson.parcels.some((p) => p.status === 'dormant'));

    const parcelOut = await execFileAsync(
      process.execPath,
      ['bin/graffiland.mjs', 'parcel', 'soho-cyber-plinth'],
      { env: { ...process.env, GRAFFILAND_API_URL: baseUrl } }
    );
    const parcelJson = JSON.parse(parcelOut.stdout);
    assert.equal(parcelJson.parcel.customName, 'SoHo Cyber Plinth');
    assert.ok(parcelJson.shareUrl.includes('slug=soho-cyber-plinth'));
  });
});
