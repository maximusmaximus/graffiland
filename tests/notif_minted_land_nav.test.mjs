import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Approved & Minted Land Notifications — Backend API Persistence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprayland-notif-mint-api-'));
  let server;
  let baseUrl;
  let ownerToken;
  let parcelId;

  before(async () => {
    process.env.GRAFFILAND_DB_PATH = path.join(tmpDir, 'notif-mint.sqlite');
    process.env.GRAFFILAND_IPFS_DIR = path.join(tmpDir, 'ipfs');
    process.env.PINATA_JWT = '';
    process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
    process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
    const { createAppServer } = await import('../server/index.mjs');
    const created = createAppServer();
    server = created.server;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const auth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: {
          email: 'mint-notif-owner@spray.test',
          name: 'Mint Notif Owner',
          username: 'mint_notif_owner'
        }
      })
    }).then((r) => r.json());
    ownerToken = auth.token;
    assert.ok(ownerToken);

    const claimed = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        lat: 39.7295,
        lng: -121.8415,
        customName: 'Aurora Courtyard',
        volume: {
          centerLat: 39.7295,
          centerLng: -121.8415,
          widthMeters: 16,
          depthMeters: 16,
          heightMeters: 12,
          rotationDeg: 0
        }
      })
    }).then((r) => r.json());
    parcelId = claimed.parcelId;
    assert.ok(parcelId);
  });

  after(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore transient Windows SQLite lock on temp dir cleanup
    }
  });

  test('minting a land AND approving/minting a pending request persist open_land notifications with Go to Land action', async () => {
    // 1. Freshly minted land emits a persisted Land Minted notification with open_land action
    const afterClaimNotifs = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    }).then((r) => r.json());
    const landMintedNotif = (afterClaimNotifs.notifications || []).find(
      (n) => n.meta?.landMinted === true && n.parcelId === parcelId
    );
    assert.ok(landMintedNotif, 'Expected persisted Land Minted notification');
    assert.equal(landMintedNotif.actionType, 'open_land');
    assert.equal(landMintedNotif.actionLabel, 'Go to Land');
    assert.equal(landMintedNotif.meta?.parcelUrl, `?parcel=${encodeURIComponent(parcelId)}`);

    // 2. Paired agent queues a pending 3D sculpture mint -> creates pending approval notification
    const pairRes = await fetch(`${baseUrl}/api/mcp/pairings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({ agentName: 'sculpt-helper-bot' })
    }).then((r) => r.json());
    const pairingCode = pairRes?.pairing?.code;
    assert.ok(pairingCode);

    await fetch(`${baseUrl}/api/mcp/pairings/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode, agentName: 'sculpt-helper-bot' })
    });

    const tinyObj = ['v -0.5 0 -0.5', 'v 0.5 0 0.5', 'v 0 1 0', 'f 1 2 3'].join('\n');
    const mcpRes = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Graffiland-Pairing-Code': pairingCode
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'notif-mint-test-1',
        method: 'tools/call',
        params: {
          name: 'load_3d_model_on_land',
          arguments: {
            parcelId,
            title: 'Neon Fountain',
            description: 'Sculpture awaiting owner approval',
            modelFormat: 'obj',
            modelData: tinyObj,
            modelScale: 1
          }
        }
      })
    }).then((r) => r.json());
    const reqId = mcpRes?.result?.structuredContent?.request?.id;
    assert.ok(reqId, `Expected pending requestId, got ${JSON.stringify(mcpRes)}`);

    // 3. Owner approves & mints -> returns executed notification + persists it with open_land
    const signRes = await fetch(
      `${baseUrl}/api/signatures/requests/${encodeURIComponent(reqId)}/mobile-sign`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({})
      }
    ).then((r) => r.json());

    assert.equal(signRes.ok, true);
    assert.ok(signRes.notification, 'Expected executed notification in mobile-sign response');
    assert.equal(signRes.notification.actionType, 'open_land');
    assert.equal(signRes.notification.actionLabel, 'Go to Land');
    assert.equal(signRes.notification.parcelId, parcelId);
    assert.equal(signRes.notification.meta?.approvedAndMinted, true);
    assert.ok(signRes.notification.title.includes('Approved & minted'));

    // 4. Persisted inbox marks pending approval read and exposes the Approved & minted notification
    const afterApproveNotifs = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    }).then((r) => r.json());
    const pendingNotif = (afterApproveNotifs.notifications || []).find(
      (n) => n.actionType === 'open_land_approval' && n.meta?.requestId === reqId
    );
    assert.ok(!pendingNotif || pendingNotif.read === true, 'Superseded pending notification should be marked read');

    const approvedNotif = (afterApproveNotifs.notifications || []).find(
      (n) => n.meta?.approvedAndMinted === true && n.meta?.requestId === reqId
    );
    assert.ok(approvedNotif, 'Expected persisted Approved & minted notification in inbox');
    assert.equal(approvedNotif.actionType, 'open_land');
    assert.equal(approvedNotif.actionLabel, 'Go to Land');
    assert.equal(approvedNotif.parcelId, parcelId);
    assert.ok(approvedNotif.sculptureId, 'Expected minted sculptureId attached for optional View Art link');
  });
});

describe('Notifications & Approvals "Go to Land" Navigation UI (React + jsdom)', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.notif-mint-ui-test-cache-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
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

  test('NotificationCenter renders Go to Land button immediately after inline approve AND on persisted approved/minted notifications even when sculptureId is set', async () => {
    const { default: NotificationCenter } = await loadJsxModule(
      'client/src/components/NotificationCenter.jsx'
    );
    const parcelId = 'GLAND-AURORA99';
    const reqId = 'sigreq-mint-ui-1';

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/mobile-sign') && opts.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            request: {
              id: reqId,
              parcelId,
              landDisplayName: 'Aurora Courtyard',
              summaryTitle: 'Place "Neon Fountain"',
              status: 'executed'
            },
            result: {
              sculpture: { id: 'sc-fountain-1', parcelId, title: 'Neon Fountain' }
            },
            notification: {
              id: 'notif-exec-1',
              category: 'land_activity',
              severity: 'success',
              title: '✅ Approved & minted: Place "Neon Fountain"',
              message: '"Place "Neon Fountain"" was approved and minted on "Aurora Courtyard".',
              parcelId,
              sculptureId: 'sc-fountain-1',
              actionType: 'open_land',
              actionLabel: 'Go to Land',
              meta: {
                requestId: reqId,
                approvedAndMinted: true,
                parcelId,
                parcelUrl: `?parcel=${parcelId}`,
                sculptureId: 'sc-fountain-1',
                sculptureUrl: '?sculpture=sc-fountain-1',
                landTitle: 'Aurora Courtyard'
              },
              read: false,
              createdAt: new Date().toISOString()
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/api/notifications/read')) {
        return new Response(JSON.stringify({ unreadCount: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/api/signatures/pending')) {
        return new Response(JSON.stringify({ requests: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/api/notifications')) {
        return new Response(
          JSON.stringify({
            unreadCount: 1,
            notifications: [
              {
                id: 'notif-minted-land-1',
                category: 'land_activity',
                severity: 'success',
                title: '✅ Approved & minted: Place "Solar Obelisk"',
                message: '"Place "Solar Obelisk"" was approved and minted on "Aurora Courtyard".',
                parcelId,
                sculptureId: 'sc-obelisk-1',
                actionType: 'open_land',
                actionLabel: 'Go to Land',
                meta: {
                  approvedAndMinted: true,
                  parcelId,
                  parcelUrl: `?parcel=${parcelId}`,
                  sculptureId: 'sc-obelisk-1',
                  sculptureUrl: '?sculpture=sc-obelisk-1',
                  landTitle: 'Aurora Courtyard'
                },
                read: false,
                createdAt: new Date().toISOString()
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const actions = [];
    const pendingReq = {
      id: reqId,
      status: 'pending',
      action: 'create_sculpture',
      parcelId,
      landDisplayName: 'Aurora Courtyard',
      summaryTitle: 'Place "Neon Fountain"',
      agentName: 'sculpt-helper-bot',
      createdAt: new Date().toISOString()
    };

    const view = RTL.render(
      React.createElement(NotificationCenter, {
        user: { id: 'u-mint-ui', name: 'Owner', walletAddress: '0x1111111111111111111111111111111111111111' },
        variant: 'desktop',
        pendingApprovals: [pendingReq],
        onAction: (act) => actions.push(act)
      })
    );

    // 1. Open Notifications -> persisted Approved & minted notification shows primary Go to Land button (NOT hijacked by sculptureId!)
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Notifications/i }));
    });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('notif-go-to-land-btn'));
    });
    assert.ok(view.getByTestId('notif-go-to-land-btn').textContent.includes('Go to Land'));
    assert.ok(view.getByTestId('notif-art-link'), 'Secondary View Art link should still remain available');

    // Click persisted Go to Land button -> emits open_land with exact parcelId
    RTL.fireEvent.click(view.getByTestId('notif-go-to-land-btn'));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].actionType, 'open_land');
    assert.equal(actions[0].parcelId, parcelId);

    // 2. Reopen Notifications -> inline approve pending mint -> status banner shows Go to Land button!
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Notifications/i }));
    });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('notif-inline-approve-btn'));
    });
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('notif-inline-approve-btn'));
    });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('notif-approval-status'));
      assert.ok(view.getByTestId('notif-approved-go-to-land-btn'));
    });

    RTL.fireEvent.click(view.getByTestId('notif-approved-go-to-land-btn'));
    assert.equal(actions.length, 2);
    assert.equal(actions[1].actionType, 'open_land');
    assert.equal(actions[1].parcelId, parcelId);
    cleanup();
  });

  test('MobilePairApprovalDropdown and SettingsSavedToast expose clickable Go to Land buttons after approval', async () => {
    const { default: MobilePairApprovalDropdown } = await loadJsxModule(
      'client/src/components/studio/MobilePairApprovalDropdown.jsx'
    );
    const { default: SettingsSavedToast } = await loadJsxModule(
      'client/src/components/SettingsSavedToast.jsx'
    );
    const { notifySettingsSaved } = await import('../client/src/utils/toastNotice.js');

    const navigatedTo = [];
    const targetParcelId = 'GLAND-MOBILE77';
    const pendingItem = {
      id: 'sigreq-mob-1',
      status: 'pending',
      action: 'create_sculpture',
      parcelId: targetParcelId,
      landDisplayName: 'Skyline Terrace',
      summaryTitle: 'Place "Glass Spire"',
      agentName: 'mobile-bot',
      expiresAt: new Date(Date.now() + 20 * 60000).toISOString()
    };
    const executedItem = {
      id: 'sigreq-mob-hist-1',
      status: 'executed',
      action: 'create_sculpture',
      parcelId: targetParcelId,
      landDisplayName: 'Skyline Terrace',
      summaryTitle: 'Place "Glass Spire"',
      agentName: 'mobile-bot',
      updatedAt: new Date().toISOString()
    };

    const view = RTL.render(
      React.createElement(MobilePairApprovalDropdown, {
        open: true,
        activeTab: 'pending',
        onSelectTab: () => {},
        onClose: () => {},
        user: { id: 'u-mob', name: 'Mobile Owner' },
        pendingSignatures: [pendingItem],
        signatureHistory: [executedItem],
        onMobileSignPending: async () => ({
          ok: true,
          request: { id: pendingItem.id, parcelId: targetParcelId },
          result: { sculpture: { id: 'sc-spire-1', parcelId: targetParcelId } }
        }),
        onMobileRejectPending: () => {},
        onNavigateToLand: (pid) => navigatedTo.push(pid),
        onRefreshSignatures: () => {}
      })
    );

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Yes, Approve/i }));
    });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('mobile-approval-go-land-btn'));
    });
    RTL.fireEvent.click(view.getByTestId('mobile-approval-go-land-btn'));
    assert.deepEqual(navigatedTo, [targetParcelId]);
    cleanup();

    // History tab also renders Go to Land on approved items
    const histView = RTL.render(
      React.createElement(MobilePairApprovalDropdown, {
        open: true,
        activeTab: 'history',
        onSelectTab: () => {},
        onClose: () => {},
        user: { id: 'u-mob', name: 'Mobile Owner' },
        pendingSignatures: [],
        signatureHistory: [executedItem],
        onMobileSignPending: async () => ({}),
        onMobileRejectPending: () => {},
        onNavigateToLand: (pid) => navigatedTo.push(pid),
        onRefreshSignatures: () => {}
      })
    );
    RTL.fireEvent.click(histView.getByTestId('mobile-history-go-land-btn'));
    assert.deepEqual(navigatedTo, [targetParcelId, targetParcelId]);
    cleanup();

    // Floating SettingsSavedToast renders optional Go to Land button when provided
    const toastView = RTL.render(React.createElement(SettingsSavedToast));
    await RTL.act(async () => {
      notifySettingsSaved('Approved & minted "Glass Spire"!', {
        actionLabel: '📍 Go to Land →',
        onAction: () => navigatedTo.push(`toast:${targetParcelId}`)
      });
    });
    await RTL.waitFor(() => {
      assert.ok(toastView.getByTestId('settings-toast-action-btn'));
    });
    RTL.fireEvent.click(toastView.getByTestId('settings-toast-action-btn'));
    assert.equal(navigatedTo[2], `toast:${targetParcelId}`);
    cleanup();
  });
});
