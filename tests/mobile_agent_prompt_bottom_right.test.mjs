/* global window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(process.cwd());

describe('Bottom-Right Copy Agent Prompt Button, Camera-Hidden View, and Copy Confirmation', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-agent-prompt-'));
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
      // ignore cleanup errors
    }
  });

  test('1. Copy Agent Prompt icon is removed from bottom slider (KEY_TOOLS) and placed on main window bottom right', async () => {
    const { KEY_TOOLS } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const ids = KEY_TOOLS.map((t) => t.id);
    assert.equal(ids.includes('agent'), false, 'Agent prompt icon must be removed from bottom slider');

    let opened = 0;
    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'draw',
        dockOpen: false,
        location: null,
        voxels: [],
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true, coveragePct: 100, scannedCount: 7, targetCount: 7 },
        isInteractingWithLand: false,
        onOpenAgentHandoff: () => {
          opened += 1;
        }
      })
    );

    const btn = view.getByTestId('floating-agent-prompt-btn');
    assert.ok(btn.classList.contains('floating-agent-prompt-btn'));
    RTL.fireEvent.click(btn);
    assert.equal(opened, 1, 'Tapping bottom-right Copy Agent Prompt button must open the view');
    cleanup();
  });

  test('2. useDrafts openAgentHandoff opens immediately without GPS gate & MobileStudio hides camera during agentOpen', async () => {
    const { useDrafts } = await loadJsxModule('client/src/hooks/useDrafts.js');

    const stableEmptyDraft = {};
    const stableEmptyVoxels = [];
    const noop = () => {};
    const emptySnapshot = () => '';

    function DraftsOpenHarness() {
      const locationRef = React.useRef(null);
      const voxelsRef = React.useRef(stableEmptyVoxels);
      const surfaceAnchorRef = React.useRef(null);
      const modeRef = React.useRef('draw');
      const drafts = useDrafts({
        initialDraft: stableEmptyDraft,
        user: null,
        location: null,
        locationRef,
        voxels: stableEmptyVoxels,
        voxelsRef,
        setVoxels: noop,
        title: '',
        setTitle: noop,
        description: '',
        setDescription: noop,
        cluePrompt: '',
        setCluePrompt: noop,
        setClueAnswer: noop,
        color: '#00f5d4',
        material: 'matte',
        reachMeters: 1.8,
        surfaceAnchor: null,
        setSurfaceAnchor: noop,
        surfaceAnchorRef,
        modeRef,
        setMode: noop,
        commitTransformAndExit: noop,
        stopBrushPainting: noop,
        resetArtTransformState: noop,
        captureSculptureSnapshot: emptySnapshot,
        setSensorBanner: noop,
        showTemporaryHint: noop
      });

      return React.createElement(
        'div',
        null,
        React.createElement(
          'button',
          { type: 'button', 'data-testid': 'trigger-agent', onClick: drafts.openAgentHandoff },
          'Open'
        ),
        React.createElement('div', { 'data-testid': 'agent-open-flag' }, drafts.agentOpen ? 'open' : 'closed')
      );
    }

    const view = RTL.render(React.createElement(DraftsOpenHarness));
    assert.equal(view.getByTestId('agent-open-flag').textContent, 'closed');
    RTL.fireEvent.click(view.getByTestId('trigger-agent'));
    await RTL.waitFor(() => {
      assert.equal(
        view.getByTestId('agent-open-flag').textContent,
        'open',
        'Agent prompt view MUST open immediately even when GPS is not locked yet'
      );
    });
    cleanup();

    const mobileStudioSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    assert.match(
      mobileStudioSrc,
      /renderPaused=\{Boolean\([\s\S]*?drafts\.agentOpen[\s\S]*?\)\}/,
      'MobileStudio must pause AR rendering when drafts.agentOpen is true'
    );
    assert.match(
      mobileStudioSrc,
      /cameraHidden=\{Boolean\(catalogSearchOpen \|\| drafts\.agentOpen\)\}/,
      'MobileStudio must hide the camera view when drafts.agentOpen is true'
    );
  });

  test('3. AgentHandoffModal hides camera, tailors prompt for existing land vs claiming new land, and confirms successful copy', async () => {
    const { AgentHandoffModal } = await loadJsxModule(
      'client/src/components/studio/AgentPairModals.jsx'
    );

    let copiedValue = '';
    const origClipboard = globalThis.navigator.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          copiedValue = String(text || '');
        }
      },
      configurable: true
    });

    try {
      let closeCount = 0;
      let notifyMsg = '';
      let copiedFlag = false;

      // 3a) Standing ON an existing land -> prompt tells agent to add to that land & engage like a human
      const viewOnLand = RTL.render(
        React.createElement(AgentHandoffModal, {
          agentBusy: false,
          agentError: '',
          agentSession: {
            code: 'AGT-1234',
            parcelId: 'GLAND-9Q8YYWE3',
            status: 'waiting',
            endpoints: {
              spec: 'https://api.example.com/api/agent/spec',
              session: 'https://api.example.com/api/agent/sessions/AGT-1234',
              submitSculpture: 'https://api.example.com/api/agent/sessions/AGT-1234/sculpture'
            }
          },
          agentCopied: copiedFlag,
          setAgentCopied: (v) => {
            copiedFlag = v;
          },
          location: { lat: 39.7302, lng: -121.8406, altitude: 62 },
          activeLand: {
            parcelId: 'GLAND-9Q8YYWE3',
            customName: 'Neon Plaza',
            isInside: true
          },
          onNotifyCopied: (m) => {
            notifyMsg = m;
          },
          onClose: () => {
            closeCount += 1;
          }
        })
      );

      const modal = viewOnLand.getByTestId('mobile-agent-prompt-modal');
      assert.ok(modal.classList.contains('is-fullscreen-sheet'));
      assert.equal(modal.getAttribute('data-camera-hidden'), 'true');
      assert.ok(viewOnLand.getByTestId('mobile-agent-camera-paused-note'));
      assert.equal(viewOnLand.getByTestId('agent-location-context').getAttribute('data-on-land'), 'true');

      const previewOnLand = viewOnLand.getByTestId('agent-prompt-preview').textContent;
      assert.match(previewOnLand, /Neon Plaza/);
      assert.match(previewOnLand, /GLAND-9Q8YYWE3/);
      assert.match(previewOnLand, /search_3d_catalog/);
      assert.match(previewOnLand, /Engage With This Land Like a Human/i);
      assert.match(previewOnLand, /AGT-1234/);

      // Backdrop taps MUST NOT dismiss the full-screen Agent Prompt sheet
      RTL.fireEvent.click(modal);
      assert.equal(closeCount, 0);

      // Clicking Copy copies the prompt AND displays unmistakable confirmation feedback!
      RTL.fireEvent.click(viewOnLand.getByTestId('copy-agent-prompt-btn'));
      await RTL.waitFor(() => {
        assert.ok(viewOnLand.queryByTestId('agent-copy-confirmation'));
      });
      assert.ok(copiedValue.includes('Neon Plaza'), 'Clipboard must contain tailored on-land prompt');
      assert.match(
        viewOnLand.getByTestId('copy-agent-prompt-btn').textContent,
        /Prompt Copied to Clipboard/i
      );
      assert.match(viewOnLand.getByTestId('agent-copy-confirmation').textContent, /Prompt copied/i);
      assert.ok(notifyMsg.length > 0, 'Copy must also trigger HUD notification callback');

      // Escape & explicit Camera close button dismiss cleanly
      RTL.fireEvent.keyDown(window, { key: 'Escape' });
      assert.equal(closeCount, 1);
      RTL.fireEvent.click(viewOnLand.getByTestId('agent-prompt-close-btn'));
      assert.equal(closeCount, 2);
      cleanup();

      // 3b) Standing on UNCLAIMED open spot -> prompt tells agent to claim new land or engage like a human
      const viewOpenSpot = RTL.render(
        React.createElement(AgentHandoffModal, {
          agentBusy: false,
          agentError: '',
          agentSession: null,
          agentCopied: false,
          setAgentCopied: () => {},
          location: { lat: 39.7401, lng: -121.8512 },
          activeLand: null,
          onClose: () => {}
        })
      );

      assert.equal(viewOpenSpot.getByTestId('agent-location-context').getAttribute('data-on-land'), 'false');
      const previewOpen = viewOpenSpot.getByTestId('agent-prompt-preview').textContent;
      assert.match(previewOpen, /Claim a New 3D Virtual Land/i);
      assert.match(previewOpen, /claim_land/);
      assert.match(previewOpen, /39\.740100, -121\.851200/);
      assert.match(previewOpen, /Engage Like a Human/i);
      cleanup();
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: origClipboard,
        configurable: true
      });
    }
  });
});
