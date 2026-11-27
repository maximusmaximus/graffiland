import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  installMobileViewportLock,
  syncMobileViewportDimensions
} from '../client/src/utils/mobilePortraitLock.js';
import { createInAppHistoryController } from '../client/src/utils/inAppHistory.js';
import {
  isWithinPointerUpGhostWindow,
  markModalOpenedFromPointerUp,
  resetPointerUpGhostWindow
} from '../client/src/utils/modalBackdropGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
    outfile: absOut,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/*', 'three', 'three/*', 'leaflet', 'maplibre-gl'],
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl' }
  });
  return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://spray.land/'
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.PointerEvent = dom.window.MouseEvent;

  React = (await import('react')).default;
  RTL = await import('@testing-library/react');
  cleanup = RTL.cleanup;
  outTmpDir = fs.mkdtempSync(path.join(ROOT, '.vp-pub-back-test-cache-'));
});

after(() => {
  cleanup?.();
  resetPointerUpGhostWindow();
  dom?.window?.close();
  try {
    fs.rmSync(outTmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('Mobile viewport bottom-icon anchoring, Publish stickiness, and In-App Back history', () => {
  test('syncMobileViewportDimensions clamps --mobile-app-height to real visible height across orientation & fullscreen changes', () => {
    const { window: win } = dom;
    const { document: doc } = win;

    // Simulate Android Chrome after fullscreen/orientation change where innerHeight lags 56px taller than visualViewport
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true, writable: true });
    Object.defineProperty(win, 'innerHeight', { value: 844, configurable: true, writable: true });
    let vvListeners = {};
    const fakeVv = {
      width: 390,
      height: 788,
      addEventListener: (ev, fn) => {
        vvListeners[ev] = fn;
      },
      removeEventListener: (ev) => {
        delete vvListeners[ev];
      }
    };
    Object.defineProperty(win, 'visualViewport', {
      value: fakeVv,
      configurable: true,
      writable: true
    });

    const uninstall = installMobileViewportLock({ win, doc });
    try {
      assert.equal(doc.documentElement.style.getPropertyValue('--mobile-app-height'), '788px');
      assert.equal(doc.documentElement.style.getPropertyValue('--mobile-app-width'), '390px');

      // Orientation change -> visualViewport adjusts cleanly -> CSS var updates immediately
      fakeVv.height = 760;
      win.dispatchEvent(new win.Event('orientationchange'));
      assert.equal(doc.documentElement.style.getPropertyValue('--mobile-app-height'), '760px');

      // Fullscreen exit -> visualViewport adjusts -> CSS var updates immediately
      fakeVv.height = 732;
      doc.dispatchEvent(new win.Event('fullscreenchange'));
      assert.equal(doc.documentElement.style.getPropertyValue('--mobile-app-height'), '732px');

      // Direct call returns exact dimensions
      const dims = syncMobileViewportDimensions(win, doc);
      assert.deepEqual(dims, { width: 390, height: 732 });
    } finally {
      uninstall();
    }

    assert.equal(doc.documentElement.style.getPropertyValue('--mobile-app-height'), '');

    // Verify CSS uses var(--mobile-app-height, 100%) instead of stale height: 100dvh on fixed studio container
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    const mobileFsRule = css.match(/\.mobile-fullscreen\s*\{[^}]*\}/)?.[0] || '';
    assert.ok(mobileFsRule.includes('var(--mobile-app-height, 100%)'));
    assert.equal(mobileFsRule.includes('100dvh'), false);

    // Verify .palette-fab-btn shares the same positioning context as .floating-map-btn and .key-carousel
    const paletteFabRule = css.match(/\.palette-fab-btn\s*\{[^}]*\}/)?.[0] || '';
    assert.equal(
      paletteFabRule.includes('position: fixed'),
      false,
      '.palette-fab-btn must not detach from .hud-layer positioning context'
    );
  });

  test('PublishSculptureModal stays open through mobile pointerup ghost clicks and drag-outs, while deliberate backdrop tap closes it', async () => {
    resetPointerUpGhostWindow();
    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );

    let closeCount = 0;
    const baseProps = {
      config: { policy: { titleMax: 48, descriptionMax: 240, descriptionMaxWords: 45 } },
      user: {
        id: 'u-bigdog',
        email: 'bigdog@spray.land',
        activeMintRecipient: '0x1111111111111111111111111111111111111111'
      },
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
      polStats: { frames: 12, flow: 95 },
      location: { lat: 39.7302, lng: -121.8406, altitude: 62 },
      orbStatus: { features: 0, keyframes: 0 },
      passkeyCount: 0,
      passkeyBusy: false,
      title: 'Test Art',
      setTitle: () => {},
      description: 'Testing publish stickiness.',
      setDescription: () => {},
      cluePrompt: '',
      setCluePrompt: () => {},
      clueAnswer: '',
      setClueAnswer: () => {},
      termsAccepted: true,
      setTermsAccepted: () => {},
      publishing: false,
      publishError: '',
      setPublishError: () => {},
      mintReceipt: null,
      mcpPairingsState: { mcpActive: false, activePairing: null },
      agentPublishPrompt: null,
      draftsBusy: false,
      draftStatusText: '',
      onSubmitPublish: (e) => e.preventDefault(),
      onCopyAgentPublishPrompt: () => {},
      onManualSaveDraft: () => {},
      onOpenInfo: () => {},
      onOpenPair: () => {},
      onOpenManageLand: () => {},
      onViewInARPreview: () => {},
      onShowHint: () => {},
      onClose: () => {
        closeCount += 1;
      }
    };

    // 1) Simulate ToolCarouselBar pointerup opening PublishSculptureModal -> ghost click arrives 10ms later on backdrop!
    markModalOpenedFromPointerUp();
    assert.equal(isWithinPointerUpGhostWindow(), true);
    const view = RTL.render(React.createElement(PublishSculptureModal, baseProps));
    const backdrop = view.container.querySelector('.modal-backdrop');
    const card = view.container.querySelector('.modal-card');
    assert.ok(backdrop && card);

    // Ghost click (no prior pointerdown on backdrop!) MUST NOT close PublishSculptureModal!
    RTL.fireEvent.click(backdrop);
    assert.equal(closeCount, 0, 'Synthetic pointerup ghost click must NEVER close Publish modal');

    // 2) Drag starting inside modal card and releasing on backdrop MUST NOT close Publish modal!
    RTL.fireEvent.mouseDown(card);
    RTL.fireEvent.click(backdrop);
    assert.equal(closeCount, 0, 'Dragging from inside modal card onto backdrop must NOT close Publish modal');

    // 3) Deliberate tap directly on backdrop (pointerDown + click on backdrop) DOES close cleanly!
    RTL.fireEvent.mouseDown(backdrop);
    RTL.fireEvent.click(backdrop);
    assert.equal(closeCount, 1, 'Deliberate backdrop tap must close Publish modal cleanly');
    cleanup();
    resetPointerUpGhostWindow();
  });

  test('In-app Back history steps cleanly through previous views and NEVER exits to previous website on root Back', () => {
    const historyStack = [];
    let historyIdx = -1;
    const listeners = new Map();

    const fakeWin = {
      location: { href: 'https://spray.land/?parcel=GLAND-TEST' },
      history: {
        get state() {
          return historyIdx >= 0 ? historyStack[historyIdx] : null;
        },
        replaceState(state) {
          if (historyIdx < 0) {
            historyStack.push(state);
            historyIdx = 0;
          } else {
            historyStack[historyIdx] = state;
          }
        },
        pushState(state) {
          historyStack.splice(historyIdx + 1);
          historyStack.push(state);
          historyIdx = historyStack.length - 1;
        }
      },
      addEventListener(ev, fn) {
        listeners.set(ev, fn);
      },
      removeEventListener(ev) {
        listeners.delete(ev);
      }
    };

    const simulateBrowserBack = () => {
      assert.ok(historyIdx > 0, 'Browser Back must NEVER underflow past the root sentinel to a previous website!');
      historyIdx -= 1;
      const fn = listeners.get('popstate');
      fn?.({ state: historyStack[historyIdx] });
    };

    // Simulate real user navigation: camera:draw -> map -> plot -> sculpture
    let currentView = 'camera:draw';
    const backTransitions = [];
    const ctrl = createInAppHistoryController({
      win: fakeWin,
      initialViewKey: currentView,
      onBackStep: () => {
        if (currentView === 'sculpture') {
          currentView = 'plot';
          backTransitions.push('sculpture->plot');
          return true;
        }
        if (currentView === 'plot') {
          currentView = 'map';
          backTransitions.push('plot->map');
          return true;
        }
        if (currentView === 'map') {
          currentView = 'camera:draw';
          backTransitions.push('map->camera:draw');
          return true;
        }
        return false;
      }
    });

    try {
      // Mount anchored sentinel (idx 0) + initial in-app frame (idx 1)
      assert.equal(historyIdx, 1);
      assert.equal(historyStack[0].__spraylandRoot, true);

      // Navigate forward: camera:draw -> map -> plot -> sculpture
      currentView = 'map';
      ctrl.syncViewKey(currentView);
      currentView = 'plot';
      ctrl.syncViewKey(currentView);
      currentView = 'sculpture';
      ctrl.syncViewKey(currentView);
      assert.deepEqual(ctrl.getStack(), ['camera:draw', 'map', 'plot', 'sculpture']);

      // Press Back 1: sculpture -> plot
      simulateBrowserBack();
      assert.equal(currentView, 'plot');

      // Press Back 2: plot -> map
      simulateBrowserBack();
      assert.equal(currentView, 'map');

      // User opens plot again, then closes it via UI X button (syncViewKey back to map), then presses Back!
      currentView = 'plot';
      ctrl.syncViewKey(currentView);
      currentView = 'map';
      ctrl.syncViewKey(currentView);
      assert.deepEqual(ctrl.getStack(), ['camera:draw', 'map']);

      // Press Back 3: map -> camera:draw (does NOT reopen the plot closed with UI X!)
      simulateBrowserBack();
      assert.equal(currentView, 'camera:draw');

      // Press Back 4 & 5 at root: stays safely on spray.land (re-pushes sentinel guard!)
      simulateBrowserBack();
      simulateBrowserBack();
      assert.equal(currentView, 'camera:draw');
      assert.ok(historyIdx >= 1, 'Root Back must re-push guard entry so user stays inside spray.land');
      assert.deepEqual(backTransitions, ['sculpture->plot', 'plot->map', 'map->camera:draw']);
    } finally {
      ctrl.destroy();
    }
  });
});
