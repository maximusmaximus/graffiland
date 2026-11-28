import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(process.cwd());

describe('Remove HUD Question Mark Icon & Clean Up Unified Help Guide', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;

  async function loadJsxModule(relPath) {
    const absIn = path.join(ROOT, relPath);
    const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const absOut = path.join(outTmpDir, `${safeName}.mjs`);
    await esbuild.build({
      entryPoints: [absIn],
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      jsx: 'automatic',
      plugins: [
        {
          name: 'ignore-css-and-url',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'ignore-css'
            }));
            build.onLoad({ filter: /.*/, namespace: 'ignore-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onResolve({ filter: /\?url$/ }, (args) => ({
              path: args.path,
              namespace: 'mock-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'mock-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}_${Math.random()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-help-guide-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    dom.window.HTMLCanvasElement.prototype.getContext = (kind) =>
      kind === '2d'
        ? {
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {},
            clearRect: () => {},
            drawImage: () => {}
          }
        : null;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup issues
    }
  });

  test('StudioHudTopBar removes the question mark icon while keeping the regular Info guide button', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    let infoOpened = 0;
    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u1', username: 'sprayartist' },
        mode: 'draw',
        isInteractingWithLand: false,
        voxels: [],
        isPaired: false,
        pendingSignatures: [],
        hasOwnedLand: false,
        ownedLandCount: 0,
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true },
        onOpenInfo: () => {
          infoOpened += 1;
        },
        onOpenAreaMap: () => {}
      })
    );

    assert.equal(view.queryByLabelText('Open Tutorial Guide'), null);
    assert.equal(view.queryByTitle('Quick Start Tutorial'), null);
    assert.equal(view.container.textContent.includes('❓'), false);
    assert.equal(view.container.querySelector('.mobile-top-hud-subrow'), null);

    const infoBtn = view.getByLabelText('Info and Terms');
    RTL.fireEvent.click(infoBtn);
    assert.equal(infoOpened, 1);
    cleanup();
  });

  test('DesktopHub renders no question mark icon and keeps the regular Info & Guide button', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sculptures')) return { ok: true, json: async () => ({ sculptures: [] }) };
      if (u.includes('/api/parcels/mine')) return { ok: true, json: async () => ({ parcels: [], parcelCount: 0 }) };
      if (u.includes('/api/parcels')) return { ok: true, json: async () => ({ parcels: [] }) };
      if (u.includes('/api/marketplace/listings')) return { ok: true, json: async () => ({ listings: [] }) };
      if (u.includes('/api/leaderboard')) return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      if (u.includes('/api/mcp/pairings')) return { ok: true, json: async () => ({ pairings: [], mcpActive: false }) };
      if (u.includes('/api/signatures/pending')) return { ok: true, json: async () => ({ requests: [] }) };
      if (u.includes('/api/notifications')) return { ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) };
      return { ok: true, json: async () => ({}) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          config: { policy: {} },
          user: { id: 'u1', username: 'desktopartist', walletAddress: '0x1111111111111111111111111111111111111111' },
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );

      assert.equal(view.queryByLabelText('Open Tutorial Guide'), null);
      assert.equal(view.queryByTitle('Quick Start Tutorial'), null);
      const buttons = Array.from(view.container.querySelectorAll('button'));
      assert.equal(
        buttons.some((b) => (b.textContent || '').trim() === '?' || (b.textContent || '').includes('❓')),
        false
      );
      assert.ok(view.getByTitle('Info & Guide'));
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('InfoTermsModal includes all migrated Quick Start Tutorial content and uses the clean responsive layout', async () => {
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );
    const { POLICY } = await import('../shared/constants.mjs');

    const view = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: POLICY, chain: { network: { name: 'Robinhood Chain' } } },
        user: null,
        initialTab: 'guide',
        initialViewportGuide: 'mobile',
        onOpenWelcome: () => {},
        onClose: () => {}
      })
    );

    // Clean anchored shell + structured grids
    assert.ok(view.container.querySelector('.info-modal-card'));
    assert.ok(view.container.querySelector('.info-modal-top'));
    assert.ok(view.container.querySelector('.info-main-tabs'));
    assert.ok(view.container.querySelector('.info-modal-body'));
    assert.ok(view.container.querySelector('.info-viewport-menu'));
    assert.ok(view.container.querySelector('.info-guide-grid'));
    assert.ok(view.container.querySelector('.info-lifecycle-grid'));
    assert.ok(view.container.querySelector('.info-interactions-grid'));

    // Migrated Quick Start Tutorial Step 1, 2, and 3 content in Mobile AR Studio guide
    const mobileGuide = view.getByTestId('info-guide-mobile');
    assert.ok(mobileGuide.textContent.includes('Aim, Scan & Lock Surface'));
    assert.ok(mobileGuide.textContent.includes('100%'));
    assert.ok(mobileGuide.textContent.includes('center circle'));
    assert.ok(mobileGuide.textContent.includes('Copy Agent Prompt'));
    assert.ok(mobileGuide.textContent.includes('IPFS'));
    assert.ok(mobileGuide.textContent.includes('pinned notes'));

    // Open Step 1 InfoTip to verify 100% scan box, Proof of Location & hold center circle details
    RTL.fireEvent.click(
      view.getByRole('button', { name: /Info: Surface Scan, Calibration & Multi-Sensor AR/i })
    );
    assert.ok(view.container.textContent.includes('Proof of Location'));
    assert.ok(view.container.textContent.includes('hold the center circle'));

    // Open Step 2 InfoTip to verify spray can, 3D bars, Stack hold-to-build, auto-fade & Copy Agent Prompt
    RTL.fireEvent.click(
      view.getByRole('button', { name: /Info: Spray Brush, 3D Manipulator Bars & Mobile Gestures/i })
    );
    assert.ok(view.container.textContent.includes('hold to build off faces'));
    assert.ok(view.container.textContent.includes('automatically fade existing land art'));
    assert.ok(view.container.textContent.includes('Copy Agent Prompt'));

    // Open Step 4 InfoTip to verify IPFS + 5% royalty + camera-locked AR chat
    RTL.fireEvent.click(
      view.getByRole('button', { name: /Info: ERC-721, IPFS, GLB & Encrypted Chat/i })
    );
    assert.ok(view.container.textContent.includes('pins your 3D art to IPFS'));
    assert.ok(view.container.textContent.includes('5% ERC-2981 royalty'));
    assert.ok(view.container.textContent.includes('unlock pinned notes'));

    // Switch to Desktop tab and confirm clean 2-column grid + updated Esc / Ghost / Search info
    RTL.fireEvent.click(view.getByRole('tab', { name: /Desktop Map & 3D Land/i }));
    const desktopGuide = view.getByTestId('info-guide-desktop');
    assert.ok(desktopGuide.classList.contains('info-guide-grid'));
    assert.ok(desktopGuide.textContent.includes('Search to Add 3D Items'));
    assert.ok(desktopGuide.textContent.includes('Esc/Undo'));

    // Confirm Terms button remains accessible as role="button" for E2E compatibility
    const termsBtn = view.getByRole('button', { name: /Terms & Virtual Land/i });
    RTL.fireEvent.click(termsBtn);
    assert.ok(view.container.textContent.includes('Marketplace & Co-Creation Royalty Economics'));
    cleanup();
  });
});
