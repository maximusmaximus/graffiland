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

    // Clicking inside the welcome card keeps it open
    await page.getByText('What Humans Can Do').click();
    await page.waitForTimeout(300);
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
    await page.getByRole('button', { name: /Intro/i }).click();
    await page.waitForSelector(welcomeSelector);
    await page.getByRole('button', { name: /Connect AI Agent/i }).click();
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    await page.waitForSelector('text=Autonomous AI Agents Connect Without OAuth');
    const selectedTabText = await page.textContent('.desktop-intro-tabs [role="tab"][aria-selected="true"]');
    assert.ok(selectedTabText.includes('Agentic User / AI Steward'));

    // Reopen via Intro button and test "Full Guide" CTA opening Info modal above MapLibre
    await page.getByRole('button', { name: /Intro/i }).click();
    await page.waitForSelector(welcomeSelector);
    await page.getByRole('button', { name: /Full Guide/i }).click();
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
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
    assert.ok(bodyText.includes('Mobile Required for Full Functionality'));
    assert.ok(bodyText.includes('E2E Lighthouse Cube'));

    // Exercise Desktop Intro Banner tabs (Human Creator <-> Collectors & Scouts <-> Agentic User / AI Steward) & Prompt Preview
    await page.getByRole('button', { name: /Copy Property-Agent Prompt/i }).waitFor();
    await page.getByRole('tab', { name: /Collectors & Scouts/i }).click();
    await page.waitForSelector('text=Collect Real-World Verified 3D NFTs');
    await page.getByRole('tab', { name: /Agentic User \/ AI Steward/i }).click();
    await page.waitForSelector('text=Autonomous AI Agents Connect Without OAuth');
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

    // Open Mint Land workspace
    await page.getByRole('button', { name: /Mint Land/i }).first().click();
    await page.waitForSelector('[data-testid="desktop-land-builder-panel"]');
    await page.waitForSelector('[data-testid="land-limits-card"]');

    // Search intersection / coordinate spot and jump map
    const searchInput = page.getByLabel('Search locations, intersections, or businesses');
    await searchInput.fill('37.786, -122.408');
    await page.getByRole('button', { name: /^Find$/i }).click();
    await page.waitForSelector('.map3d-search-item');
    await page.locator('.map3d-search-item').first().click();
    await page.waitForTimeout(350);

    // Activate Draw Land while map is in 2D
    const stage = page.locator('.map3d-stage');
    assert.equal(await stage.getAttribute('data-view-mode'), '2d');
    await page.getByRole('button', { name: /Draw Land/i }).click();
    assert.equal(await stage.getAttribute('data-draw-mode'), 'on');

    // Drag-draw first rectangle directly onto the map -> automatically switches to 3D mode!
    const mapBox = await page.locator('.map-container').boundingBox();
    assert.ok(mapBox && mapBox.width > 200 && mapBox.height > 200);
    const cx = mapBox.x + mapBox.width * 0.54;
    const cy = mapBox.y + mapBox.height * 0.56;
    await page.mouse.move(cx - 32, cy - 32);
    await page.mouse.down();
    await page.mouse.move(cx + 38, cy + 38, { steps: 6 });
    await page.mouse.up();

    await page.waitForSelector('.map3d-stage[data-draft-count="1"]');
    assert.equal(await stage.getAttribute('data-view-mode'), '3d');
    await page.waitForSelector('.map3d-auto3d-pill');

    // Switch Back to 2D cleanly, then to Isometric, rotate & adjust 2D-to-3D tilt
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
    await page.getByLabel('Width (m)').fill('28');
    await page.getByLabel('Depth (m)').fill('22');
    await page.getByLabel('Rotate (°)').fill('30');
    await page.getByLabel('Z-Axis Scale').fill('2');

    const firstItemText = await page.locator('.land-draft-item').first().textContent();
    assert.ok(firstItemText.includes('28×22×36m'), `Expected 28x22x36m in ${firstItemText}`);
    assert.ok(firstItemText.includes('30°'), `Expected 30 deg in ${firstItemText}`);
    assert.ok(firstItemText.includes('616 m²'), `Expected 616 m2 in ${firstItemText}`);

    // Copy Parcel Link & Copy All Properties for Agent
    await page.getByRole('button', { name: /Copy Parcel Link/i }).click();
    await page.waitForSelector('text=/Copied parcel link for GLAND-/i');

    await page.getByRole('button', { name: /Copy All Properties for Agent/i }).click();
    const previewBox = page.getByLabel('Agent properties prompt preview');
    await previewBox.waitFor();
    const agentPrompt = await previewBox.inputValue();
    assert.ok(agentPrompt.includes('Total Selected Properties: 2'));
    assert.ok(agentPrompt.includes('Oriented Corners ([lng, lat]):'));
    assert.ok(agentPrompt.includes('5,000 m²'));
    assert.ok((agentPrompt.match(/GLAND-[0-9A-Z]+/g) || []).length >= 2);

    // Sign in and mint the first square from Desktop
    const initialOwned = Number(await stage.getAttribute('data-owned-count'));
    await page.getByRole('button', { name: /Sign In/i }).first().click();
    await page.getByRole('button', { name: /Continue with Google/i }).click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });

    await page.getByRole('button', { name: /Mint This Land/i }).click();
    await page.waitForSelector('text=/Minted GLAND-/i');
    await page.waitForSelector('.map3d-stage[data-draft-count="1"]');
    const afterOwned = Number(await stage.getAttribute('data-owned-count'));
    assert.equal(afterOwned, initialOwned + 1);

    assert.deepEqual(pageErrors, []);
    await context.close();
  });
});
