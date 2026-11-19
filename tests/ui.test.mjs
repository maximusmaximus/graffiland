import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

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
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    outfile: absOut
  });
  return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
}

describe('GRAFFILAND React UI Components (jsdom + Testing Library)', () => {
  before(async () => {
    const fs = await import('node:fs');
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-test-cache-'));

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

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(async () => {
    const fs = await import('node:fs');
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('FirstRunTutorialModal progresses steps, toggles Quick Sculpt, and passes dontShowAgain flag', async () => {
    const { default: FirstRunTutorialModal } = await loadJsxModule(
      'client/src/components/studio/FirstRunTutorialModal.jsx'
    );
    let closedWith = null;
    let quickToggled = 0;
    const view = RTL.render(
      React.createElement(FirstRunTutorialModal, {
        quickSculpt: false,
        onToggleQuickSculpt: () => {
          quickToggled += 1;
        },
        onClose: (dontShow) => {
          closedWith = dontShow;
        }
      })
    );

    assert.ok(view.getByText(/1\. Aim & Lock Your Starting Surface/i));
    RTL.fireEvent.click(view.getByRole('button', { name: /Pro HUD/i }));
    assert.equal(quickToggled, 1);

    RTL.fireEvent.click(view.getByText(/Next Step/i));
    assert.ok(view.getByText(/2\. Sculpt 4x Blocks or Hand Off to AI/i));

    RTL.fireEvent.click(view.getByText(/Next Step/i));
    assert.ok(view.getByText(/3\. Claim Virtual Land, Chat & Curate/i));

    RTL.fireEvent.click(view.getByText(/Start Sculpting/i));
    assert.equal(closedWith, true);
    cleanup();
  });

  test('SceneErrorBoundary catches 3D render error and recovers when Reload button clicked', async () => {
    const { default: SceneErrorBoundary } = await loadJsxModule(
      'client/src/components/SceneErrorBoundary.jsx'
    );
    let shouldThrow = true;
    function ProblemScene() {
      if (shouldThrow) throw new Error('Simulated WebGL context failure');
      return React.createElement('div', null, 'Scene Recovered OK');
    }

    const origErr = console.error;
    console.error = () => {};
    let recovered = false;
    try {
      const view = RTL.render(
        React.createElement(
          SceneErrorBoundary,
          { onRecover: () => { recovered = true; } },
          React.createElement(ProblemScene)
        )
      );
      assert.ok(view.getByText(/3D AR Scene Interrupted/i));
      assert.ok(view.getByText(/Simulated WebGL context failure/i));

      shouldThrow = false;
      RTL.fireEvent.click(view.getByText(/Reload 3D Viewport/i));
      assert.equal(recovered, true);
      assert.ok(view.getByText('Scene Recovered OK'));
    } finally {
      console.error = origErr;
      cleanup();
    }
  });

  test('InfoTermsModal displays Proof of Location threat model & Takedown/Dispute policy tabs', async () => {
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );
    const { POLICY } = await import('../shared/constants.mjs');
    const view = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: POLICY, chain: { network: { name: 'Robinhood Chain Testnet' } } },
        user: null,
        onClose: () => {}
      })
    );

    assert.ok(view.getByText(/Proof of Location Threat Model & Transparency/i));
    assert.ok(view.getByText(/Agentic-First Stewardship, Quests & 5% \/ 3% \/ 2% Splits/i));
    assert.ok(view.getByText(POLICY.threatModelSummary));

    RTL.fireEvent.click(view.getByText(/Terms & Virtual Land/i));
    assert.ok(view.getByText(/Marketplace & Co-Creation Royalty Economics \(5% \/ 3% \/ 2%\)/i));
    assert.ok(view.getByText(/Prohibited Content, Takedown & Virtual Land Dispute Process/i));
    assert.ok(view.getByText(/Hate speech, harassment, doxxing/i));
    cleanup();
  });

  test('PublishSculptureModal shows Quest eligibility gate and Awakening Rush celebration receipt', async () => {
    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );
    const { POLICY } = await import('../shared/constants.mjs');
    const preView = RTL.render(
      React.createElement(PublishSculptureModal, {
        config: { policy: POLICY },
        user: { id: 'u1', walletAddress: '0x1234', activeMintRecipient: '0x1234' },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }],
        polStats: { frames: 10, flow: 90 },
        location: { lat: 37.77, lng: -122.41, altitude: 10 },
        orbStatus: { keyframes: 3, features: 24 },
        activeQuest: {
          id: 'q1',
          title: 'Neon Plinth Challenge',
          firstSparkBoost: true,
          badgeLabel: '🔥 First-Spark Needed · 2x XP · 2% Pool'
        },
        selectedPlinthSlot: { id: 'plinth-1', label: 'Center Pedestal' },
        passkeyCount: 0,
        passkeyBusy: false,
        onEnrollPasskey: async () => {},
        title: 'Phoenix',
        setTitle: () => {},
        description: 'Glowing voxel statue on the cyber pedestal.',
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
        mcpPairingsState: { activePairing: null },
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
        onClose: () => {}
      })
    );
    assert.ok(preView.getByText(/Neon Plinth Challenge/i));
    assert.ok(preView.getByText(/Add at least 2 more voxel\(s\)/i));
    cleanup();

    const receiptView = RTL.render(
      React.createElement(PublishSculptureModal, {
        config: { policy: POLICY },
        user: { id: 'u1', walletAddress: '0x1234' },
        voxels: [],
        polStats: { frames: 10, flow: 90 },
        orbStatus: { keyframes: 3, features: 24 },
        mintReceipt: {
          sculpture: { id: 's1', title: 'Phoenix', parcelId: 'GLAND-9Q8YY' },
          mint: { tokenId: 9, txHash: '0xabc' },
          ipfs: { metadataCid: 'bafkrei123' },
          awakening: {
            awakenedParcel: true,
            xpAwarded: 300,
            qualifiesForContributorPool: true,
            slotsUnlockedForAgent: 2
          }
        },
        title: '',
        setTitle: () => {},
        description: '',
        setDescription: () => {},
        cluePrompt: '',
        setCluePrompt: () => {},
        clueAnswer: '',
        setClueAnswer: () => {},
        termsAccepted: true,
        setTermsAccepted: () => {},
        setPublishError: () => {},
        onOpenManageLand: () => {},
        onViewInARPreview: () => {},
        onShowHint: () => {},
        onClose: () => {}
      })
    );
    assert.ok(receiptView.getByText(/First-Spark Awakening! \(\+300 XP/i));
    assert.ok(receiptView.getByText(/unlocked \+2 more free land slots!/i));
    cleanup();
  });

  test('AdminPanel gates non-admins and renders telemetry/policy for admin accounts', async () => {
    const { default: AdminPanel } = await loadJsxModule('client/src/components/AdminPanel.jsx');
    const nonAdmin = RTL.render(
      React.createElement(AdminPanel, {
        user: { id: 'u1', email: 'artist@example.com', isAdmin: false },
        config: {}
      })
    );
    assert.ok(nonAdmin.getByText(/Administrator Access Required/i));
    cleanup();

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/admin/metrics')) {
        return {
          ok: true,
          json: async () => ({
            status: 'healthy',
            relayerTodayOps: 3,
            counts: { sculptures: 9, revisions: 14, landmarks: 2, rateLimitTrips24h: 1, pinFailures24h: 0 },
            recentAlerts: []
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          sculptures: [
            {
              id: 's-ui-1',
              title: 'Neon Pillar UI',
              parcelId: 'GLAND-9Q8YY',
              lat: 37.77,
              lng: -122.41,
              creatorName: 'Alice',
              creatorEmail: 'alice@test.dev',
              polScore: 95,
              hidden: false,
              chain: { tokenId: 7 },
              ipfs: { metadataCid: 'bafkreiexamplecid1234567890' }
            }
          ]
        })
      };
    };

    try {
      const adminView = RTL.render(
        React.createElement(AdminPanel, {
          user: { id: 'adm', email: 'admin@graffiland.local', isAdmin: true },
          config: { ipfsProvider: 'pinata', chain: { network: { name: 'Robinhood', chainId: 46630 } } },
          onSelectSculpture: () => {}
        })
      );
      await RTL.waitFor(() => {
        assert.ok(adminView.getByText(/Operational Telemetry & Quota Health/i));
        assert.ok(adminView.getByText('Neon Pillar UI'));
        assert.ok(adminView.getByText(/Takedown & Virtual Land Dispute Policy/i));
      });
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('DesktopIntroBanner switches Human/Agentic tabs, previews, and copies connection prompts', async () => {
    const { default: DesktopIntroBanner } = await loadJsxModule(
      'client/src/components/DesktopIntroBanner.jsx'
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

    let activeRole = 'human';
    let view;
    const renderBanner = (role) => {
      const el = React.createElement(DesktopIntroBanner, {
        user: { id: 'u1', walletAddress: '0x1234567890abcdef1234567890abcdef12345678' },
        mcpState: { activePairing: { code: 'GLP-ABCD-EFGH-JKLM-NPQR' }, pairings: [] },
        roleTab: role,
        onRoleTabChange: (next) => {
          activeRole = next;
        },
        onOpenPair: () => {},
        onOpenInfo: () => {},
        onDismiss: () => {}
      });
      if (!view) view = RTL.render(el);
      else view.rerender(el);
    };

    renderBanner('human');
    assert.ok(view.getByText(/Mobile Required for Full Functionality/i));
    RTL.fireEvent.click(view.getByText(/Copy Property-Agent Prompt/i));
    await RTL.waitFor(() => {
      assert.equal(copiedTexts.length, 1);
      assert.ok(copiedTexts[0].includes('GLP-ABCD-EFGH-JKLM-NPQR'));
    });

    RTL.fireEvent.click(view.getByRole('tab', { name: /Agentic User \/ AI Steward/i }));
    assert.equal(activeRole, 'agent');
    renderBanner('agent');
    assert.ok(view.getByText(/Autonomous AI Agents Connect Without OAuth/i));

    RTL.fireEvent.click(view.getByText(/Preview Prompt/i));
    assert.ok(view.getByText(/Zero-OAuth Autonomous Agent Steward/i));

    RTL.fireEvent.click(view.getByText(/Copy Autonomous Agent Prompt/i));
    await RTL.waitFor(() => {
      assert.equal(copiedTexts.length, 2);
      assert.ok(copiedTexts[1].includes('/api/agents/challenge'));
      assert.ok(copiedTexts[1].includes('claim_land'));
      assert.ok(copiedTexts[1].includes('own chain gas'));
    });

    RTL.fireEvent.click(view.getByRole('tab', { name: /Collectors & Scouts/i }));
    assert.equal(activeRole, 'collector');
    renderBanner('collector');
    assert.ok(view.getByText(/Collect Real-World Verified 3D NFTs/i));
    assert.ok(view.getByText(/Proof of Real Presence/i));
    cleanup();
  });
});
