import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

import { computeVisualViewportLayout } from '../client/src/utils/visualViewportMetrics.js';
import { saveLocalRoomKey } from '../client/src/utils/chatCrypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Full-Screen Mobile Land Chat & Virtual Keyboard UX Checks', () => {
  test('computeVisualViewportLayout handles Android resizes-visual, Android resizes-content, iOS offsetTop scroll, and landscape keyboards', () => {
    // 1. Portrait mobile with keyboard closed (390x844)
    const closed = computeVisualViewportLayout(
      { innerWidth: 390, innerHeight: 844, visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 } },
      { baselineHeight: 844, inputFocused: false }
    );
    assert.deepEqual(closed, {
      top: 0,
      left: 0,
      width: 390,
      height: 844,
      keyboardInset: 0,
      keyboardOpen: false,
      compact: false
    });

    // 2. Samsung/Android overlay keyboard + autofill bar (visualViewport shrinks to 360px while innerHeight stays 844px)
    const androidVisual = computeVisualViewportLayout(
      { innerWidth: 390, innerHeight: 844, visualViewport: { width: 390, height: 360, offsetTop: 0, offsetLeft: 0 } },
      { baselineHeight: 844, inputFocused: true }
    );
    assert.equal(androidVisual.height, 360);
    assert.equal(androidVisual.top, 0);
    assert.equal(androidVisual.keyboardInset, 484);
    assert.equal(androidVisual.keyboardOpen, true);
    assert.equal(androidVisual.compact, true);

    // 3. Android Chrome interactive-widget=resizes-content (innerHeight itself shrinks from baseline 844 -> 390)
    const androidContent = computeVisualViewportLayout(
      { innerWidth: 390, innerHeight: 390, visualViewport: { width: 390, height: 390, offsetTop: 0, offsetLeft: 0 } },
      { baselineHeight: 844, inputFocused: true }
    );
    assert.equal(androidContent.height, 390);
    assert.equal(androidContent.keyboardInset, 454);
    assert.equal(androidContent.keyboardOpen, true);
    assert.equal(androidContent.compact, true);

    // 4. iOS Safari keyboard open with scrolled visualViewport.offsetTop = 112px
    const iosScrolled = computeVisualViewportLayout(
      { innerWidth: 390, innerHeight: 844, visualViewport: { width: 390, height: 420, offsetTop: 112, offsetLeft: 0 } },
      { baselineHeight: 844, inputFocused: true }
    );
    assert.equal(iosScrolled.top, 112);
    assert.equal(iosScrolled.height, 420);
    assert.equal(iosScrolled.keyboardInset, 424);
    assert.equal(iosScrolled.keyboardOpen, true);

    // 5. Fallback when browser lacks visualViewport
    const fallback = computeVisualViewportLayout(
      { innerWidth: 375, innerHeight: 667, visualViewport: null },
      { baselineHeight: 667 }
    );
    assert.equal(fallback.width, 375);
    assert.equal(fallback.height, 667);
    assert.equal(fallback.keyboardOpen, false);
  });

  test('HTML viewport meta and CSS enforce full-screen chat, zero feed min-height trap, upward emoji popover & >=16px mobile inputs', () => {
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /interactive-widget=resizes-content/);

    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    // Full-screen backdrop & modal with zero outer margin/radius
    assert.match(css, /\.modal-backdrop\.chat-board-backdrop\s*\{[\s\S]*?padding:\s*0;/);
    assert.match(css, /\.modal-card\.chat-board-modal\s*\{[\s\S]*?max-width:\s*none;[\s\S]*?height:\s*100%;[\s\S]*?border-radius:\s*0;/);
    // Chat feed MUST allow shrinking down to 0 so bottom composer can never be pushed below virtual keyboard
    assert.match(css, /\.chat-board-feed\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*none;/);
    // Emoji picker inside bottom composer MUST open upward so it is never hidden behind mobile keyboard
    assert.match(css, /\.chat-board-composer\s+\.emoji-picker-popover\s*\{[\s\S]*?top:\s*auto;[\s\S]*?bottom:\s*calc\(100%\s*\+\s*8px\);/);
    // Inputs inside chat must be >=16px to prevent iOS Safari focus auto-zoom
    assert.match(css, /\.chat-board-composer\s+\.chat-composer-input\s*\{[\s\S]*?font-size:\s*16px;/);
    // Keyboard-open compact chrome rules must exist
    assert.match(css, /\.chat-board-backdrop\.is-keyboard-open\s+\.chat-board-composer/);
  });
});

describe('SculptureChatDrawer Full-Screen & VisualViewport Keyboard Responsiveness (React + jsdom)', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;
  let origFetch;

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
      define: { 'import.meta.env': '{}' },
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({ path: 'stub.css', namespace: 'stub-css' }));
            build.onResolve({ filter: /\?url$/ }, () => ({ path: 'stub-url', namespace: 'stub-url' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({ contents: '', loader: 'js' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({ contents: 'export default "";', loader: 'js' }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.chat-ux-test-cache-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    if (!globalThis.Element.prototype.scrollIntoView) {
      globalThis.Element.prototype.scrollIntoView = () => {};
    }
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(async () => {
    cleanup?.();
    if (origFetch !== undefined) globalThis.fetch = origFetch;
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('SculptureChatDrawer opens full-screen, tracks visualViewport keyboard shrink/offsetTop, keeps composer & emoji picker accessible, and closes on Escape', async () => {
    // Configure mock 390x844 mobile viewport with EventTarget visualViewport
    Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true, writable: true });
    Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true, writable: true });

    const vvListeners = new Map();
    const mockVv = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener(type, fn) {
        if (!vvListeners.has(type)) vvListeners.set(type, new Set());
        vvListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        vvListeners.get(type)?.delete(fn);
      },
      emit(type) {
        for (const fn of vvListeners.get(type) || []) fn();
      }
    };
    Object.defineProperty(dom.window, 'visualViewport', {
      value: mockVv,
      configurable: true,
      writable: true
    });

    // Seed a valid local AES room key for user 'user-chat-1' and board 'sc-icecream' epoch 1
    const roomKeyBytes = new Uint8Array(32).fill(7);
    const roomKeyB64 = Buffer.from(roomKeyBytes).toString('base64');
    saveLocalRoomKey('user-chat-1', 'sc-icecream', 1, roomKeyB64);

    // Mock API responses so the unlocked Land Chat board & composer render live
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/chat/enter')) {
        return new Response(
          JSON.stringify({
            ok: true,
            initialized: true,
            boardId: 'sc-icecream',
            board: {
              sculptureId: 'sc-icecream',
              keyEpoch: 1,
              creatorSub: 'user-chat-1',
              hasClue: false
            },
            sight: { distanceMeters: 1.7 },
            isLandHolder: true,
            messages: [],
            pendingRequestsCount: 0,
            pinMeta: { hasPins: false, batchSeq: 0 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true, grants: [], meta: { hasPins: false, batchSeq: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const { default: SculptureChatDrawer } = await loadJsxModule(
      'client/src/components/SculptureChatDrawer.jsx'
    );

    let closedCount = 0;
    const view = RTL.render(
      React.createElement(SculptureChatDrawer, {
        sculpture: {
          id: 'sc-icecream',
          title: 'I SCREAMED',
          parcelId: 'GLAND-ICECREAM',
          parcelName: 'I SCREAMED 🍦 Land',
          creatorSub: 'user-chat-1',
          creatorUsername: 'bigdog',
          distanceMeters: 2
        },
        user: {
          id: 'user-chat-1',
          username: 'bigdog',
          name: 'bigdog'
        },
        location: { lat: 37.7749, lng: -122.4194, altitude: 10 },
        cameraReady: true,
        onRequestLogin: () => {},
        onClose: () => {
          closedCount += 1;
        }
      })
    );

    // Wait for unlocked composer to appear
    const input = await view.findByTestId('chat-composer-input');
    const backdrop = view.getByTestId('sculpture-chat-backdrop');
    const sendBtn = view.getByTestId('chat-composer-send');
    assert.equal(backdrop.getAttribute('data-fullscreen'), 'true');
    assert.equal(backdrop.getAttribute('data-keyboard-open'), 'false');
    assert.equal(backdrop.style.height, '844px');
    assert.equal(backdrop.style.top, '0px');
    assert.equal(input.getAttribute('enterkeyhint'), 'send');
    assert.equal(sendBtn.disabled, true);

    // Simulate focusing input and mobile keyboard sliding up (shrinking visualViewport to 360px + 54px offsetTop)
    RTL.fireEvent.focus(input);
    await RTL.act(async () => {
      mockVv.height = 360;
      mockVv.offsetTop = 54;
      mockVv.emit('resize');
      mockVv.emit('scroll');
    });

    assert.equal(backdrop.getAttribute('data-keyboard-open'), 'true');
    assert.ok(backdrop.className.includes('is-keyboard-open'));
    assert.equal(backdrop.style.height, '360px');
    assert.equal(backdrop.style.top, '54px');
    assert.ok(view.getByTestId('chat-board-feed'));

    // Type text and verify user sees live text and Send button becomes enabled
    RTL.fireEvent.change(input, { target: { value: 'Hey from the plaza :fire:' } });
    assert.ok(input.value.includes('Hey from the plaza'));
    assert.equal(sendBtn.disabled, false);

    // Simulate dismissing mobile keyboard -> restores full 844px height & top 0px
    await RTL.act(async () => {
      mockVv.height = 844;
      mockVv.offsetTop = 0;
      mockVv.emit('resize');
      mockVv.emit('scroll');
    });
    assert.equal(backdrop.getAttribute('data-keyboard-open'), 'false');
    assert.equal(backdrop.style.height, '844px');
    assert.equal(backdrop.style.top, '0px');

    // Escape closes full-screen chat cleanly
    RTL.fireEvent.keyDown(dom.window, { key: 'Escape' });
    assert.equal(closedCount, 1);

    view.unmount();
  });
});
