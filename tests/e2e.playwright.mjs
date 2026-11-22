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
          cameraFrames: 6,
          gpsSamples: [
            { lat: 37.7749, lng: -122.4194, t: Date.now() - 3000 },
            { lat: 37.77491, lng: -122.41941, t: Date.now() - 500 }
          ],
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
      args: [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
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

  test('First-time visitor welcome overlay stays visibly above 3D MapLibre canvas until closed, clicked off, or Escaped', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.desktop-nav');
    await page.waitForSelector('.maplibregl-ctrl-top-right');
    await page.waitForSelector('.maplibregl-ctrl-zoom-in');
    // Allow MapLibre async mount/layout effects to settle; overlay must remain on top
    await page.waitForTimeout(1500);

    const welcomeSelector = '[aria-label="Welcome to GRAFFILAND first-visit overview"]';
    const welcomeVisible = await page.isVisible(welcomeSelector);
    assert.equal(welcomeVisible, true);
    const initialLs = await page.evaluate(() =>
      globalThis.localStorage.getItem('graffiland_first_visit_welcome_seen_v1')
    );
    assert.equal(initialLs, null);

    const layerAudit = await page.evaluate(() => {
      const backdrop = globalThis.document.querySelector('.welcome-overlay-backdrop');
      const card = globalThis.document.querySelector('.welcome-overlay-card');
      const mapCont = globalThis.document.querySelector('.map-container');
      const mlCont = globalThis.document.querySelector('.maplibregl-map');
      const zoomIn = globalThis.document.querySelector('.maplibregl-ctrl-zoom-in');
      const cardRect = card?.getBoundingClientRect();
      const zoomRect = zoomIn?.getBoundingClientRect();
      const zoomX = zoomRect ? zoomRect.left + zoomRect.width / 2 : 0;
      const zoomY = zoomRect ? zoomRect.top + zoomRect.height / 2 : 0;
      const hitAtZoom = zoomRect ? globalThis.document.elementFromPoint(zoomX, zoomY) : null;
      const samplePoints = cardRect
        ? [
            [cardRect.left + cardRect.width / 2, cardRect.top + cardRect.height / 2],
            [cardRect.left + 16, cardRect.top + 16],
            [cardRect.right - 16, cardRect.top + 16],
            [cardRect.left + 16, cardRect.bottom - 16],
            [cardRect.right - 16, cardRect.bottom - 16]
          ]
        : [];
      const allPointsInsideCard =
        samplePoints.length === 5 &&
        samplePoints.every(([x, y]) => {
          const hit = globalThis.document.elementFromPoint(x, y);
          return Boolean(card && hit && card.contains(hit));
        });
      return {
        mapIsolation: mapCont ? globalThis.getComputedStyle(mapCont).isolation : null,
        mapZ: mapCont ? globalThis.getComputedStyle(mapCont).zIndex : null,
        mlIsolation: mlCont ? globalThis.getComputedStyle(mlCont).isolation : null,
        mlZ: mlCont ? globalThis.getComputedStyle(mlCont).zIndex : null,
        backdropZ: backdrop ? Number(globalThis.getComputedStyle(backdrop).zIndex) : 0,
        innerWidth: globalThis.window.innerWidth,
        innerHeight: globalThis.window.innerHeight,
        cardRect: cardRect
          ? {
              top: cardRect.top,
              left: cardRect.left,
              right: cardRect.right,
              bottom: cardRect.bottom
            }
          : null,
        backdropClickCoord: {
          x: Math.max(12, Math.floor((cardRect?.left || 40) / 2)),
          y: Math.floor(globalThis.window.innerHeight / 2)
        },
        hitAtZoomIsMapLibre: Boolean(
          hitAtZoom?.closest('.maplibregl-ctrl, .maplibregl-map, .maplibregl-canvas-container')
        ),
        hitAtZoomCoveredByOverlay: Boolean(
          backdrop && hitAtZoom && (hitAtZoom === backdrop || backdrop.contains(hitAtZoom))
        ),
        allPointsInsideCard
      };
    });

    assert.equal(layerAudit.mapIsolation, 'isolate');
    assert.equal(layerAudit.mapZ, '0');
    assert.equal(layerAudit.mlIsolation, 'isolate');
    assert.equal(layerAudit.mlZ, '0');
    assert.ok(layerAudit.backdropZ >= 2000, `Expected backdrop z >= 2000, got ${layerAudit.backdropZ}`);
    assert.ok(layerAudit.cardRect.top >= 0 && layerAudit.cardRect.left >= 0);
    assert.ok(
      layerAudit.cardRect.bottom <= layerAudit.innerHeight + 1 &&
        layerAudit.cardRect.right <= layerAudit.innerWidth + 1
    );
    assert.equal(layerAudit.hitAtZoomIsMapLibre, false);
    assert.equal(layerAudit.hitAtZoomCoveredByOverlay, true);
    assert.equal(layerAudit.allPointsInsideCard, true);

    // Clicking inside the welcome card or clicking an "i" tooltip keeps it open
    await page.getByText('For Humans', { exact: true }).click();
    await page.getByRole('button', { name: /Info: How Humans Play/i }).click();
    await page.waitForSelector('[role="tooltip"]');
    await page.waitForTimeout(250);
    assert.equal(await page.isVisible(welcomeSelector), true);

    // Uncheck "Don't show automatically again" and click off card onto the dark backdrop
    await page.getByRole('checkbox').uncheck();
    await page.mouse.click(layerAudit.backdropClickCoord.x, layerAudit.backdropClickCoord.y);
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    const afterUncheckedClose = await page.evaluate(() =>
      globalThis.localStorage.getItem('graffiland_first_visit_welcome_seen_v1')
    );
    assert.equal(afterUncheckedClose, null);

    // Reloading shows the banner again because checkbox was unchecked
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.maplibregl-ctrl-top-right');
    await page.waitForTimeout(1000);
    assert.equal(await page.isVisible(welcomeSelector), true);

    // Pressing Escape with default checked "Don't show again" persists preference and closes banner
    await page.keyboard.press('Escape');
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    const afterEscape = await page.evaluate(() =>
      globalThis.localStorage.getItem('graffiland_first_visit_welcome_seen_v1')
    );
    assert.equal(afterEscape, '1');

    // Returning visitor does not automatically see the welcome overlay on reload
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.maplibregl-ctrl-top-right');
    await page.waitForTimeout(800);
    assert.equal(await page.locator(welcomeSelector).count(), 0);

    // Reopen via Intro button and test "Connect AI Agent" CTA
    await page.getByRole('button', { name: /^Intro$/i }).click();
    await page.waitForSelector(welcomeSelector);
    await page.getByRole('button', { name: /Connect AI Agent/i }).click();
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    await page.waitForSelector('text=Wallet / MCP Auth');
    const selectedTabText = await page.textContent('.desktop-intro-tabs [role="tab"][aria-selected="true"]');
    assert.ok(selectedTabText.includes('AI Agents'));

    // Reopen via Intro button and test "Full Guide" CTA opening viewport-tabbed Info modal above MapLibre
    await page.getByRole('button', { name: /^Intro$/i }).click();
    await page.waitForSelector(welcomeSelector);
    await page.getByRole('button', { name: /Full Guide/i }).click();
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    await page.waitForSelector('[data-testid="info-guide-desktop"]');
    await page.getByRole('tab', { name: /Mobile AR Studio/i }).click();
    await page.waitForSelector('[data-testid="info-guide-mobile"]');
    await page.waitForSelector('text=Proof of Location Threat Model');

    const infoModalAudit = await page.evaluate(() => {
      const backdrop = globalThis.document.querySelector('.modal-backdrop');
      const zoomIn = globalThis.document.querySelector('.maplibregl-ctrl-zoom-in');
      const zr = zoomIn?.getBoundingClientRect();
      const hit = zr ? globalThis.document.elementFromPoint(zr.left + zr.width / 2, zr.top + zr.height / 2) : null;
      return {
        zIndex: backdrop ? Number(globalThis.getComputedStyle(backdrop).zIndex) : 0,
        coversMapLibre: Boolean(backdrop && hit && (hit === backdrop || backdrop.contains(hit)))
      };
    });
    assert.ok(infoModalAudit.zIndex >= 2000);
    assert.equal(infoModalAudit.coversMapLibre, true);

    assert.deepEqual(pageErrors, []);
    await context.close();
  });

  test('Desktop defaults to Map Explorer, stays 100% viewport framed across desktop sizes, opens Pair/Info & ?sculpture= deep link', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.desktop-nav');

    // Dismiss initial first-time visitor overlay via primary CTA
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]');
    await page.getByRole('button', { name: /Explore the Map/i }).click();
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]', {
      state: 'detached'
    });

    const bodyText = await page.textContent('body');
    assert.ok(bodyText.includes('Desktop Map Explorer'));
    assert.ok(bodyText.includes('A real-world 3D art map where humans draw land'));
    assert.ok(bodyText.includes('E2E Lighthouse Cube'));

    // Exercise Desktop Intro Banner tabs (Humans <-> Collectors <-> AI Agents), clickable "i" tooltip & Prompt Preview
    await page.getByRole('button', { name: /Copy Property-Agent Prompt/i }).waitFor();
    await page.getByRole('tab', { name: /Collectors/i }).click();
    await page.waitForSelector('text=Verified IRL 3D NFTs');
    await page.getByRole('tab', { name: /AI Agents/i }).click();
    await page.waitForSelector('text=Wallet / MCP Auth');
    await page.getByRole('button', { name: /Info: Zero-OAuth Autonomous Login/i }).click();
    await page.waitForSelector('[role="tooltip"]');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Preview Prompt/i }).click();
    await page.waitForSelector('text=Zero-OAuth Autonomous Agent Steward');

    // Verify 100% full-viewport framing even when Intro + Prompt Preview are expanded (1440x900 & 1280x720)
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 1280, height: 720 },
      { width: 1440, height: 900 }
    ]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(120);
      const viewportMetrics = await page.evaluate(() => {
        const mapEl = globalThis.document.querySelector('.desktop-map-stage .map-container');
        const sideEl = globalThis.document.querySelector('.desktop-nearby-panel');
        const mapRect = mapEl?.getBoundingClientRect();
        const sideRect = sideEl?.getBoundingClientRect();
        return {
          innerWidth: globalThis.window.innerWidth,
          innerHeight: globalThis.window.innerHeight,
          docScrollWidth: globalThis.document.documentElement.scrollWidth,
          docScrollHeight: globalThis.document.documentElement.scrollHeight,
          mapHeight: mapRect?.height || 0,
          sideHeight: sideRect?.height || 0,
          mapBottom: mapRect?.bottom || 0,
          sideBottom: sideRect?.bottom || 0
        };
      });
      const minPanelHeight = vp.height >= 800 ? 250 : 120;
      assert.ok(
        viewportMetrics.docScrollHeight <= viewportMetrics.innerHeight + 2,
        `Expected 100% viewport fit (${vp.width}x${vp.height}), got docScrollHeight=${viewportMetrics.docScrollHeight} vs innerHeight=${viewportMetrics.innerHeight}`
      );
      assert.ok(
        viewportMetrics.docScrollWidth <= viewportMetrics.innerWidth + 1,
        `Expected no horizontal overflow (${vp.width}x${vp.height}), got ${viewportMetrics.docScrollWidth} > ${viewportMetrics.innerWidth}`
      );
      assert.ok(
        viewportMetrics.mapHeight >= minPanelHeight && viewportMetrics.sideHeight >= minPanelHeight,
        `Expected map & sidebar height >= ${minPanelHeight}px (${vp.width}x${vp.height}), got map=${viewportMetrics.mapHeight}, side=${viewportMetrics.sideHeight}`
      );
      assert.ok(
        Math.abs(viewportMetrics.mapBottom - viewportMetrics.sideBottom) <= 4,
        `Expected map & sidebar bottoms aligned (${vp.width}x${vp.height}), got mapBottom=${viewportMetrics.mapBottom}, sideBottom=${viewportMetrics.sideBottom}`
      );
    }

    await page.getByRole('button', { name: /Copy Autonomous Agent Prompt/i }).click();
    await page.waitForSelector('text=Copied Autonomous Agent Prompt');
    await page.getByRole('button', { name: /Dismiss intro banner/i }).click();
    assert.equal(await page.locator('.desktop-nav').getByRole('button', { name: /Connect Agent/i }).count(), 0);

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

    // Open QR Pair modal and verify it stacks above Leaflet
    await page.getByRole('button', { name: /Pair Phone/i }).click();
    await page.waitForSelector('text=Pair Phone via QR');
    const pairZ = await page.evaluate(() =>
      Number(globalThis.getComputedStyle(globalThis.document.querySelector('.modal-backdrop')).zIndex)
    );
    assert.ok(pairZ >= 2000);
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
    const deepModalZ = await page.evaluate(() =>
      Number(globalThis.getComputedStyle(globalThis.document.querySelector('.modal-backdrop')).zIndex)
    );
    assert.ok(deepModalZ >= 2000);

    assert.deepEqual(pageErrors, []);
    await context.close();
  });

  test('Mobile first-time visitor overlay (390x844) stays open without colliding with tutorial & supports Quick Guide / Skip', async () => {
    const mobileOptions = {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile'
    };

    const ctx1 = await browser.newContext(mobileOptions);
    const page1 = await ctx1.newPage();
    const errors1 = [];
    page1.on('pageerror', (err) => errors1.push(err.message));

    await page1.goto(baseUrl, { waitUntil: 'networkidle' });
    await page1.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]');
    await page1.waitForTimeout(1000);

    assert.equal(await page1.isVisible('[aria-label="Welcome to GRAFFILAND first-visit overview"]'), true);
    assert.equal(await page1.locator('[aria-label="GRAFFILAND Quick Start Guide"]').count(), 0);
    const scrollW = await page1.evaluate(() => globalThis.document.documentElement.scrollWidth);
    assert.ok(scrollW <= 391, `Expected mobile overlay width <= 391px, got ${scrollW}`);

    await page1.getByRole('button', { name: /Next: Quick Camera Guide/i }).click();
    await page1.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]', {
      state: 'detached'
    });
    await page1.waitForSelector('[aria-label="GRAFFILAND Quick Start Guide"]');
    assert.deepEqual(errors1, []);
    await ctx1.close();

    const ctx2 = await browser.newContext(mobileOptions);
    const page2 = await ctx2.newPage();
    const errors2 = [];
    page2.on('pageerror', (err) => errors2.push(err.message));

    await page2.goto(baseUrl, { waitUntil: 'networkidle' });
    await page2.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]');
    await page2.getByRole('button', { name: /Skip to AR Camera/i }).click();
    await page2.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]', {
      state: 'detached'
    });
    assert.equal(await page2.locator('[aria-label="GRAFFILAND Quick Start Guide"]').count(), 0);
    const prefs = await page2.evaluate(() => ({
      welcome: globalThis.localStorage.getItem('graffiland_first_visit_welcome_seen_v1'),
      tutorial: globalThis.localStorage.getItem('graffiland_studio_tutorial_v1')
    }));
    assert.equal(prefs.welcome, '1');
    assert.equal(prefs.tutorial, '1');

    // Logged-out mobile top-left Sign In button opens login modal, and Info "i" tips unfold cleanly inside viewport
    await page2.waitForSelector('[data-testid="mobile-signin-btn"]', { timeout: 10000 });
    const signInBox = await page2.locator('[data-testid="mobile-signin-btn"]').boundingBox();
    assert.ok(signInBox && signInBox.x < 40 && signInBox.y < 40, 'Expected Sign In button at top-left on mobile');

    await page2.getByRole('button', { name: 'Info and Terms' }).click();
    await page2.waitForSelector('.info-simple-card');
    await page2.locator('.info-tip-btn').first().click();
    const tipBox = await page2.locator('[role="tooltip"]').boundingBox();
    assert.ok(tipBox && tipBox.x >= 0 && tipBox.x + tipBox.width <= 390, `Expected unfolded InfoTip inside 390px viewport, got ${JSON.stringify(tipBox)}`);
    // Selecting a second "i" button closes the first and unfolds the second
    await page2.locator('.info-tip-btn').nth(1).click();
    assert.equal(await page2.locator('[role="tooltip"]').count(), 1);
    // Scrolling past the unfolded item automatically closes it
    await page2.evaluate(() => {
      const modal = globalThis.document.querySelector('.modal-card');
      if (modal) modal.scrollTop = 260;
    });
    await page2.waitForSelector('[role="tooltip"]', { state: 'detached', timeout: 3000 });
    await page2.getByRole('button', { name: 'Close info' }).click();

    // Mobile Studio bottom-right Palette opens Brush & Pencil Options popup (Block Size + Preset Colors) & switches to Pencil
    await page2.waitForSelector('[data-testid="palette-options-toggle"]');
    await page2.getByTestId('palette-options-toggle').click();
    await page2.waitForSelector('[data-testid="brush-options-popup"]');
    const popBox = await page2.getByTestId('brush-options-popup').boundingBox();
    assert.ok(
      popBox && popBox.x >= 0 && popBox.x + popBox.width <= 390 && popBox.y >= 0,
      `Expected Brush & Pencil options popup cleanly inside 390x844 viewport, got ${JSON.stringify(popBox)}`
    );
    await page2.getByTestId('block-size-l').click();
    await page2.getByRole('button', { name: 'Color Red' }).click();
    await page2.getByTestId('palette-select-pencil').click();
    await page2.waitForSelector('.key-tool-caption:has-text("Pencil")');
    await page2.getByTestId('palette-options-toggle').click();
    await page2.waitForSelector('[data-testid="brush-options-popup"]', { state: 'detached' });

    assert.deepEqual(errors2, []);
    await ctx2.close();
  });

  test('Desktop 3D Isometric Land Builder: search, draw first square auto-3D, Isometric/rotate/tilt, W/D/Rot/Z sliders, agent export & mint', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    const mapConsoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        if (/data expressions not supported|worker failed to load/i.test(txt)) {
          mapConsoleErrors.push(txt);
        }
      }
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.maplibregl-ctrl-zoom-in');
    await page.waitForFunction(() => {
      const txt = globalThis.document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent || '';
      return /OpenFreeMap|OpenStreetMap|CARTO/i.test(txt);
    }, { timeout: 15000 });
    assert.deepEqual(mapConsoleErrors, []);
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]');
    await page.getByRole('button', { name: /Explore the Map/i }).click();
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]', {
      state: 'detached'
    });

    // Verify Desktop map starts immediately in Isometric mode (-45 deg, pitch 52 deg) and renders real 3D sculptures
    const stage = page.locator('.map3d-stage');
    assert.equal(await stage.getAttribute('data-view-mode'), 'isometric');
    assert.equal(Number(await stage.getAttribute('data-pitch')), 52);
    assert.equal(Number(await stage.getAttribute('data-bearing')), -45);
    await page.waitForFunction(
      () => Number(globalThis.document.querySelector('.map3d-stage')?.getAttribute('data-rendered-3d-sculptures') || 0) >= 1
    );

    // Click rendered 3D sculpture on Desktop map -> opens SculptureModal with ALL metadata (incl. expandable full JSON)
    await page.locator('.map3d-sculpture-marker').first().click();
    await page.waitForSelector('text=E2E Lighthouse Cube');
    await page.getByRole('button', { name: /View All Metadata/i }).click();
    await page.waitForSelector('[data-testid="sculpture-all-metadata"]');
    const rawMetaText = await page.locator('[data-testid="sculpture-all-metadata"]').textContent();
    assert.ok(rawMetaText.includes('proofHash') && rawMetaText.includes('parcelId') && rawMetaText.includes('voxelCount'));
    await page.locator('.modal-backdrop').click({ position: { x: 10, y: 10 } });
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });

    // Dynamic live search: typing auto-opens dropdown without clicking Find; Enter jumps & drops a target pin
    const searchInput = page.getByLabel('Search locations, intersections, or businesses');
    await searchInput.fill('37.786, -122.408');
    await page.waitForSelector('.map3d-search-item', { timeout: 6000 });
    await searchInput.press('Enter');
    await page.waitForSelector('.map3d-search-pin', { timeout: 5000 });
    await page.waitForTimeout(350);

    // Verify broken Connect Agent button is removed, Pair Phone glows, and Pair modal has structured revealable Agent Pairing
    assert.equal(await page.locator('.desktop-nav').getByRole('button', { name: /Connect Agent/i }).count(), 0);
    const pairNavBtn = page.getByTestId('nav-pair-phone-btn');
    assert.ok((await pairNavBtn.getAttribute('class')).includes('btn-pair-glow'));
    await pairNavBtn.click();
    await page.waitForSelector('[data-testid="pair-phone-modal"]');
    assert.equal(await page.locator('[data-testid="pair-agent-structured-steps"]').count(), 0);
    await page.getByTestId('pair-agent-reveal-toggle').click();
    await page.waitForSelector('[data-testid="pair-agent-structured-steps"]');
    await page.getByRole('button', { name: /Close pairing modal/i }).click();
    await page.waitForSelector('[data-testid="pair-phone-modal"]', { state: 'detached' });

    // Hold down in 1 location on the map (~450ms) WITHOUT clicking Draw Land -> activates Hold-to-Draw Cube & drags out a 3D cube!
    const mapBox = await page.locator('.map-container').boundingBox();
    assert.ok(mapBox && mapBox.width > 200 && mapBox.height > 200);
    await page.mouse.move(mapBox.x + mapBox.width * 0.36, mapBox.y + mapBox.height * 0.42);
    await page.mouse.down();
    await page.waitForSelector('.map3d-stage[data-hold-draw="active"]', { timeout: 4000 });
    await page.mouse.move(mapBox.x + mapBox.width * 0.60, mapBox.y + mapBox.height * 0.64, { steps: 8 });
    await page.mouse.up();

    await page.waitForSelector('.map3d-stage[data-draft-count="1"]');
    await page.waitForSelector('[data-testid="desktop-land-builder-panel"]');
    assert.equal(await stage.getAttribute('data-view-mode'), 'isometric');
    assert.equal(await stage.getAttribute('data-draw-mode'), 'off');
    const drawnText = await page.locator('.land-draft-item').first().textContent();
    assert.ok(drawnText.includes('315°'), `Expected drawn square to inherit 315° isometric orientation, got: ${drawnText}`);
    assert.ok(drawnText.includes('Name Req.'), `Expected untitled drawn plot to require a land title, got: ${drawnText}`);
    // No pre-mint copy or Title button next to Mint This Land
    assert.equal(await page.getByRole('button', { name: /Copy Parcel Link/i }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /🏷️ Title/i }).count(), 0);

    // Compact sliders start collapsed under Description; expand them for manual checks
    assert.equal(await page.locator('[data-testid="land-sliders-body"]').count(), 0);
    await page.getByTestId('land-sliders-toggle').click();
    await page.waitForSelector('[data-testid="land-sliders-body"]');

    // Give the plot a unique title so it becomes Ready
    await page.locator('#land-square-name-input').fill('E2E Neon Corner');
    await page.waitForSelector('[data-testid="land-title-validation"]:has-text("available")', { timeout: 5000 });

    // Verify hover-to-select & on-map 3D CAD gizmo handles (corner ball scale, pronounced center up/down Z handle, side bar stretch, vertical bar rotate, body move)
    await page.waitForFunction(() => Boolean(globalThis.document.querySelector('.map3d-stage')?.getAttribute('data-active-gizmo')));
    const readGizmo = async () =>
      JSON.parse(await stage.getAttribute('data-active-gizmo'));

    let gizmo = await readGizmo();
    assert.ok(Array.isArray(gizmo.heightHandle), 'Expected pronounced heightHandle coords in data-active-gizmo');

    // 1) Hover over drawn plot selects it & shows handle hint pill
    await page.mouse.move(mapBox.x + gizmo.center[0], mapBox.y + gizmo.center[1]);
    await page.waitForFunction(
      (id) => globalThis.document.querySelector('.map3d-stage')?.getAttribute('data-hovered-draft-id') === id,
      gizmo.id
    );
    await page.waitForSelector('.map3d-gizmo-pill');

    // 1b) Pull the pronounced center up/down elevator orb UP -> Z height grows cleanly!
    const zBeforePull = Number(await page.getByLabel('Z-Axis Scale').inputValue());
    await page.mouse.move(mapBox.x + gizmo.heightHandle[0], mapBox.y + gizmo.heightHandle[1]);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + gizmo.heightHandle[0], mapBox.y + gizmo.heightHandle[1] - 48, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const zAfterPull = Number(await page.getByLabel('Z-Axis Scale').inputValue());
    assert.ok(zAfterPull > zBeforePull, `Expected pulling center Z handle up to increase height (${zBeforePull} -> ${zAfterPull})`);

    // 2) Drag a corner ball outward to scale footprint smoothly
    const beforeCornerText = await page.locator('.land-draft-item').first().textContent();
    await page.mouse.move(mapBox.x + gizmo.corner0[0], mapBox.y + gizmo.corner0[1]);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + gizmo.corner0[0] - 28, mapBox.y + gizmo.corner0[1] - 22, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const afterCornerText = await page.locator('.land-draft-item').first().textContent();
    assert.notEqual(afterCornerText, beforeCornerText, 'Expected dragging corner ball to resize footprint');
    assert.ok(afterCornerText.includes('Ready'), `Expected corner-scaled plot to stay Ready, got: ${afterCornerText}`);

    // 3) Drag a side segment bar inward toward center to move/resize a single edge cleanly
    gizmo = await readGizmo();
    const beforeEdgeText = await page.locator('.land-draft-item').first().textContent();
    const edgeTargetX = mapBox.x + gizmo.edge0[0] + (gizmo.center[0] - gizmo.edge0[0]) * 0.45;
    const edgeTargetY = mapBox.y + gizmo.edge0[1] + (gizmo.center[1] - gizmo.edge0[1]) * 0.45;
    await page.mouse.move(mapBox.x + gizmo.edge0[0], mapBox.y + gizmo.edge0[1]);
    await page.mouse.down();
    await page.mouse.move(edgeTargetX, edgeTargetY, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const afterEdgeText = await page.locator('.land-draft-item').first().textContent();
    assert.notEqual(afterEdgeText, beforeEdgeText, 'Expected dragging side segment bar to resize side');

    // 4) Hold & drag a vertical corner bar to rotate the box
    gizmo = await readGizmo();
    const rotBefore = await page.getByLabel('Rotate (°)').inputValue();
    await page.mouse.move(mapBox.x + gizmo.vbar0[0], mapBox.y + gizmo.vbar0[1]);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + gizmo.vbar0[0] + 45, mapBox.y + gizmo.vbar0[1] + 20, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const rotAfter = await page.getByLabel('Rotate (°)').inputValue();
    assert.notEqual(rotAfter, rotBefore, `Expected holding & dragging vertical bar to rotate box (before=${rotBefore}, after=${rotAfter})`);

    // 5) Drag center body to move the entire property on canvas
    gizmo = await readGizmo();
    const idBeforeMove = await page.locator('.land-editor-id').textContent();
    await page.mouse.move(mapBox.x + gizmo.center[0], mapBox.y + gizmo.center[1]);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + gizmo.center[0] + 42, mapBox.y + gizmo.center[1] + 24, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const gizmoAfterMove = await readGizmo();
    assert.ok(
      Math.hypot(gizmoAfterMove.center[0] - gizmo.center[0], gizmoAfterMove.center[1] - gizmo.center[1]) >= 10,
      `Expected center body drag to move parcel (${idBeforeMove})`
    );

    // Verify scale-to-limit & max-height controls keep parcel valid up to the exact limit
    await page.getByRole('button', { name: /Max Limit Size/i }).click();
    await page.getByRole('button', { name: /Max Height/i }).click();
    const scaledText = await page.locator('.land-draft-item').first().textContent();
    assert.ok(scaledText.includes('Ready'), `Expected Max Limit Size + Max Height to remain valid Ready, got: ${scaledText}`);

    // Verify 2D -> 3D auto-switch still works if user clears, switches to 2D, activates Draw Land, and draws
    await page.getByRole('button', { name: /^Clear \(1\)$/i }).click();
    await page.locator('.map3d-toolbar').getByRole('button', { name: /^2D$/i }).click();
    assert.equal(await stage.getAttribute('data-view-mode'), '2d');
    await page.locator('.map3d-toolbar').getByRole('button', { name: /Draw Land/i }).click();
    await page.waitForTimeout(250);
    const cx = mapBox.x + mapBox.width * 0.54;
    const cy = mapBox.y + mapBox.height * 0.56;
    await page.mouse.move(cx - 28, cy - 28);
    await page.mouse.down();
    await page.mouse.move(cx + 34, cy + 34, { steps: 6 });
    await page.mouse.up();

    await page.waitForSelector('.map3d-stage[data-draft-count="1"]');
    assert.equal(await stage.getAttribute('data-view-mode'), '3d');
    await page.waitForSelector('.map3d-auto3d-pill');

    // Switch Back to 2D cleanly, then back to Isometric, rotate & adjust 2D-to-3D tilt
    await page.locator('.map3d-auto3d-pill').getByRole('button', { name: /Back to 2D/i }).click();
    assert.equal(await stage.getAttribute('data-view-mode'), '2d');

    await page.locator('.map3d-toolbar').getByRole('button', { name: /^Isometric$/i }).click();
    assert.equal(await stage.getAttribute('data-view-mode'), 'isometric');
    await page.waitForTimeout(250);

    const bearingBefore = Number(await stage.getAttribute('data-bearing'));
    await page.locator('.map3d-toolbar').getByRole('button', { name: /\+15°/i }).click();
    await page.waitForFunction(
      (prev) => {
        const el = globalThis.document.querySelector('.map3d-stage');
        return el && Number(el.getAttribute('data-bearing')) !== prev;
      },
      bearingBefore
    );

    await page.getByLabel('Canvas 2D to 3D tilt').fill('40');
    assert.equal(await stage.getAttribute('data-pitch'), '40');

    // Add a second square and edit Width, Depth, Rotate, and Z-Axis Scale on Square #1
    await page.getByRole('button', { name: /\+ Add Square/i }).click();
    await page.waitForSelector('.map3d-stage[data-draft-count="2"]');

    await page.locator('.land-draft-item').first().click();
    await page.locator('#land-square-name-input').fill('Skyline Studio Plot');
    await page.waitForSelector('[data-testid="land-title-validation"]:has-text("available")', { timeout: 5000 });
    await page.getByLabel('Width (m)').fill('28');
    await page.getByLabel('Depth (m)').fill('22');
    await page.getByLabel('Rotate (°)').fill('30');
    await page.getByLabel('Z-Axis Scale').fill('2');

    const firstItemText = await page.locator('.land-draft-item').first().textContent();
    assert.ok(firstItemText.includes('28×22×36m'), `Expected 28x22x36m in ${firstItemText}`);
    assert.ok(firstItemText.includes('30°'), `Expected 30 deg in ${firstItemText}`);
    assert.ok(firstItemText.includes('616 m²'), `Expected 616 m2 in ${firstItemText}`);

    // Sign in, complete mandatory username onboarding, and mint the first square from Desktop
    const initialOwned = Number(await stage.getAttribute('data-owned-count'));
    await page.getByRole('button', { name: /Sign In/i }).first().click();
    await page.getByRole('button', { name: /Continue with Google/i }).click();
    await page.waitForSelector('[data-testid="username-onboarding-modal"]', { timeout: 10000 });
    await page.getByLabel('Choose username').fill('street_voxel_e2e');
    await page.waitForSelector('[data-testid="onboarding-username-status"]:has-text("available")', {
      timeout: 5000
    });
    await page.locator('[data-testid="onboarding-save-username-btn"]').click();
    await page.waitForSelector('[data-testid="username-onboarding-modal"]', { state: 'detached' });
    await page.waitForSelector('[data-testid="desktop-profile-btn"]:has-text("@street_voxel_e2e")');

    await page.getByRole('button', { name: /Mint This Land/i }).click();
    await page.waitForSelector('text=/Minted "Skyline Studio Plot"/i');
    await page.waitForSelector('.map3d-stage[data-draft-count="1"]');
    const afterOwned = Number(await stage.getAttribute('data-owned-count'));
    assert.equal(afterOwned, initialOwned + 1);

    // Post-mint Copy All Locations + Copy Prompt (All) + Individual Copy Icons become available ONLY after minting
    await page.waitForSelector('[data-testid="minted-lands-copy-panel"]');
    await page.getByTestId('copy-all-minted-prompt-btn').click();
    const mintedPromptBox = page.getByLabel('Minted lands AI agent prompt preview');
    await mintedPromptBox.waitFor();
    const mintedPromptVal = await mintedPromptBox.inputValue();
    assert.ok(mintedPromptVal.includes('Skyline Studio Plot'));

    // After minting: floating pin layer sits strictly ABOVE wireframes with "+" button on map & minted list!
    await page.waitForSelector('.map3d-floating-pins-layer .map3d-owned-plus-btn', { timeout: 6000 });
    await page.waitForSelector('.land-owned-plus-btn', { timeout: 6000 });
    await page.locator('.map3d-owned-plus-btn').first().click();
    await page.waitForSelector('.add-item-modal-card');
    await page.getByRole('radio', { name: /\.GLB 3D Model/i }).click();
    const itemPromptVal = await page.getByLabel('Add 3D item agent prompt preview').inputValue();
    assert.ok(itemPromptVal.includes('load_3d_model_on_land'));
    assert.ok(itemPromptVal.includes('update_land_sculpture'));
    assert.ok(itemPromptVal.includes('set_sculpture_visibility'));
    assert.ok(itemPromptVal.includes('update_land_settings'));
    await page.getByRole('button', { name: /Copy 3D Item Agent Prompt/i }).click();
    await page.waitForSelector('text=/Copied 3D item agent prompt/i');

    // Freeze the newly minted land directly from the modal -> button updates to Unfreeze Land
    await page.locator('.add-item-modal-card').getByRole('button', { name: /Freeze Land/i }).click();
    await page.locator('.add-item-modal-card').getByRole('button', { name: /Unfreeze Land/i }).waitFor();
    await page.getByRole('button', { name: /Close add 3D item modal/i }).click();

    assert.deepEqual(pageErrors, []);
    await context.close();
  });

  test('3-Step Walkthrough, Cart/Popup Titling, Land Management Name+Desc & Mobile Shared Parcel Visit View', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // 1) Click through all 3 illustrated walkthrough steps on first visit
    await page.waitForSelector('[data-testid="welcome-step-1"]');
    await page.getByRole('button', { name: /Next Step \(2\/3\)/i }).click();
    await page.waitForSelector('[data-testid="welcome-step-2"]');
    await page.getByRole('button', { name: /Next Step \(3\/3\)/i }).click();
    await page.waitForSelector('[data-testid="welcome-step-3"]');
    await page.getByRole('button', { name: /Explore the Map/i }).click();
    await page.waitForSelector('[aria-label="Welcome to GRAFFILAND first-visit overview"]', {
      state: 'detached'
    });

    // 2) Clicking Mint Land auto-selects Draw Land; add plot, enter unique title & description, and Mint!
    await page.locator('.desktop-nav').getByRole('button', { name: /Mint Land/i }).click();
    assert.equal(await page.locator('.map3d-stage').getAttribute('data-draw-mode'), 'on');
    await page.getByRole('button', { name: /Sign In/i }).first().click();
    await page.getByRole('button', { name: /Continue with Google/i }).click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });

    await page.getByRole('button', { name: /\+ Add Square/i }).click();
    await page.waitForSelector('#land-square-name-input');
    await page.locator('#land-square-name-input').fill('Civic Sunset Terrace');
    await page.waitForSelector('[data-testid="land-title-validation"]:has-text("available")', { timeout: 5000 });
    await page
      .locator('#land-square-desc-input')
      .fill('Open 3D art courtyard at Market and Van Ness.');
    await page.getByRole('button', { name: /Mint This Land/i }).click();
    await page.waitForSelector('text=/Minted "Civic Sunset Terrace"/i');

    // Mint a second parcel in a distinct location so Land Management tests switching between isometric land views
    await page.evaluate(async () => {
      const token = localStorage.getItem('graffiland_jwt') || '';
      await fetch('/api/lands/claim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          lat: 37.7955,
          lng: -122.3937,
          widthMeters: 24,
          depthMeters: 22,
          heightMeters: 26,
          rotationDeg: 20,
          customName: 'Embarcadero Pier',
          description: 'Waterfront 3D plaza'
        })
      });
    });

    // Verify minted land has on-map copy share link icon & cleaned-up Land Management ("i" tooltips + ":" emoji entry + isometric map preview)
    await page.waitForSelector('.map3d-parcel-share-btn');
    await page.locator('.desktop-nav').getByRole('button', { name: /Land Management/i }).click();
    await page.waitForSelector('[aria-label="Land Management"]');

    // Verify Isometric Geographic Preview renders cleanly and updates when selecting another land
    const isoPreview = page.getByTestId('land-mgmt-iso-preview');
    await isoPreview.waitFor({ state: 'visible' });
    const firstPreviewParcelId = await isoPreview.getAttribute('data-parcel-id');
    assert.ok(firstPreviewParcelId && firstPreviewParcelId.startsWith('GLAND-'));
    assert.equal(await isoPreview.getAttribute('data-view-mode'), 'isometric');
    assert.ok((await page.getByTestId('land-preview-coords').textContent()).includes('°'));
    assert.ok((await page.getByTestId('land-preview-scale').textContent()).includes('m'));

    // Switch preview to Area context, then select the other owned land and confirm it reloads in isometric view
    await isoPreview.getByRole('button', { name: /Area/i }).click();
    assert.equal(await isoPreview.getAttribute('data-view-mode'), 'context');
    const otherTab = page
      .locator('[role="tablist"][aria-label="Your owned lands"] [role="tab"]')
      .filter({ hasNotText: new RegExp(firstPreviewParcelId.replace(/^GLAND-/, ''), 'i') })
      .nth(1);
    const tabsCount = await page
      .locator('[role="tablist"][aria-label="Your owned lands"] [role="tab"]')
      .count();
    assert.ok(tabsCount >= 2, `Expected >= 2 owned land tabs, got ${tabsCount}`);
    await page.getByRole('button', { name: /Next land/i }).click();
    const secondPreviewParcelId = await isoPreview.getAttribute('data-parcel-id');
    assert.notEqual(secondPreviewParcelId, firstPreviewParcelId);
    assert.equal(await isoPreview.getAttribute('data-view-mode'), 'isometric');
    if (await otherTab.isVisible().catch(() => false)) {
      // ensure clicking back to first parcel works cleanly
      await page.getByRole('button', { name: /Previous land/i }).click();
    } else {
      await page.getByRole('button', { name: /Previous land/i }).click();
    }
    assert.equal(await isoPreview.getAttribute('data-parcel-id'), firstPreviewParcelId);

    await page.getByRole('button', { name: /Info: Freeze Land/i }).click();
    await page.waitForSelector('[role="tooltip"]');
    await page.keyboard.press('Escape');

    const landNameInput = page.getByLabel('Land Name', { exact: true });
    await landNameInput.fill('');
    await landNameInput.type('Market Gallery :fire:');
    assert.equal(await landNameInput.inputValue(), 'Market Gallery 🔥');

    const landDescInput = page.getByLabel('Land Description', { exact: true });
    await landDescInput.fill('');
    await landDescInput.type('Public sculpture garden :art');
    await page.waitForSelector('[aria-label="Emoji suggestions"]');
    await landDescInput.press('Enter');
    assert.ok((await landDescInput.inputValue()).includes('🎨'));

    await page.getByRole('button', { name: /Save Land Settings/i }).click();
    await page.waitForSelector('text=/Saved settings for "Market Gallery 🔥"/i');
    // Confirm the Land Management modal and isometric preview never display raw GLAND- internal IDs
    const mgmtVisibleText = await page.locator('.land-mgmt-modal').innerText();
    assert.equal(
      /GLAND-[0-9A-Z]{6,10}/i.test(mgmtVisibleText),
      false,
      `Expected Land Management UI to use owner land names instead of internal GLAND IDs, got:\n${mgmtVisibleText}`
    );
    await page.getByRole('button', { name: /Close land management/i }).click();
    assert.deepEqual(pageErrors, []);
    await context.close();

    // 3) Mobile Shared Parcel Visit View: FAR -> Get Directions only; NEAR (Open) -> View in AR + Make Art; NEAR (Frozen) -> View in AR only
    const mobileBase = {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      permissions: ['geolocation'],
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile'
    };

    // Far visitor
    const farCtx = await browser.newContext({
      ...mobileBase,
      geolocation: { latitude: 37.82, longitude: -122.42 }
    });
    const farPage = await farCtx.newPage();
    await farPage.goto(`${baseUrl}/?parcel=GLAND-9Q8YYK8Y`, { waitUntil: 'networkidle' });
    await farPage.waitForSelector('[data-testid="mobile-parcel-visit-view"]');
    await farPage.waitForSelector('[data-testid="parcel-proximity-far"]');
    await farPage.getByRole('link', { name: /Get Directions/i }).waitFor();
    assert.equal(await farPage.getByRole('button', { name: /View in AR/i }).count(), 0);
    assert.equal(await farPage.getByRole('button', { name: /Make Art on This Property/i }).count(), 0);
    await farCtx.close();

    // Near visitor on open land
    const nearCtx = await browser.newContext({
      ...mobileBase,
      geolocation: { latitude: 37.77492, longitude: -122.41942 }
    });
    const nearPage = await nearCtx.newPage();
    await nearPage.goto(`${baseUrl}/?parcel=GLAND-9Q8YYK8Y`, { waitUntil: 'networkidle' });
    await nearPage.waitForSelector('[data-testid="parcel-proximity-near"]');
    await nearPage.getByRole('button', { name: /View in AR/i }).waitFor();
    await nearPage.getByRole('button', { name: /Make Art on This Property/i }).waitFor();
    await nearCtx.close();

    // 4) Mobile Main Canvas Pair & Approvals Hub: notification pill, dropdown Yes/No approval, history & QR scanner
    const ownerAuth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'mobile-pair-e2e@graffiland.test', name: 'Mobile Owner' } })
    }).then((r) => r.json());
    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({ username: 'mobile_owner', bio: 'Mobile AR creator' })
    });
    const ownerClaim = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({ lat: 37.7755, lng: -122.4185, customName: 'Mobile Pair Lot' })
    }).then((r) => r.json());
    const mcpPair = await fetch(`${baseUrl}/api/mcp/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({})
    }).then((r) => r.json());
    await fetch(`${baseUrl}/api/mcp/pairings/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingCode: mcpPair.pairing.code,
        agentName: 'E2E Mobile Bot',
        agentAddress: ownerAuth.user.walletAddress
      })
    });
    // Enqueue 2 agent requests: reject 1 immediately so History starts with 1 item, keep 1 Pending!
    const stagedA = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Graffiland-Pairing-Code': mcpPair.pairing.code
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_land_parcel',
          arguments: {
            parcelId: ownerClaim.parcelId,
            customName: 'Approved Mobile Plaza',
            description: 'Updated via one-tap mobile approval'
          }
        }
      })
    }).then((r) => r.json());
    const stagedB = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Graffiland-Pairing-Code': mcpPair.pairing.code
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'update_land_settings',
          arguments: { parcelId: ownerClaim.parcelId, frozen: true }
        }
      })
    }).then((r) => r.json());
    const rejectId = stagedB.result.structuredContent.request.id;
    await fetch(`${baseUrl}/api/signatures/requests/${rejectId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({})
    });
    assert.ok(stagedA.result.structuredContent.request.id);

    const hubCtx = await browser.newContext({
      ...mobileBase,
      geolocation: { latitude: 37.7755, longitude: -122.4185 }
    });
    await hubCtx.addInitScript((tok) => {
      globalThis.localStorage.setItem('graffiland_jwt', tok);
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
      globalThis.localStorage.setItem('graffiland_studio_tutorial_v1', '1');
    }, ownerAuth.token);
    const hubPage = await hubCtx.newPage();
    const hubErrors = [];
    hubPage.on('pageerror', (err) => hubErrors.push(err.message));

    await hubPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await hubPage.waitForSelector('[data-testid="mobile-pair-hub-btn"]', { timeout: 15000 });
    await hubPage.waitForSelector('[data-testid="mobile-pending-pill"]', { timeout: 10000 });
    assert.equal(await hubPage.locator('[data-testid="mobile-pending-pill"]').textContent(), '1');
    await hubPage.waitForSelector('[data-testid="mobile-pending-alert-pill"]');

    // Open dropdown from main canvas button -> lands on Pending tab with item description & Yes/No
    await hubPage.locator('[data-testid="mobile-pair-hub-btn"]').click();
    await hubPage.waitForSelector('[data-testid="mobile-pair-dropdown"]');
    await hubPage.waitForSelector('text=Approved Mobile Plaza');

    // Approve Yes -> notification pill disappears and item appears in History as Approved
    await hubPage.getByRole('button', { name: /Yes, Approve/i }).click();
    await hubPage.waitForSelector('[data-testid="mobile-pending-pill"]', { state: 'detached', timeout: 10000 });
    await hubPage.getByRole('tab', { name: /History/i }).click();
    await hubPage.waitForSelector('[data-testid="mobile-history-item"]');
    assert.equal(await hubPage.locator('[data-testid="mobile-history-item"]').count(), 2);

    // Switch to Pair tab -> verify QR Scanner and Copy Agent Connector controls are present
    await hubPage.getByRole('tab', { name: /Pair/i }).click();
    await hubPage.getByRole('button', { name: /Scan Desktop QR Code/i }).click();
    await hubPage.waitForSelector('[data-testid="desktop-qr-scanner"]');
    await hubPage.getByRole('button', { name: /Copy Agent Connector Prompt/i }).waitFor();

    // Open Mobile Map Icon -> defaults to Nearest Lands with nested sculptures, expiration times & Google Maps links
    await hubPage.locator('[data-testid="mobile-pair-hub-btn"]').click(); // close dropdown

    // First verify live AR Camera Land Interaction right from the initial drawing camera view:
    // Because the mobile user is standing right at their seeded land, the On/Near Land pill appears on camera,
    // tapping it opens the full AR Land Inspector and temporarily hides non-useful HUD buttons!
    await hubPage.waitForSelector('[data-testid="ar-nearby-land-pill"]', { timeout: 10000 });
    await hubPage.getByTestId('ar-nearby-land-pill').click();
    await hubPage.waitForSelector('[data-testid="ar-land-inspector"]', { timeout: 10000 });
    await hubPage.getByTestId('ar-land-exit-top-btn').waitFor({ state: 'visible', timeout: 5000 });
    const arInspectState = await hubPage.evaluate(() => ({
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      pairBtnCount: globalThis.document.querySelectorAll('[data-testid="mobile-pair-hub-btn"]').length,
      carouselCount: globalThis.document.querySelectorAll('.key-carousel').length,
      dockToggleCount: globalThis.document.querySelectorAll('.floating-tools-toggle').length,
      scanBoxCount: globalThis.document.querySelectorAll('.scene-scan-box').length,
      mapBtnCount: globalThis.document.querySelectorAll('.floating-map-btn').length,
      reticleCount: globalThis.document.querySelectorAll('.reticle').length
    }));
    assert.ok(
      arInspectState.scrollWidth <= 391,
      `Expected AR land inspector scrollWidth <= 391, got ${arInspectState.scrollWidth}`
    );
    assert.equal(arInspectState.pairBtnCount, 0, 'Pair button should hide while interacting with land');
    assert.equal(arInspectState.carouselCount, 0, 'Bottom tool carousel should hide while interacting with land');
    assert.equal(arInspectState.dockToggleCount, 0, 'Tools drawer toggle should hide while interacting with land');
    assert.equal(arInspectState.scanBoxCount, 0, 'Scene scan widget should hide while interacting with land');
    assert.equal(arInspectState.mapBtnCount, 0, 'Floating map button should hide while interacting with land');
    assert.equal(arInspectState.reticleCount, 0, 'Drawing reticle should hide while interacting with land');

    // Exit land interaction via Back to Draw -> all drawing buttons immediately restore
    await hubPage.getByTestId('ar-land-exit-top-btn').click();
    await hubPage.locator('.floating-map-btn').waitFor({ state: 'visible', timeout: 5000 });
    await hubPage.locator('.key-carousel').waitFor({ state: 'visible', timeout: 5000 });

    await hubPage.locator('.floating-map-btn').click();
    await hubPage.waitForSelector('[aria-label="Nearest Lands and Sculptures Map"]', { timeout: 10000 });
    await hubPage.waitForSelector('[data-testid="mobile-land-card"]', { timeout: 10000 });

    const landCards = hubPage.locator('[data-testid="mobile-land-card"]');
    const landCardCount = await landCards.count();
    assert.ok(landCardCount >= 2, `Expected >= 2 nearest land cards, got ${landCardCount}`);

    // Verify Google Maps link exists on every rendered land card
    const gmapsLinks = hubPage.locator('[data-testid="land-google-maps-link"]');
    assert.equal(await gmapsLinks.count(), landCardCount);
    const firstHref = await gmapsLinks.first().getAttribute('href');
    assert.ok(firstHref && firstHref.startsWith('https://www.google.com/maps/dir/?api=1&destination='));

    // Verify expiration badges render (both dormant countdown "left" and Permanent lands exist from seeded data)
    const expTexts = await hubPage.locator('[data-testid="land-expiration-badge"]').allTextContents();
    assert.ok(
      expTexts.some((t) => /\bleft\b/i.test(t)),
      `Expected a dormant land expiration countdown badge, got: ${JSON.stringify(expTexts)}`
    );
    assert.ok(
      expTexts.some((t) => /Permanent/i.test(t)),
      `Expected a permanent land badge, got: ${JSON.stringify(expTexts)}`
    );

    // Verify nested sculptures render under lands with metadata and tapping 3D opens SculptureModal above the map
    const sculptureItems = hubPage.locator('[data-testid="land-sculpture-item"]');
    assert.ok((await sculptureItems.count()) >= 1, 'Expected at least 1 nested sculpture under a land');
    const firstScText = await sculptureItems.first().textContent();
    assert.ok(/blocks|3D/i.test(firstScText || ''));

    // Verify zero horizontal overflow on mobile 390px viewport, visible Leaflet map height, and simple land labels
    const mapMetrics = await hubPage.evaluate(() => ({
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      leafletHeight:
        globalThis.document.querySelector('.mobile-map-canvas .leaflet-container')?.clientHeight || 0,
      landLabelCount: globalThis.document.querySelectorAll('[data-testid="map-land-label"]').length
    }));
    assert.ok(
      mapMetrics.scrollWidth <= 391,
      `Expected mobile map scrollWidth <= 391, got ${mapMetrics.scrollWidth}`
    );
    assert.ok(
      mapMetrics.leafletHeight >= 150,
      `Expected visible mobile Leaflet map height >= 150px, got ${mapMetrics.leafletHeight}`
    );
    assert.ok(
      mapMetrics.landLabelCount >= 2,
      `Expected >= 2 simple land labels on mobile map, got ${mapMetrics.landLabelCount}`
    );

    // Verify 2D <-> 3D Isometric map toggle works cleanly on mobile (compact AND full-screen expanded)
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-iso-3d-map"]', { timeout: 10000 });
    await hubPage.getByTestId('mobile-map-2d-toggle-btn').waitFor({ state: 'visible', timeout: 5000 });
    await hubPage.getByTestId('mobile-map-orbit-btn').click();

    // Expand Full Map -> verify full-screen height & that 2D/3D/Orbit/Fit/Exit buttons ALL remain clickable
    await hubPage.getByTestId('mobile-map-expand-header-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-map-canvas"][data-map-expanded="fullscreen"]', {
      timeout: 5000
    });
    const full3dMetrics = await hubPage.evaluate(() => ({
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      mapHeight: globalThis.document.querySelector('[data-testid="mobile-map-canvas"]')?.clientHeight || 0
    }));
    assert.ok(
      full3dMetrics.scrollWidth <= 391,
      `Expected full-screen 3D mobile map scrollWidth <= 391, got ${full3dMetrics.scrollWidth}`
    );
    assert.ok(
      full3dMetrics.mapHeight >= 480,
      `Expected full-screen 3D mobile map height >= 480px, got ${full3dMetrics.mapHeight}`
    );
    await hubPage.getByTestId('mobile-map-orbit-btn').click();
    await hubPage.getByTestId('mobile-map-2d-toggle-btn').click();
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').waitFor({ state: 'visible', timeout: 5000 });
    const full2dHeight = await hubPage.evaluate(
      () => globalThis.document.querySelector('.mobile-map-canvas .leaflet-container')?.clientHeight || 0
    );
    assert.ok(
      full2dHeight >= 480,
      `Expected full-screen 2D mobile map height >= 480px, got ${full2dHeight}`
    );
    // Switch back to 3D then collapse full-screen cleanly back to split Nearest Lands view
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-iso-3d-map"]', { timeout: 5000 });
    await hubPage.getByTestId('mobile-map-fullscreen-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-nearest-lands-list"]', { timeout: 5000 });
    await hubPage.getByTestId('mobile-map-2d-toggle-btn').click();
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').waitFor({ state: 'visible', timeout: 5000 });

    // Open a nested sculpture in 3D modal and verify modal sits cleanly above map overlay
    await sculptureItems.first().getByRole('button', { name: /3D/i }).click();
    await hubPage.waitForSelector('.modal-backdrop', { timeout: 10000 });
    const scModalZ = await hubPage.evaluate(() =>
      Number(globalThis.getComputedStyle(globalThis.document.querySelector('.modal-backdrop')).zIndex)
    );
    assert.ok(scModalZ >= 2000);

    // Close sculpture modal, then verify owned land shows manage gear & click-to-rename title right in Nearest Lands
    await hubPage.locator('.modal-backdrop').getByRole('button', { name: /Close/i }).first().click();

    const ownedCards = hubPage.locator('[data-testid="mobile-land-card"][data-owned="true"]');
    const otherCards = hubPage.locator('[data-testid="mobile-land-card"][data-owned="false"]');
    assert.ok((await ownedCards.count()) >= 1, 'Expected at least 1 owned land card in Nearest Lands');
    assert.ok((await otherCards.count()) >= 1, 'Expected at least 1 non-owned land card in Nearest Lands');
    assert.equal(await otherCards.first().locator('[data-testid="land-manage-gear-btn"]').count(), 0);
    assert.equal(await otherCards.first().locator('[data-testid="land-title-edit-trigger"]').count(), 0);

    const myOwnedCard = ownedCards.first();
    const myOwnedParcelId = await myOwnedCard.getAttribute('data-parcel-id');
    assert.ok(myOwnedParcelId);

    // Click owned land title -> rename inline with :fire: emoji -> save
    await myOwnedCard.locator('[data-testid="land-title-edit-trigger"]').click();
    const inlineInput = myOwnedCard.getByLabel('Rename land');
    await inlineInput.fill('');
    await inlineInput.type('Bayfront Studio :fire:');
    assert.equal(await inlineInput.inputValue(), 'Bayfront Studio 🔥');
    await myOwnedCard.locator('[data-testid="land-inline-rename-save"]').click();
    await hubPage.waitForSelector(
      `[data-parcel-id="${myOwnedParcelId}"] [data-testid="land-title-edit-trigger"]:has-text("Bayfront Studio 🔥")`,
      { timeout: 10000 }
    );

    // Click the gear button on the owned land -> opens Land Management focused on that exact parcel
    await myOwnedCard.locator('[data-testid="land-manage-gear-btn"]').click();
    await hubPage.waitForSelector('[aria-label="Land Management"]', { timeout: 10000 });
    assert.equal(
      await hubPage.getByTestId('land-mgmt-iso-preview').getAttribute('data-parcel-id'),
      myOwnedParcelId
    );
    assert.equal(await hubPage.getByLabel('Land Name', { exact: true }).inputValue(), 'Bayfront Studio 🔥');
    await hubPage.getByRole('button', { name: /Close land management/i }).click();

    // Open Mobile Profile pill (@mobile_owner) and verify bio + public land/action links
    await hubPage.locator('[data-testid="mobile-profile-btn"]').click();
    await hubPage.waitForSelector('[data-testid="profile-modal"]', { timeout: 10000 });
    assert.equal(await hubPage.locator('[data-testid="profile-handle"]').textContent(), '@mobile_owner');
    assert.ok((await hubPage.locator('[data-testid="profile-bio"]').textContent()).includes('Mobile AR creator'));
    assert.ok((await hubPage.locator('[data-testid="profile-land-public-link"]').count()) >= 1);

    assert.deepEqual(hubErrors, []);
    await hubCtx.close();
  });

  test('Onboarding requires unique username, profile allows changing username + bio with collision validation, and ?u= public profile links lands & actions', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Sign In/i }).first().click();
    await page.getByPlaceholder('you@gmail.com').fill('maya-profile-e2e@graffiland.test');
    await page.getByPlaceholder('Your artist name').fill('Maya Profile');
    await page.getByRole('button', { name: /Continue with Google/i }).click();

    // Onboarding modal must require a unique username and reject an already-taken handle
    await page.waitForSelector('[data-testid="username-onboarding-modal"]', { timeout: 10000 });
    await page.getByLabel('Choose username').fill('street_voxel_e2e');
    await page.waitForSelector('[data-testid="onboarding-username-status"]:has-text("already taken")', {
      timeout: 5000
    });
    assert.equal(
      await page.locator('[data-testid="onboarding-save-username-btn"]').isDisabled(),
      true
    );

    // Choose a unique handle + bio and save
    await page.getByLabel('Choose username').fill('maya_skyline');
    await page.getByLabel('Profile bio').fill('3D street artist in SF');
    await page.waitForSelector('[data-testid="onboarding-username-status"]:has-text("available")', {
      timeout: 5000
    });
    await page.locator('[data-testid="onboarding-save-username-btn"]').click();
    await page.waitForSelector('[data-testid="username-onboarding-modal"]', { state: 'detached' });

    // Open own profile, edit username & bio, verify collision check, then save rename
    await page.locator('[data-testid="desktop-profile-btn"]').click();
    await page.waitForSelector('[data-testid="profile-modal"]', { timeout: 10000 });
    assert.equal(await page.locator('[data-testid="profile-handle"]').textContent(), '@maya_skyline');
    await page.locator('[data-testid="profile-edit-btn"]').click();
    await page.getByLabel('Username').fill('mobile_owner');
    await page.waitForSelector('[data-testid="profile-username-status"]:has-text("already taken")', {
      timeout: 5000
    });
    assert.equal(await page.locator('[data-testid="profile-save-btn"]').isDisabled(), true);

    await page.getByLabel('Username', { exact: true }).fill('maya_cyber');
    await page.getByLabel('Bio', { exact: true }).fill('Neon sculptures & AR landmarks');
    // Customize bio image (upload real PNG) and profile header preset in Edit Profile
    const tinyPngBuf = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    await page.getByTestId('profile-avatar-file-input').setInputFiles({
      name: 'maya-icon.png',
      mimeType: 'image/png',
      buffer: tinyPngBuf
    });
    await page.getByRole('button', { name: /Header preset: Sunset Voxel/i }).click();
    await page.waitForSelector('[data-testid="profile-username-status"]:has-text("available")', {
      timeout: 5000
    });
    await page.locator('[data-testid="profile-save-btn"]').click();
    await page.waitForSelector('[data-testid="profile-handle"]:has-text("@maya_cyber")', {
      timeout: 10000
    });
    assert.ok(
      (await page.locator('[data-testid="profile-user-number"]').textContent()).includes('USER #')
    );
    assert.equal(
      await page.locator('[data-testid="public-profile-banner"]').getAttribute('data-header-preset'),
      'sunset-voxel'
    );
    assert.ok(
      (await page.locator('[data-testid="profile-banner-avatar-img"]').getAttribute('src')).startsWith(
        'data:image/'
      )
    );
    await page.waitForSelector('[data-testid="desktop-profile-btn"]:has-text("@maya_cyber")');
    assert.deepEqual(pageErrors, []);
    await context.close();

    // Logged-out public visitor opens ?u=maya_cyber directly -> sees clean banner with user number, username, custom icon & header background
    const mayaPubCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const mayaPubPage = await mayaPubCtx.newPage();
    await mayaPubPage.goto(`${baseUrl}/?u=maya_cyber`, { waitUntil: 'networkidle' });
    await mayaPubPage.waitForSelector('[data-testid="public-profile-banner"]', { timeout: 10000 });
    assert.ok(
      (await mayaPubPage.locator('[data-testid="profile-user-number"]').textContent()).includes(
        'USER #'
      )
    );
    assert.equal(
      await mayaPubPage.locator('[data-testid="public-profile-banner"]').getAttribute('data-header-preset'),
      'sunset-voxel'
    );
    assert.ok(
      (
        await mayaPubPage.locator('[data-testid="profile-banner-avatar-img"]').getAttribute('src')
      ).startsWith('data:image/')
    );
    await mayaPubCtx.close();

    // Logged-out public visitor opens ?u=mobile_owner directly -> sees bio, public land links & actions
    const pubCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pubPage = await pubCtx.newPage();
    const pubErrors = [];
    pubPage.on('pageerror', (err) => pubErrors.push(err.message));

    await pubPage.goto(`${baseUrl}/?u=mobile_owner`, { waitUntil: 'networkidle' });
    await pubPage.waitForSelector('[data-testid="profile-modal"]', { timeout: 10000 });
    assert.equal(await pubPage.locator('[data-testid="profile-handle"]').textContent(), '@mobile_owner');
    assert.ok((await pubPage.locator('[data-testid="profile-bio"]').textContent()).includes('Mobile AR creator'));
    assert.ok((await pubPage.locator('[data-testid="profile-land-public-link"]').count()) >= 1);
    await pubPage.getByRole('tab', { name: /Actions/i }).click();
    assert.ok((await pubPage.locator('[data-testid="profile-action-link"]').count()) >= 1);
    assert.deepEqual(pubErrors, []);
    await pubCtx.close();
  });
});
