import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('UI Toolbar & Module Cleanup (Copy Icons, Save 3D Volume, Refresh, Top Trophy)', () => {
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
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({
              path: 'stub.css',
              namespace: 'stub-css'
            }));
            build.onResolve({ filter: /\?url$/ }, () => ({
              path: 'stub-url',
              namespace: 'stub-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-toolbar-cleanup-'));
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
    globalThis.matchMedia =
      globalThis.matchMedia ||
      (() => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      }));
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    globalThis.fetch = origFetch;
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('1. DesktopHub places icon-only trophy in top menu bar, removes Leaders & Refresh buttons, and puts icon-only copy in top-right of land cards', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
    const { default: DesktopIntroBanner } = await loadJsxModule(
      'client/src/components/DesktopIntroBanner.jsx'
    );

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sculptures')) {
        return new Response(JSON.stringify({ sculptures: [] }), { status: 200 });
      }
      if (u.includes('/api/lands/mine')) {
        return new Response(JSON.stringify({ parcels: [], parcelCount: 0 }), { status: 200 });
      }
      if (u.includes('/api/parcels') || u.includes('/api/lands')) {
        return new Response(
          JSON.stringify({
            parcels: [
              {
                parcelId: 'GLAND-TOP1',
                customName: 'Sunset Plaza',
                centerLat: 39.73,
                centerLng: -121.84,
                ownerSub: 'u-1',
                volume: {
                  centerLat: 39.73,
                  centerLng: -121.84,
                  widthMeters: 20,
                  depthMeters: 20,
                  heightMeters: 15
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (u.includes('/api/marketplace/listings')) {
        return new Response(JSON.stringify({ listings: [] }), { status: 200 });
      }
      if (u.includes('/api/leaderboard')) {
        return new Response(JSON.stringify({ leaderboard: [], aiStewards: [], humanArtists: [] }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ ok: true, notifications: [], pairings: [] }), {
        status: 200
      });
    };

    let view;
    await RTL.act(async () => {
      view = RTL.render(
        React.createElement(DesktopHub, {
          config: { policy: {} },
          user: { id: 'u-1', username: 'bigdog', walletAddress: '0x1111111111111111111111111111111111111111' },
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );
      await new Promise((r) => setTimeout(r, 40));
    });

    // Trophy icon is on the top main menu bar (header.desktop-nav) with no "Leaders" text
    const trophyBtn = view.getByTestId('nav-leaderboard-btn');
    assert.ok(
      view.container.querySelector('header.desktop-nav')?.contains(trophyBtn),
      'Trophy button must live inside the top main menu bar (header.desktop-nav)'
    );
    assert.equal((trophyBtn.textContent || '').trim(), '', 'Trophy button should be icon-only');
    const trophyImg = trophyBtn.querySelector('img');
    assert.ok(
      trophyImg && String(trophyImg.getAttribute('src') || '').includes('1f3c6'),
      'Trophy button must render the trophy icon (1f3c6)'
    );

    // No "Leaders" button anywhere
    assert.equal(view.queryByRole('button', { name: /Leaders/i }), null);

    // Clicking the top trophy icon opens Creator Leaderboard; clicking again returns to List
    RTL.fireEvent.click(trophyBtn);
    assert.ok(view.getByLabelText('Creator Leaderboard'));
    RTL.fireEvent.click(trophyBtn);
    assert.equal(view.queryByLabelText('Creator Leaderboard'), null);

    // No Refresh button on desktop right panel
    assert.equal(view.queryByLabelText(/Refresh land/i), null);
    assert.equal(view.container.querySelector('.desktop-nearby-refresh-btn'), null);

    // Land card has icon-only copy button in .desktop-land-item-top and zero "Copy Link" buttons
    const cardCopyBtn = view.getByTestId('desktop-land-copy-link-btn');
    assert.ok(
      cardCopyBtn.closest('.desktop-land-item-top'),
      'Land card copy icon must be placed in .desktop-land-item-top'
    );
    assert.equal((cardCopyBtn.textContent || '').trim(), '');
    assert.equal(view.queryByRole('button', { name: /Copy Link/i }), null);
    cleanup();

    // DesktopIntroBanner also omits the "Leaders" button
    const introView = RTL.render(
      React.createElement(DesktopIntroBanner, {
        user: null,
        roleTab: 'agent',
        onOpenMarket: () => {},
        onOpenQuests: () => {},
        onOpenLeaders: () => {}
      })
    );
    assert.equal(introView.queryByRole('button', { name: /Leaders/i }), null);
    cleanup();
  });

  test('2. DesktopLandBuilderPanel removes Save 3D Volume & Copy Link buttons and places icon-only copy in editor top-right', async () => {
    const { default: DesktopLandBuilderPanel } = await loadJsxModule(
      'client/src/components/DesktopLandBuilderPanel.jsx'
    );

    const ownedParcel = {
      parcelId: 'GLAND-OWNED1',
      customName: 'Neon Rooftop',
      volume: {
        parcelId: 'GLAND-OWNED1',
        centerLat: 39.73,
        centerLng: -121.84,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 18,
        zScale: 1,
        rotationDeg: 0
      }
    };

    const view = RTL.render(
      React.createElement(DesktopLandBuilderPanel, {
        draftParcels: [],
        selectedDraftId: `owned:${ownedParcel.parcelId}`,
        ownedParcels: [ownedParcel],
        onSelectDraft: () => {},
        onOpenAddLandItem: () => {}
      })
    );

    // "Save 3D Volume" button is completely removed
    assert.equal(view.queryByRole('button', { name: /Save 3D Volume/i }), null);
    // No "Copy Link" text button in .land-editor-actions
    const actionsEl = view.container.querySelector('.land-editor-actions');
    assert.ok(actionsEl);
    assert.equal(actionsEl.textContent.includes('Copy Link'), false);
    assert.equal(actionsEl.textContent.includes('Save 3D Volume'), false);

    // Icon-only copy button lives in top-right of .land-editor-header
    const headerCopyBtn = view.getByTestId('land-editor-header-copy-link-btn');
    assert.ok(headerCopyBtn.closest('.land-editor-header'));
    assert.equal((headerCopyBtn.textContent || '').trim(), '');
    cleanup();
  });

  test('3. All shareable modals/modules expose icon-only copy in top-right and have zero Copy Link text buttons', async () => {
    const { default: SculptureModal } = await loadJsxModule('client/src/components/SculptureModal.jsx');
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );
    const { default: AddLandItemModal } = await loadJsxModule(
      'client/src/components/AddLandItemModal.jsx'
    );
    const { default: LandArchiveModal } = await loadJsxModule(
      'client/src/components/LandArchiveModal.jsx'
    );
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );

    const copiedTexts = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          copiedTexts.push(text);
        }
      },
      configurable: true
    });

    // 3a) SculptureModal
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const scView = RTL.render(
      React.createElement(SculptureModal, {
        sculpture: {
          id: 'sc-clean-1',
          title: 'Bonsai Clean',
          parcelId: 'GLAND-CLN1',
          lat: 39.73,
          lng: -121.84,
          voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }]
        },
        user: null,
        config: {},
        onClose: () => {}
      })
    );
    const scCopy = scView.getByTestId('sculpture-header-copy-link-btn');
    assert.ok(scCopy.closest('.sculpture-modal-top-actions'));
    assert.equal((scCopy.textContent || '').trim(), '');
    assert.equal(scView.container.textContent.includes('Copy Link'), false);
    await RTL.act(async () => {
      RTL.fireEvent.click(scCopy);
    });
    assert.ok(
      copiedTexts.at(-1)?.includes('/share/sculpture/sc-clean-1') ||
        copiedTexts.at(-1)?.includes('sculpture=sc-clean-1')
    );
    cleanup();

    // 3b) LandManagementModal
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        return new Response(
          JSON.stringify({
            parcels: [
              {
                parcelId: 'GLAND-MGT1',
                customName: 'Civic Yard',
                volume: { widthMeters: 15, depthMeters: 15, heightMeters: 15 },
                sculptures: []
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ passkeys: [] }), { status: 200 });
    };
    let mgtView;
    await RTL.act(async () => {
      mgtView = RTL.render(
        React.createElement(LandManagementModal, {
          user: { id: 'u-1', username: 'bigdog' },
          onClose: () => {}
        })
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    const mgtCopy = mgtView.getByTestId('land-mgmt-header-copy-link-btn');
    assert.ok(mgtCopy.closest('.modal-header-actions'));
    assert.equal((mgtCopy.textContent || '').trim(), '');
    assert.equal(mgtView.container.textContent.includes('Copy Link'), false);
    cleanup();

    // 3c) AddLandItemModal
    const addView = RTL.render(
      React.createElement(AddLandItemModal, {
        parcel: {
          parcelId: 'GLAND-ADD1',
          customName: 'Sky Deck',
          volume: { widthMeters: 12, depthMeters: 12, heightMeters: 12 }
        },
        user: { id: 'u-1', username: 'bigdog' },
        onClose: () => {}
      })
    );
    const addCopy = addView.getByTestId('add-item-header-copy-link-btn');
    assert.ok(addCopy.closest('.modal-header-actions'));
    assert.equal((addCopy.textContent || '').trim(), '');
    assert.equal(addView.container.textContent.includes('Copy Link'), false);
    cleanup();

    // 3d) LandArchiveModal
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ archivedParcels: [], stats: {} }), { status: 200 });
    const archView = RTL.render(React.createElement(LandArchiveModal, { onClose: () => {} }));
    const archCopy = archView.getByTestId('archive-header-copy-link-btn');
    assert.ok(archCopy.closest('.modal-header'));
    assert.equal((archCopy.textContent || '').trim(), '');
    assert.equal(archView.container.textContent.includes('Copy Archive Link'), false);
    cleanup();

    // 3e) ProfileModal
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          profile: {
            id: 'u-1',
            username: 'bigdog',
            bio: 'Street builder',
            parcels: [],
            sculptures: []
          }
        }),
        { status: 200 }
      );
    let profView;
    await RTL.act(async () => {
      profView = RTL.render(
        React.createElement(ProfileModal, {
          handle: 'bigdog',
          user: { id: 'u-1', username: 'bigdog' },
          onClose: () => {}
        })
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    const profCopy = profView.getByTestId('copy-profile-link-btn');
    assert.ok(profCopy.closest('.modal-header'));
    assert.equal((profCopy.textContent || '').trim(), '');
    assert.equal(profView.container.textContent.includes('Copy Public Profile Link'), false);
    cleanup();

    // 3f) ARLandInspectorPanel
    const arView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: {
          parcelId: 'GLAND-AR1',
          customName: 'Stibblez Land',
          isInside: true,
          edgeDistanceMeters: 0,
          googleMapsUrl: 'https://maps.google.com/?q=39.73,-121.84',
          sculptures: []
        },
        onAdjustCompassNudge: () => {},
        onClose: () => {}
      })
    );
    const arCopy = arView.getByTestId('ar-land-copy-link-btn');
    assert.ok(arCopy.closest('.ar-land-top-right'));
    assert.equal((arCopy.textContent || '').trim(), '');
    assert.equal(arView.container.textContent.includes('Copy Link'), false);
    cleanup();

    // 3g) PublishSculptureModal (mint receipt)
    const pubView = RTL.render(
      React.createElement(PublishSculptureModal, {
        config: {},
        user: { id: 'u-1', username: 'bigdog' },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
        title: 'Fresh Tag',
        description: '',
        mintReceipt: {
          sculpture: { id: 'sc-minted-9', title: 'Fresh Tag', parcelId: 'GLAND-PUB1' },
          mint: { tokenId: '42', txHash: '0xabc' },
          ipfs: { metadataCid: 'bafy123' }
        },
        onClose: () => {}
      })
    );
    const pubCopy = pubView.getByTestId('publish-header-copy-link-btn');
    assert.ok(pubCopy.closest('.modal-header-actions'));
    assert.equal((pubCopy.textContent || '').trim(), '');
    assert.equal(pubView.container.textContent.includes('Copy Link'), false);
    cleanup();
  });

  test('4. Refresh buttons are removed from MobileMapSheet, NotificationCenter, AdminPanel, SavedDraftsModal, and MobilePairApprovalDropdown', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const { default: NotificationCenter } = await loadJsxModule(
      'client/src/components/NotificationCenter.jsx'
    );
    const { default: AdminPanel } = await loadJsxModule('client/src/components/AdminPanel.jsx');
    const { SavedDraftsModal } = await loadJsxModule(
      'client/src/components/studio/AgentPairModals.jsx'
    );
    const { default: MobilePairApprovalDropdown } = await loadJsxModule(
      'client/src/components/studio/MobilePairApprovalDropdown.jsx'
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ notifications: [], history: [], sculptures: [], reports: [] }), {
        status: 200
      });

    // MobileMapSheet
    const mapView = RTL.render(
      React.createElement(MobileMapSheet, {
        config: {},
        location: { lat: 39.73, lng: -121.84 },
        mapParcels: [],
        onClose: () => {}
      })
    );
    assert.equal(mapView.queryByLabelText(/Refresh/i), null);
    assert.equal(mapView.queryByRole('button', { name: /Refresh/i }), null);
    cleanup();

    // NotificationCenter (open inbox + history)
    let notifView;
    await RTL.act(async () => {
      notifView = RTL.render(
        React.createElement(NotificationCenter, {
          user: { id: 'u-1', username: 'bigdog' },
          variant: 'desktop'
        })
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    RTL.fireEvent.click(notifView.getByRole('button', { name: /Notifications/i }));
    assert.equal(notifView.queryByTestId('notif-refresh-btn'), null);
    assert.equal(notifView.queryByRole('button', { name: /Refresh/i }), null);
    const historyTab = notifView.queryByRole('tab', { name: /History/i }) || notifView.queryByRole('button', { name: /History/i });
    if (historyTab) {
      RTL.fireEvent.click(historyTab);
      assert.equal(notifView.queryByRole('button', { name: /Refresh/i }), null);
    }
    cleanup();

    // AdminPanel
    const adminView = RTL.render(
      React.createElement(AdminPanel, {
        config: { chain: { network: { name: 'Base Sepolia', chainId: 84532 } }, ipfsProvider: 'pinata' }
      })
    );
    assert.equal(adminView.queryByRole('button', { name: /Refresh/i }), null);
    cleanup();

    // SavedDraftsModal
    const draftsView = RTL.render(
      React.createElement(SavedDraftsModal, {
        user: { id: 'u-1', username: 'bigdog' },
        title: 'Test Draft',
        description: '',
        voxelsLength: 5,
        cloudDrafts: [],
        onClose: () => {}
      })
    );
    assert.equal(draftsView.queryByRole('button', { name: /Refresh/i }), null);
    cleanup();

    // MobilePairApprovalDropdown (history tab)
    const pairView = RTL.render(
      React.createElement(MobilePairApprovalDropdown, {
        open: true,
        user: { id: 'u-1', username: 'bigdog' },
        signatureHistory: [],
        pendingSignatures: [],
        onClose: () => {}
      })
    );
    const histBtn = pairView.queryByRole('button', { name: /History/i });
    if (histBtn) {
      RTL.fireEvent.click(histBtn);
    }
    assert.equal(pairView.queryByRole('button', { name: /Refresh/i }), null);
    cleanup();
  });
});
