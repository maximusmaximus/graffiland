import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();

describe('Global Notifications API: Clear All & Scope Management', () => {
  let server;
  let baseUrl;
  let tmpDir;
  let userToken;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-global-notif-api-'));
    process.env.GRAFFILAND_DB_PATH = path.join(tmpDir, 'global-notif.sqlite');
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

    const loginRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: {
          email: 'notif-everywhere@spray.land',
          name: 'Notif Everywhere',
          username: 'notif_everywhere'
        }
      })
    });
    const loginBody = await loginRes.json();
    assert.equal(loginRes.status, 200);
    userToken = loginBody.token;
  });

  after(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore Windows SQLite file-lock cleanup race
      }
    }
  });

  test('DELETE /api/notifications clears read-only or all notifications cleanly', async () => {
    // Mint two real lands so the server generates two persisted notifications
    for (const [idx, [lat, lng]] of [
      [37.7811, -122.4111],
      [37.7855, -122.4155]
    ].entries()) {
      const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`
        },
        body: JSON.stringify({
          customName: `Notif Land ${idx + 1}`,
          lat,
          lng,
          widthMeters: 8,
          depthMeters: 8,
          heightMeters: 6
        })
      });
      assert.equal(claimRes.status, 201);
    }

    const initialList = await (
      await fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${userToken}` }
      })
    ).json();
    assert.ok(initialList.notifications.length >= 2);
    const n1 = initialList.notifications[0];
    const n2 = initialList.notifications[1];

    // Mark only the first notification as read
    const readRes = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({ ids: [n1.id] })
    });
    assert.equal(readRes.status, 200);

    // Clear only read notifications -> n2 stays unread
    const clearReadRes = await fetch(`${baseUrl}/api/notifications?scope=read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert.equal(clearReadRes.status, 200);
    const clearReadBody = await clearReadRes.json();
    assert.equal(clearReadBody.cleared, true);
    assert.ok(clearReadBody.unreadCount >= 1);

    const midList = await (
      await fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${userToken}` }
      })
    ).json();
    assert.equal(midList.notifications.some((n) => n.id === n1.id), false);
    assert.equal(midList.notifications.some((n) => n.id === n2.id), true);

    // Clear all notifications -> empty list & unreadCount 0
    const clearAllRes = await fetch(`${baseUrl}/api/notifications?scope=all`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert.equal(clearAllRes.status, 200);
    const clearAllBody = await clearAllRes.json();
    assert.equal(clearAllBody.cleared, true);
    assert.equal(clearAllBody.unreadCount, 0);

    const finalList = await (
      await fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${userToken}` }
      })
    ).json();
    assert.equal(finalList.notifications.length, 0);
  });
});

describe('Global Notifications Access & Management Across Views (React + jsdom)', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.global-notif-ui-test-cache-'));
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
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
  });

  test('NotificationProvider shares a single poll across all view bells, exposes History & Clear All, manages Settings, and isolates Escape/backdrop from underlying modals', async () => {
    const notifMod = await loadJsxModule('client/src/components/NotificationCenter.jsx');
    const { NotificationProvider, GlobalNotificationBell } = notifMod;
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    let notifGetCount = 0;
    let clearAllCalls = 0;
    let prefPatchBody = null;
    const serverNotifications = [
      {
        id: 'n-unread-1',
        category: 'sculpture_on_land',
        severity: 'info',
        title: '🎨 New art on "Alone in the Woods"',
        message: '@bigdog placed "Ghost Mushroom Nursery" on your land.',
        parcelId: 'GLAND-U34DU8TH',
        actionType: 'open_land',
        actionLabel: 'Go to Land',
        meta: { parcelUrl: '?parcel=GLAND-U34DU8TH' },
        read: false,
        createdAt: new Date().toISOString()
      },
      {
        id: 'n-history-1',
        category: 'land_activity',
        severity: 'success',
        title: '🗺️ Land minted: VOYAGE',
        message: 'Your land VOYAGE is live on the map.',
        parcelId: 'GLAND-VOYAGE01',
        actionType: 'open_land',
        actionLabel: 'Go to Land',
        meta: { parcelUrl: '?parcel=GLAND-VOYAGE01', landMinted: true },
        read: true,
        createdAt: new Date(Date.now() - 3600_000).toISOString()
      }
    ];

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/notifications/preferences') && opts.method === 'PATCH') {
        prefPatchBody = JSON.parse(opts.body || '{}');
        return new Response(
          JSON.stringify({
            preferences: {
              sculpture_on_land: true,
              mint_slots_unlocked: true,
              mint_limit_reached: true,
              land_expiring: true,
              land_activity: true,
              browser_push_enabled: false,
              ...prefPatchBody
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/api/notifications/read') && opts.method === 'POST') {
        return new Response(JSON.stringify({ unreadCount: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/api/notifications') && opts.method === 'DELETE') {
        clearAllCalls += 1;
        return new Response(JSON.stringify({ cleared: true, unreadCount: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/api/notifications')) {
        notifGetCount += 1;
        return new Response(
          JSON.stringify({
            unreadCount: 1,
            preferences: {
              sculpture_on_land: true,
              mint_slots_unlocked: true,
              mint_limit_reached: true,
              land_expiring: true,
              land_activity: true,
              browser_push_enabled: false
            },
            notifications: serverNotifications
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true, requests: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const actions = [];
    let infoModalClosed = false;
    const testUser = { id: 'u-global-1', username: 'muffkor', name: 'Muffkor' };

    const view = RTL.render(
      React.createElement(
        NotificationProvider,
        {
          user: testUser,
          variant: 'desktop',
          pendingApprovals: [],
          onAction: (item) => actions.push(item)
        },
        React.createElement(GlobalNotificationBell, { compact: true, testId: 'extra-view-bell' }),
        React.createElement(StudioHudTopBar, {
          user: testUser,
          isInteractingWithLand: true,
          arExitLabel: 'Back to Draw',
          voxels: [],
          pendingSignatures: []
        }),
        React.createElement(InfoTermsModal, {
          user: testUser,
          config: {},
          onClose: () => {
            infoModalClosed = true;
          }
        })
      )
    );

    // Wait for single shared fetch to populate unread badge across ALL mounted bells
    await RTL.waitFor(() => {
      const badges = view.getAllByTestId('notif-unread-badge');
      assert.ok(badges.length >= 3, 'All mounted view bells should render the synchronized unread badge');
      assert.equal(badges[0].textContent, '1');
    });
    assert.equal(notifGetCount, 1, 'Provider must poll /api/notifications only once across all mounted bells');

    // AR Land Inspection top-right HUD still exposes Notifications!
    assert.ok(view.getByTestId('ar-land-top-right-hud'));

    // Open notifications directly from inside InfoTermsModal's header bell
    const infoBell = view.getByTestId('info-modal-notif-bell-btn');
    RTL.fireEvent.click(infoBell);

    // Popover renders in document.body portal with unread alert visible
    await RTL.waitFor(() => {
      assert.ok(RTL.screen.getByTestId('notif-popover'));
      assert.ok(RTL.screen.getByText(/New art on "Alone in the Woods"/i));
    });

    // Switch to History tab -> see past read notification & trigger Clear All
    RTL.fireEvent.click(RTL.screen.getByTestId('notif-tab-history'));
    await RTL.waitFor(() => {
      assert.ok(RTL.screen.getByText(/Land minted: VOYAGE/i));
    });

    // Switch to Settings tab -> toggle preference directly from inside the modal
    RTL.fireEvent.click(RTL.screen.getByTestId('notif-tab-settings'));
    const checkboxes = RTL.screen.getAllByRole('checkbox');
    assert.ok(checkboxes.length >= 5);
    RTL.fireEvent.click(checkboxes[0]);
    await RTL.waitFor(() => {
      assert.deepEqual(prefPatchBody, { sculpture_on_land: false });
    });

    // Switch back to History -> click Clear All
    RTL.fireEvent.click(RTL.screen.getByTestId('notif-tab-history'));
    RTL.fireEvent.click(RTL.screen.getByTestId('notif-clear-all-btn'));
    await RTL.waitFor(() => {
      assert.equal(clearAllCalls, 1);
      assert.ok(RTL.screen.getByText(/No past notifications/i));
    });

    // Pressing Escape closes ONLY the notification popover, NOT InfoTermsModal!
    RTL.fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    await RTL.waitFor(() => {
      assert.equal(RTL.screen.queryByTestId('notif-popover'), null);
    });
    assert.equal(infoModalClosed, false, 'Escape on notifications popover must not close underlying modal');

    // Re-open from extra bell & click portal backdrop -> closes ONLY popover, NOT InfoTermsModal
    RTL.fireEvent.click(view.getByTestId('extra-view-bell'));
    await RTL.waitFor(() => {
      assert.ok(RTL.screen.getByTestId('notif-portal-backdrop'));
    });
    RTL.fireEvent.click(RTL.screen.getByTestId('notif-portal-backdrop'));
    await RTL.waitFor(() => {
      assert.equal(RTL.screen.queryByTestId('notif-popover'), null);
    });
    assert.equal(infoModalClosed, false, 'Backdrop click must not bubble to close underlying modal');

    cleanup();
  });
});
