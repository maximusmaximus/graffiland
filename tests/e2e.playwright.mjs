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

describe('SPRAY.LAND Desktop Browser E2E (Playwright)', { skip: !hasChrome || !hasDist }, () => {
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

    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginRes.token}` },
      body: JSON.stringify({ username: 'e2e_artist', bio: 'Seeded E2E sculptor' })
    });

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

    const welcomeSelector = '[aria-label="SPRAY.LAND first-visit overview"]';
    const welcomeVisible = await page.isVisible(welcomeSelector);
    assert.equal(welcomeVisible, true);
    // Verify official Voxel Spray Can brand lockup renders in both navbar & intro card, with NO "Welcome"
    assert.equal(await page.locator('.desktop-nav [data-testid="brand-logo-lockup"]').isVisible(), true);
    assert.equal(await page.locator('.welcome-overlay-card [data-testid="brand-logo-lockup"]').isVisible(), true);
    const introCardText = await page.locator('.welcome-overlay-card').textContent();
    assert.equal(/welcome/i.test(introCardText || ''), false, 'Intro card should not say Welcome');
    assert.ok((introCardText || '').includes('icon can give you info about how something works'));
    assert.ok((introCardText || '').includes('Make art in 3D in the real world'));
    assert.ok((introCardText || '').includes('Make art on the land in person IRL, and invite others.'));
    assert.ok((introCardText || '').includes('Invite your agents to add art to the land.'));
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

    // Onboarding omits "Don't show again" checkbox and "Guide & Help" button
    assert.equal(await page.getByRole('checkbox').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Guide & Help/i }).count(), 0);

    // Clicking off card onto the dark backdrop dismisses and persists seen preference
    await page.mouse.click(layerAudit.backdropClickCoord.x, layerAudit.backdropClickCoord.y);
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    const afterBackdropClose = await page.evaluate(() =>
      globalThis.localStorage.getItem('graffiland_first_visit_welcome_seen_v1')
    );
    assert.equal(afterBackdropClose, '1');

    // Returning visitor does not automatically see the welcome overlay on reload
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.maplibregl-ctrl-top-right');
    await page.waitForTimeout(800);
    assert.equal(await page.locator(welcomeSelector).count(), 0);

    // Open Info modal above MapLibre via header Info button, verify Desktop / Mobile / AI Agents tabs & Intro walkthrough reopen
    await page.getByRole('button', { name: /^Info$/i }).click();
    await page.waitForSelector('[data-testid="info-guide-desktop"]');
    await page.waitForSelector('[data-testid="info-guide-tip-callout"]');
    await page.getByTestId('info-guide-agents-tab').click();
    await page.waitForSelector('[data-testid="info-guide-agents"]');
    await page.waitForSelector('text=Wallet / MCP Auth');
    await page.getByTestId('info-reopen-intro-btn').click();
    await page.waitForSelector(welcomeSelector);
    await page.getByRole('button', { name: /Connect AI/i }).click();
    await page.waitForSelector(welcomeSelector, { state: 'detached' });
    await page.waitForSelector('[data-testid="info-guide-agents"]');
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

    // Dismiss initial first-time visitor overlay via magenta Quick Start CTA (verify MINT FREE LAND banner)
    await page.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]');
    const freeLandText = await page.getByTestId('welcome-free-land-banner').textContent();
    assert.ok(freeLandText.includes('MINT FREE LAND by making art!'));
    const quickStartBtn = page.getByTestId('welcome-quick-start-btn');
    assert.ok((await quickStartBtn.textContent()).includes('Quick Start'));
    assert.ok((await quickStartBtn.getAttribute('class')).includes('btn-magenta'));
    await quickStartBtn.click();
    await page.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]', {
      state: 'detached'
    });

    const bodyText = await page.textContent('body');
    assert.ok(bodyText.includes('Desktop Map Explorer'));
    assert.ok(bodyText.includes('Make art in 3D in the real world — make your own land and help develop others.'));
    // Desktop defaults to Land folder tab (larger, emoji icons, no "Around You")
    assert.equal(await page.getByTestId('desktop-nearby-tab-land').getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByTestId('desktop-nearby-tab-sculptures').getAttribute('aria-selected'), 'false');
    const headerText = await page.locator('.desktop-nearby-header').textContent();
    assert.equal(headerText.includes('Around You'), false);
    const folderTabMetrics = await page.evaluate(() => {
      const landBtn = globalThis.document.querySelector('[data-testid="desktop-nearby-tab-land"]');
      const rect = landBtn?.getBoundingClientRect();
      const cs = landBtn ? globalThis.getComputedStyle(landBtn) : null;
      return {
        height: rect?.height || 0,
        topRadius: parseFloat(cs?.borderTopLeftRadius || '0'),
        bottomRadius: parseFloat(cs?.borderBottomLeftRadius || '0'),
        hasIcon: Boolean(landBtn?.querySelector('.xero-icon'))
      };
    });
    assert.ok(folderTabMetrics.height >= 40, `Expected larger folder tab height >= 40px, got ${folderTabMetrics.height}`);
    assert.ok(folderTabMetrics.topRadius >= 10 && folderTabMetrics.bottomRadius === 0, `Expected folder tab corners, got ${JSON.stringify(folderTabMetrics)}`);
    assert.equal(folderTabMetrics.hasIcon, true);

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

    // Exercise Land <-> Sculptures folder tabs: Land is default, selecting a sculpture zooms map into its land and stays there after closing
    await page.waitForSelector('[data-testid="desktop-nearby-lands-list"]');
    const firstLandCard = page.getByTestId('desktop-land-item').first();
    await firstLandCard.click();
    assert.equal(await firstLandCard.getAttribute('data-selected'), 'true');
    await page.getByTestId('desktop-nearby-tab-sculptures').click();
    await page.waitForSelector('[data-testid="desktop-nearby-sculptures-list"]');
    const lighthouseBtn = page
      .locator('[data-testid="desktop-nearby-sculptures-list"] button')
      .filter({ hasText: 'E2E Lighthouse Cube' })
      .first();
    await lighthouseBtn.click();
    await page.waitForSelector('[aria-label="Close sculpture details"]');
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /Close sculpture details/i }).click();
    await page.waitForSelector('[aria-label="Close sculpture details"]', { state: 'detached' });
    const postCloseMap = await page.evaluate(() => {
      const stage = globalThis.document.querySelector('.map3d-stage');
      return {
        selectedParcelId: stage?.getAttribute('data-selected-parcel-id') || '',
        focusParcelId: stage?.getAttribute('data-focus-parcel-id') || '',
        focusZoom: Number(stage?.getAttribute('data-focus-zoom') || 0),
        liveZoom: Number(stage?.getAttribute('data-map-zoom') || 0)
      };
    });
    assert.ok(postCloseMap.selectedParcelId.startsWith('GLAND-'), `Expected selected land parcel after closing sculpture, got ${JSON.stringify(postCloseMap)}`);
    assert.equal(postCloseMap.focusParcelId, postCloseMap.selectedParcelId);
    assert.ok(postCloseMap.focusZoom >= 17.5, `Expected zoomed focus >= 17.5, got ${JSON.stringify(postCloseMap)}`);
    assert.ok(postCloseMap.liveZoom >= 17.0, `Expected live map zoomed into land >= 17.0 after closing sculpture, got ${JSON.stringify(postCloseMap)}`);

    // Switch sidebar tabs: Market -> Gallery -> Leaders -> List (Quests tab hidden)
    assert.equal(await page.getByRole('button', { name: /Quests/i }).count(), 0);

    await page.getByRole('button', { name: /Market/i }).click();
    await page.waitForSelector('[aria-label="SPRAY.LAND Marketplace"]');
    const marketText = await page.textContent('[aria-label="SPRAY.LAND Marketplace"]');
    assert.ok(marketText.includes('5% Platform'));
    assert.ok(marketText.includes('3% Agent Steward'));
    assert.ok(marketText.includes('2% Human Contributors Pool'));
    assert.ok(marketText.includes('Bot Plinth Stage'));

    await page.getByRole('button', { name: /Gallery/i }).click();
    await page.waitForSelector('[data-testid="desktop-gallery-grid"]');
    await page.waitForSelector('[data-testid="desktop-gallery-card"]');
    const galleryThumbCount = await page.locator('[data-testid="gallery-sculpture-thumb"]').count();
    assert.ok(galleryThumbCount >= 1, `Expected gallery sculpture thumbnails >= 1, got ${galleryThumbCount}`);
    // Wait for WebGL 3D thumbnail image (or instant voxel SVG preview) to render cleanly
    await page.waitForSelector(
      '[data-testid="gallery-sculpture-thumb"] img.gallery-thumb-img, [data-testid="gallery-sculpture-thumb"] svg.gallery-thumb-svg',
      { timeout: 10000 }
    );
    // Clicking a Gallery thumbnail card loads that exact sculpture in SculptureModal
    const firstGalleryCard = page.locator('[data-testid="desktop-gallery-card"]').first();
    const expectedGalleryTitle = (
      await firstGalleryCard.locator('.gallery-card-title').textContent()
    ).trim();
    await firstGalleryCard.click();
    await page.waitForSelector('[data-testid="sculpture-modal"]', { timeout: 10000 });
    const modalHeading = (
      await page.locator('[data-testid="sculpture-modal"] .modal-title').first().textContent()
    ).trim();
    assert.ok(
      modalHeading.includes(expectedGalleryTitle),
      `Expected SculptureModal to load "${expectedGalleryTitle}", got "${modalHeading}"`
    );
    await page.getByRole('button', { name: /Close sculpture details/i }).click();
    await page.waitForSelector('[data-testid="sculpture-modal"]', { state: 'detached' });

    await page.getByRole('button', { name: /Leaders/i }).click();
    await page.waitForSelector('[aria-label="Creator Leaderboard"]');
    const leaderText = await page.textContent('[aria-label="Creator Leaderboard"]');
    // Must refer to human creators ONLY by chosen @username (never raw Google display name)
    assert.ok(leaderText.includes('@e2e_artist'), `Expected @e2e_artist in leaderboard, got: ${leaderText}`);
    assert.ok(!leaderText.includes('E2E Artist'), 'Leaderboard must never expose Google first/last name');
    assert.ok(leaderText.includes('Playwright Bot Steward'));

    // Open Pairing modal and verify it stacks above Leaflet with MCP expanded
    await page.getByTestId('nav-pair-phone-btn').click();
    await page.waitForSelector('[data-testid="pair-phone-modal"]');
    await page.waitForSelector('[data-testid="pair-agent-structured-steps"]');
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

    // Navigate via deep link ?sculpture=<id> (logged-out first visit shows clean direct-link intro)
    assert.ok(seededSculptureId);
    await page.goto(`${baseUrl}/?sculpture=${encodeURIComponent(seededSculptureId)}`, {
      waitUntil: 'networkidle'
    });
    await page.waitForSelector('[data-testid="direct-link-intro-card"]');
    await page.locator('[data-testid="direct-link-intro-close-btn"]').click();
    await page.waitForSelector('[data-testid="direct-link-intro-card"]', { state: 'detached' });
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
    await page1.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]');
    await page1.waitForTimeout(1000);

    assert.equal(await page1.isVisible('[aria-label="SPRAY.LAND first-visit overview"]'), true);
    assert.equal(await page1.locator('[aria-label="SPRAY.LAND Quick Start Guide"]').count(), 0);
    assert.equal(await page1.getByRole('button', { name: /Quick Camera Guide/i }).count(), 0);
    assert.equal(await page1.getByRole('button', { name: /Skip to Camera/i }).count(), 0);
    assert.equal(await page1.getByRole('button', { name: /Guide & Help/i }).count(), 0);
    assert.equal(await page1.getByRole('checkbox').count(), 0);
    const scrollW = await page1.evaluate(() => globalThis.document.documentElement.scrollWidth);
    assert.ok(scrollW <= 391, `Expected mobile overlay width <= 391px, got ${scrollW}`);

    await page1.getByRole('button', { name: /Next Step \(2\/3\)/i }).click();
    await page1.getByRole('button', { name: /Next Step \(3\/3\)/i }).click();
    await page1.getByTestId('welcome-get-started-btn').click();
    await page1.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]', {
      state: 'detached'
    });
    assert.equal(await page1.locator('[aria-label="SPRAY.LAND Quick Start Guide"]').count(), 0);
    assert.deepEqual(errors1, []);
    await ctx1.close();

    const ctx2 = await browser.newContext(mobileOptions);
    const page2 = await ctx2.newPage();
    const errors2 = [];
    page2.on('pageerror', (err) => errors2.push(err.message));

    await page2.goto(baseUrl, { waitUntil: 'networkidle' });
    await page2.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]');
    await page2.getByRole('button', { name: /Close intro/i }).click();
    await page2.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]', {
      state: 'detached'
    });
    assert.equal(await page2.locator('[aria-label="SPRAY.LAND Quick Start Guide"]').count(), 0);
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

    // Mobile Studio bottom-right Paint & Brush Kit floats ABOVE the center tool carousel (leaving active tool visible),
    // keeps Brush/Pencil/Eraser exclusively in the center bottom tool switcher, and minimizes back to icon on click-off
    await page2.waitForSelector('[data-testid="palette-options-toggle"]');
    await page2.getByTestId('palette-options-toggle').click();
    await page2.waitForSelector('[data-testid="brush-options-popup"]');
    const popBox = await page2.getByTestId('brush-options-popup').boundingBox();
    const carouselBox = await page2.getByTestId('key-carousel').boundingBox();
    assert.ok(
      popBox && popBox.x >= 0 && popBox.x + popBox.width <= 390 && popBox.y >= 0,
      `Expected Paint & Brush Kit cleanly inside 390x844 viewport, got ${JSON.stringify(popBox)}`
    );
    assert.ok(
      carouselBox && popBox.y + popBox.height <= carouselBox.y + 1,
      `Expected Paint & Brush Kit above center tool button (${JSON.stringify(popBox)} vs ${JSON.stringify(carouselBox)})`
    );
    // Brush, Pencil, and Eraser options must NOT live inside the palette
    assert.equal(await page2.locator('[data-testid="palette-select-brush"]').count(), 0);
    assert.equal(await page2.locator('[data-testid="palette-select-pencil"]').count(), 0);
    assert.equal(await page2.locator('[data-testid="palette-select-erase"]').count(), 0);

    await page2.getByTestId('block-size-l').click();
    await page2.getByRole('button', { name: 'Color Red' }).click();

    // Clicking off the Paint & Brush Kit onto open viewport minimizes it cleanly back to its icon
    await page2.mouse.click(40, 180);
    await page2.waitForSelector('[data-testid="brush-options-popup"]', { state: 'detached' });

    // Tool switching (Brush, Pencil, Erase) lives strictly in the center bottom button carousel
    await page2.locator('[data-tool-rel="1"]').click();
    await page2.waitForSelector('.key-tool-caption:has-text("Pencil")');
    await page2.locator('[data-tool-rel="1"]').click();
    await page2.waitForSelector('.key-tool-caption:has-text("Erase")');
    // Switching back to Brush for the first time triggers the Spray-Can Brush intro popup once
    await page2.locator('[data-tool-rel="-1"]').click();
    await page2.waitForSelector('.key-tool-caption:has-text("Pencil")');
    await page2.locator('[data-tool-rel="-1"]').click();
    await page2.waitForSelector('[data-testid="spray-brush-guide-modal"]', { timeout: 5000 });
    await page2.getByTestId('spray-brush-guide-start-btn').click();
    await page2.waitForSelector('[data-testid="spray-brush-guide-modal"]', { state: 'detached' });
    // Switching back to Brush a second time must NOT re-open the first-time guide popup
    await page2.locator('[data-tool-rel="1"]').click();
    await page2.waitForSelector('.key-tool-caption:has-text("Pencil")');
    await page2.locator('[data-tool-rel="-1"]').click();
    await page2.waitForSelector('.key-tool-caption:has-text("Brush")');
    assert.equal(await page2.locator('[data-testid="spray-brush-guide-modal"]').count(), 0);

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
    await page.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]');
    await page.getByRole('button', { name: /Quick Start/i }).click();
    await page.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]', {
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
    await page.waitForSelector('.modal-title');
    const openedSculptureTitle = (await page.locator('.modal-title').first().textContent()).trim();
    assert.ok(openedSculptureTitle.length > 0);
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

    // Verify broken Connect Agent button is removed, Pairing label is concise & glows, and Pairing modal opens with MCP Agent Pairing already expanded
    assert.equal(await page.locator('.desktop-nav').getByRole('button', { name: /Connect Agent/i }).count(), 0);
    assert.equal(await page.locator('.desktop-nav').getByRole('button', { name: /Last Viewed/i }).count(), 0);
    const pairNavBtn = page.getByTestId('nav-pair-phone-btn');
    assert.equal((await pairNavBtn.textContent()).trim(), 'Pairing');
    assert.ok((await pairNavBtn.getAttribute('class')).includes('btn-pair-glow'));
    await pairNavBtn.click();
    await page.waitForSelector('[data-testid="pair-phone-modal"]');
    await page.waitForSelector('[data-testid="pair-agent-structured-steps"]');
    assert.equal(await page.getByTestId('pair-agent-reveal-toggle').getAttribute('aria-expanded'), 'true');
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
    assert.equal(await stage.getAttribute('data-canvas-drag'), 'orbit');
    await page.waitForSelector('[data-testid="map3d-orbit-pan-toggle"]');

    // Click and drag on blank canvas around the drawn land -> rotates & tilts the map smoothly around it!
    const bearingBeforeOrbit = Number(await stage.getAttribute('data-bearing'));
    const orbitStartX = mapBox.x + mapBox.width * 0.14;
    const orbitStartY = mapBox.y + mapBox.height * 0.55;
    await page.mouse.move(orbitStartX, orbitStartY);
    await page.mouse.down();
    await page.mouse.move(orbitStartX + 95, orbitStartY - 24, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const bearingAfterOrbit = Number(await stage.getAttribute('data-bearing'));
    assert.notEqual(
      bearingAfterOrbit,
      bearingBeforeOrbit,
      `Expected canvas click-drag around drawn land to rotate map bearing (${bearingBeforeOrbit} -> ${bearingAfterOrbit})`
    );
    // Reset back to Isometric orientation before exercising gizmo handle coordinates
    await page.locator('.map3d-toolbar').getByRole('button', { name: /^Isometric$/i }).click();
    await page.waitForTimeout(220);
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

    // 1c) Pulling a TOP rim bar UP raises cube height and pulling it DOWN lowers cube height (not footprint in/out!)
    gizmo = await readGizmo();
    assert.ok(Array.isArray(gizmo.topBar0), 'Expected topBar0 coords in data-active-gizmo');
    const zBeforeTopBarUp = Number(await page.getByLabel('Z-Axis Scale').inputValue());
    await page.mouse.move(mapBox.x + gizmo.topBar0[0], mapBox.y + gizmo.topBar0[1]);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + gizmo.topBar0[0], mapBox.y + gizmo.topBar0[1] - 42, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const zAfterTopBarUp = Number(await page.getByLabel('Z-Axis Scale').inputValue());
    assert.ok(
      zAfterTopBarUp > zBeforeTopBarUp,
      `Expected pulling top bar UP to raise cube height (${zBeforeTopBarUp} -> ${zAfterTopBarUp})`
    );

    gizmo = await readGizmo();
    await page.mouse.move(mapBox.x + gizmo.topBar0[0], mapBox.y + gizmo.topBar0[1]);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + gizmo.topBar0[0], mapBox.y + gizmo.topBar0[1] + 72, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const zAfterTopBarDown = Number(await page.getByLabel('Z-Axis Scale').inputValue());
    assert.ok(
      zAfterTopBarDown < zAfterTopBarUp,
      `Expected pulling top bar DOWN to lower cube height (${zAfterTopBarUp} -> ${zAfterTopBarDown})`
    );

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

    // Verify scale-to-limit & max-height controls keep parcel valid AND auto-zoom out so the top rectangle stays visible & draggable!
    await page.getByRole('button', { name: /Max Limit Size/i }).click();
    await page.getByRole('button', { name: /Max Height/i }).click();
    await page.waitForTimeout(550);
    const scaledText = await page.locator('.land-draft-item').first().textContent();
    assert.ok(scaledText.includes('Ready'), `Expected Max Limit Size + Max Height to remain valid Ready, got: ${scaledText}`);

    const tallGizmo = await readGizmo();
    assert.ok(
      tallGizmo && Array.isArray(tallGizmo.topBar0) && tallGizmo.topBar0[1] >= 28 && tallGizmo.topBar0[1] < mapBox.height - 20,
      `Expected map to zoom out so Max Height top rectangle stays visibly inside viewport (topBar0=${JSON.stringify(tallGizmo?.topBar0)}, h=${mapBox.height})`
    );
    assert.ok(
      Array.isArray(tallGizmo.heightHandle) && tallGizmo.heightHandle[1] >= 12,
      `Expected Max Height ↕ handle to stay visible inside viewport (heightHandle=${JSON.stringify(tallGizmo?.heightHandle)})`
    );

    // Verify explicit Zoom Out, Fit Draft, and Zoom In toolbar buttons work cleanly while drafting
    const zoomBeforeOut = Number(await stage.getAttribute('data-map-zoom'));
    await page.getByTestId('map3d-zoom-out-btn').click();
    await page.waitForFunction(
      (prev) => {
        const z = Number(globalThis.document.querySelector('.map3d-stage')?.getAttribute('data-map-zoom') || 0);
        return z > 0 && z < prev - 0.5;
      },
      zoomBeforeOut,
      { timeout: 5000 }
    );
    await page.getByTestId('map3d-fit-draft-btn').click();
    await page.waitForTimeout(650);
    const fitGizmo = await readGizmo();
    assert.ok(
      fitGizmo && Array.isArray(fitGizmo.topBar0) && fitGizmo.topBar0[1] >= 28,
      `Expected Fit Draft button to keep drafted land top rectangle clearly visible (topBar0=${JSON.stringify(fitGizmo?.topBar0)})`
    );
    const zoomBeforeIn = Number(await stage.getAttribute('data-map-zoom'));
    await page.getByTestId('map3d-zoom-in-btn').click();
    await page.waitForFunction(
      (prev) => {
        const z = Number(globalThis.document.querySelector('.map3d-stage')?.getAttribute('data-map-zoom') || 0);
        return z > prev + 0.5;
      },
      zoomBeforeIn,
      { timeout: 5000 }
    );

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

    // After minting: floating pin layer sits strictly ABOVE wireframes with "+" button & label Copy Link!
    await page.waitForSelector('.map3d-floating-pins-layer .map3d-owned-plus-btn', { timeout: 6000 });
    await page.waitForSelector('.land-owned-plus-btn', { timeout: 6000 });
    // Newly minted empty land shows a quick Copy Link button right on the floating land label on top of the land
    const mapLabelCopyBtn = page
      .locator('[data-testid="map3d-land-copy-btn"][aria-label*="Skyline Studio Plot"]')
      .first();
    await mapLabelCopyBtn.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(
      (await mapLabelCopyBtn.textContent()).includes('Copy'),
      `Expected empty minted land top label to expose Copy button, got: ${await mapLabelCopyBtn.textContent()}`
    );
    await mapLabelCopyBtn.click();
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="map3d-land-copy-btn"][aria-label*="Skyline Studio Plot"]')
          ?.textContent?.includes('Copied'),
      null,
      { timeout: 4000 }
    );

    await page.locator('.map3d-owned-plus-btn').first().click();
    await page.waitForSelector('.add-item-modal-card');
    // AI Agent Prompt appears strictly ABOVE the collapsed Add Manually fold-down
    const agentBox = await page.getByTestId('add-item-agent-section').boundingBox();
    const manualToggleLoc = page.getByTestId('add-item-manual-toggle');
    const manualBox = await manualToggleLoc.boundingBox();
    assert.ok(agentBox && manualBox && agentBox.y < manualBox.y, 'Expected Agent Prompt above Add Manually fold-down');
    assert.equal(await manualToggleLoc.getAttribute('aria-expanded'), 'false');

    const itemPromptVal = await page.getByLabel('Add 3D item agent prompt preview').inputValue();
    assert.ok(itemPromptVal.includes('load_3d_model_on_land'));
    assert.ok(itemPromptVal.includes('update_land_sculpture'));
    assert.ok(itemPromptVal.includes('set_sculpture_visibility'));
    assert.ok(itemPromptVal.includes('update_land_settings'));
    await page.getByRole('button', { name: /Copy 3D Item Agent Prompt/i }).click();
    await page.waitForSelector('[data-testid="copy-validation-confirmed"]');
    await page.waitForSelector('text=/Copied 3D item agent prompt/i');

    // Expand Add Manually fold-down -> format radio & URL uploader appear
    await manualToggleLoc.click();
    assert.equal(await manualToggleLoc.getAttribute('aria-expanded'), 'true');
    await page.getByRole('radio', { name: /\.GLB 3D Model/i }).click();

    // Freeze the newly minted land directly from the modal -> button updates to Unfreeze Land
    await page.locator('.add-item-modal-card').getByRole('button', { name: /Freeze Land/i }).click();
    await page.locator('.add-item-modal-card').getByRole('button', { name: /Unfreeze Land/i }).waitFor();
    await page.getByRole('button', { name: /Close add 3D item modal/i }).click();

    // Open Profile -> verify Last Viewed items & Action History (mint/freeze) live under Profile
    await page.getByTestId('desktop-profile-btn').click();
    await page.waitForSelector('[data-testid="profile-modal"]', { timeout: 10000 });
    await page.getByTestId('profile-tab-last-viewed').click();
    await page.waitForSelector('[data-testid="profile-last-viewed-list"]');
    const viewedProfileText = await page.getByTestId('profile-last-viewed-list').textContent();
    assert.ok(
      viewedProfileText.includes(openedSculptureTitle),
      `Expected "${openedSculptureTitle}" in Profile Last Viewed, got: ${viewedProfileText}`
    );
    await page.getByTestId('profile-tab-actions').click();
    await page.waitForSelector('[data-testid="profile-actions-list"]');
    const actionsProfileText = await page.getByTestId('profile-actions-list').textContent();
    assert.ok(actionsProfileText.includes('History of Actions'), `Expected History of Actions heading, got: ${actionsProfileText}`);
    assert.ok(actionsProfileText.includes('Skyline Studio Plot'), `Expected Skyline Studio Plot action in Profile Action History, got: ${actionsProfileText}`);
    await page.getByRole('button', { name: /Close profile/i }).click();

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
    await page.getByRole('button', { name: /Quick Start/i }).click();
    await page.waitForSelector('[aria-label="SPRAY.LAND first-visit overview"]', {
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

    // Verify minted land has on-map copy share link icon & Land Management stays hidden until paired
    await page.waitForSelector('.map3d-parcel-share-btn');
    assert.equal(
      await page.locator('.desktop-nav').getByRole('button', { name: /Land Management/i }).count(),
      0,
      'Expected Land Management tab to remain hidden before user has paired'
    );

    // Pair the user's account (MCP pairing connected) -> Land Management tab appears immediately
    await page.evaluate(async () => {
      const token = localStorage.getItem('graffiland_jwt') || '';
      const created = await fetch('/api/mcp/pairings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({})
      }).then((r) => r.json());
      const code = created?.pairing?.code;
      if (code) {
        await fetch('/api/mcp/pairings/connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ pairingCode: code, agentName: 'e2e-land-agent' })
        });
      }
    });
    // Trigger immediate pairing refresh via opening & closing Pairing modal
    await page.getByTestId('nav-pair-phone-btn').click();
    await page.waitForSelector('[data-testid="pair-phone-modal"]');
    await page.getByRole('button', { name: /Close pairing modal/i }).click();
    await page.waitForSelector('[data-testid="nav-land-management-btn"]', { timeout: 10000 });

    await page.locator('.desktop-nav').getByRole('button', { name: /Land Management/i }).click();
    await page.waitForSelector('[aria-label="Land Management"]');

    // Verify Isometric Geographic Preview renders cleanly and updates when selecting another land
    const isoPreview = page.getByTestId('land-mgmt-iso-preview');
    await isoPreview.waitFor({ state: 'visible' });
    const firstPreviewParcelId = await isoPreview.getAttribute('data-parcel-id');
    assert.ok(firstPreviewParcelId && firstPreviewParcelId.startsWith('GLAND-'));
    assert.equal(await isoPreview.getAttribute('data-view-mode'), 'isometric');
    assert.ok((await page.getByTestId('land-preview-coords').textContent()).includes('°'));
    assert.match(await page.getByTestId('land-preview-scale').textContent(), /\b(ft|mi)\b/);

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
    await farPage.waitForSelector('[data-testid="direct-link-intro-card"]');
    await farPage.locator('[data-testid="direct-link-intro-close-btn"]').click();
    await farPage.waitForSelector('[data-testid="mobile-parcel-visit-view"]');
    await farPage.waitForSelector('[data-testid="parcel-proximity-far"]');
    await farPage.getByRole('link', { name: /Navigate/i }).waitFor();
    const farHeaderState = await farPage.evaluate(() => {
      const header = globalThis.document.querySelector('[data-testid="plot-visit-header"]');
      return {
        text: header?.textContent || '',
        btnCount: header?.querySelectorAll('button').length || 0,
        hasStatus: Boolean(header?.querySelector('[data-testid="plot-status-badge"]')),
        hasShare: Boolean(header?.querySelector('[data-testid="plot-share-btn"]')),
        hasClose: Boolean(header?.querySelector('[data-testid="plot-close-btn"]'))
      };
    });
    assert.equal(farHeaderState.btnCount, 2, 'Land top bar must only have Share and Close buttons');
    assert.equal(farHeaderState.hasStatus, true);
    assert.equal(farHeaderState.hasShare, true);
    assert.equal(farHeaderState.hasClose, true);
    assert.equal(farHeaderState.text.includes('37.7749'), false, 'Coords must be inside the "i" icon, not top bar');
    assert.equal(farHeaderState.text.includes('ft'), false, 'Dimensions must be inside the "i" icon, not top bar');
    await farPage.locator('[data-testid="parcel-directions-info"] button').click();
    await farPage.waitForSelector('[data-testid="plot-info-coords"]');
    await farPage.waitForSelector('[data-testid="plot-info-dimensions"]');
    const farOrder = await farPage.evaluate(() => {
      const dist = globalThis.document.querySelector('[data-testid="parcel-proximity-far"]')?.getBoundingClientRect();
      const nav = globalThis.document.querySelector('[data-testid="parcel-directions-row"] a')?.getBoundingClientRect();
      return { distLeft: dist?.left ?? 9999, navLeft: nav?.left ?? 0 };
    });
    assert.ok(
      farOrder.distLeft < farOrder.navLeft,
      `Expected distance tag on the left of Navigate button, got ${JSON.stringify(farOrder)}`
    );
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
    await nearPage.waitForSelector('[data-testid="direct-link-intro-card"]');
    await nearPage.locator('[data-testid="direct-link-intro-close-btn"]').click();
    await nearPage.waitForSelector('[data-testid="parcel-proximity-near"]');
    await nearPage.getByRole('button', { name: /View in AR/i }).waitFor();
    await nearPage.getByRole('button', { name: /Make Art on This Property/i }).waitFor();

    // Clicking "View in AR" opens clean AR land view (ZERO greyscale mapping grid, ZERO occlusion canvas, ZERO mapping HUD)
    await nearPage.getByRole('button', { name: /View in AR/i }).click();
    await nearPage.waitForSelector('[data-testid="ar-land-inspector"]', { timeout: 10000 });
    await nearPage.getByTestId('ar-land-exit-top-btn').waitFor({ state: 'visible', timeout: 5000 });
    const viewInArState = await nearPage.evaluate(() => ({
      exitLabel: globalThis.document.querySelector('[data-testid="ar-land-exit-top-btn"]')?.textContent?.trim() || '',
      arViewOnlyAttr: globalThis.document.querySelector('.webgl-overlay')?.getAttribute('data-ar-view-only'),
      greyGridCount: globalThis.document.querySelectorAll('.mapping-grayscale-grid').length,
      occlusionCount: globalThis.document.querySelectorAll('.occlusion-overlay').length,
      scanBoxCount: globalThis.document.querySelectorAll('.scene-scan-box').length,
      carouselCount: globalThis.document.querySelectorAll('.key-carousel').length,
      dockToggleCount: globalThis.document.querySelectorAll('.floating-tools-toggle').length,
      reticleCount: globalThis.document.querySelectorAll('.reticle').length,
      surfacePillCount: globalThis.document.querySelectorAll('.surface-pill').length
    }));
    assert.equal(viewInArState.arViewOnlyAttr, 'true', 'AR viewport must be in clean arViewOnly mode');
    assert.equal(viewInArState.greyGridCount, 0, 'Mapping greyscale grid must NOT render in View in AR');
    assert.equal(viewInArState.occlusionCount, 0, 'Occlusion mapping canvas must NOT render in View in AR');
    assert.equal(viewInArState.scanBoxCount, 0, 'SceneCoverageWidget must NOT render in View in AR');
    assert.equal(viewInArState.carouselCount, 0, 'Drawing tool carousel must NOT render in View in AR');
    assert.equal(viewInArState.dockToggleCount, 0, 'Drawing dock toggle must NOT render in View in AR');
    assert.equal(viewInArState.reticleCount, 0, 'Drawing reticle must NOT render in View in AR');
    assert.equal(viewInArState.surfacePillCount, 0, 'Surface mapping pill must NOT render in View in AR');
    assert.ok(
      viewInArState.exitLabel.includes('Back') && !viewInArState.exitLabel.includes('Draw'),
      `Expected clean Back button label from View in AR, got "${viewInArState.exitLabel}"`
    );

    // Tapping empty sky during View in AR must NOT drop user into mapping camera
    await nearPage.mouse.click(195, 110);
    await nearPage.waitForTimeout(150);
    assert.equal(await nearPage.locator('[data-testid="ar-land-inspector"]').count(), 1);
    assert.equal(await nearPage.locator('.mapping-grayscale-grid').count(), 0);
    assert.equal(await nearPage.locator('.scene-scan-box').count(), 0);

    // Clicking Back returns cleanly to the Plot Visit View (never dumping into mapping camera)
    await nearPage.getByTestId('ar-land-exit-top-btn').click();
    await nearPage.waitForSelector('[data-testid="mobile-parcel-visit-view"]', { timeout: 10000 });
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

    // Verify cards start compact/closed with Share button on the right top and US imperial units (ft/mi)
    const closedCardMetrics = await hubPage.evaluate(() => {
      const cards = Array.from(globalThis.document.querySelectorAll('[data-testid="mobile-land-card"]'));
      return cards.map((card) => {
        const cardRect = card.getBoundingClientRect();
        const shareBtn = card.querySelector('[data-testid="land-card-share-btn"]');
        const shareRect = shareBtn?.getBoundingClientRect();
        return {
          expanded: card.getAttribute('data-expanded'),
          height: Math.round(cardRect.height),
          hasShareAtTopRight:
            Boolean(shareRect) &&
            shareRect.right >= cardRect.right - 20 &&
            shareRect.top <= cardRect.top + 24,
          distText: card.querySelector('[data-testid="land-distance-badge"]')?.textContent || ''
        };
      });
    });
    assert.ok(
      closedCardMetrics.every((m) => m.expanded === 'false'),
      `Expected all nearest land cards to start compact/closed, got: ${JSON.stringify(closedCardMetrics)}`
    );
    assert.ok(
      closedCardMetrics.every((m) => m.height <= 96),
      `Expected compact closed land cards <= 96px tall, got: ${JSON.stringify(closedCardMetrics)}`
    );
    assert.ok(
      closedCardMetrics.every((m) => m.hasShareAtTopRight),
      `Expected Share button at top-right of every closed card, got: ${JSON.stringify(closedCardMetrics)}`
    );
    assert.ok(
      closedCardMetrics.some((m) => /\b(ft|mi)\b/i.test(m.distText)),
      `Expected US location to default to feet/miles, got: ${JSON.stringify(closedCardMetrics)}`
    );

    // Verify expiration badges render ONLY for dormant countdowns (Permanent label is hidden!)
    const expTexts = await hubPage.locator('[data-testid="land-expiration-badge"]').allTextContents();
    assert.ok(
      expTexts.some((t) => /\bleft\b/i.test(t)),
      `Expected a dormant land expiration countdown badge, got: ${JSON.stringify(expTexts)}`
    );
    assert.equal(
      expTexts.some((t) => /Permanent/i.test(t)),
      false,
      `Did not expect redundant Permanent badge, got: ${JSON.stringify(expTexts)}`
    );

    // Clicking the rank number (#1) focuses that land on top map AND opens the card
    await landCards.first().getByTestId('land-card-rank-btn').click();
    assert.equal(await landCards.first().getAttribute('data-expanded'), 'true');
    const firstNavLink = landCards.first().getByTestId('land-google-maps-link');
    assert.ok((await firstNavLink.textContent()).includes('Navigate'));
    assert.equal((await firstNavLink.textContent()).includes('Google Maps'), false);
    const firstHref = await firstNavLink.getAttribute('href');
    assert.ok(firstHref && firstHref.startsWith('https://www.google.com/maps/dir/?api=1&destination='));

    // Clicking the triangle on card #2 opens it separately (and clicking again closes it)
    await landCards.nth(1).getByTestId('land-card-expand-toggle').click();
    assert.equal(await landCards.nth(1).getAttribute('data-expanded'), 'true');
    const secondHref = await landCards.nth(1).getByTestId('land-google-maps-link').getAttribute('href');
    assert.ok(secondHref && secondHref.startsWith('https://www.google.com/maps/dir/?api=1&destination='));

    // Verify nested sculptures render under expanded lands with metadata and tapping 3D opens SculptureModal above the map
    const sculptureItems = hubPage.locator('[data-testid="land-sculpture-item"]');
    assert.ok((await sculptureItems.count()) >= 1, 'Expected at least 1 nested sculpture under a land');
    const firstScText = await sculptureItems.first().textContent();
    assert.ok(/blocks|3D/i.test(firstScText || ''));

    // Verify Nearest Lands opens in 3D isometric view by default, is a 1:1 square on mobile, and has zero horizontal overflow
    await hubPage.waitForSelector('[data-testid="mobile-iso-3d-map"]', { timeout: 10000 });
    await hubPage.getByTestId('mobile-map-2d-toggle-btn').waitFor({ state: 'visible', timeout: 5000 });
    const default3dMetrics = await hubPage.evaluate(() => {
      const box = globalThis.document
        .querySelector('[data-testid="mobile-map-canvas"]')
        ?.getBoundingClientRect();
      return {
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        width: Math.round(box?.width || 0),
        height: Math.round(box?.height || 0)
      };
    });
    assert.ok(
      default3dMetrics.scrollWidth <= 391,
      `Expected mobile map scrollWidth <= 391, got ${default3dMetrics.scrollWidth}`
    );
    assert.ok(
      default3dMetrics.width >= 300 &&
        default3dMetrics.height >= 300 &&
        Math.abs(default3dMetrics.width - default3dMetrics.height) <= 4,
      `Expected mobile Nearest Lands map to be a 1:1 square, got ${default3dMetrics.width}x${default3dMetrics.height}`
    );
    await hubPage.getByTestId('mobile-map-orbit-btn').click();

    // Switch 3D -> 2D in compact mode -> verify square Leaflet map focused on #1 with neighbor edge arrows, then back to 3D
    await hubPage.getByTestId('mobile-map-2d-toggle-btn').click();
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').waitFor({ state: 'visible', timeout: 5000 });
    const mapMetrics = await hubPage.evaluate(() => {
      const leaflet = globalThis.document.querySelector('.mobile-map-canvas .leaflet-container');
      const rect = leaflet?.getBoundingClientRect();
      return {
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        leafletWidth: Math.round(rect?.width || 0),
        leafletHeight: Math.round(rect?.height || 0),
        landLabelCount: globalThis.document.querySelectorAll('[data-testid="map-land-label"]').length,
        neighborArrowCount: globalThis.document.querySelectorAll('[data-testid="neighbor-edge-arrow"]').length
      };
    });
    assert.ok(
      mapMetrics.scrollWidth <= 391,
      `Expected mobile 2D map scrollWidth <= 391, got ${mapMetrics.scrollWidth}`
    );
    assert.ok(
      mapMetrics.leafletWidth >= 300 &&
        mapMetrics.leafletHeight >= 300 &&
        Math.abs(mapMetrics.leafletWidth - mapMetrics.leafletHeight) <= 4,
      `Expected compact 2D mobile Leaflet map to stay square, got ${mapMetrics.leafletWidth}x${mapMetrics.leafletHeight}`
    );
    assert.ok(
      mapMetrics.landLabelCount === 1 && mapMetrics.neighborArrowCount >= 1,
      `Expected focused 2D map (1 focused land label + >=1 neighbor edge arrow after clicking #1), got labels=${mapMetrics.landLabelCount}, arrows=${mapMetrics.neighborArrowCount}`
    );
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-iso-3d-map"]', { timeout: 10000 });

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
    // Switch back to 3D then collapse full-screen cleanly back to split square Nearest Lands view
    await hubPage.getByTestId('mobile-map-3d-toggle-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-iso-3d-map"]', { timeout: 5000 });
    await hubPage.getByTestId('mobile-map-fullscreen-btn').click();
    await hubPage.waitForSelector('[data-testid="mobile-nearest-lands-list"]', { timeout: 5000 });
    const collapsedMetrics = await hubPage.evaluate(() => {
      const box = globalThis.document
        .querySelector('[data-testid="mobile-map-canvas"]')
        ?.getBoundingClientRect();
      return {
        width: Math.round(box?.width || 0),
        height: Math.round(box?.height || 0)
      };
    });
    assert.ok(
      Math.abs(collapsedMetrics.width - collapsedMetrics.height) <= 4,
      `Expected collapsed map to return to 1:1 square, got ${collapsedMetrics.width}x${collapsedMetrics.height}`
    );

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
    assert.equal(await hubPage.getByRole('button', { name: /Focus Map/i }).count(), 0);
    // Clicking non-owned property name targets that land on the top map cleanly
    const otherTargetBtn = otherCards.first().locator('[data-testid="land-title-target-trigger"]');
    assert.equal(await otherTargetBtn.count(), 1);
    await otherTargetBtn.click();
    assert.ok(
      (await otherCards.first().getAttribute('class') || '').includes('is-selected'),
      'Expected clicking non-owned property name to target and select that land'
    );

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
    await mayaPubPage.waitForSelector('[data-testid="direct-link-intro-card"]');
    await mayaPubPage.locator('[data-testid="direct-link-intro-close-btn"]').click();
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
    await pubPage.waitForSelector('[data-testid="direct-link-intro-card"]');
    await pubPage.locator('[data-testid="direct-link-intro-close-btn"]').click();
    await pubPage.waitForSelector('[data-testid="profile-modal"]', { timeout: 10000 });
    assert.equal(await pubPage.locator('[data-testid="profile-handle"]').textContent(), '@mobile_owner');
    assert.ok((await pubPage.locator('[data-testid="profile-bio"]').textContent()).includes('Mobile AR creator'));
    assert.ok((await pubPage.locator('[data-testid="profile-land-public-link"]').count()) >= 1);
    await pubPage.getByRole('tab', { name: /Actions/i }).click();
    assert.ok((await pubPage.locator('[data-testid="profile-action-link"]').count()) >= 1);
    assert.deepEqual(pubErrors, []);
    await pubCtx.close();
  });

  test('Direct plot link auto-opens Isometric Showcase with floating land & side artwork labels and logged-in owner management on Desktop & Mobile', async () => {
    // 1) Create an owner account, claim a named plot, and stage/publish an artwork on it
    const ownerAuth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: { email: 'iso-showcase-owner@graffiland.test', name: 'Iso Showcase Owner' }
      })
    }).then((r) => r.json());
    assert.ok(ownerAuth.token);

    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({ username: 'iso_showcase_owner', bio: 'Isometric gallery curator' })
    });

    const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({
        lat: 37.7772,
        lng: -122.4165,
        customName: 'Iso Showcase Plaza',
        description: 'Open-air isometric sculpture showcase'
      })
    }).then((r) => r.json());
    const parcelId = claimRes?.parcelId || claimRes?.parcel?.parcelId;
    assert.ok(parcelId, `Expected parcelId from /api/lands/claim, got: ${JSON.stringify(claimRes)}`);

    // Add a real 3D voxel artwork onto this plot via publish endpoint
    const pubRes = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'Neon Obelisk',
        description: 'Glowing cyan isometric pillar',
        parcelId,
        termsAccepted: true,
        location: { lat: 37.7772, lng: -122.4165, altitude: 18, accuracy: 5 },
        proofOfLocation: {
          cameraFrames: 6,
          gpsSamples: [
            { lat: 37.7772, lng: -122.4165, t: Date.now() - 3000 },
            { lat: 37.77721, lng: -122.41651, t: Date.now() - 500 }
          ],
          frameHashes: ['s1', 's2', 's3', 's4'],
          gyroSamples: [
            { alpha: 1, beta: 2, gamma: 3 },
            { alpha: 11, beta: 5, gamma: 2 }
          ],
          flowCorrelation: 0.85,
          skyPalette: ['#00f5d4'],
          visualDHash: '1010101010101010',
          frameCount: 6,
          flowScore: 0.85
        },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ffd166', material: 'matte' },
          { x: 0, y: 0.1, z: 0, color: '#ff3e7f', material: 'neon' }
        ]
      })
    }).then((r) => r.json());
    assert.ok(pubRes?.sculpture?.id);

    // 2) Logged-out Desktop visitor opens /?parcel=<parcelId> -> enters 3D isometric showcase automatically
    const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestPage = await guestCtx.newPage();
    const guestErrors = [];
    guestPage.on('pageerror', (err) => guestErrors.push(err.message));

    await guestPage.goto(`${baseUrl}/?parcel=${encodeURIComponent(parcelId)}`, {
      waitUntil: 'networkidle'
    });
    // First visit to direct link while not signed in shows ultra-clean <=3-sentence intro
    await guestPage.waitForSelector('[data-testid="direct-link-intro-card"]', { timeout: 10000 });
    const introCopy = (
      await guestPage.locator('[data-testid="direct-link-intro-text"]').textContent()
    ).trim();
    const introSentences = introCopy.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(
      introSentences.length >= 2 && introSentences.length <= 3,
      `Expected <= 3 sentences in direct-link intro, got ${introSentences.length}: ${introCopy}`
    );
    await guestPage.locator('[data-testid="direct-link-intro-close-btn"]').click();
    await guestPage.waitForSelector('[data-testid="direct-link-intro-card"]', {
      state: 'detached',
      timeout: 5000
    });
    // Reloading direct link must NOT re-show intro (first visit only)
    await guestPage.reload({ waitUntil: 'networkidle' });
    await guestPage.waitForSelector('[data-testid="desktop-plot-visit-view"]', { timeout: 10000 });
    assert.equal(await guestPage.locator('[data-testid="direct-link-intro-card"]').count(), 0);
    await guestPage.waitForSelector('[data-testid="mobile-iso-3d-map"][data-map-mode="3d"]', {
      timeout: 10000
    });
    await guestPage.waitForSelector('[data-testid="plot-land-label"]', { timeout: 10000 });
    await guestPage.waitForSelector('[data-testid="plot-artwork-label"]', { timeout: 10000 });
    assert.ok(
      (await guestPage.locator('[data-testid="plot-land-label"]').textContent()).includes(
        'Iso Showcase Plaza'
      )
    );
    // Side sculpture callout includes real direct link (<a href*="sculpture=">)
    const artLinkHref = await guestPage
      .locator('a[data-testid="plot-artwork-view-btn"]')
      .first()
      .getAttribute('href');
    assert.ok(
      artLinkHref && artLinkHref.includes('sculpture='),
      `Expected side sculpture label link href to contain sculpture=, got ${artLinkHref}`
    );
    assert.equal(await guestPage.locator('[data-testid="plot-land-management"]').count(), 0);

    // Click Full View button -> unlocks free 3D/2D navigation (no isometric snapping) with explicit Fit recenter
    await guestPage.locator('[data-testid="mobile-map-fullscreen-btn"]').click();
    assert.equal(
      await guestPage.locator('[data-testid="mobile-iso-3d-map"]').getAttribute('data-free-nav'),
      'true'
    );
    assert.equal(
      (await guestPage.locator('[data-testid="mobile-iso-mode-chip"]').textContent()).trim(),
      '3D FREE'
    );
    // Toggle 3D -> 2D -> 3D while in Full View stays in free navigation without snapping back
    await guestPage.locator('[data-testid="mobile-map-2d-toggle-btn"]').click();
    await guestPage.waitForSelector('[data-testid="mobile-map-3d-toggle-btn"]', { timeout: 5000 });
    await guestPage.waitForSelector('[data-testid="mobile-map-fit-btn"]', { timeout: 5000 });
    await guestPage.locator('[data-testid="mobile-map-3d-toggle-btn"]').click();
    await guestPage.waitForSelector('[data-testid="mobile-iso-3d-map"][data-free-nav="true"]', {
      timeout: 5000
    });
    // Exit Full View cleanly
    await guestPage.locator('[data-testid="mobile-map-fullscreen-btn"]').click();
    await guestPage.waitForSelector('[data-testid="mobile-iso-3d-map"][data-free-nav="false"]', {
      timeout: 5000
    });

    // Details start hidden by default; clicking Show Details expands cleanly
    assert.equal(await guestPage.locator('[data-testid="plot-land-details"]').count(), 0);
    await guestPage.locator('[data-testid="plot-details-toggle"]').click();
    await guestPage.waitForSelector('[data-testid="plot-land-details"]');

    // Click side artwork label -> centers object isometrically and shows Neon Obelisk details below
    await guestPage.locator('[data-testid="plot-artwork-label"]').first().click();
    await guestPage.waitForSelector('[data-testid="plot-artwork-details"]');
    assert.ok(
      (await guestPage.locator('[data-testid="plot-artwork-details"]').textContent()).includes(
        'Neon Obelisk'
      )
    );
    assert.equal(await guestPage.locator('[data-testid="plot-artwork-management"]').count(), 0);

    // Click floating Land Label -> centers land isometrically and switches cleanly back to Land details
    await guestPage.locator('[data-testid="plot-land-label"]').click();
    await guestPage.waitForSelector('[data-testid="plot-land-details"]');

    // Collapse & re-expand details panel cleanly
    await guestPage.locator('[data-testid="plot-details-toggle"]').click();
    assert.equal(await guestPage.locator('[data-testid="plot-land-details"]').count(), 0);
    await guestPage.locator('[data-testid="plot-details-toggle"]').click();
    await guestPage.waitForSelector('[data-testid="plot-land-details"]');
    assert.deepEqual(guestErrors, []);
    await guestCtx.close();

    // 3) Logged-in Desktop owner opens /?parcel=<parcelId> -> sees Land & Artwork Management controls
    const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ownerCtx.addInitScript((token) => {
      globalThis.localStorage.setItem('graffiland_jwt', token);
    }, ownerAuth.token);
    const ownerPage = await ownerCtx.newPage();
    const ownerErrors = [];
    ownerPage.on('pageerror', (err) => ownerErrors.push(err.message));

    await ownerPage.goto(`${baseUrl}/?parcel=${encodeURIComponent(parcelId)}`, {
      waitUntil: 'networkidle'
    });
    await ownerPage.waitForSelector('[data-testid="desktop-plot-visit-view"]', { timeout: 10000 });
    assert.equal(await ownerPage.locator('[data-testid="direct-link-intro-card"]').count(), 0);
    await ownerPage.waitForSelector('[data-testid="plot-owner-badge"]', { timeout: 10000 });
    await ownerPage.waitForSelector('[data-testid="plot-land-management"]', { timeout: 10000 });

    // Inline rename updates floating land label live
    await ownerPage.locator('[data-testid="plot-land-edit-btn"]').click();
    await ownerPage.getByLabel('Edit land name').fill('Aurora Isometric Plaza');
    await ownerPage.locator('[data-testid="plot-land-save-btn"]').click();
    await ownerPage.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="plot-land-label"]')
          ?.textContent?.includes('Aurora Isometric Plaza'),
      null,
      { timeout: 10000 }
    );

    // Click side artwork label -> owner sees Artwork Management panel
    await ownerPage.locator('[data-testid="plot-artwork-label"]').first().click();
    await ownerPage.waitForSelector('[data-testid="plot-artwork-management"]', { timeout: 10000 });
    assert.deepEqual(ownerErrors, []);
    await ownerCtx.close();

    // 4) Mobile visitor opens /?parcel=<parcelId> -> auto-opens in 3D isometric mode with clickable labels
    const mobCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile'
    });
    const mobPage = await mobCtx.newPage();
    const mobErrors = [];
    mobPage.on('pageerror', (err) => mobErrors.push(err.message));

    await mobPage.goto(`${baseUrl}/?parcel=${encodeURIComponent(parcelId)}`, {
      waitUntil: 'networkidle'
    });
    // First-time logged-out mobile visitor on direct link sees intro & can dismiss by clicking off
    await mobPage.waitForSelector('[data-testid="direct-link-intro-card"]', { timeout: 10000 });
    await mobPage.locator('[data-testid="direct-link-intro-backdrop"]').click({
      position: { x: 10, y: 10 }
    });
    await mobPage.waitForSelector('[data-testid="direct-link-intro-card"]', {
      state: 'detached',
      timeout: 5000
    });
    await mobPage.waitForSelector('[data-testid="mobile-parcel-visit-view"]', { timeout: 10000 });
    await mobPage.waitForSelector('[data-testid="mobile-iso-3d-map"][data-map-mode="3d"]', {
      timeout: 10000
    });
    await mobPage.waitForSelector('[data-testid="plot-land-label"]', { timeout: 10000 });
    await mobPage.waitForSelector('[data-testid="plot-artwork-label"]', { timeout: 10000 });
    await mobPage.locator('[data-testid="plot-artwork-label"]').first().click();
    await mobPage.waitForSelector('[data-testid="plot-artwork-details"]');
    assert.deepEqual(mobErrors, []);
    await mobCtx.close();
  });

  test('Logged-in owner visiting ?sculpture=<id> can modify, scale, move (gently pushing sibling inside land bounds), block out-of-bounds scale, and remove artwork', async () => {
    const ownerAuth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: { email: 'sculpt-edit-e2e@graffiland.test', name: 'Sculpture Studio Owner' }
      })
    }).then((r) => r.json());
    assert.ok(ownerAuth.token);

    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({ username: 'sculpt_studio_owner', bio: '3D transform tester' })
    });

    const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({
        lat: 37.7832,
        lng: -122.4112,
        customName: 'Studio Bounds Park',
        volume: {
          centerLat: 37.7832,
          centerLng: -122.4112,
          widthMeters: 10,
          depthMeters: 10,
          heightMeters: 12,
          rotationDeg: 0
        }
      })
    }).then((r) => r.json());
    const pid = claimRes.parcelId;
    assert.ok(pid);

    const createItem = async (title, dx) => {
      const r = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(pid)}/sculptures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
        body: JSON.stringify({
          title,
          description: `${title} in Studio Bounds Park`,
          anchorOffset: { dx, dy: 0, dz: 0, yaw: 0 },
          voxels: [
            { x: -0.5, y: 0, z: -0.5, color: '#00f5d4', material: 'neon' },
            { x: 0.5, y: 1.0, z: 0.5, color: '#ffd166', material: 'matte' }
          ]
        })
      }).then((res) => res.json());
      return r.sculpture;
    };

    const mainArt = await createItem('Hero Pine', 0);
    const neighborArt = await createItem('Side Lantern', 1.4);
    assert.ok(mainArt?.id && neighborArt?.id);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((token) => {
      globalThis.localStorage.setItem('graffiland_jwt', token);
    }, ownerAuth.token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`${baseUrl}/?sculpture=${encodeURIComponent(mainArt.id)}`, {
      waitUntil: 'networkidle'
    });
    await page.waitForSelector('[data-testid="sculpture-transform-studio"]', { timeout: 10000 });
    assert.equal(await page.locator('[data-testid="direct-link-intro-card"]').count(), 0);
    await page.waitForSelector('[data-testid="sculpture-sticky-stage"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="sculpture-gizmo-hud"]', { timeout: 10000 });

    // Verify 3D model window stays pinned at top while modifier sliders scroll smoothly behind it
    const stickyMetrics = await page.evaluate(() => {
      const sticky = globalThis.document.querySelector('[data-testid="sculpture-sticky-stage"]');
      const scrollBody = globalThis.document.querySelector('[data-testid="sculpture-scroll-body"]');
      const viewer = globalThis.document.querySelector('[data-testid="sculpture-viewer-3d"]');
      const beforeTop = sticky.getBoundingClientRect().top;
      const beforeBottom = sticky.getBoundingClientRect().bottom;
      scrollBody.scrollTop = 260;
      const afterTop = sticky.getBoundingClientRect().top;
      const afterBottom = sticky.getBoundingClientRect().bottom;
      const stickyZ = Number(globalThis.getComputedStyle(sticky).zIndex || 0);
      const bodyZ = Number(globalThis.getComputedStyle(scrollBody).zIndex || 0);
      return {
        beforeTop,
        afterTop,
        beforeBottom,
        afterBottom,
        scrolled: scrollBody.scrollTop,
        stickyZ,
        bodyZ,
        gizmoAttr: viewer?.getAttribute('data-edit-gizmo')
      };
    });
    assert.ok(Math.abs(stickyMetrics.beforeTop - stickyMetrics.afterTop) < 1);
    assert.ok(Math.abs(stickyMetrics.beforeBottom - stickyMetrics.afterBottom) < 1);
    assert.ok(stickyMetrics.scrolled > 50, `Expected modifier body to scroll, got ${stickyMetrics.scrolled}`);
    assert.ok(stickyMetrics.stickyZ > stickyMetrics.bodyZ, 'Sticky 3D model stage must layer above modifier scroll body');
    assert.equal(stickyMetrics.gizmoAttr, 'on');
    await page.evaluate(() => {
      const scrollBody = globalThis.document.querySelector('[data-testid="sculpture-scroll-body"]');
      if (scrollBody) scrollBody.scrollTop = 0;
    });

    // Scale up to 3.0x -> gently shifts Side Lantern inside land bounds without intersection
    await page.locator('[data-testid="sculpture-scale-input"]').fill('3');
    await page.waitForSelector('[data-testid="sculpture-placement-status"]');
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="sculpture-placement-status"]')
          ?.textContent?.includes('Side Lantern'),
      null,
      { timeout: 10000 }
    );

    // Oversize to 15x -> blocked cleanly & Fit Max Safe restores valid placement
    await page.locator('[data-testid="sculpture-scale-input"]').fill('15');
    await page.waitForSelector('[data-testid="sculpture-placement-blocked"]');
    assert.equal(await page.locator('[data-testid="sculpture-save-transform-btn"]').isDisabled(), true);
    await page.locator('[data-testid="sculpture-scale-input"]').fill('3');
    await page.waitForSelector('[data-testid="sculpture-placement-status"]');

    // Save transform and verify persistence + pushed sibling strictly inside bounds
    await page.locator('[data-testid="sculpture-save-transform-btn"]').click();
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="sculpture-scale-badge"]')
          ?.textContent?.includes('3.00×'),
      null,
      { timeout: 10000 }
    );

    const sibCheck = await fetch(`${baseUrl}/api/sculptures/${encodeURIComponent(neighborArt.id)}`).then((r) =>
      r.json()
    );
    assert.ok(
      sibCheck.sculpture.anchorOffset.dx > 2.0 && sibCheck.sculpture.anchorOffset.dx <= 4.5,
      `Expected pushed sibling inside land bounds, got dx=${sibCheck.sculpture.anchorOffset.dx}`
    );

    // Two-step Remove Artwork closes modal cleanly and removes it from backend
    await page.locator('[data-testid="sculpture-remove-btn"]').click();
    await page.locator('[data-testid="sculpture-confirm-remove-btn"]').click();
    await page.waitForSelector('[data-testid="sculpture-modal"]', { state: 'detached', timeout: 10000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Pending sculpture mint shows temporary "Preview" label on map, 3D preview modal, preview-model endpoint, and direct Approve from Notification Menu', async () => {
    const ownerAuth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: { email: 'preview-approve-e2e@graffiland.test', name: 'Preview Approve Owner' }
      })
    }).then((r) => r.json());
    assert.ok(ownerAuth.token);

    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({ username: 'preview_approve_owner', bio: 'Preview approval E2E' })
    });

    const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({
        lat: 37.7845,
        lng: -122.4095,
        customName: 'Preview Gallery Lot',
        volume: {
          centerLat: 37.7845,
          centerLng: -122.4095,
          widthMeters: 16,
          depthMeters: 16,
          heightMeters: 16,
          rotationDeg: 0
        }
      })
    }).then((r) => r.json());
    const pid = claimRes.parcelId;
    assert.ok(pid);

    // Pair an MCP agent and queue a pending OBJ 3D sculpture mint transaction
    const pairCreate = await fetch(`${baseUrl}/api/mcp/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAuth.token}` },
      body: JSON.stringify({ apiOrigin: baseUrl })
    }).then((r) => r.json());
    const pairingCode = pairCreate?.pairing?.code;
    assert.ok(pairingCode);

    await fetch(`${baseUrl}/api/mcp/pairings/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode, agentName: 'preview-e2e-agent' })
    });

    const tinyObj = [
      'v -0.5 0 -0.5',
      'v 0.5 0 -0.5',
      'v 0.5 1.2 -0.5',
      'v -0.5 1.2 -0.5',
      'v -0.5 0 0.5',
      'v 0.5 0 0.5',
      'v 0.5 1.2 0.5',
      'v -0.5 1.2 0.5',
      'f 1 2 3 4',
      'f 5 6 7 8',
      'f 1 2 6 5',
      'f 2 3 7 6',
      'f 3 4 8 7',
      'f 4 1 5 8'
    ].join('\n');

    const mcpRes = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Graffiland-Pairing-Code': pairingCode
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'e2e-preview-1',
        method: 'tools/call',
        params: {
          name: 'load_3d_model_on_land',
          arguments: {
            parcelId: pid,
            title: 'Golden Obelisk',
            description: 'Temporary preview sculpture awaiting owner approval.',
            modelFormat: 'obj',
            modelData: tinyObj,
            modelScale: 1
          }
        }
      })
    }).then((r) => r.json());
    const reqId = mcpRes?.result?.structuredContent?.request?.id;
    assert.ok(reqId, `Expected pending signature request id, got ${JSON.stringify(mcpRes)}`);

    // Verify authenticated owner preview-model endpoint serves the exact model bytes
    const previewModelRes = await fetch(
      `${baseUrl}/api/signatures/requests/${encodeURIComponent(reqId)}/preview-model`,
      { headers: { Authorization: `Bearer ${ownerAuth.token}` } }
    );
    assert.equal(previewModelRes.status, 200);
    const previewModelText = await previewModelRes.text();
    assert.ok(previewModelText.includes('v -0.5 0 -0.5'));

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((token) => {
      globalThis.localStorage.setItem('graffiland_jwt', token);
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
    }, ownerAuth.token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.desktop-nav');

    // Focus the owner's land so the 3D map frames it, and confirm the temporary "Preview" label renders on the map
    await page.waitForSelector('[data-testid="desktop-land-item"]');
    const targetLandCard = page
      .locator('[data-testid="desktop-land-item"]')
      .filter({ hasText: 'Preview Gallery Lot' })
      .first();
    await targetLandCard.click();
    await page.waitForSelector('[data-testid="map3d-preview-label"]', { timeout: 10000 });
    const mapPreviewText = await page.locator('[data-testid="map3d-preview-label"]').first().textContent();
    assert.ok(mapPreviewText.includes('Preview'), `Expected temporary "Preview" badge on map, got: ${mapPreviewText}`);
    assert.ok(mapPreviewText.includes('Golden Obelisk'));

    // Open Notification Menu -> preview the sculpture in 3D modal first
    await page.getByRole('button', { name: /Notifications/i }).click();
    await page.waitForSelector('[data-testid="notif-inline-approve-btn"]', { timeout: 10000 });
    await page.getByTestId('notif-preview-btn').first().click();
    await page.waitForSelector('[data-testid="preview-modal-badge"]', { timeout: 10000 });
    assert.equal(
      (await page.getByTestId('preview-modal-badge').textContent()).trim(),
      'Preview'
    );
    assert.ok(await page.isVisible('[data-testid="sculpture-preview-approval-bar"]'));

    // Close preview modal, reopen Notification Menu, and approve directly from the Notification Menu!
    await page.getByRole('button', { name: /Close sculpture details/i }).click();
    await page.waitForSelector('[data-testid="sculpture-modal"]', { state: 'detached' });

    await page.getByRole('button', { name: /Notifications/i }).click();
    await page.waitForSelector('[data-testid="notif-inline-approve-btn"]', { timeout: 10000 });
    await page.getByTestId('notif-inline-approve-btn').first().click();
    await page.waitForSelector('[data-testid="notif-approval-status"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="notif-approved-go-to-land-btn"]', { timeout: 5000 });

    // Once approved, temporary "Preview" label disappears and the real sculpture is minted on the land
    await page.waitForSelector('[data-testid="map3d-preview-label"]', {
      state: 'detached',
      timeout: 10000
    });

    // Click the "Go to Land" button right in Notifications -> navigates straight to the minted land showcase!
    await page.getByTestId('notif-approved-go-to-land-btn').click();
    await page.waitForSelector('[data-testid="desktop-plot-visit-view"]', { timeout: 10000 });
    const plotText = await page.getByTestId('desktop-plot-visit-view').textContent();
    assert.ok(
      plotText.includes('Preview Gallery Lot'),
      `Expected PlotVisitView to navigate to "Preview Gallery Lot", got: ${plotText.slice(0, 200)}`
    );

    // Persisted notification in backend inbox also links directly to the land it was minted on
    const afterNotifs = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${ownerAuth.token}` }
    }).then((r) => r.json());
    const mintedNotif = (afterNotifs.notifications || []).find(
      (n) => n.meta?.approvedAndMinted === true && n.parcelId === pid
    );
    assert.ok(mintedNotif, 'Expected persisted Approved & minted notification in /api/notifications');
    assert.equal(mintedNotif.actionType, 'open_land');

    const landDetail = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(pid)}`).then((r) =>
      r.json()
    );
    assert.ok(
      (landDetail.sculptures || []).some((s) => s.title === 'Golden Obelisk'),
      `Expected Golden Obelisk minted on ${pid}, got ${JSON.stringify(landDetail.sculptures)}`
    );

    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Desktop draft land Undo (Ctrl+Z), Delete unminted + Undo restore, and Copy/Paste (Ctrl+C / Ctrl+V) duplicate workflow', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.desktop-nav');

    // Open Mint Land mode and add an unminted draft plot
    await page.locator('.desktop-nav').getByRole('button', { name: /Mint Land/i }).click();
    await page.getByRole('button', { name: /\+ Add Square/i }).click();
    await page.waitForSelector('#land-square-name-input');
    await page.locator('#land-square-name-input').fill('Kbd Plaza');
    // Blur input so global land keyboard shortcuts apply
    await page.locator('#land-square-name-input').blur();

    // Ctrl+C copies the selected draft land, Ctrl+V pastes a non-overlapping duplicate
    await page.keyboard.press('Control+c');
    await page.waitForSelector('text=/Copied "Kbd Plaza"/i');
    await page.keyboard.press('Control+v');
    await page.waitForSelector('text=/Draft Plots \\(2\\//');
    assert.equal(await page.locator('#land-square-name-input').inputValue(), 'Kbd Plaza Copy');

    // Pressing Delete removes the selected unminted duplicate
    await page.keyboard.press('Delete');
    await page.waitForSelector('text=/Draft Plots \\(1\\//');

    // Pressing Ctrl+Z restores the deleted duplicate right back
    await page.keyboard.press('Control+z');
    await page.waitForSelector('text=/Draft Plots \\(2\\//');
    assert.equal(await page.locator('#land-square-name-input').inputValue(), 'Kbd Plaza Copy');

    // Pressing Ctrl+Z again undoes the paste back to 1 plot
    await page.keyboard.press('Control+z');
    await page.waitForSelector('text=/Draft Plots \\(1\\//');

    // Pressing Backspace removes the last unminted plot, and clicking Undo toolbar restores it
    await page.keyboard.press('Backspace');
    await page.waitForSelector('text=/Draft Plots \\(0\\//');
    await page.getByTestId('land-undo-btn').click();
    await page.waitForSelector('text=/Draft Plots \\(1\\//');

    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Clicking minted land label or boundary opens detailed view, and Pairing preserves code across reopen with one-click copy', async () => {
    const ownerAuth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: {
          email: 'detail-click-owner@graffiland.local',
          name: 'Detail Click Owner',
          username: 'detail_clicker'
        }
      })
    }).then((r) => r.json());
    assert.ok(ownerAuth?.token);
    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({ username: 'detail_clicker', bio: 'E2E detail view tester' })
    });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((token) => {
      globalThis.localStorage.setItem('graffiland_jwt', token);
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
      globalThis.__copiedClipLog = [];
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            globalThis.__copiedClipLog.push(String(text));
          }
        }
      });
    }, ownerAuth.token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.desktop-nav');

    // Open Mint Land and mint a fresh plot as our dedicated owner
    await page.locator('.desktop-nav').getByRole('button', { name: /Mint Land/i }).click();
    await page.getByRole('button', { name: /\+ Add Square/i }).click();
    await page.waitForSelector('#land-square-name-input');
    await page.locator('#land-square-name-input').fill('Detail Click Plaza');
    await page.waitForSelector('[data-testid="land-title-validation"]:has-text("available")', { timeout: 5000 });
    await page.getByRole('button', { name: /Mint This Land/i }).click();
    await page.waitForSelector('text=/Minted "Detail Click Plaza"/i');

    // 1) Click the minted land label directly on the map -> opens detailed view (PlotVisitView)!
    const landLabel = page.locator('[data-testid="map3d-land-label"]', { hasText: 'Detail Click Plaza' }).first();
    await landLabel.waitFor({ state: 'visible', timeout: 10000 });
    await landLabel.click();
    await page.waitForSelector('[data-testid="desktop-plot-visit-view"]', { timeout: 10000 });
    assert.ok(
      (await page.getByTestId('desktop-plot-visit-view').textContent()).includes('Detail Click Plaza')
    );

    // Close detailed view
    await page.getByTestId('desktop-plot-visit-view').getByRole('button', { name: /Close|Back/i }).first().click();
    await page.waitForSelector('[data-testid="desktop-plot-visit-view"]', { state: 'detached' });

    // 2) Click directly on the minted land's 3D boundary / prism right below its floating label -> opens detailed view!
    const labelBox = await landLabel.boundingBox();
    assert.ok(labelBox, 'Expected minted land label bounding box on map');
    // Leader line points straight down from label to the roof center of the 3D land prism
    await page.mouse.click(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height + 28);
    await page.waitForSelector('[data-testid="desktop-plot-visit-view"]', { timeout: 10000 });
    await page.getByTestId('desktop-plot-visit-view').getByRole('button', { name: /Close|Back/i }).first().click();
    await page.waitForSelector('[data-testid="desktop-plot-visit-view"]', { state: 'detached' });

    // 3) Open Pairing window -> Phone pair code persists across modal close/reopen, and both Phone & MCP codes copy on click or copy icon!
    await page.getByTestId('nav-pair-phone-btn').click();
    await page.waitForSelector('[data-testid="pair-phone-code-value"]');
    await page.waitForFunction(() => {
      const el = globalThis.document.querySelector('[data-testid="pair-phone-code-value"]');
      return Boolean(el && /^[A-Z2-9]{6}/.test((el.textContent || '').trim()));
    });
    const firstPhoneCode = (
      await page.getByTestId('pair-phone-code-value').textContent()
    )
      .replace(/[^A-Z2-9]/g, '')
      .slice(0, 6);
    assert.equal(firstPhoneCode.length, 6);

    // Click phone code itself -> copies exact code
    await page.getByTestId('pair-phone-code-value').click();
    const afterPhoneCopy = await page.evaluate(() => globalThis.__copiedClipLog.slice());
    assert.ok(afterPhoneCopy.includes(firstPhoneCode));

    // Close and reopen Pairing modal -> SAME phone code is reclaimed (does NOT drop/rotate!)
    await page.getByRole('button', { name: /Close pairing modal/i }).click();
    await page.waitForSelector('[data-testid="pair-phone-modal"]', { state: 'detached' });
    await page.getByTestId('nav-pair-phone-btn').click();
    await page.waitForSelector('[data-testid="pair-phone-code-value"]');
    await page.waitForFunction((expected) => {
      const el = globalThis.document.querySelector('[data-testid="pair-phone-code-value"]');
      return Boolean(el && (el.textContent || '').includes(expected));
    }, firstPhoneCode);

    // Generate MCP code -> click MCP Copy icon button & MCP code box -> copies exact GLP code!
    await page.getByTestId('pair-agent-generate-copy-btn').click();
    await page.waitForFunction(() => {
      const el = globalThis.document.querySelector('[data-testid="pair-agent-code-value"]');
      return Boolean(el && (el.textContent || '').includes('GLP-'));
    });
    const mcpCode = (await page.getByTestId('pair-agent-code-value').textContent()).trim();
    assert.ok(mcpCode.startsWith('GLP-'));

    await page.evaluate(() => {
      globalThis.__copiedClipLog = [];
    });
    await page.getByTestId('pair-agent-code-copy-btn').click();
    const afterMcpCopy = await page.evaluate(() => globalThis.__copiedClipLog.slice());
    assert.ok(afterMcpCopy.includes(mcpCode), `Expected MCP code ${mcpCode} copied, got ${JSON.stringify(afterMcpCopy)}`);

    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Mobile Land Chat opens full-screen and stays keyboard-responsive (composer, live typing, feed & upward emoji picker never blocked)', async () => {
    const ownerAuth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: {
          email: 'mobile-chat-ux@graffiland.local',
          name: 'Mobile Chat UX',
          username: 'bigdog_chat'
        }
      })
    }).then((r) => r.json());
    assert.ok(ownerAuth?.token);

    await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({ username: 'bigdog_chat', bio: 'Mobile chat UX verifier' })
    });

    const chatLat = 37.7755;
    const chatLng = -122.4182;
    const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({
        lat: chatLat,
        lng: chatLng,
        customName: 'I SCREAMED Land',
        volume: {
          centerLat: chatLat,
          centerLng: chatLng,
          widthMeters: 16,
          depthMeters: 16,
          heightMeters: 12,
          rotationDeg: 0
        }
      })
    }).then((r) => r.json());
    assert.ok(claimRes?.parcelId);

    const mobCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      geolocation: { latitude: chatLat, longitude: chatLng, accuracy: 4 },
      permissions: ['geolocation', 'camera'],
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'
    });
    await mobCtx.addInitScript((token) => {
      globalThis.localStorage.setItem('graffiland_jwt', token);
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
      globalThis.localStorage.setItem('graffiland_tutorial_seen_v1', '1');
      globalThis.localStorage.setItem('graffiland_spray_brush_guide_seen_v1', '1');
    }, ownerAuth.token);

    const page = await mobCtx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${baseUrl}/?studio=1`, { waitUntil: 'networkidle' });

    // Dismiss any first-run modal if present
    for (let i = 0; i < 3; i += 1) {
      const backdrop = page.locator('.modal-backdrop').first();
      if (!(await backdrop.isVisible().catch(() => false))) break;
      const closeBtn = backdrop
        .locator(
          '[data-testid="first-visit-quick-start-btn"], [data-testid="first-visit-close-btn"], button:has-text("Skip"), button[aria-label*="Close"]'
        )
        .first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(250);
    }

    // Open nearby land inspector -> Land Chat
    await page.waitForSelector('[data-testid="ar-nearby-land-pill"]', { timeout: 15000 });
    await page.getByTestId('ar-nearby-land-pill').click();
    await page.waitForSelector('[data-testid="ar-land-chat-btn"]', { timeout: 10000 });
    await page.getByTestId('ar-land-chat-btn').click();

    await page.waitForSelector('[data-testid="sculpture-chat-backdrop"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="chat-composer-input"]', { timeout: 15000 });

    // 1) Verify full-screen edge-to-edge coverage on mobile (390x844)
    const fullScreenMetrics = await page.evaluate(() => {
      const bd = globalThis.document.querySelector('[data-testid="sculpture-chat-backdrop"]');
      const card = globalThis.document.querySelector('[data-testid="sculpture-chat-drawer"]');
      const input = globalThis.document.querySelector('[data-testid="chat-composer-input"]');
      const composer = globalThis.document.querySelector('[data-testid="chat-composer-form"]');
      return {
        fullscreenAttr: bd?.getAttribute('data-fullscreen'),
        keyboardAttr: bd?.getAttribute('data-keyboard-open'),
        bdRect: bd?.getBoundingClientRect().toJSON(),
        cardRect: card?.getBoundingClientRect().toJSON(),
        composerRect: composer?.getBoundingClientRect().toJSON(),
        inputFontSizePx: parseFloat(globalThis.getComputedStyle(input).fontSize || '0'),
        scrollWidth: globalThis.document.documentElement.scrollWidth
      };
    });
    assert.equal(fullScreenMetrics.fullscreenAttr, 'true');
    assert.equal(fullScreenMetrics.keyboardAttr, 'false');
    assert.equal(Math.round(fullScreenMetrics.cardRect.width), 390);
    assert.equal(Math.round(fullScreenMetrics.cardRect.height), 844);
    assert.equal(Math.round(fullScreenMetrics.cardRect.top), 0);
    assert.ok(fullScreenMetrics.composerRect.bottom <= 845);
    assert.ok(
      fullScreenMetrics.inputFontSizePx >= 16,
      `Mobile chat input font-size must be >=16px to prevent iOS zoom (got ${fullScreenMetrics.inputFontSizePx}px)`
    );
    assert.ok(fullScreenMetrics.scrollWidth <= 390);

    // 2) Focus input & simulate virtual keyboard shrinking visible viewport to 390x380
    const inputLoc = page.getByTestId('chat-composer-input');
    await inputLoc.click();
    await page.setViewportSize({ width: 390, height: 380 });
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="sculpture-chat-backdrop"]')
          ?.getAttribute('data-keyboard-open') === 'true',
      null,
      { timeout: 5000 }
    );

    // Type message with emoji shortcode query to also verify upward emoji picker stays above keyboard
    await inputLoc.type('Seeing this clearly! :fir', { delay: 10 });
    await page.waitForSelector('.emoji-picker-popover', { timeout: 5000 });

    const kbMetrics = await page.evaluate(() => {
      const bd = globalThis.document.querySelector('[data-testid="sculpture-chat-backdrop"]');
      const header = globalThis.document.querySelector('.chat-board-header');
      const feed = globalThis.document.querySelector('[data-testid="chat-board-feed"]');
      const composer = globalThis.document.querySelector('[data-testid="chat-composer-form"]');
      const input = globalThis.document.querySelector('[data-testid="chat-composer-input"]');
      const sendBtn = globalThis.document.querySelector('[data-testid="chat-composer-send"]');
      const emojiPop = globalThis.document.querySelector('.emoji-picker-popover');
      return {
        vh: globalThis.innerHeight,
        vw: globalThis.innerWidth,
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        bdRect: bd?.getBoundingClientRect().toJSON(),
        headerRect: header?.getBoundingClientRect().toJSON(),
        feedRect: feed?.getBoundingClientRect().toJSON(),
        composerRect: composer?.getBoundingClientRect().toJSON(),
        inputRect: input?.getBoundingClientRect().toJSON(),
        sendRect: sendBtn?.getBoundingClientRect().toJSON(),
        emojiRect: emojiPop?.getBoundingClientRect().toJSON()
      };
    });

    assert.ok(kbMetrics.bdRect.height <= 381, `Backdrop must fit above keyboard (${kbMetrics.bdRect.height}px)`);
    assert.ok(
      kbMetrics.inputRect.top >= kbMetrics.headerRect.bottom && kbMetrics.inputRect.bottom <= 381,
      `Typing input must be fully visible above keyboard (top=${kbMetrics.inputRect.top}, bottom=${kbMetrics.inputRect.bottom})`
    );
    assert.ok(
      kbMetrics.sendRect.right <= 391 && kbMetrics.sendRect.bottom <= 381,
      `Send button must stay fully on-screen above keyboard (right=${kbMetrics.sendRect.right}, bottom=${kbMetrics.sendRect.bottom})`
    );
    assert.ok(
      kbMetrics.feedRect.height >= 40 && kbMetrics.feedRect.bottom <= kbMetrics.composerRect.top + 2,
      `Chat message feed must remain visible above composer (feedHeight=${kbMetrics.feedRect.height})`
    );
    assert.ok(
      kbMetrics.emojiRect && kbMetrics.emojiRect.bottom <= kbMetrics.inputRect.top + 4 && kbMetrics.emojiRect.top >= 0,
      `Emoji suggestions must open UPWARD above composer (popover bottom=${kbMetrics.emojiRect?.bottom}, input top=${kbMetrics.inputRect.top})`
    );
    assert.ok(kbMetrics.scrollWidth <= 390);

    // Pick emoji suggestion & send message while keyboard is still open -> verify bubble renders cleanly!
    await page.locator('.emoji-picker-option').first().click();
    await page.getByTestId('chat-composer-send').click();
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="chat-board-feed"]')
          ?.textContent?.includes('Seeing this clearly!'),
      null,
      { timeout: 10000 }
    );

    // 3) Dismiss virtual keyboard -> full 844px height restores cleanly
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="sculpture-chat-backdrop"]')
          ?.getAttribute('data-keyboard-open') === 'false',
      null,
      { timeout: 5000 }
    );
    const restoredH = await page.evaluate(
      () => Math.round(globalThis.document.querySelector('[data-testid="sculpture-chat-drawer"]').getBoundingClientRect().height)
    );
    assert.equal(restoredH, 844);

    assert.deepEqual(errors, []);
    await mobCtx.close();
  });

  test('Mobile AR holding Brush shows side volumetric remaining-pixels bar, drains live as strokes paint, and hides on release without HUD overlap', async () => {
    const mobCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    await mobCtx.addInitScript(() => {
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
      globalThis.localStorage.setItem('graffiland_studio_tutorial_v1', '1');
      globalThis.localStorage.setItem('graffiland_spray_brush_guide_seen_v1', '1');
    });
    const page = await mobCtx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="key-carousel"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="draw-volume-meter"]', { state: 'attached', timeout: 10000 });

    // 1. Meter is hidden while idle
    const initVisible = await page
      .getByTestId('draw-volume-meter')
      .getAttribute('data-visible');
    assert.equal(initVisible, 'false', 'Volumetric meter should stay hidden until draw tool is held');

    const initRemaining = Number(
      await page.getByTestId('draw-volume-meter').getAttribute('data-remaining')
    );
    assert.equal(initRemaining, 4096);

    // 2. Press and hold center Brush tool -> meter immediately appears on the left side & drains live!
    const brushBtn = page.locator('.key-slot-btn.is-center').first();
    const box = await brushBtn.boundingBox();
    assert.ok(box && box.width > 20, 'Expected center brush button bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="draw-volume-meter"]')
          ?.getAttribute('data-visible') === 'true',
      null,
      { timeout: 5000 }
    );

    // Wait briefly for continuous hold delay (~75ms) to place voxel(s)
    await page.waitForFunction(
      () =>
        Number(
          globalThis.document
            .querySelector('[data-testid="draw-volume-meter"]')
            ?.getAttribute('data-remaining') || '4096'
        ) < 4096,
      null,
      { timeout: 5000 }
    );

    // Wait for slide-in transition to settle before measuring final resting geometry
    await page.waitForTimeout(280);

    const layoutCheck = await page.evaluate(() => {
      const meter = globalThis.document.querySelector('[data-testid="draw-volume-meter"]');
      const carousel = globalThis.document.querySelector('[data-testid="key-carousel"]');
      const topLeft = globalThis.document.querySelector('.mobile-top-hud-left');
      const mapBtn = globalThis.document.querySelector('.floating-map-btn');
      const scanBox = globalThis.document.querySelector('[data-testid="scene-coverage-widget"]');
      return {
        remaining: Number(meter?.getAttribute('data-remaining') || 0),
        text: meter?.querySelector('[data-testid="draw-volume-remaining"]')?.textContent || '',
        meterRect: meter?.getBoundingClientRect().toJSON(),
        carouselRect: carousel?.getBoundingClientRect().toJSON(),
        topLeftRect: topLeft?.getBoundingClientRect().toJSON(),
        mapBtnRect: mapBtn?.getBoundingClientRect().toJSON(),
        scanRect: scanBox?.getBoundingClientRect().toJSON()
      };
    });

    assert.ok(layoutCheck.remaining < 4096, `Expected remaining pixels to drain, got ${layoutCheck.remaining}`);
    assert.ok(layoutCheck.meterRect.left >= 0 && layoutCheck.meterRect.right < 120, 'Meter should sit cleanly on the left side');
    assert.ok(
      layoutCheck.meterRect.top > (layoutCheck.topLeftRect?.bottom || 0),
      `Meter must not overlap top HUD (meter top=${layoutCheck.meterRect.top}, topHUD bottom=${layoutCheck.topLeftRect?.bottom})`
    );
    assert.ok(
      layoutCheck.meterRect.bottom < (layoutCheck.mapBtnRect?.top || 844),
      `Meter must not overlap bottom map button (meter bottom=${layoutCheck.meterRect.bottom}, map top=${layoutCheck.mapBtnRect?.top})`
    );
    if (layoutCheck.scanRect && layoutCheck.scanRect.width > 0) {
      assert.ok(
        layoutCheck.meterRect.right < layoutCheck.scanRect.left,
        'Meter on left must never overlap scene scan box on right'
      );
    }

    // 3. Release tool -> volumetric bar smoothly fades back out after linger
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="draw-volume-meter"]')
          ?.getAttribute('data-visible') === 'false',
      null,
      { timeout: 5000 }
    );

    assert.deepEqual(errors, []);
    await mobCtx.close();
  });

  test('Desktop map views draw same-color pointer lines to on-screen tags and pin off-screen tags to viewport edges for click navigation', async () => {
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'desktop-tags@graffiland.test', name: 'Desktop Tag Tester' } })
    }).then((r) => r.json());
    assert.ok(authRes.token, 'Expected dev login token');

    // Claim 3 lands: Center focal land, Near East land (~28m away -> on-screen), Far West land (~2.2km away -> off-screen)
    const claimLand = async (lat, lng, customName) => {
      const res = await fetch(`${baseUrl}/api/lands/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authRes.token}`
        },
        body: JSON.stringify({
          lat,
          lng,
          customName,
          volume: {
            centerLat: lat,
            centerLng: lng,
            widthMeters: 16,
            depthMeters: 16,
            heightMeters: 12,
            rotationDeg: 0
          }
        })
      });
      const data = await res.json();
      assert.equal(res.status, 201, `Failed to claim ${customName}: ${JSON.stringify(data)}`);
      return data.parcel || data.land || data;
    };

    const centerLand = await claimLand(37.768, -122.425, 'Pointer Hub Plaza');
    const nearLand = await claimLand(37.768, -122.42468, 'Adjacent Gallery');
    const farLand = await claimLand(37.768, -122.45, 'Distant Horizon Plot');

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      globalThis.localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');
    });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // 1) Desktop PlotVisitView (direct parcel visit -> 3D isometric + 2D Leaflet)
    await page.goto(`${baseUrl}/?parcel=${encodeURIComponent(centerLand.parcelId)}`, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForSelector('[data-testid="desktop-plot-visit-view"]', { timeout: 15000 });
    const introClose = page.getByTestId('direct-link-intro-close-btn');
    if (await introClose.isVisible().catch(() => false)) {
      await introClose.click();
    }

    // Switch to 2D Leaflet mode where projection is deterministic even without hardware GPU acceleration
    await page.getByTestId('mobile-map-2d-toggle-btn').click();
    await page.waitForSelector('.plot-visit-stage[data-map-mode="2d"]', { timeout: 10000 });

    // Zoom out slightly via wheel/Leaflet so Adjacent Gallery (~28m) is guaranteed inside the 2D frame while Distant Horizon (~2.2km) stays off-screen
    await page.waitForFunction(
      () => {
        const btns = Array.from(
          globalThis.document.querySelectorAll('.plot-visit-stage [data-testid="neighbor-edge-arrow"]')
        );
        return btns.length >= 2;
      },
      null,
      { timeout: 10000 }
    );

    const check2dTags = await page.evaluate(
      ({ nearPid, farPid }) => {
        const stage = globalThis.document.querySelector('.plot-visit-stage');
        const btns = Array.from(stage.querySelectorAll('[data-testid="neighbor-edge-arrow"]')).map((el) => ({
          parcelId: el.getAttribute('data-parcel-id'),
          placement: el.getAttribute('data-placement'),
          side: el.getAttribute('data-edge-side'),
          tagColor: el.getAttribute('data-tag-color'),
          hasDot: Boolean(el.querySelector('.neighbor-onscreen-dot')),
          hasEdgeArrow: Boolean(el.querySelector('svg.neighbor-edge-arrow-svg'))
        }));
        const leaders = Array.from(stage.querySelectorAll('[data-testid="neighbor-tag-leader-line"]')).map((g) => ({
          parcelId: g.getAttribute('data-parcel-id'),
          lineColor: g.getAttribute('data-line-color'),
          stroke: g.querySelectorAll('line')[1]?.getAttribute('stroke') || ''
        }));
        return {
          nearBtn: btns.find((b) => b.parcelId === nearPid) || null,
          farBtn: btns.find((b) => b.parcelId === farPid) || null,
          nearLeader: leaders.find((l) => l.parcelId === nearPid) || null,
          farLeader: leaders.find((l) => l.parcelId === farPid) || null,
          allBtns: btns,
          allLeaders: leaders
        };
      },
      { nearPid: nearLand.parcelId, farPid: farLand.parcelId }
    );

    assert.ok(check2dTags.nearBtn, `Expected near neighbor tag in desktop 2D view: ${JSON.stringify(check2dTags.allBtns)}`);
    assert.equal(check2dTags.nearBtn.placement, 'on-screen', 'On-screen neighbor land must use on-screen pointer placement');
    assert.equal(check2dTags.nearBtn.hasDot, true, 'On-screen tag should show color dot');
    assert.ok(check2dTags.nearLeader, 'On-screen neighbor land must draw an SVG leader line');
    assert.equal(
      check2dTags.nearLeader.stroke,
      check2dTags.nearBtn.tagColor,
      'Leader line stroke color must exactly match the tag color'
    );

    assert.ok(check2dTags.farBtn, `Expected off-screen neighbor edge tag in desktop 2D view: ${JSON.stringify(check2dTags.allBtns)}`);
    assert.equal(check2dTags.farBtn.placement, 'edge', 'Off-screen neighbor land must stay pinned on the viewport edge');
    assert.equal(check2dTags.farBtn.hasEdgeArrow, true, 'Off-screen edge tag must show directional arrow');
    assert.equal(check2dTags.farLeader, null, 'Off-screen edge tag must NOT draw an interior leader line');

    // Click the off-screen edge tag -> navigates PlotVisitView directly to Distant Horizon Plot
    await page
      .locator(`.plot-visit-stage [data-testid="neighbor-edge-arrow"][data-parcel-id="${farLand.parcelId}"]`)
      .click();
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="desktop-plot-visit-view"]')
          ?.textContent?.includes('Distant Horizon Plot'),
      null,
      { timeout: 10000 }
    );

    // 2) Close PlotVisitView -> verify Desktop World Map (MapView3D) shows off-screen edge tags & same-color land tags
    await page.getByTestId('plot-close-btn').click();
    await page.waitForSelector('.map-container', { timeout: 10000 });
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('.map-container [data-testid="neighbor-edge-arrow"]').length >= 1,
      null,
      { timeout: 12000 }
    );

    const map3dEdgeCheck = await page.evaluate(() => {
      const edges = Array.from(
        globalThis.document.querySelectorAll('.map-container [data-testid="neighbor-edge-arrow"]')
      ).map((el) => ({
        placement: el.getAttribute('data-placement'),
        side: el.getAttribute('data-edge-side'),
        tagColor: el.getAttribute('data-tag-color'),
        parcelId: el.getAttribute('data-parcel-id'),
        sculptureId: el.getAttribute('data-sculpture-id')
      }));
      return { edges };
    });
    assert.ok(map3dEdgeCheck.edges.length >= 1, 'Expected off-screen edge tags on desktop MapView3D');
    assert.ok(
      map3dEdgeCheck.edges.every((e) => e.placement === 'edge'),
      `Expected MapView3D edge overlay items to be off-screen edge tags, got ${JSON.stringify(map3dEdgeCheck.edges)}`
    );

    // 3) Open SculptureModal on Desktop -> verify mini-land-map renders clickable tags
    await page.goto(`${baseUrl}/?sculpture=${encodeURIComponent(seededSculptureId)}`, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForSelector('.mini-land-map-stage', { timeout: 15000 });
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('.mini-land-map-stage [data-testid="neighbor-edge-arrow"]').length >= 1,
      null,
      { timeout: 10000 }
    );

    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
