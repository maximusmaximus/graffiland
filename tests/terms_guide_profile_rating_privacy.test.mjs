import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { POLICY } from '../shared/constants.mjs';
import {
  PROFILE_FEATURE_MILESTONES,
  computeProfileFeatureScore
} from '../shared/profileRules.mjs';

const ROOT = path.resolve(process.cwd());

describe('Terms Disclaimer, Guide Calibration Tip, Profile Feature Rating & Public Profile Privacy', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;
  let srv;
  let baseUrl;
  let dbTmpDir;

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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-terms-profile-'));
    dbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-privacy-test-'));

    // Setup JSDOM environment for React component tests
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

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;

    // Spin up isolated Express server for end-to-end profile privacy API tests
    process.env.GRAFFILAND_DB_PATH = path.join(dbTmpDir, 'privacy.sqlite');
    process.env.GRAFFILAND_IPFS_DIR = path.join(dbTmpDir, 'ipfs');
    process.env.PINATA_JWT = '';
    process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
    process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
    const { createAppServer } = await import('../server/index.mjs');
    const { server } = createAppServer();
    srv = server;
    await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${srv.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    cleanup?.();
    await new Promise((resolve) => srv?.close(resolve));
    for (const dir of [outTmpDir, dbTmpDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows file lock
      }
    }
  });

  test('Terms policy & InfoTermsModal clearly warn about experimental tech, rapid battery drain, malfunctions, device loss, and physical safety non-liability', async () => {
    assert.ok(POLICY.experimentalSafetyDisclaimer, 'POLICY.experimentalSafetyDisclaimer must exist');
    assert.match(POLICY.experimentalSafetyDisclaimer, /highly experimental/i);
    assert.match(POLICY.experimentalSafetyDisclaimer, /battery/i);
    assert.match(POLICY.experimentalSafetyDisclaimer, /sensors/i);
    assert.match(POLICY.experimentalSafetyDisclaimer, /not liable/i);
    assert.match(POLICY.experimentalSafetyDisclaimer, /malfunctions/i);
    assert.match(POLICY.experimentalSafetyDisclaimer, /device loss/i);
    assert.match(POLICY.experimentalSafetyDisclaimer, /personal harm/i);

    const clause8 = POLICY.termsText.find((t) => /^8\./.test(t));
    assert.ok(clause8, 'Terms clause 8 should document experimental tech & physical safety disclaimer');
    assert.match(clause8, /highly experimental/i);
    assert.match(clause8, /drain your battery quickly/i);
    assert.match(clause8, /not liable/i);
    assert.match(clause8, /physically/i);

    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );

    const view = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: POLICY },
        user: null,
        initialTab: 'terms',
        onClose: () => {}
      })
    );

    const card = view.getByTestId('terms-experimental-safety-card');
    assert.ok(card, 'Experimental safety disclaimer card must render at top of Terms');
    assert.match(card.textContent, /experimental/i);
    assert.match(card.textContent, /battery/i);
    assert.match(card.textContent, /not liable/i);
    assert.match(card.textContent, /personal harm/i);
    assert.match(view.container.textContent, /8\. Experimental Tech, Battery Drain/i);
    cleanup();
  });

  test('Guide shares phone-case calibration tip and fun AI sidekick 3D model alternative', async () => {
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );

    const view = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: POLICY },
        user: null,
        initialTab: 'guide',
        initialViewportGuide: 'mobile',
        onClose: () => {}
      })
    );

    const tipBox = view.getByTestId('guide-calibration-case-ai-tip');
    assert.ok(tipBox, 'Guide should render calibration case + AI tip callout');
    assert.match(tipBox.textContent, /phone case/i);
    assert.match(tipBox.textContent, /calibration/i);
    assert.match(tipBox.textContent, /\bAI\b/i);
    assert.match(tipBox.textContent, /3D\s*models/i);
    cleanup();
  });

  test('computeProfileFeatureScore calculates transparent 0-100 ratings and remaining tips accurately', () => {
    const totalPossible = PROFILE_FEATURE_MILESTONES.reduce((sum, m) => sum + m.points, 0);
    assert.equal(totalPossible, 100, 'Feature rating milestones must sum to exactly 100');

    // Empty / brand-new creator -> 0/100
    const empty = computeProfileFeatureScore({
      profile: { username: 'rookie', bio: '', avatarImage: '', headerImage: 'preset:cyber-grid' },
      stats: { landCount: 0, sculptureCount: 0, totalBlocks: 0, awakenedLands: 0, activeListingCount: 0, questCount: 0 }
    });
    assert.equal(empty.score, 0);
    assert.equal(empty.maxScore, 100);
    assert.equal(empty.completedCount, 0);
    assert.equal(empty.nextToTry.length, PROFILE_FEATURE_MILESTONES.length);

    // Partial history -> profile_setup (10) + own_land (10) + publish_art (15) = 35/100
    const partial = computeProfileFeatureScore({
      profile: { username: 'neon_painter', bio: 'Painting rooftop voxels' },
      stats: { landCount: 1, sculptureCount: 1, totalBlocks: 12, awakenedLands: 0 },
      lands: [{ parcelId: 'u4pruydq' }],
      sculptures: [{ id: 'sc-1', modelType: 'voxel' }]
    });
    assert.equal(partial.score, 35);
    assert.equal(partial.completedCount, 3);
    assert.equal(partial.nextToTry.length, 7);
    assert.ok(partial.nextToTry.some((m) => m.id === 'place_3d_model'));
    assert.ok(partial.nextToTry.some((m) => m.id === 'agent_collab'));

    // Full history across all 10 features -> 100/100
    const full = computeProfileFeatureScore({
      profile: {
        username: 'legend_creator',
        bio: 'All features mastered',
        avatarImage: 'https://cdn.example.com/a.png',
        headerImage: 'preset:neon-skyline'
      },
      stats: {
        landCount: 3,
        sculptureCount: 4,
        totalBlocks: 120,
        awakenedLands: 1,
        activeListingCount: 1,
        questCount: 1
      },
      lands: [{ parcelId: 'u4pruydq', customName: 'Sky Gallery', stewardStatus: 'awakened' }],
      sculptures: [{ id: 'sc-glb', modelType: 'custom-3d' }],
      actions: [{ type: 'signed_action', title: 'Approved agent action' }],
      lastViewed: [{ id: 'sc-1', kind: 'sculpture' }]
    });
    assert.equal(full.score, 100);
    assert.equal(full.completedCount, 10);
    assert.equal(full.nextToTry.length, 0);
  });

  test('ProfileModal displays X/100 Feature Rating with "i" tips and Public Profile ON/OFF toggle in Settings', async () => {
    const { default: ProfileModal } = await loadJsxModule(
      'client/src/components/ProfileModal.jsx'
    );

    const ownerUser = {
      id: 'user-owner-1',
      username: 'spark_artist',
      bio: 'Sculpting AR voxels',
      profilePublic: true
    };
    const mockOwnerPayload = {
      isPrivate: false,
      profile: {
        id: 'user-owner-1',
        username: 'spark_artist',
        displayName: '@spark_artist',
        bio: 'Sculpting AR voxels',
        profilePublic: true,
        isPrivate: false,
        accountType: 'human',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        joinedAt: '2026-05-01T00:00:00.000Z',
        userNumber: 7,
        userNumberLabel: '#0007'
      },
      stats: {
        landCount: 1,
        sculptureCount: 1,
        activeListingCount: 0,
        questCount: 0,
        actionCount: 2,
        totalBlocks: 14,
        awakenedLands: 0,
        totalXp: 150
      },
      lands: [{ parcelId: '9q8yyk8y', customName: '', sculptureCount: 1 }],
      sculptures: [{ id: 'sc-1', title: 'Neon Arc', modelType: 'voxel', voxelCount: 14 }],
      listings: [],
      quests: [],
      actions: []
    };

    const savedPayloads = [];
    const ownerView = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'spark_artist',
        user: ownerUser,
        fetchProfileFn: async () => mockOwnerPayload,
        saveProfileFn: async (payload) => {
          savedPayloads.push(payload);
          const nextPublic = Boolean(payload.profilePublic);
          return {
            ...mockOwnerPayload,
            user: { ...ownerUser, profilePublic: nextPublic },
            profile: { ...mockOwnerPayload.profile, profilePublic: nextPublic }
          };
        },
        onClose: () => {}
      })
    );

    // Wait for async profile load
    const ratingEl = await ownerView.findByTestId('profile-feature-rating');
    assert.ok(ratingEl, 'Feature Rating bar must render');
    const scoreVal = ownerView.getByTestId('profile-feature-score-value');
    assert.equal(scoreVal.textContent.trim(), '35/100');

    // Click the adjacent "i" InfoTip button inside the Feature Rating row
    const ratingInfoBtn = ratingEl.querySelector('button.info-tip-btn');
    assert.ok(ratingInfoBtn, 'Feature Rating must include an "i" InfoTip button');
    RTL.fireEvent.click(ratingInfoBtn);
    const tipsEl = ownerView.getByTestId('profile-feature-rating-tips');
    assert.match(tipsEl.textContent, /Try next to raise your score/i);
    assert.match(tipsEl.textContent, /Place a 3D Model/i);

    // Public profile link is visible when profilePublic === true
    assert.ok(ownerView.getByTestId('profile-share-copy-btn'));
    assert.equal(ownerView.queryByTestId('profile-private-owner-badge'), null);

    // Open ⚙️ Settings and toggle Public Profile OFF
    RTL.fireEvent.click(ownerView.getByTestId('profile-settings-gear-btn'));
    const publicToggle = ownerView.getByTestId('setting-toggle-public-profile');
    assert.equal(publicToggle.getAttribute('aria-checked'), 'true');
    assert.equal(publicToggle.textContent.trim(), 'ON');

    await RTL.act(async () => {
      RTL.fireEvent.click(publicToggle);
    });

    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0].profilePublic, false);
    assert.equal(publicToggle.getAttribute('aria-checked'), 'false');
    assert.equal(publicToggle.textContent.trim(), 'OFF');
    assert.ok(ownerView.getByTestId('profile-private-owner-badge'));
    assert.equal(ownerView.queryByTestId('profile-share-copy-btn'), null);
    cleanup();

    // Non-owner visiting a private profile sees the private lock gate and no profile content
    const visitorView = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'spark_artist',
        user: { id: 'other-user-2', username: 'visitor_bob' },
        fetchProfileFn: async () => ({
          isPrivate: true,
          profile: {
            id: 'user-owner-1',
            username: 'spark_artist',
            displayName: '@spark_artist',
            bio: '',
            profilePublic: false,
            isPrivate: true,
            accountType: 'human',
            walletAddress: '',
            profileUrl: ''
          },
          stats: {
            landCount: 0,
            sculptureCount: 0,
            activeListingCount: 0,
            questCount: 0,
            actionCount: 0,
            totalBlocks: 0,
            awakenedLands: 0,
            totalXp: 0
          },
          lands: [],
          sculptures: [],
          listings: [],
          quests: [],
          actions: []
        }),
        onClose: () => {}
      })
    );

    const gate = await visitorView.findByTestId('profile-private-gate');
    assert.match(gate.textContent, /@spark_artist is private/i);
    assert.equal(visitorView.queryByTestId('profile-feature-rating'), null);
    assert.equal(visitorView.queryByTestId('profile-bio'), null);
    cleanup();
  });

  test('Backend API enforces profilePublic ON/OFF for anonymous & non-owner visitors while preserving owner access', async () => {
    // 1. User A signs in, sets profile, claims land & publishes sculpture
    const authA = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'priya@graffiland.test', name: 'Priya AR' } })
    }).then((r) => r.json());
    assert.equal(authA.user.profilePublic, true, 'New accounts default to public profile ON');

    const saveA = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ username: 'priya_ar', bio: 'Secret sky sculptures' })
    }).then((r) => r.json());
    assert.equal(saveA.user.username, 'priya_ar');
    assert.equal(saveA.user.profilePublic, true);

    await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ lat: 37.781, lng: -122.411, customName: 'Priya Courtyard' })
    }).then((r) => r.json());

    // 2. User B signs in
    const authB = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'viewer@graffiland.test', name: 'Viewer Two' } })
    }).then((r) => r.json());

    // Confirm public view works before turning OFF
    const beforePub = await fetch(`${baseUrl}/api/profiles/priya_ar`).then((r) => r.json());
    assert.equal(beforePub.isPrivate, false);
    assert.equal(beforePub.profile.profilePublic, true);
    assert.equal(beforePub.profile.bio, 'Secret sky sculptures');
    assert.ok(beforePub.lands.length >= 1);

    // 3. User A turns Public Profile OFF
    const toggleOff = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ profilePublic: false })
    });
    assert.equal(toggleOff.status, 200);
    const toggleOffJson = await toggleOff.json();
    assert.equal(toggleOffJson.user.profilePublic, false);
    assert.equal(toggleOffJson.isPrivate, false, 'Owner response remains unlocked');
    assert.equal(toggleOffJson.profile.profilePublic, false);
    assert.ok(toggleOffJson.lands.length >= 1);

    // 4. Anonymous visitor & User B receive private locked response with no leaked details
    const anonView = await fetch(`${baseUrl}/api/profiles/priya_ar`).then((r) => r.json());
    assert.equal(anonView.isPrivate, true);
    assert.equal(anonView.profile.profilePublic, false);
    assert.equal(anonView.profile.bio, '');
    assert.equal(anonView.profile.walletAddress, '');
    assert.equal(anonView.lands.length, 0);
    assert.equal(anonView.sculptures.length, 0);
    assert.equal(anonView.actions.length, 0);
    assert.equal(anonView.stats.landCount, 0);

    const otherUserView = await fetch(`${baseUrl}/api/profiles/priya_ar`, {
      headers: { Authorization: `Bearer ${authB.token}` }
    }).then((r) => r.json());
    assert.equal(otherUserView.isPrivate, true);
    assert.equal(otherUserView.lands.length, 0);

    // 5. Owner calling /api/profiles/priya_ar with their own token still sees full data
    const ownerSelfView = await fetch(`${baseUrl}/api/profiles/priya_ar`, {
      headers: { Authorization: `Bearer ${authA.token}` }
    }).then((r) => r.json());
    assert.equal(ownerSelfView.isPrivate, false);
    assert.equal(ownerSelfView.profile.profilePublic, false);
    assert.equal(ownerSelfView.profile.bio, 'Secret sky sculptures');
    assert.ok(ownerSelfView.lands.length >= 1);

    // 6. Owner turns Public Profile back ON -> anonymous visitor sees full profile again
    const toggleOn = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ profilePublic: true })
    });
    assert.equal(toggleOn.status, 200);
    const afterPub = await fetch(`${baseUrl}/api/profiles/priya_ar`).then((r) => r.json());
    assert.equal(afterPub.isPrivate, false);
    assert.equal(afterPub.profile.profilePublic, true);
    assert.equal(afterPub.profile.bio, 'Secret sky sculptures');
    assert.ok(afterPub.lands.length >= 1);
  });
});
