import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(process.cwd());

describe('Align AR Removal, Land Management Ordered Unfold, Portrait-Only Lock & Default 6-DoF ARCore Pre-Calibration', () => {
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
      define: { 'import.meta.env': '{}' },
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-arcore-portrait-land-'));
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
    globalThis.requestAnimationFrame = (cb) => {
      cb(Date.now());
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
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
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('1. Align AR button, manual compass nudge settings, and on-screen 6-DoF buttons are removed from AR HUD & Inspector', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const inspView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: {
          parcelId: 'GLAND-NOALIGN',
          displayName: 'Sunset Plaza',
          centerLat: 37.7749,
          centerLng: -122.4194,
          isInside: true,
          isOwned: true,
          sculptures: []
        },
        onOpen3DMap: () => {},
        onManageLand: () => {},
        onClose: () => {}
      })
    );
    assert.equal(inspView.queryByTestId('ar-compass-align-toggle-btn'), null);
    assert.equal(inspView.queryByTestId('ar-compass-nudge-controls'), null);
    assert.equal(inspView.queryByTestId('ar-inspector-webxr-btn'), null);
    assert.equal(inspView.container.textContent.includes('Align AR'), false);
    inspView.unmount();

    const hudView = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'preview',
        dockOpen: false,
        location: { lat: 37.7749, lng: -122.4194 },
        voxels: [],
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true, coveragePct: 100, scannedCount: 9, targetCount: 9 },
        isInteractingWithLand: true,
        webxrActive: false,
        sensorStatus: {
          source: 'ios-compass-fused',
          trueNorthLocked: true,
          headingAccuracyDeg: 5,
          gpsAccuracyM: 4,
          needsCompassCalibration: false
        }
      })
    );
    assert.equal(
      hudView.queryByTestId('ar-webxr-toggle-btn'),
      null,
      'On-screen 6-DoF ARCore toggle button must not appear on camera HUD'
    );
    hudView.unmount();

    const infoSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/InfoTermsModal.jsx'),
      'utf8'
    );
    assert.equal(
      /Align nudge/i.test(infoSrc),
      false,
      'Help guide must no longer tell users to use manual Align nudge'
    );
  });

  test('2. LandManagementModal keeps lands folded under an unfold button, sorts cleanly A–Z, and closes list + moves to preview on selection', async () => {
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        return {
          ok: true,
          json: async () => ({
            ownerAddress: '0xabc',
            parcelCount: 3,
            parcels: [
              {
                parcelId: 'GLAND-ZEBRA',
                customName: 'Zebra Park',
                centerLat: 37.78,
                centerLng: -122.41,
                volume: { centerLat: 37.78, centerLng: -122.41, widthMeters: 16, depthMeters: 16, heightMeters: 16 },
                sculptureCount: 4,
                frozen: false,
                sculptures: []
              },
              {
                parcelId: 'GLAND-ALPHA',
                customName: 'Alpha Plaza',
                centerLat: 37.77,
                centerLng: -122.42,
                volume: { centerLat: 37.77, centerLng: -122.42, widthMeters: 18, depthMeters: 18, heightMeters: 20 },
                sculptureCount: 2,
                frozen: false,
                sculptures: []
              },
              {
                parcelId: 'GLAND-MID',
                customName: 'Midtown Tower',
                centerLat: 40.75,
                centerLng: -73.98,
                volume: { centerLat: 40.75, centerLng: -73.98, widthMeters: 20, depthMeters: 20, heightMeters: 24 },
                sculptureCount: 1,
                frozen: true,
                sculptures: []
              }
            ]
          })
        };
      }
      if (u.includes('/api/passkeys/status')) {
        return { ok: true, json: async () => ({ passkeys: [] }) };
      }
      return { ok: true, json: async () => ({ shortLabel: 'Downtown' }) };
    };

    let scrolledIntoViewCount = 0;
    const origScrollIntoView = dom.window.HTMLElement.prototype.scrollIntoView;
    dom.window.HTMLElement.prototype.scrollIntoView = function () {
      scrolledIntoViewCount += 1;
    };

    try {
      const view = RTL.render(
        React.createElement(LandManagementModal, {
          user: { id: 'u1', walletAddress: '0xabc' },
          onClose: () => {}
        })
      );

      // Loads first alphabetically (Alpha Plaza) and keeps lands list FOLDED by default!
      await RTL.waitFor(() => {
        const preview = view.getByTestId('land-mgmt-iso-preview');
        assert.equal(preview.getAttribute('data-parcel-id'), 'GLAND-ALPHA');
      });
      assert.equal(
        view.queryByTestId('land-mgmt-lands-list'),
        null,
        'Owned lands list must be folded by default so it does not push content down'
      );

      const unfoldBtn = view.getByTestId('land-mgmt-lands-unfold-btn');
      assert.equal(unfoldBtn.getAttribute('aria-expanded'), 'false');
      assert.ok(unfoldBtn.textContent.includes('My Lands (3)'));

      // Unfold the list -> verify clean A-Z ordered rows (#1 Alpha Plaza, #2 Midtown Tower, #3 Zebra Park)
      RTL.fireEvent.click(unfoldBtn);
      assert.equal(unfoldBtn.getAttribute('aria-expanded'), 'true');
      const rows = view.getAllByTestId('land-mgmt-land-row');
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((r) => r.getAttribute('data-parcel-id')),
        ['GLAND-ALPHA', 'GLAND-MID', 'GLAND-ZEBRA']
      );
      assert.ok(rows[0].textContent.includes('#1') && rows[0].textContent.includes('Alpha Plaza'));
      assert.ok(rows[1].textContent.includes('#2') && rows[1].textContent.includes('Midtown Tower'));
      assert.ok(rows[2].textContent.includes('#3') && rows[2].textContent.includes('Zebra Park'));

      // Select Zebra Park -> unfolded list immediately closes, preview switches to GLAND-ZEBRA, and scrolls to preview
      scrolledIntoViewCount = 0;
      RTL.fireEvent.click(rows[2]);

      assert.equal(
        view.queryByTestId('land-mgmt-lands-list'),
        null,
        'Selecting a land must immediately close the unfolded list view'
      );
      assert.equal(unfoldBtn.getAttribute('aria-expanded'), 'false');
      await RTL.waitFor(() => {
        assert.equal(
          view.getByTestId('land-mgmt-iso-preview').getAttribute('data-parcel-id'),
          'GLAND-ZEBRA'
        );
      });
      assert.ok(
        scrolledIntoViewCount >= 1,
        'Selecting a land must move/scroll cleanly to the land preview section'
      );
      view.unmount();
    } finally {
      globalThis.fetch = origFetch;
      dom.window.HTMLElement.prototype.scrollIntoView = origScrollIntoView;
    }
  });

  test('3. Mobile portrait lock blocks horizontal rotation across orientation APIs, fullscreen, CSS, and WebXR', async () => {
    const {
      installMobileViewportLock,
      syncPortraitLockClass
    } = await loadJsxModule('client/src/utils/mobilePortraitLock.js');

    const { window: win } = dom;
    const { document: doc } = win;

    let lockAttempts = 0;
    const fakeScreenOrient = {
      type: 'portrait-primary',
      listeners: new Map(),
      async lock(mode) {
        lockAttempts += 1;
        if (mode !== 'portrait-primary') throw new Error('bad mode');
      },
      addEventListener(ev, fn) {
        this.listeners.set(ev, fn);
      },
      removeEventListener(ev) {
        this.listeners.delete(ev);
      }
    };
    Object.defineProperty(win, 'screen', {
      value: { orientation: fakeScreenOrient },
      configurable: true,
      writable: true
    });
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true, writable: true });
    Object.defineProperty(win, 'innerHeight', { value: 844, configurable: true, writable: true });

    const uninstall = installMobileViewportLock({ win, doc });
    try {
      assert.equal(doc.documentElement.classList.contains('mobile-portrait-locked'), true);
      assert.equal(doc.documentElement.classList.contains('mobile-landscape-blocked'), false);
      const initialLocks = lockAttempts;

      // Rotate device horizontally -> class toggles ON immediately and portrait lock re-attempts!
      fakeScreenOrient.type = 'landscape-primary';
      win.innerWidth = 844;
      win.innerHeight = 390;
      const blocked = syncPortraitLockClass(win, doc);
      assert.equal(blocked, true);
      assert.equal(doc.documentElement.classList.contains('mobile-landscape-blocked'), true);

      // Firing screen.orientation change re-attempts native portrait lock
      fakeScreenOrient.listeners.get('change')?.();
      assert.ok(
        lockAttempts > initialLocks,
        'Rotating sideways must re-attempt native screen.orientation.lock("portrait-primary")'
      );

      // Return upright -> horizontal block clears cleanly
      fakeScreenOrient.type = 'portrait-primary';
      win.innerWidth = 390;
      win.innerHeight = 844;
      assert.equal(syncPortraitLockClass(win, doc), false);
      assert.equal(doc.documentElement.classList.contains('mobile-landscape-blocked'), false);
    } finally {
      uninstall();
    }

    assert.equal(doc.documentElement.classList.contains('mobile-landscape-blocked'), false);

    // Verify CSS + App.jsx + ARViewportCanvas horizontal block hardening
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    assert.ok(css.includes('html.mobile-landscape-blocked .mobile-fullscreen'));
    assert.ok(css.includes('overflow-x: hidden;'));
    assert.ok(css.includes('overscroll-behavior-x: none;'));
    assert.ok(css.includes('z-index: 2147483647;'));

    const appSrc = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8');
    assert.match(appSrc, /wasMobileRef/);
    assert.match(appSrc, /syncPortraitLockClass/);
    assert.match(appSrc, /orientation:\s*landscape/);

    const viewportSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(viewportSrc, /document\.getElementById\('root'\)/);
    assert.match(viewportSrc, /tryLockPortraitOrientation\(\)/);
  });

  test('4. Default 6-DoF ARCore pre-calibration prompt runs BEFORE standard calibration when supported, and Settings toggle controls it', async () => {
    const {
      resetArSettings,
      saveArSettings,
      loadArSettings,
      shouldShowWebXrPreCalibrationPrompt
    } = await loadJsxModule('client/src/utils/arSettings.js');
    const { default: SceneCoverageWidget } = await loadJsxModule(
      'client/src/components/studio/SceneCoverageWidget.jsx'
    );
    const { default: ArTrackingSettings } = await loadJsxModule(
      'client/src/components/ArTrackingSettings.jsx'
    );
    const { default: ProfileModal } = await loadJsxModule(
      'client/src/components/ProfileModal.jsx'
    );

    resetArSettings();
    const defaults = loadArSettings();
    assert.equal(defaults.useWebXr6Dof, true, '6-DoF ARCore setting must default to ON');
    assert.equal(
      defaults.autoPreCalibrationPrompt,
      true,
      'Pre-calibration 6-DoF prompt setting must default to ON'
    );

    // Prompt activates by default BEFORE calibration when device supports 6-DoF ARCore
    assert.equal(
      shouldShowWebXrPreCalibrationPrompt({
        webxrSupported: true,
        webxrActive: false,
        arSettings: defaults,
        dismissed: false,
        calibrationReady: false
      }),
      true
    );
    // Does not show on unsupported devices or once active or when turned OFF in settings
    assert.equal(
      shouldShowWebXrPreCalibrationPrompt({
        webxrSupported: false,
        webxrActive: false,
        arSettings: defaults
      }),
      false
    );
    assert.equal(
      shouldShowWebXrPreCalibrationPrompt({
        webxrSupported: true,
        webxrActive: true,
        arSettings: defaults
      }),
      false
    );
    assert.equal(
      shouldShowWebXrPreCalibrationPrompt({
        webxrSupported: true,
        webxrActive: false,
        arSettings: { useWebXr6Dof: false, autoPreCalibrationPrompt: true }
      }),
      false
    );

    // SceneCoverageWidget shows 6-DoF ARCore Ready prompt FIRST before standard sweep grid
    let startedXr = 0;
    let skippedXr = 0;
    const calView = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: { scannedCount: 0, targetCount: 7, coveragePct: 0, optimal: false },
        orbStatus: { keyframes: 0, engine: 'Gyro+ORB' },
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrating',
        showWebXrPreCalPrompt: true,
        webxrActive: false,
        onStartWebXrPreCal: () => {
          startedXr += 1;
        },
        onSkipWebXrPreCal: () => {
          skippedXr += 1;
        }
      })
    );
    assert.ok(calView.getByTestId('webxr-precalibration-prompt'));
    assert.equal(
      calView.getByTestId('scene-coverage-widget').getAttribute('data-calibration-phase'),
      'webxr-precalibration'
    );
    RTL.fireEvent.click(calView.getByTestId('webxr-precalibration-start-btn'));
    RTL.fireEvent.click(calView.getByTestId('webxr-precalibration-skip-btn'));
    assert.equal(startedXr, 1);
    assert.equal(skippedXr, 1);

    // Once 6-DoF ARCore is active, standard calibration proceeds with ✓ 6-DoF chip visible
    calView.rerender(
      React.createElement(SceneCoverageWidget, {
        sceneScan: { scannedCount: 2, targetCount: 4, coveragePct: 50, optimal: false },
        orbStatus: { keyframes: 1, engine: 'WebXR+ORB' },
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrating',
        showWebXrPreCalPrompt: false,
        webxrActive: true
      })
    );
    assert.equal(calView.queryByTestId('webxr-precalibration-prompt'), null);
    assert.ok(calView.getByTestId('cal-chip-webxr').textContent.includes('6-DoF'));
    calView.unmount();

    // ArTrackingSettings lets user turn 6-DoF ARCore and Pre-Cal Prompt ON or OFF
    let disableCalls = 0;
    let enableCalls = 0;
    const settingsView = RTL.render(
      React.createElement(ArTrackingSettings, {
        webxrSupported: true,
        webxrActive: true,
        onEnableWebxr: async () => {
          enableCalls += 1;
        },
        onDisableWebxr: async () => {
          disableCalls += 1;
        }
      })
    );
    const xrToggle = settingsView.getByTestId('setting-toggle-webxr-6dof');
    const promptToggle = settingsView.getByTestId('setting-toggle-webxr-prompt');
    assert.equal(xrToggle.getAttribute('aria-checked'), 'true');
    assert.equal(promptToggle.getAttribute('aria-checked'), 'true');

    // Toggle 6-DoF OFF -> persists false & stops active WebXR session
    await RTL.act(async () => {
      RTL.fireEvent.click(xrToggle);
    });
    assert.equal(loadArSettings().useWebXr6Dof, false);
    assert.equal(disableCalls, 1);

    // Toggle 6-DoF back ON (while inactive) -> persists true & enables WebXR
    settingsView.rerender(
      React.createElement(ArTrackingSettings, {
        webxrSupported: true,
        webxrActive: false,
        onEnableWebxr: async () => {
          enableCalls += 1;
        },
        onDisableWebxr: async () => {
          disableCalls += 1;
        }
      })
    );
    await RTL.act(async () => {
      RTL.fireEvent.click(settingsView.getByTestId('setting-toggle-webxr-6dof'));
    });
    assert.equal(loadArSettings().useWebXr6Dof, true);
    assert.equal(enableCalls, 1);

    // Toggle Pre-Calibration Prompt OFF -> persists false
    RTL.fireEvent.click(settingsView.getByTestId('setting-toggle-webxr-prompt'));
    assert.equal(loadArSettings().autoPreCalibrationPrompt, false);
    settingsView.unmount();

    // Reset back to default ON and confirm ArTrackingSettings appears inside ProfileModal ⚙️ Settings
    saveArSettings({ useWebXr6Dof: true, autoPreCalibrationPrompt: true });
    const profView = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'bigdog',
        user: { id: 'u1', username: 'bigdog', email: 'bigdog@spray.land' },
        webxrSupported: true,
        webxrActive: false,
        fetchProfileFn: async () => ({
          profile: { id: 'u1', username: 'bigdog', userNumber: 7 },
          stats: { landCount: 1, sculptureCount: 1, activeListingCount: 0, questCount: 0, actionCount: 0, totalBlocks: 10, awakenedLands: 1, totalXp: 100 },
          lands: [],
          sculptures: [],
          listings: [],
          actions: []
        }),
        onClose: () => {}
      })
    );
    await RTL.waitFor(() => {
      assert.ok(profView.getByTestId('profile-settings-gear-btn'));
    });
    RTL.fireEvent.click(profView.getByTestId('profile-settings-gear-btn'));
    assert.ok(
      profView.getByTestId('ar-tracking-settings'),
      'Profile ⚙️ Settings panel must include AR Calibration & 6-DoF ARCore toggles'
    );
    profView.unmount();
  });
});
