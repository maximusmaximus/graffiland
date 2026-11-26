import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();

describe('LaunchSplashOverlay Kinetic Brand Intro (React + jsdom + CSS)', () => {
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
      define: { 'import.meta.env': '{}' },
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.launch-splash-test-cache-'));
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
    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
  });

  test('renders large logo mark layered behind wordmark with playful sparks, waits for appReady, fades out smoothly, and unmounts cleanly', async () => {
    const { default: LaunchSplashOverlay } = await loadJsxModule(
      'client/src/components/LaunchSplashOverlay.jsx'
    );

    let completed = false;
    const view = RTL.render(
      React.createElement(LaunchSplashOverlay, {
        appReady: false,
        introDurationMs: 40,
        settleHoldMs: 25,
        fadeOutDurationMs: 60,
        onComplete: () => {
          completed = true;
        }
      })
    );

    // Starts in intro phase with official Spray Can mark + SPRAY.LAND wordmark + sparks
    const overlay = view.getByTestId('launch-splash-overlay');
    assert.equal(overlay.getAttribute('data-phase'), 'intro');
    assert.ok(view.getByTestId('brand-logo-mark'));
    assert.ok(view.getByTestId('brand-logo-wordmark'));
    assert.ok(view.getByTestId('launch-splash-mark-layer'));
    assert.ok(view.getByTestId('launch-splash-wordmark-layer'));
    assert.ok(view.getByTestId('launch-splash-sparks').children.length >= 6);

    // Transitions to settle after introDurationMs and holds while appReady is false
    await RTL.waitFor(() => {
      assert.equal(view.getByTestId('launch-splash-overlay').getAttribute('data-phase'), 'settle');
    });
    assert.equal(completed, false);

    // Once appReady flips true -> enters fadeout phase -> unmounts completely
    view.rerender(
      React.createElement(LaunchSplashOverlay, {
        appReady: true,
        introDurationMs: 40,
        settleHoldMs: 25,
        fadeOutDurationMs: 60,
        onComplete: () => {
          completed = true;
        }
      })
    );

    await RTL.waitFor(() => {
      assert.equal(view.getByTestId('launch-splash-overlay').getAttribute('data-phase'), 'fadeout');
    });

    await RTL.waitFor(() => {
      assert.equal(Boolean(view.queryByTestId('launch-splash-overlay')), false);
      assert.equal(completed, true);
    });
    cleanup();
  });

  test('CSS defines shrink-behind keyframe, wordmark reveal in front, 1000ms fadeout, and non-blocking pointer-events', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    const startIdx = css.indexOf('/* ---------- Kinetic Site Launch Splash');
    assert.ok(startIdx >= 0, 'Launch splash CSS section must exist');
    const section = css.slice(startIdx);
    assert.ok(section.includes('.launch-splash-overlay'));
    assert.ok(section.includes('pointer-events: none;'));
    assert.ok(section.includes('--launch-fadeout-ms, 1000ms'));
    assert.ok(section.includes('@keyframes launchMarkShrinkBehind'));
    assert.ok(section.includes('scale(2.15)'));
    assert.ok(section.includes('opacity: 0.24;'));
    assert.ok(section.includes('@keyframes launchWordmarkReveal'));
    assert.ok(section.includes('.launch-splash-mark-layer'));
    assert.ok(section.includes('z-index: 1;'));
    assert.ok(section.includes('.launch-splash-wordmark-layer'));
    assert.ok(section.includes('z-index: 2;'));
  });
});
