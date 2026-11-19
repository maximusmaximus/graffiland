import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ethers } from 'ethers';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const hasChrome = fs.existsSync(CHROME_PATH);
const hasDist = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));

describe('GRAFFILAND Desktop Browser E2E (Playwright)', { skip: !hasChrome || !hasDist }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-e2e-'));
  let srv;
  let baseUrl;
  let browser;
  let seededSculptureId = '';

  before(async () => {
    process.env.GRAFFILAND_DB_PATH = path.join(tmpDir, 'e2e.sqlite');
    process.env.GRAFFILAND_IPFS_DIR = path.join(tmpDir, 'ipfs');
    process.env.PINATA_JWT = '';
    process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
    process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
    const { createAppServer } = await import('../server/index.mjs');
    const { app, server } = createAppServer();
    app.use('/graffiland', express.static(path.join(ROOT, 'dist')));
    app.use(express.static(path.join(ROOT, 'dist')));
    srv = server;
    await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${srv.address().port}`;
        resolve();
      });
    });

    // Seed one published sculpture so Gallery / Leaders / deep link ?sculpture= are exercised live
    const loginRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'e2e@graffiland.test', name: 'E2E Artist' } })
    }).then((r) => r.json());

    const pubRes = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginRes.token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'E2E Lighthouse Cube',
        description: 'Seeded E2E voxel tower for Desktop map and deep link checks.',
        termsAccepted: true,
        location: { lat: 37.7749, lng: -122.4194, altitude: 18, accuracy: 5 },
        proofOfLocation: {
          frameHashes: ['e1', 'e2', 'e3', 'e4'],
          gyroSamples: [{ alpha: 1, beta: 2, gamma: 3 }, { alpha: 11, beta: 5, gamma: 2 }],
          flowCorrelation: 0.85,
          skyPalette: ['#00f5d4'],
          visualDHash: '1010101010101010',
          frameCount: 6,
          flowScore: 0.85
        },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ffd166', material: 'matte' }
        ]
      })
    }).then((r) => r.json());
    seededSculptureId = pubRes?.sculpture?.id || '';

    // Seed autonomous AI Steward claiming a dormant land, deploying a quest plinth, and listing on marketplace
    const botWallet = ethers.Wallet.createRandom();
    const chal = await fetch(`${baseUrl}/api/agents/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: botWallet.address })
    }).then((r) => r.json());
    const botSig = await botWallet.signMessage(chal.message);
    const botAuth = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: botWallet.address,
        nonce: chal.nonce,
        signature: botSig,
        name: 'Playwright Bot Steward',
        framework: 'openclaw'
      })
    }).then((r) => r.json());

    const scoutRes = await fetch(`${baseUrl}/api/lands/scout?lat=37.781&lng=-122.412&status=unclaimed`)
      .then((r) => r.json());
    const dormantPid = scoutRes.parcels[0].parcelId;
    const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botAuth.token}` },
      body: JSON.stringify({ parcelId: dormantPid, customName: 'Bot Cyber Plaza' })
    });
    assert.equal(claimRes.status, 201);
    const buildRpc = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botAuth.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'batch_build_land',
          arguments: {
            parcelId: dormantPid,
            items: [{ prefab: 'plinth', title: 'Bot Plinth Stage', accentColor: '#00f5d4' }],
            quest: {
              title: 'E2E Neon Plinth Quest',
              prompt: 'Sculpt 3+ glowing voxels onto our center plinth.',
              bountyEth: 0.2
            }
          }
        }
      })
    }).then((r) => r.json());
    assert.ok(buildRpc?.result?.structuredContent?.quest?.id, JSON.stringify(buildRpc));
    const stageScId = buildRpc.result.structuredContent.sculptures[0].id;
    const listRes = await fetch(`${baseUrl}/api/marketplace/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botAuth.token}` },
      body: JSON.stringify({ sculptureId: stageScId, priceEth: 0.1 })
    });
    assert.equal(listRes.status, 201);

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu-sandbox']
    });
  });

  after(async () => {
    await browser?.close();
    if (srv) await new Promise((resolve) => srv.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('Desktop defaults to Map Explorer, switches Gallery/Leaders tabs, opens Pair QR & ?sculpture= deep link', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.desktop-nav');

    // First-time visitor overlay appears automatically over Desktop Explorer
    const welcomeDialog = await page.waitForSelector(
      '[aria-label="Welcome to GRAFFILAND first-visit overview"]'
    );
    const welcomeText = await welcomeDialog.textContent();
    assert.ok(welcomeText.includes('GRAFFILAND is a real-world 3D art map'));
    assert.ok(welcomeText.includes('What Humans Can Do'));
    assert.ok(welcomeText.includes('What AI Agents Can Do'));
    await page.getByRole('button', { name: /Explore the Map/i }).click();
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]', {
      state: 'detached'
    });
    const welcomeSaved = await page.evaluate(() =>
      globalThis.localStorage.getItem('graffiland_first_visit_welcome_seen_v1')
    );
    assert.equal(welcomeSaved, '1');

    // Can still reopen the welcome banner anytime from the Intro button
    await page.getByRole('button', { name: /Intro/i }).click();
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]');
    await page.getByRole('button', { name: /Close welcome banner/i }).click();

    const bodyText = await page.textContent('body');
    assert.ok(bodyText.includes('Desktop Map Explorer'));
    assert.ok(bodyText.includes('Mobile Required for Full Functionality'));
    assert.ok(bodyText.includes('E2E Lighthouse Cube'));

    // Exercise Desktop Intro Banner tabs (Human Creator <-> Agentic User / AI Steward <-> Collectors & Scouts) & Prompt Preview
    await page.getByRole('button', { name: /Copy Property-Agent Prompt/i }).waitFor();
    await page.getByRole('tab', { name: /Collectors & Scouts/i }).click();
    await page.waitForSelector('text=Collect Real-World Verified 3D NFTs');
    await page.getByRole('tab', { name: /Agentic User \/ AI Steward/i }).click();
    await page.waitForSelector('text=Autonomous AI Agents Connect Without OAuth');
    await page.getByRole('button', { name: /Preview Prompt/i }).click();
    await page.waitForSelector('text=Zero-OAuth Autonomous Agent Steward');

    // Verify 100% full-viewport framing even when Intro + Prompt Preview are expanded
    const viewportMetrics = await page.evaluate(() => {
      const shell = globalThis.document.querySelector('.desktop-shell');
      const mapEl = globalThis.document.querySelector('.desktop-map-stage .map-container');
      const sideEl = globalThis.document.querySelector('.desktop-nearby-panel');
      return {
        innerWidth: globalThis.window.innerWidth,
        innerHeight: globalThis.window.innerHeight,
        docScrollHeight: globalThis.document.documentElement.scrollHeight,
        shellHeight: shell?.getBoundingClientRect().height || 0,
        mapHeight: mapEl?.getBoundingClientRect().height || 0,
        sideHeight: sideEl?.getBoundingClientRect().height || 0
      };
    });
    assert.ok(
      viewportMetrics.docScrollHeight <= viewportMetrics.innerHeight + 2,
      `Expected 100% viewport fit without page scroll, got docScrollHeight=${viewportMetrics.docScrollHeight} vs innerHeight=${viewportMetrics.innerHeight}`
    );
    assert.ok(
      viewportMetrics.mapHeight >= 300 && viewportMetrics.sideHeight >= 300,
      `Expected map & sidebar to share full height cleanly, got map=${viewportMetrics.mapHeight}, side=${viewportMetrics.sideHeight}`
    );

    await page.getByRole('button', { name: /Copy Autonomous Agent Prompt/i }).click();
    await page.waitForSelector('text=Copied Autonomous Agent Prompt');
    await page.getByRole('button', { name: /Dismiss mobile notice/i }).click();
    await page.getByRole('button', { name: /Connect Agent/i }).click();
    await page.waitForSelector('text=Autonomous AI Agents Connect Without OAuth');

    // Switch sidebar tabs: Quests -> Market -> Gallery -> Leaders -> List
    await page.getByRole('button', { name: /Quests/i }).click();
    await page.waitForSelector('[aria-label="Agent Land Quests"]');
    const questsText = await page.textContent('[aria-label="Agent Land Quests"]');
    assert.ok(questsText.includes('E2E Neon Plinth Quest'));
    assert.ok(questsText.includes('First-Spark'));

    await page.getByRole('button', { name: /Market/i }).click();
    await page.waitForSelector('[aria-label="GRAFFILAND Marketplace"]');
    const marketText = await page.textContent('[aria-label="GRAFFILAND Marketplace"]');
    assert.ok(marketText.includes('5% Platform'));
    assert.ok(marketText.includes('3% Agent Steward'));
    assert.ok(marketText.includes('2% Human Contributors Pool'));
    assert.ok(marketText.includes('Bot Plinth Stage'));

    await page.getByRole('button', { name: /Gallery/i }).click();
    await page.waitForSelector('[aria-label="Sculpture Gallery"]');
    await page.getByRole('button', { name: /Leaders/i }).click();
    await page.waitForSelector('[aria-label="Creator Leaderboard"]');
    const leaderText = await page.textContent('[aria-label="Creator Leaderboard"]');
    assert.ok(leaderText.includes('E2E Artist'));
    assert.ok(leaderText.includes('Playwright Bot Steward'));

    // Open QR Pair modal
    await page.getByRole('button', { name: /Pair Phone/i }).click();
    await page.waitForSelector('text=Pair Phone via QR');
    await page.getByRole('button', { name: /Close pairing modal/i }).click();

    // Open Info modal and confirm Threat Model + Policy
    await page.getByRole('button', { name: /^Info$/i }).click();
    await page.waitForSelector('text=Proof of Location Threat Model');
    await page.getByRole('button', { name: /Terms & Virtual Land/i }).click();
    await page.waitForSelector('text=Prohibited Content, Takedown & Virtual Land Dispute Process');

    // Navigate via deep link ?sculpture=<id>
    assert.ok(seededSculptureId);
    await page.goto(`${baseUrl}/?sculpture=${encodeURIComponent(seededSculptureId)}`, {
      waitUntil: 'networkidle'
    });
    await page.waitForSelector('text=Copy Link');
    const modalText = await page.textContent('.modal-card');
    assert.ok(modalText.includes('E2E Lighthouse Cube'));
    assert.ok(modalText.includes('Share to X'));

    assert.deepEqual(pageErrors, []);
    await context.close();
  });
});
