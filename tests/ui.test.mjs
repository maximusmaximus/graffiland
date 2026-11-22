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

  test('InfoTermsModal organizes Guide by Desktop vs Mobile viewport, toggles "i" tooltips & shows Terms', async () => {
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

    assert.ok(view.getByRole('tab', { name: /Desktop Map & 3D Land/i }));
    assert.ok(view.getByRole('tab', { name: /Mobile AR Studio/i }));
    assert.ok(view.getByTestId('info-guide-desktop'));
    assert.ok(view.getByText(/Draw, Shape & Mint 3D Land/i));
    assert.ok(view.getByText(/Proof of Location Threat Model/i));

    // Switch to Mobile AR Studio guide tab
    RTL.fireEvent.click(view.getByRole('tab', { name: /Mobile AR Studio/i }));
    assert.ok(view.getByTestId('info-guide-mobile'));
    assert.ok(view.getByText(/Tap Surface & Paint 3D Voxels/i));

    // Click the "i" tooltip button next to Threat Model to pull up full security summary
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: Transparency & Security Details/i }));
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
    assert.ok(view.getByText(/A real-world 3D art map where humans draw land/i));
    // Open clickable "i" tooltip on a feature chip
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: Desktop 3D Land Builder/i }));
    assert.ok(view.getByRole('tooltip'));
    assert.ok(view.getByText(/hold vertical bars to rotate/i));

    RTL.fireEvent.click(view.getByText(/Copy Property-Agent Prompt/i));
    await RTL.waitFor(() => {
      assert.equal(copiedTexts.length, 1);
      assert.ok(copiedTexts[0].includes('GLP-ABCD-EFGH-JKLM-NPQR'));
    });

    RTL.fireEvent.click(view.getByRole('tab', { name: /AI Agents/i }));
    assert.equal(activeRole, 'agent');
    renderBanner('agent');
    assert.ok(view.getByText(/Wallet \/ MCP Auth/i));

    RTL.fireEvent.click(view.getByText(/Preview Prompt/i));
    assert.ok(view.getByText(/Zero-OAuth Autonomous Agent Steward/i));

    RTL.fireEvent.click(view.getByText(/Copy Autonomous Agent Prompt/i));
    await RTL.waitFor(() => {
      assert.equal(copiedTexts.length, 2);
      assert.ok(copiedTexts[1].includes('/api/agents/challenge'));
      assert.ok(copiedTexts[1].includes('claim_land'));
      assert.ok(copiedTexts[1].includes('own chain gas'));
    });

    RTL.fireEvent.click(view.getByRole('tab', { name: /Collectors/i }));
    assert.equal(activeRole, 'collector');
    renderBanner('collector');
    assert.ok(view.getByText(/Verified IRL 3D NFTs/i));
    assert.ok(view.getByText(/5% \/ 3% \/ 2% Split/i));
    cleanup();
  });

  test('FirstVisitWelcomeOverlay explains product in one sentence with Human/Agent cards & clickable "i" tooltips', async () => {
    const { default: FirstVisitWelcomeOverlay } = await loadJsxModule(
      'client/src/components/FirstVisitWelcomeOverlay.jsx'
    );
    const exploreCalls = [];
    let agentConnected = false;
    let guideOpened = false;
    const view = RTL.render(
      React.createElement(FirstVisitWelcomeOverlay, {
        isMobile: false,
        onExplore: (dontShow) => {
          exploreCalls.push(dontShow);
        },
        onConnectAgent: () => {
          agentConnected = true;
        },
        onOpenGuide: () => {
          guideOpened = true;
        }
      })
    );

    assert.ok(view.getByText(/GRAFFILAND is a real-world 3D art map/i));
    assert.ok(view.getByTestId('welcome-step-1'));
    assert.ok(view.getByText(/Draw & Title Real-World 3D Land/i));
    assert.ok(view.container.querySelector('.welcome-step-svg'));

    // Click through all 3 illustrated walkthrough steps and verify Back works
    RTL.fireEvent.click(view.getByRole('button', { name: /Next Step \(2\/3\)/i }));
    assert.ok(view.getByTestId('welcome-step-2'));
    assert.ok(view.getByText(/Upload 3D Models or Paint Free AR Art/i));

    RTL.fireEvent.click(view.getByRole('button', { name: /Next Step \(3\/3\)/i }));
    assert.ok(view.getByTestId('welcome-step-3'));
    assert.ok(view.getByText(/Share Visit Links & Pair AI Agents/i));

    RTL.fireEvent.click(view.getByRole('button', { name: /Back/i }));
    assert.ok(view.getByTestId('welcome-step-2'));
    assert.equal(exploreCalls.length, 0);

    assert.ok(view.getByText(/^For Humans$/i));
    assert.ok(view.getByText(/^For AI Agents$/i));
    assert.ok(view.getByText(/90% Seller/i));

    // Clicking inside the card or opening an "i" tooltip must keep the overlay open
    RTL.fireEvent.click(view.getByText(/^For Humans$/i));
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: How Humans Play/i }));
    assert.ok(view.getByRole('tooltip'));
    assert.ok(view.getByText(/3 free gas-sponsored starter plots/i));
    assert.equal(exploreCalls.length, 0);

    // Starting a pointer press inside the card and releasing on the backdrop must NOT close it
    const backdrop = view.getByRole('dialog', { name: /Welcome to GRAFFILAND first-visit overview/i });
    const cardEl = view.container.querySelector('.welcome-overlay-card');
    RTL.fireEvent.pointerDown(cardEl);
    RTL.fireEvent.click(backdrop);
    assert.equal(exploreCalls.length, 0);

    // Uncheck dontShowAgain and click genuinely on the backdrop -> calls onExplore(false)
    const checkbox = view.getByRole('checkbox');
    RTL.fireEvent.click(checkbox);
    RTL.fireEvent.pointerDown(backdrop);
    RTL.fireEvent.click(backdrop);
    assert.equal(exploreCalls.length, 1);
    assert.equal(exploreCalls[0], false);

    // Pressing Escape dismisses cleanly with current dontShowAgain flag
    RTL.fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    assert.equal(exploreCalls.length, 2);
    assert.equal(exploreCalls[1], false);

    // Re-check dontShowAgain -> action buttons pass true
    RTL.fireEvent.click(checkbox);
    RTL.fireEvent.click(view.getByRole('button', { name: /Full Guide/i }));
    assert.equal(guideOpened, true);

    RTL.fireEvent.click(view.getByRole('button', { name: /Connect AI Agent/i }));
    assert.equal(agentConnected, true);

    RTL.fireEvent.click(view.getByRole('button', { name: /Explore the Map/i }));
    assert.equal(exploreCalls.length, 3);
    assert.equal(exploreCalls[2], true);
    cleanup();

    let skippedCamera = false;
    const mobileView = RTL.render(
      React.createElement(FirstVisitWelcomeOverlay, {
        isMobile: true,
        onExplore: () => {},
        onSkipToCamera: () => {
          skippedCamera = true;
        }
      })
    );
    assert.ok(mobileView.getByRole('button', { name: /Next: Quick Camera Guide/i }));
    RTL.fireEvent.click(mobileView.getByRole('button', { name: /Skip to AR Camera/i }));
    assert.equal(skippedCamera, true);
    cleanup();
  });

  test('DesktopLandBuilderPanel validates unique titles, compacts sliders, blocks pre-mint copy, shows post-mint copy tools & 3-free limit card', async () => {
    const { DesktopLandBuilderPanel } = await loadJsxModule(
      'client/src/components/DesktopLandBuilderPanel.jsx'
    );
    const { validateAndNormalizeLandVolume } = await import('../shared/landVolume.mjs');

    const p1 = {
      id: 'draft-1',
      ...validateAndNormalizeLandVolume({
        lat: 37.7749,
        lng: -122.4194,
        widthMeters: 20,
        depthMeters: 16,
        heightMeters: 18,
        rotationDeg: 0
      }).volume,
      customName: 'Studio West',
      valid: true,
      hasOverlap: false,
      errors: []
    };
    const p2 = {
      id: 'draft-2',
      ...validateAndNormalizeLandVolume({
        lat: 37.776,
        lng: -122.418,
        widthMeters: 14,
        depthMeters: 14,
        heightMeters: 27,
        rotationDeg: 45
      }).volume,
      customName: 'Plaza East',
      valid: true,
      hasOverlap: false,
      errors: []
    };
    const owned1 = {
      parcelId: 'GLAND-9Q8YYK9P',
      customName: 'Minted Terrace',
      volume: validateAndNormalizeLandVolume({
        lat: 37.7752,
        lng: -122.419,
        widthMeters: 18,
        depthMeters: 16,
        heightMeters: 20,
        rotationDeg: 15
      }).volume
    };

    const updates = [];
    const minted = [];
    let pairOpened = 0;
    const view = RTL.render(
      React.createElement(DesktopLandBuilderPanel, {
        draftParcels: [p1, p2],
        ownedParcels: [owned1],
        recentlyMintedParcels: [owned1],
        selectedDraftId: 'draft-1',
        drawMode: true,
        onToggleDrawMode: () => {},
        onAddDraftAtCenter: () => {},
        onSelectDraft: () => {},
        onUpdateDraft: (id, patch) => updates.push({ id, patch }),
        onRemoveDraft: () => {},
        onClearDrafts: () => {},
        onMintDraft: (draft) => minted.push(draft.parcelId),
        onMintAll: () => {},
        onOpenPairMobile: () => {
          pairOpened += 1;
        },
        mintLimitError: {
          usedSlots: 3,
          maxSlots: 3,
          unbuiltParcels: [{ parcelId: 'GLAND-9Q8YYK9P', displayName: 'Minted Terrace' }]
        },
        checkLandNameFn: async (name) => ({
          ok: true,
          available: name.toLowerCase() !== 'taken plaza',
          reason: name.toLowerCase() === 'taken plaza' ? '"Taken Plaza" is already taken.' : ''
        }),
        cameraBearingDeg: 315,
        user: { id: 'u1', name: 'Land Creator' }
      })
    );

    // 1) Limits, no pre-mint Copy Parcel Link, and no Title button next to Mint This Land
    const limitsCard = view.getByTestId('land-limits-card');
    assert.ok(limitsCard.textContent.includes('5,000 m²'));
    assert.ok(limitsCard.textContent.includes('500,000 m³'));
    assert.ok(limitsCard.textContent.includes('3 free human claims'));
    assert.equal(view.queryByRole('button', { name: /Copy Parcel Link/i }), null);
    assert.equal(view.queryByRole('button', { name: /🏷️ Title/i }), null);

    // 2) 3-free limit notification card renders with unbuilt land + Pair Phone QR button + mobile link
    assert.ok(view.getByTestId('mint-limit-notification'));
    assert.ok(/^https?:\/\//.test(view.getByTestId('mint-limit-mobile-link').getAttribute('href') || ''));
    RTL.fireEvent.click(view.getByTestId('mint-limit-pair-mobile-btn'));
    assert.equal(pairOpened, 1);

    // 3) Sliders start collapsed under Description and expand on demand
    assert.equal(view.queryByTestId('land-sliders-body'), null);
    RTL.fireEvent.click(view.getByTestId('land-sliders-toggle'));
    assert.ok(view.getByTestId('land-sliders-body'));

    RTL.fireEvent.change(view.getByLabelText('Width (m)'), { target: { value: '32' } });
    RTL.fireEvent.change(view.getByLabelText('Depth (m)'), { target: { value: '24' } });
    RTL.fireEvent.change(view.getByLabelText('Rotate (°)'), { target: { value: '45' } });
    RTL.fireEvent.change(view.getByLabelText('Z-Axis Scale'), { target: { value: '2' } });
    RTL.fireEvent.click(view.getByRole('button', { name: '+15°' }));
    RTL.fireEvent.click(view.getByRole('button', { name: /Match Map Angle/i }));
    RTL.fireEvent.click(view.getByRole('button', { name: /Max Limit Size/i }));
    RTL.fireEvent.click(view.getByRole('button', { name: /Max Height/i }));

    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.widthMeters === 32));
    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.depthMeters === 24));
    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.rotationDeg === 45));
    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.zScale === 2 && u.patch.heightMeters === 36));
    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.rotationDeg === 15));
    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.rotationDeg === 315));
    assert.ok(
      updates.some(
        (u) =>
          u.id === 'draft-1' &&
          u.patch.widthMeters * u.patch.depthMeters > 4900 &&
          u.patch.widthMeters * u.patch.depthMeters <= 5000
      )
    );
    assert.ok(updates.some((u) => u.id === 'draft-1' && u.patch.heightMeters === 250));

    // 4) Post-mint Copy All Locations + Copy Prompt (All) + Individual Copy Icons
    assert.ok(view.getByTestId('minted-lands-copy-panel'));
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('copy-all-minted-prompt-btn'));
    });
    const previewBox = view.getByLabelText('Minted lands AI agent prompt preview');
    assert.ok(previewBox.value.includes('Minted Terrace'));
    assert.ok(previewBox.value.includes('GLAND-9Q8YYK9P'));

    // 5) Wait for live title validation to confirm availability, then mint
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('land-title-validation').textContent.includes('available'));
    });
    RTL.fireEvent.click(view.getByRole('button', { name: /Mint This Land/i }));
    assert.deepEqual(minted, [p1.parcelId]);
    cleanup();
  });

  test('AddLandItemModal supports all 3D formats, generates copyable agent prompt, toggles freeze & hides artworks', async () => {
    const { default: AddLandItemModal } = await loadJsxModule(
      'client/src/components/AddLandItemModal.jsx'
    );
    const copied = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          copied.push(text);
        }
      },
      configurable: true
    });

    const freezeCalls = [];
    const visCalls = [];
    const view = RTL.render(
      React.createElement(AddLandItemModal, {
        parcel: {
          parcelId: 'GLAND-9Q8YYK8Y',
          customName: 'Civic Plaza',
          frozen: false,
          volume: { centerLat: 37.7749, centerLng: -122.4194, widthMeters: 24, depthMeters: 18, heightMeters: 22, rotationDeg: 315 }
        },
        existingSculptures: [
          { id: 'sc-1', title: 'Visitor Beacon', voxelCount: 12, creatorName: 'Alex', hidden: false }
        ],
        user: { id: 'u1', walletAddress: '0x1234567890abcdef1234567890abcdef12345678' },
        mcpState: { activePairing: { code: 'GLP-1111-2222-3333-4444' } },
        onToggleFreeze: async (pid, next) => freezeCalls.push({ pid, next }),
        onToggleSculptureVisibility: async (sid, next) => visCalls.push({ sid, next }),
        onClose: () => {}
      })
    );

    assert.ok(view.getByText(/Add 3D Item to Civic Plaza/i));
    RTL.fireEvent.click(view.getByRole('radio', { name: /\.GLB 3D Model/i }));
    RTL.fireEvent.change(view.getByPlaceholderText(/Glowing Cyber Dragon/i), {
      target: { value: 'Neon Dragon Arch' }
    });

    const promptPreview = view.getByLabelText('Add 3D item agent prompt preview');
    assert.ok(promptPreview.value.includes('load_3d_model_on_land'));
    assert.ok(promptPreview.value.includes('Neon Dragon Arch'));
    assert.ok(promptPreview.value.includes('GLP-1111-2222-3333-4444'));
    assert.ok(promptPreview.value.includes('update_land_sculpture'));
    assert.ok(promptPreview.value.includes('set_sculpture_visibility'));
    assert.ok(promptPreview.value.includes('update_land_settings'));

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Copy 3D Item Agent Prompt/i }));
    });
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes('Neon Dragon Arch'));

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Freeze Land/i }));
    });
    assert.deepEqual(freezeCalls, [{ pid: 'GLAND-9Q8YYK8Y', next: true }]);

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Hide/i }));
    });
    assert.deepEqual(visCalls, [{ sid: 'sc-1', next: true }]);

    // Verify model format SVG preview illustrations and direct model URL validation + upload
    assert.ok(view.container.querySelectorAll('.model-format-svg').length >= 6);
    const origFetch = globalThis.fetch;
    let uploadedPayload = null;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/models/validate-url')) {
        return {
          ok: true,
          json: async () => ({
            valid: true,
            format: 'glb',
            byteLength: 48120,
            stats: { triangleCount: 840 },
            suggestedTitle: 'Cyber Phoenix',
            modelUrl: 'https://assets.example.com/cyber-phoenix.glb'
          })
        };
      }
      if (u.includes('/sculptures')) {
        uploadedPayload = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          json: async () => ({
            sculpture: { id: 'sc-new-1', title: uploadedPayload.title }
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    try {
      RTL.fireEvent.change(view.getByLabelText('3D Model URL'), {
        target: { value: 'https://assets.example.com/cyber-phoenix.glb' }
      });
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByRole('button', { name: /^Validate Link$/i }));
      });
      assert.ok(view.getByTestId('model-url-valid-badge').textContent.includes('Supported .GLB'));

      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByRole('button', { name: /Validate & Upload/i }));
      });
      assert.equal(uploadedPayload.modelFormat, 'glb');
      assert.equal(uploadedPayload.modelUrl, 'https://assets.example.com/cyber-phoenix.glb');
    } finally {
      globalThis.fetch = origFetch;
    }
    cleanup();
  });

  test('TitleLandModal edits title/description with live slug preview and supports Save & Mint', async () => {
    const { default: TitleLandModal } = await loadJsxModule(
      'client/src/components/TitleLandModal.jsx'
    );
    const saved = [];
    const minted = [];
    const view = RTL.render(
      React.createElement(TitleLandModal, {
        mode: 'draft',
        parcel: { id: 'd1', parcelId: 'GLAND-9Q8YYK8Y', customName: '', description: '' },
        onSave: async (data) => saved.push(data),
        onSaveAndMint: async (data) => minted.push(data),
        onClose: () => {}
      })
    );

    RTL.fireEvent.change(view.getByLabelText('Land Title'), {
      target: { value: 'Golden Gate Plaza' }
    });
    RTL.fireEvent.change(view.getByLabelText('Land Description'), {
      target: { value: 'Outdoor 3D sculpture garden open to everyone.' }
    });
    assert.ok(view.getByText(/\/golden-gate-plaza/i));
    assert.equal(view.queryByText(/GLAND-9Q8YYK8Y/i), null);

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Save & Mint Land/i }));
    });
    assert.equal(minted.length, 1);
    assert.equal(minted[0].customName, 'Golden Gate Plaza');
    assert.equal(minted[0].description, 'Outdoor 3D sculpture garden open to everyone.');
    cleanup();
  });

  test('MobileParcelVisitView adapts clean options by proximity & frozen status (Directions vs View in AR + Make Art)', async () => {
    const { default: MobileParcelVisitView } = await loadJsxModule(
      'client/src/components/studio/MobileParcelVisitView.jsx'
    );
    const baseParcel = {
      parcelId: 'GLAND-9Q8YYK8Y',
      customName: 'Sunset Neon Courtyard',
      description: 'Sculpture park overlooking Market St.',
      centerLat: 37.7749,
      centerLng: -122.4194,
      frozen: false,
      volume: {
        centerLat: 37.7749,
        centerLng: -122.4194,
        widthMeters: 20,
        depthMeters: 16,
        heightMeters: 18
      }
    };

    // 1) Far away -> Get Directions shown, View in AR & Make Art hidden
    const farView = RTL.render(
      React.createElement(MobileParcelVisitView, {
        parcel: baseParcel,
        sculptures: [{ id: 's1', title: 'Neon Spire', voxelCount: 24, lat: 37.7749, lng: -122.4194 }],
        userLocation: { lat: 37.81, lng: -122.42 },
        onClose: () => {}
      })
    );
    assert.ok(farView.getAllByText('Sunset Neon Courtyard').length >= 2);
    assert.ok(farView.getByText(/Sculpture park overlooking Market St/i));
    assert.ok(farView.getByRole('link', { name: /Get Directions/i }));
    assert.equal(farView.queryByRole('button', { name: /View in AR/i }), null);
    assert.equal(farView.queryByRole('button', { name: /Make Art on This Property/i }), null);
    cleanup();

    // 2) Near + Open -> View in AR AND Make Art on This Property both shown
    let viewedAr = false;
    let madeArt = false;
    const nearOpen = RTL.render(
      React.createElement(MobileParcelVisitView, {
        parcel: baseParcel,
        sculptures: [{ id: 's1', title: 'Neon Spire', voxelCount: 24, lat: 37.7749, lng: -122.4194 }],
        userLocation: { lat: 37.77495, lng: -122.41942 },
        onViewInAR: () => {
          viewedAr = true;
        },
        onMakeArt: () => {
          madeArt = true;
        },
        onClose: () => {}
      })
    );
    assert.ok(nearOpen.getByTestId('parcel-proximity-near'));
    RTL.fireEvent.click(nearOpen.getByRole('button', { name: /View in AR/i }));
    RTL.fireEvent.click(nearOpen.getByRole('button', { name: /Make Art on This Property/i }));
    assert.equal(viewedAr, true);
    assert.equal(madeArt, true);
    cleanup();

    // 3) Near + Frozen -> View in AR shown, Make Art hidden + frozen notice shown
    const nearFrozen = RTL.render(
      React.createElement(MobileParcelVisitView, {
        parcel: { ...baseParcel, frozen: true },
        sculptures: [],
        userLocation: { lat: 37.77495, lng: -122.41942 },
        onViewInAR: () => {},
        onMakeArt: () => {},
        onClose: () => {}
      })
    );
    assert.ok(nearFrozen.getByRole('button', { name: /View in AR/i }));
    assert.equal(nearFrozen.queryByRole('button', { name: /Make Art on This Property/i }), null);
    assert.ok(nearFrozen.getByText(/frozen by the owner/i));
    cleanup();
  });

  test('EmojiInput and EmojiTextarea insert emojis via : shortcode autocomplete & auto-replace while ignoring URLs', async () => {
    const { EmojiInput, EmojiTextarea } = await loadJsxModule('client/src/components/EmojiField.jsx');

    function Harness() {
      const [title, setTitle] = React.useState('');
      const [desc, setDesc] = React.useState('');
      return React.createElement(
        'div',
        null,
        React.createElement(EmojiInput, {
          'aria-label': 'Emoji Test Input',
          value: title,
          onChange: (e) => setTitle(e.target.value)
        }),
        React.createElement(EmojiTextarea, {
          'aria-label': 'Emoji Test Textarea',
          value: desc,
          onChange: (e) => setDesc(e.target.value)
        })
      );
    }

    const view = RTL.render(React.createElement(Harness));
    const input = view.getByLabelText('Emoji Test Input');
    const textarea = view.getByLabelText('Emoji Test Textarea');

    // 1) Typing partial `:fir` shows suggestions listbox & Enter inserts 🔥
    RTL.fireEvent.change(input, { target: { value: 'Neon :fir', selectionStart: 9 } });
    const listbox = view.getByRole('listbox', { name: /Emoji suggestions/i });
    assert.ok(listbox.textContent.includes(':fire:'));
    RTL.fireEvent.keyDown(input, { key: 'Enter' });
    assert.equal(input.value, 'Neon 🔥');

    // 2) Typing completed `:rocket:` immediately replaces with 🚀 (and supports chained emojis)
    RTL.fireEvent.change(textarea, {
      target: { value: 'Launch :rocket:', selectionStart: 15 }
    });
    assert.equal(textarea.value, 'Launch 🚀');
    assert.equal(textarea.selectionStart, 'Launch 🚀'.length);

    RTL.fireEvent.change(textarea, {
      target: { value: 'Launch 🚀:fire:', selectionStart: 'Launch 🚀:fire:'.length }
    });
    assert.equal(textarea.value, 'Launch 🚀🔥');

    // 3) URLs, timestamps, and double-colons must NOT trigger emoji autocomplete
    RTL.fireEvent.change(input, {
      target: { value: 'Visit https://example.com at 12:30 ::before', selectionStart: 43 }
    });
    assert.equal(view.queryByRole('listbox', { name: /Emoji suggestions/i }), null);
    cleanup();
  });

  test('LandManagementModal is concise with clickable "i" tooltips & supports ":" emojis in Land Name and Description', async () => {
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );
    const savedCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        return {
          ok: true,
          json: async () => ({
            ownerAddress: '0x1234',
            parcelCount: 1,
            parcels: [
              {
                parcelId: 'GLAND-9Q8YYK8Y',
                customName: 'Civic Plaza',
                description: 'Original desc',
                curationNote: 'Original desc',
                sculptureCount: 0,
                frozen: false,
                settings: { allowAgentErase: true, allowContributorEdits: true, frozen: false },
                securityPolicy: { requirePasskeyUnlock: false, requireOrbUnlock: false, minOrbInliers: 8 },
                contributors: [],
                eligibleVisitors: [],
                sculptures: []
              }
            ]
          })
        };
      }
      if (u.includes('/api/passkeys/status')) {
        return { ok: true, json: async () => ({ passkeys: [] }) };
      }
      if (u.includes('/update')) {
        savedCalls.push(JSON.parse(opts.body || '{}'));
        return { ok: true, json: async () => ({ parcel: { parcelId: 'GLAND-9Q8YYK8Y' } }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(LandManagementModal, {
          user: { id: 'u1', walletAddress: '0x1234' },
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(view.getByLabelText('Land Name'));
      });

      // Clickable "i" tooltips reveal extra feature context on demand
      RTL.fireEvent.click(view.getByRole('button', { name: /Info: Freeze Land/i }));
      assert.ok(view.getByRole('tooltip').textContent.includes('Blocks all new sculptures'));
      RTL.fireEvent.click(view.getByRole('button', { name: /Info: How Contributors Work/i }));
      assert.ok(view.getByRole('tooltip').textContent.includes('physically visited'));

      // Type :fire: and :art: into Land Name & Land Description and save
      RTL.fireEvent.change(view.getByLabelText('Land Name'), {
        target: { value: 'Sunset Plaza :fire:', selectionStart: 19 }
      });
      RTL.fireEvent.change(view.getByLabelText('Land Description'), {
        target: { value: 'Sculpture park :art:', selectionStart: 20 }
      });
      assert.equal(view.getByLabelText('Land Name').value, 'Sunset Plaza 🔥');
      assert.equal(view.getByLabelText('Land Description').value, 'Sculpture park 🎨');

      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByRole('button', { name: /Save Land Settings/i }));
      });
      assert.equal(savedCalls.length, 1);
      assert.equal(savedCalls[0].customName, 'Sunset Plaza 🔥');
      assert.equal(savedCalls[0].description, 'Sculpture park 🎨');
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('StudioHudTopBar Pair & Approvals button shows notification pill, Yes/No approvals with descriptions, QR scanner, Agent Connector copy & history', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    const approved = [];
    const rejected = [];
    const connectedCodes = [];
    const copiedTexts = [];

    const origClipboard = globalThis.navigator.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (txt) => {
          copiedTexts.push(txt);
        }
      }
    });

    const pendingItems = [
      {
        id: 'sigreq_1',
        action: 'create_sculpture',
        parcelId: 'GLAND-9Q8YYK8Y',
        agentName: 'VoxelBot',
        summaryTitle: 'Place "Neon Dragon"',
        summaryDescription: 'Add GLB 3D model on parcel GLAND-9Q8YYK8Y — Fire-breathing corner statue.',
        status: 'pending',
        expiresAt: new Date(Date.now() + 30 * 60000).toISOString()
      },
      {
        id: 'sigreq_2',
        action: 'update_land_settings',
        parcelId: 'GLAND-9Q8YYK8Y',
        agentName: 'StewardAI',
        summaryTitle: 'Freeze Land',
        summaryDescription: 'Freeze land on parcel GLAND-9Q8YYK8Y.',
        status: 'pending',
        expiresAt: new Date(Date.now() + 45 * 60000).toISOString()
      }
    ];
    const historyItems = [
      {
        id: 'sigreq_old_1',
        action: 'update_parcel',
        parcelId: 'GLAND-9Q8YYK8Y',
        agentName: 'VoxelBot',
        summaryTitle: 'Update Land Details',
        summaryDescription: 'Set name "Sunset Plaza" on parcel GLAND-9Q8YYK8Y.',
        status: 'executed',
        signedBy: 'mobile-wallet',
        updatedAt: new Date(Date.now() - 15 * 60000).toISOString()
      },
      {
        id: 'sigreq_old_2',
        action: 'erase_land',
        parcelId: 'GLAND-9Q8YYK8Y',
        agentName: 'RogueBot',
        summaryTitle: 'Erase All Land Artworks',
        summaryDescription: 'Erase all artworks & curations on parcel GLAND-9Q8YYK8Y.',
        status: 'rejected',
        updatedAt: new Date(Date.now() - 40 * 60000).toISOString()
      }
    ];

    try {
      function Wrapper() {
        const [pairInput, setPairInput] = React.useState('');
        const [notice, setNotice] = React.useState('');
        return React.createElement(StudioHudTopBar, {
          user: { id: 'u1', walletAddress: '0x1111111111111111111111111111111111111111' },
          mode: 'draw',
          dockOpen: false,
          location: { lat: 37.7749, lng: -122.4194 },
          pairedCode: '',
          pairCodeInput: pairInput,
          setPairCodeInput: setPairInput,
          onConnectPairCode: (code) => connectedCodes.push(code),
          mcpPairingsState: {
            mcpActive: true,
            activePairing: { code: 'GLP-ABCD-2345-EFGH-6789', keyConnected: false },
            pairings: []
          },
          mcpPairNotice: notice,
          setMcpPairNotice: setNotice,
          voxels: [],
          quickSculpt: false,
          onToggleQuickSculpt: () => {},
          onOpenTutorial: () => {},
          onOpenInfo: () => {},
          hasOwnedLand: true,
          ownedLandCount: 1,
          onOpenLandManage: () => {},
          originStatus: { originBlocked: false },
          sceneScan: { optimal: false },
          pendingSignatures: pendingItems,
          signatureHistory: historyItems,
          onMobileSignPending: (item) => approved.push(item.id),
          onMobileRejectPending: (id) => rejected.push(id),
          mapOpen: false,
          nearbyCount: 0,
          onOpenAreaMap: () => {}
        });
      }

      const view = RTL.render(React.createElement(Wrapper));

      // Notification pill count (2) and persistent alert pill are immediately visible on main canvas
      assert.equal(view.getByTestId('mobile-pending-pill').textContent, '2');
      assert.ok(view.getByTestId('mobile-pending-alert-pill').textContent.includes('2 pending approvals'));

      // Clicking the Pair & Approvals button drops down to Pending tab with descriptions & Yes/No buttons
      RTL.fireEvent.click(view.getByTestId('mobile-pair-hub-btn'));
      assert.ok(view.getByTestId('mobile-pair-dropdown'));
      assert.equal(view.getAllByTestId('mobile-pending-item').length, 2);
      assert.ok(view.getByText(/Fire-breathing corner statue/));

      // Approve Yes on first item, Reject No on second item
      RTL.fireEvent.click(view.getAllByRole('button', { name: /Yes, Approve/i })[0]);
      RTL.fireEvent.click(view.getAllByRole('button', { name: /No, Reject/i })[1]);
      assert.deepEqual(approved, ['sigreq_1']);
      assert.deepEqual(rejected, ['sigreq_2']);

      // Switch to History tab -> both past Approved & Rejected items appear with descriptions
      RTL.fireEvent.click(view.getByRole('tab', { name: /History/i }));
      assert.equal(view.getAllByTestId('mobile-history-item').length, 2);
      assert.ok(view.getByText(/Set name "Sunset Plaza"/));
      assert.ok(view.getByText(/Erase all artworks/));

      // Switch to Pair tab -> scan QR viewfinder toggles, URL paste extracts code, and Agent Connector copies
      RTL.fireEvent.click(view.getByRole('tab', { name: /^🔗 Pair$/i }));
      RTL.fireEvent.click(view.getByRole('button', { name: /Scan Desktop QR Code/i }));
      assert.ok(view.getByTestId('desktop-qr-scanner'));
      RTL.fireEvent.click(view.getByRole('button', { name: /Close Scanner/i }));

      RTL.fireEvent.change(view.getByLabelText('Desktop pair code'), {
        target: { value: 'https://maximusmaximus.github.io/graffiland/?pair=xy98ab' }
      });
      RTL.fireEvent.click(view.getByRole('button', { name: /^Connect$/i }));
      assert.deepEqual(connectedCodes, ['XY98AB']);

      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByRole('button', { name: /Copy Agent Connector Prompt/i }));
      });
      assert.ok(copiedTexts.some((t) => t.includes('GLP-ABCD-2345-EFGH-6789')));
    } finally {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: origClipboard
      });
      cleanup();
    }
  });

  test('MobileMapSheet defaults to Nearest Lands with nested sculptures, land/sculpture metadata, expiration countdown, and Google Maps links', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const selectedSculptures = [];
    const focusedParcels = [];
    const parcels = [
      {
        parcelId: 'GLAND-FAR',
        customName: 'Embarcadero Pier',
        description: 'Waterfront sculpture deck',
        centerLat: 37.7955,
        centerLng: -122.3937,
        bounds: { sw: [37.795, -122.394], ne: [37.796, -122.393], center: [37.7955, -122.3937] },
        volume: { widthMeters: 20, depthMeters: 20, heightMeters: 30, footprintAreaSqM: 400 },
        stewardName: 'Maya',
        stewardType: 'human',
        stewardStatus: 'awakened',
        awakenedAt: '2026-11-10T00:00:00.000Z',
        humanContributorCount: 3,
        sculptureCount: 0
      },
      {
        parcelId: 'GLAND-NEAR',
        customName: 'Civic Neon Plaza',
        description: 'Agent-staged plaza awaiting human art',
        centerLat: 37.7755,
        centerLng: -122.4194,
        bounds: { sw: [37.775, -122.42], ne: [37.776, -122.419], center: [37.7755, -122.4194] },
        volume: { widthMeters: 24, depthMeters: 16, heightMeters: 36, footprintAreaSqM: 384 },
        stewardName: 'PainterBot',
        stewardType: 'agent',
        stewardStatus: 'dormant',
        firstSparkBoost: true,
        leaseExpiresAt: '2026-11-22T06:00:00.000Z',
        openQuestCount: 2,
        sculptureCount: 2
      }
    ];
    const sculptures = [
      {
        id: 'sc-voxel-1',
        parcelId: 'GLAND-NEAR',
        title: 'Prism Arch',
        description: 'Floating voxel gateway',
        lat: 37.7755,
        lng: -122.4194,
        voxelCount: 142,
        creatorName: 'Alex',
        polScore: 94,
        layerRole: 'artist_work',
        createdAt: '2026-11-19T18:00:00.000Z',
        chain: { txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', simulated: true }
      },
      {
        id: 'sc-glb-2',
        parcelId: 'GLAND-NEAR',
        title: 'Plinth Stage',
        lat: 37.7755,
        lng: -122.4194,
        modelType: 'custom-3d',
        customModel: { format: 'glb', triangleCount: 3200 },
        creatorName: 'PainterBot',
        layerRole: 'steward_stage',
        createdAt: '2026-11-18T10:00:00.000Z'
      }
    ];

    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        config: {},
        location: { lat: 37.7749, lng: -122.4194 },
        areaFilterMode: 'nearby',
        setAreaFilterMode: () => {},
        mapLoading: false,
        loadPublicMapData: () => {},
        areaSculpturesSorted: sculptures,
        mapParcels: parcels,
        onSelectParcel: (pid) => focusedParcels.push(pid),
        onSelectSculpture: (sc) => selectedSculptures.push(sc.id),
        onShowHint: () => {},
        onClose: () => {},
        nowMsOverride: now
      })
    );

    const cards = view.getAllByTestId('mobile-land-card');
    assert.equal(cards.length, 2);
    // Nearest land (#1) must be Civic Neon Plaza, followed by Embarcadero Pier (#2)
    assert.equal(cards[0].getAttribute('data-parcel-id'), 'GLAND-NEAR');
    assert.equal(cards[1].getAttribute('data-parcel-id'), 'GLAND-FAR');

    // Expiration countdown and Permanent badges render accurately
    const expBadges = view.getAllByTestId('land-expiration-badge');
    assert.ok(expBadges[0].textContent.includes('1d 18h left'));
    assert.ok(expBadges[1].textContent.includes('Permanent'));
    assert.ok(view.getByTestId('land-expiration-detail').textContent.includes('2x First-Spark XP'));

    // Land metadata (dimensions, steward with icon badge, quests, contributors) renders
    assert.ok(cards[0].textContent.includes('24×16×36 m · 384 m²'));
    assert.ok(cards[0].textContent.includes('PainterBot'));
    assert.ok(cards[0].querySelector('[data-testid="user-handle-badge"]'));
    assert.ok(cards[0].textContent.includes('2 open quests'));
    assert.ok(cards[1].textContent.includes('3 contributors'));

    // Every land card includes a Google Maps link pointing to its coordinates
    const gmapsLinks = view.getAllByTestId('land-google-maps-link');
    assert.equal(gmapsLinks.length, 2);
    assert.ok(gmapsLinks[0].getAttribute('href').startsWith('https://www.google.com/maps/dir/?api=1&destination=37.775500'));
    assert.ok(gmapsLinks[1].getAttribute('href').startsWith('https://www.google.com/maps/dir/?api=1&destination=37.795500'));

    // Nested sculptures appear directly under GLAND-NEAR with full metadata
    const nestedItems = view.getAllByTestId('land-sculpture-item');
    assert.equal(nestedItems.length, 2);
    assert.ok(nestedItems[0].textContent.includes('Prism Arch'));
    assert.ok(nestedItems[0].textContent.includes('142 blocks'));
    assert.ok(nestedItems[0].textContent.includes('PoL 94'));
    assert.ok(nestedItems[1].textContent.includes('GLB 3D · 3,200 tris'));

    // Clicking Focus Map and 3D inspect fire callbacks cleanly
    RTL.fireEvent.click(view.getByRole('button', { name: /Focus Civic Neon Plaza on map/i }));
    assert.deepEqual(focusedParcels, ['GLAND-NEAR']);
    RTL.fireEvent.click(RTL.within(nestedItems[0]).getByRole('button', { name: /3D/i }));
    assert.deepEqual(selectedSculptures, ['sc-voxel-1']);

    cleanup();
  });

  test('UsernameOnboardingModal requires a valid available username and saves username + bio', async () => {
    const { default: UsernameOnboardingModal } = await loadJsxModule(
      'client/src/components/UsernameOnboardingModal.jsx'
    );
    const savedPayloads = [];
    let completedUser = null;

    const view = RTL.render(
      React.createElement(UsernameOnboardingModal, {
        user: { id: 'u1', name: 'Maya Chen', email: 'maya@test.io', username: '', bio: '' },
        checkUsernameFn: async (handle) =>
          handle === 'taken_name'
            ? { available: false, username: handle, reason: '@taken_name is already taken.' }
            : { available: true, username: handle, reason: `@${handle} is available!` },
        saveProfileFn: async (payload) => {
          savedPayloads.push(payload);
          return {
            user: {
              id: 'u1',
              name: 'Maya Chen',
              username: payload.username,
              bio: payload.bio,
              needsUsernameOnboarding: false
            }
          };
        },
        onComplete: (u) => {
          completedUser = u;
        },
        onLogout: () => {}
      })
    );

    const input = view.getByLabelText('Choose username');
    const saveBtn = view.getByTestId('onboarding-save-username-btn');

    // Invalid short handle disables submit
    RTL.fireEvent.change(input, { target: { value: 'ab' } });
    assert.equal(saveBtn.disabled, true);
    assert.ok(view.getByTestId('onboarding-username-status').textContent.includes('at least 3'));

    // Taken handle reports unavailable and keeps submit disabled
    RTL.fireEvent.change(input, { target: { value: 'taken_name' } });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('onboarding-username-status').textContent.includes('already taken'));
    });
    assert.equal(saveBtn.disabled, true);

    // Valid available handle + bio enables save and completes onboarding
    RTL.fireEvent.change(input, { target: { value: 'maya_neon' } });
    RTL.fireEvent.change(view.getByLabelText('Profile bio'), {
      target: { value: 'AR sculptor in SF' }
    });
    await RTL.waitFor(() => {
      assert.equal(saveBtn.disabled, false);
    });

    await RTL.act(async () => {
      RTL.fireEvent.click(saveBtn);
    });
    assert.deepEqual(savedPayloads, [{ username: 'maya_neon', bio: 'AR sculptor in SF' }]);
    assert.equal(completedUser?.username, 'maya_neon');
    cleanup();
  });

  test('ProfileModal displays bio, public land/sculpture/action links, and validates username changes', async () => {
    const { default: ProfileModal } = await loadJsxModule(
      'client/src/components/ProfileModal.jsx'
    );
    const updatedUsers = [];
    const mockData = {
      profile: {
        id: 'u1',
        username: 'maya_neon',
        displayName: 'Maya Chen',
        bio: 'Building neon voxel art',
        walletAddress: '0x1111111111111111111111111111111111111111',
        accountType: 'human',
        joinedAt: '2026-11-01T00:00:00.000Z'
      },
      stats: {
        landCount: 1,
        sculptureCount: 1,
        activeListingCount: 0,
        actionCount: 2,
        totalBlocks: 88
      },
      lands: [
        {
          parcelId: 'GLAND-9Q8YYK',
          customName: 'Civic Neon Plaza',
          displayName: 'Civic Neon Plaza',
          description: 'Open 3D sculpture lot',
          sculptureCount: 1,
          stewardStatus: 'awakened',
          volume: { widthMeters: 20, depthMeters: 16, heightMeters: 28, footprintAreaSqM: 320 },
          googleMapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=37.774900%2C-122.419400'
        }
      ],
      sculptures: [
        {
          id: 'sc-1',
          title: 'Neon Arch',
          description: 'Floating voxel gateway',
          parcelId: 'GLAND-9Q8YYK',
          voxelCount: 88,
          polScore: 95,
          createdAt: '2026-11-20T00:00:00.000Z',
          chain: { txHash: '0x1234567890abcdef', simulated: true }
        }
      ],
      listings: [],
      actions: [
        {
          id: 'act-1',
          type: 'sculpture_published',
          icon: '🧊',
          title: 'Published "Neon Arch"',
          detail: 'GLAND-9Q8YYK · 88 blocks',
          parcelId: 'GLAND-9Q8YYK',
          sculptureId: 'sc-1',
          linkLabel: 'View Sculpture',
          createdAt: '2026-11-20T00:00:00.000Z'
        }
      ]
    };

    const view = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'maya_neon',
        user: { id: 'u1', username: 'maya_neon', name: 'Maya Chen' },
        fetchProfileFn: async () => mockData,
        checkUsernameFn: async (u) =>
          u === 'taken_other'
            ? { available: false, username: u, reason: '@taken_other is already taken.' }
            : { available: true, username: u, reason: `@${u} is available!` },
        saveProfileFn: async ({ username, bio }) => ({
          ...mockData,
          user: { id: 'u1', username, bio, name: 'Maya Chen', needsUsernameOnboarding: false },
          profile: { ...mockData.profile, username, bio }
        }),
        onUserUpdate: (u) => updatedUsers.push(u),
        onClose: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.equal(view.getByTestId('profile-handle').textContent, '@maya_neon');
    });
    assert.ok(view.getByTestId('profile-bio').textContent.includes('Building neon voxel art'));

    // Public land link renders on Lands tab
    const landLink = view.getByTestId('profile-land-public-link');
    assert.ok(landLink.getAttribute('href').includes('GLAND-9Q8YYK'));

    // Switch to Sculptures tab -> public sculpture link renders
    RTL.fireEvent.click(view.getByRole('tab', { name: /Sculptures/i }));
    const scLink = view.getByTestId('profile-sculpture-public-link');
    assert.ok(scLink.getAttribute('href').includes('?sculpture=sc-1'));

    // Switch to Actions tab -> public action link renders
    RTL.fireEvent.click(view.getByRole('tab', { name: /Actions/i }));
    const actLink = view.getByTestId('profile-action-link');
    assert.ok(actLink.getAttribute('href').includes('?sculpture=sc-1'));

    // Open Edit Profile, verify duplicate username is blocked, then save valid rename + new bio
    RTL.fireEvent.click(view.getByTestId('profile-edit-btn'));
    const uInput = view.getByLabelText('Username');
    const saveBtn = view.getByTestId('profile-save-btn');
    RTL.fireEvent.change(uInput, { target: { value: 'taken_other' } });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('profile-username-status').textContent.includes('already taken'));
    });
    assert.equal(saveBtn.disabled, true);

    RTL.fireEvent.change(uInput, { target: { value: 'maya_voxels' } });
    RTL.fireEvent.change(view.getByLabelText('Bio'), {
      target: { value: 'Updated bio with AR maps' }
    });
    await RTL.waitFor(() => {
      assert.equal(saveBtn.disabled, false);
    });
    await RTL.act(async () => {
      RTL.fireEvent.click(saveBtn);
    });

    assert.equal(updatedUsers[0]?.username, 'maya_voxels');
    assert.equal(view.getByTestId('profile-handle').textContent, '@maya_voxels');
    assert.ok(view.getByTestId('profile-bio').textContent.includes('Updated bio with AR maps'));
    cleanup();
  });

  test('InfoTip unfolds inline underneath each item, closes when selecting another item, and closes when scrolled past', async () => {
    const { default: InfoTip } = await loadJsxModule('client/src/components/InfoTip.jsx');
    const view = RTL.render(
      React.createElement(
        'div',
        { 'data-testid': 'scroll-box', style: { overflowY: 'auto', height: '200px' } },
        React.createElement(
          'div',
          { className: 'info-simple-title' },
          React.createElement('strong', null, 'Item One'),
          React.createElement(InfoTip, { title: 'Item One Details' }, 'First unfolded explanation')
        ),
        React.createElement(
          'div',
          { className: 'info-simple-title' },
          React.createElement('strong', null, 'Item Two'),
          React.createElement(InfoTip, { title: 'Item Two Details' }, 'Second unfolded explanation')
        )
      )
    );

    // Clicking Item One unfolds inline directly under Item One
    RTL.fireEvent.click(view.getByRole('button', { name: 'Info: Item One Details' }));
    const tip1 = view.getByRole('tooltip');
    assert.equal(tip1.getAttribute('data-info-tip-mode'), 'inline');
    assert.ok(tip1.textContent.includes('First unfolded explanation'));

    // Selecting Item Two closes Item One and unfolds Item Two
    RTL.fireEvent.click(view.getByRole('button', { name: 'Info: Item Two Details' }));
    assert.equal(view.queryByText('First unfolded explanation'), null);
    const tip2 = view.getByRole('tooltip');
    assert.ok(tip2.textContent.includes('Second unfolded explanation'));

    // Scrolling past Item Two (panel bottom above visible container top) auto-closes it
    tip2.getBoundingClientRect = () => ({ top: -120, bottom: -20, left: 10, right: 300, width: 290, height: 100 });
    RTL.fireEvent.scroll(globalThis.window);
    assert.equal(view.queryByRole('tooltip'), null);

    cleanup();
  });

  test('StudioHudTopBar renders top-left Sign In button when logged out and unstacked red error banner with Retry Camera + Dismiss', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    let loginClicks = 0;
    let retryClicks = 0;
    let dismissClicks = 0;

    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'draw',
        dockOpen: true,
        location: null,
        pairedCode: '',
        voxels: [],
        quickSculpt: false,
        onToggleQuickSculpt: () => {},
        onOpenTutorial: () => {},
        onOpenInfo: () => {},
        onOpenLogin: () => {
          loginClicks += 1;
        },
        hasOwnedLand: false,
        ownedLandCount: 0,
        onOpenLandManage: () => {},
        needsGyroTap: false,
        gyroFallbackActive: false,
        cameraReady: false,
        onRetryCameraAccess: () => {
          retryClicks += 1;
        },
        sensorBanner: 'Camera is blocked. Allow camera for this site.',
        onDismissSensorBanner: () => {
          dismissClicks += 1;
        },
        originStatus: { originBlocked: false },
        sceneScan: { optimal: false },
        mapOpen: false,
        nearbyCount: 0,
        onOpenAreaMap: () => {}
      })
    );

    // Top-left Sign In button is present and clickable
    const signInBtn = view.getByTestId('mobile-signin-btn');
    RTL.fireEvent.click(signInBtn);
    assert.equal(loginClicks, 1);

    // Only ONE camera/sensor error banner renders (red error with integrated Retry Camera + Dismiss)
    const errBanner = view.getByTestId('mobile-error-banner');
    assert.ok(errBanner.textContent.includes('Camera is blocked'));
    assert.equal(view.getAllByRole('button', { name: /Retry Camera/i }).length, 1);
    RTL.fireEvent.click(view.getByRole('button', { name: /Retry Camera/i }));
    assert.equal(retryClicks, 1);
    RTL.fireEvent.click(view.getByRole('button', { name: /Dismiss alert/i }));
    assert.equal(dismissClicks, 1);

    cleanup();
  });

  test('landPreviewHelpers computes exact isometric camera fit, scale bar, cardinal coords, and spatial context', async () => {
    const helpers = await import('../client/src/utils/landPreviewHelpers.js');

    // 1) Defensively reconstructs volume corners/ring even when only geohash parcelId is supplied
    const decodedVol = helpers.resolveParcelVolume({ parcelId: 'GLAND-9Q8YYK8Y' });
    assert.ok(decodedVol);
    assert.equal(decodedVol.corners.length, 4);
    assert.equal(decodedVol.ring.length, 5);
    assert.ok(decodedVol.centerLat > 37.7 && decodedVol.centerLat < 37.85);

    // 2) Exact isometric fit scales zoom inversely with parcel footprint & height
    const smallVol = helpers.resolveParcelVolume({
      parcelId: 'GLAND-9Q8YYK8Y',
      volume: {
        centerLat: 37.7793,
        centerLng: -122.4193,
        widthMeters: 12,
        depthMeters: 12,
        heightMeters: 12,
        rotationDeg: 15
      }
    });
    const largeVol = helpers.resolveParcelVolume({
      parcelId: 'GLAND-9Q8YYK8Z',
      volume: {
        centerLat: 37.7793,
        centerLng: -122.4193,
        widthMeters: 50,
        depthMeters: 45,
        heightMeters: 40,
        rotationDeg: 0
      }
    });

    const smallIso = helpers.computeIsometricCameraFit(smallVol, {
      viewportWidth: 640,
      viewportHeight: 272,
      viewMode: 'isometric'
    });
    const largeIso = helpers.computeIsometricCameraFit(largeVol, {
      viewportWidth: 640,
      viewportHeight: 272,
      viewMode: 'isometric'
    });
    const contextView = helpers.computeIsometricCameraFit(smallVol, {
      viewportWidth: 640,
      viewportHeight: 272,
      viewMode: 'context'
    });
    const topDownView = helpers.computeIsometricCameraFit(smallVol, {
      viewportWidth: 640,
      viewportHeight: 272,
      viewMode: 'topdown'
    });

    assert.equal(smallIso.pitch, 55);
    assert.equal(smallIso.bearing, -30); // rotationDeg (15) - 45 = -30
    assert.ok(smallIso.zoom > largeIso.zoom, 'Smaller parcel should zoom closer than larger parcel');
    assert.ok(smallIso.padding.top > smallIso.padding.bottom, 'Isometric fit shifts padding for Z-height');
    assert.ok(contextView.zoom < smallIso.zoom - 1.5, 'Area context view zooms out cleanly');
    assert.equal(topDownView.pitch, 0);
    assert.equal(topDownView.bearing, 0);

    // 3) Scale bar, cardinal coords & spatial summary with nearest owned land
    const bar = helpers.computeScaleBarForZoom(37.7793, smallIso.zoom, 92);
    assert.ok(bar.meters >= 5 && bar.widthPx >= 28 && bar.widthPx <= 92);
    assert.equal(helpers.formatCardinalCoords(37.7793, -122.4193), '37.77930° N, 122.41930° W');

    const summary = helpers.buildParcelGeoSummary(
      { parcelId: 'GLAND-9Q8YYK8Y', customName: 'Civic Plaza', volume: smallVol },
      {
        allParcels: [
          { parcelId: 'GLAND-9Q8YYK8Y', customName: 'Civic Plaza', volume: smallVol },
          {
            parcelId: 'GLAND-9Q8YYM22',
            customName: 'Ferry Tower',
            volume: {
              centerLat: 37.7955,
              centerLng: -122.3937,
              widthMeters: 20,
              depthMeters: 20,
              heightMeters: 24
            }
          }
        ],
        placeContext: { shortLabel: 'Market St · Civic Center, San Francisco, CA' }
      }
    );
    assert.equal(summary.placePrimary, 'Market St · Civic Center, San Francisco, CA');
    assert.ok(summary.googleMapsUrl.includes('37.779300'));
    assert.equal(summary.nearestOwnedLand.name, 'Ferry Tower');
    assert.equal(summary.nearestOwnedLand.cardinal, 'SW');
  });

  test('LandManagementModal renders perfectly fit isometric preview and reloads view when another land is selected', async () => {
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );

    let mineFetchCount = 0;
    const reverseCalls = [];
    const focusedParcels = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        mineFetchCount += 1;
        return {
          ok: true,
          json: async () => ({
            ownerAddress: '0x1234',
            parcelCount: 2,
            parcels: [
              {
                parcelId: 'GLAND-9Q8YYK8Y',
                geohash: '9q8yyk8y',
                customName: 'Civic Plaza',
                description: 'Downtown civic showcase',
                curationNote: 'Downtown civic showcase',
                centerLat: 37.7793,
                centerLng: -122.4193,
                volume: {
                  parcelId: 'GLAND-9Q8YYK8Y',
                  geohash: '9q8yyk8y',
                  centerLat: 37.7793,
                  centerLng: -122.4193,
                  widthMeters: 18,
                  depthMeters: 16,
                  heightMeters: 20,
                  rotationDeg: 10
                },
                sculptureCount: 1,
                frozen: false,
                settings: { allowAgentErase: true, allowContributorEdits: true, frozen: false },
                securityPolicy: { requirePasskeyUnlock: false, requireOrbUnlock: false, minOrbInliers: 8 },
                contributors: [],
                eligibleVisitors: [],
                sculptures: [{ id: 'sc-1', title: 'Neon Arch', lat: 37.7793, lng: -122.4193, voxelCount: 12 }]
              },
              {
                parcelId: 'GLAND-DR5RU6N5',
                geohash: 'dr5ru6n5',
                customName: 'Midtown Rooftop',
                description: 'Skyline gallery',
                curationNote: 'Skyline gallery',
                centerLat: 40.758,
                centerLng: -73.9855,
                volume: {
                  parcelId: 'GLAND-DR5RU6N5',
                  geohash: 'dr5ru6n5',
                  centerLat: 40.758,
                  centerLng: -73.9855,
                  widthMeters: 28,
                  depthMeters: 24,
                  heightMeters: 32,
                  rotationDeg: 29
                },
                sculptureCount: 2,
                frozen: true,
                settings: { allowAgentErase: true, allowContributorEdits: true, frozen: true },
                securityPolicy: { requirePasskeyUnlock: false, requireOrbUnlock: false, minOrbInliers: 8 },
                contributors: [],
                eligibleVisitors: [],
                sculptures: []
              }
            ]
          })
        };
      }
      if (u.includes('/api/geocode/reverse')) {
        reverseCalls.push(u);
        if (u.includes('40.758')) {
          return {
            ok: true,
            json: async () => ({
              shortLabel: 'Broadway · Times Square, New York, NY',
              city: 'New York',
              region: 'NY'
            })
          };
        }
        return {
          ok: true,
          json: async () => ({
            shortLabel: 'Polk St · Civic Center, San Francisco, CA',
            city: 'San Francisco',
            region: 'CA'
          })
        };
      }
      if (u.includes('/api/passkeys/status')) {
        return { ok: true, json: async () => ({ passkeys: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(LandManagementModal, {
          user: { id: 'u1', walletAddress: '0x1234' },
          onFocusParcel: (p) => focusedParcels.push(p.parcelId),
          onClose: () => {}
        })
      );

      // 1) Initial land loads in isometric view with geographic place & coordinates
      await RTL.waitFor(() => {
        const preview = view.getByTestId('land-mgmt-iso-preview');
        assert.equal(preview.getAttribute('data-parcel-id'), 'GLAND-9Q8YYK8Y');
        assert.equal(preview.getAttribute('data-view-mode'), 'isometric');
        assert.ok(view.getByTestId('land-preview-place').textContent.includes('San Francisco'));
      });
      assert.ok(view.getByTestId('land-preview-coords').textContent.includes('37.77930° N'));
      assert.ok(view.getByTestId('land-preview-scale').textContent.includes('m'));

      // Toggle view modes (Area Context -> 2D -> Iso)
      RTL.fireEvent.click(view.getByRole('button', { name: /Area/i }));
      assert.equal(
        view.getByTestId('land-mgmt-iso-preview').getAttribute('data-view-mode'),
        'context'
      );
      RTL.fireEvent.click(view.getByRole('button', { name: /2D/i }));
      assert.equal(
        view.getByTestId('land-mgmt-iso-preview').getAttribute('data-view-mode'),
        'topdown'
      );

      // 2) Selecting another land immediately loads that land's isometric preview (and resets to isometric)
      RTL.fireEvent.click(view.getByRole('tab', { name: /Midtown Rooftop/i }));
      await RTL.waitFor(() => {
        const preview = view.getByTestId('land-mgmt-iso-preview');
        assert.equal(preview.getAttribute('data-parcel-id'), 'GLAND-DR5RU6N5');
        assert.equal(preview.getAttribute('data-view-mode'), 'isometric');
        assert.ok(view.getByTestId('land-preview-place').textContent.includes('Times Square'));
      });
      assert.ok(view.getByTestId('land-preview-coords').textContent.includes('40.75800° N'));
      assert.equal(mineFetchCount, 1, 'Switching lands must NOT re-fetch /api/lands/mine');

      // 3) Clicking Next land cycles back to Civic Plaza cleanly
      RTL.fireEvent.click(view.getByRole('button', { name: /Next land/i }));
      await RTL.waitFor(() => {
        assert.equal(
          view.getByTestId('land-mgmt-iso-preview').getAttribute('data-parcel-id'),
          'GLAND-9Q8YYK8Y'
        );
      });

      // 4) Open on Map triggers onFocusParcel with active parcel
      RTL.fireEvent.click(view.getByRole('button', { name: /Open on Map/i }));
      assert.deepEqual(focusedParcels, ['GLAND-9Q8YYK8Y']);
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('ProfileModal renders clean public banner with user number, username, icon & background and saves custom bio image + header', async () => {
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');
    const savedPayloads = [];
    const TINY_PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const mockData = {
      profile: {
        id: 'u42',
        userNumber: 42,
        userNumberLabel: '#0042',
        username: 'maya_neon',
        displayName: 'Maya Chen',
        bio: 'Sculpting neon plazas',
        picture: '',
        avatarImage: '',
        headerImage: 'preset:cyber-grid',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        accountType: 'human',
        joinedAt: '2026-11-01T00:00:00.000Z'
      },
      stats: { landCount: 0, sculptureCount: 0, activeListingCount: 0, actionCount: 0, totalBlocks: 0 },
      lands: [],
      sculptures: [],
      listings: [],
      actions: []
    };

    const view = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'maya_neon',
        user: { id: 'u42', userNumber: 42, username: 'maya_neon', name: 'Maya Chen' },
        fetchProfileFn: async () => mockData,
        checkUsernameFn: async (u) => ({ available: true, username: u, reason: `@${u} is available!` }),
        saveProfileFn: async (payload) => {
          savedPayloads.push(payload);
          return {
            ...mockData,
            user: {
              id: 'u42',
              userNumber: 42,
              username: payload.username,
              bio: payload.bio,
              avatarImage: payload.avatarImage || '',
              picture: payload.avatarImage || '',
              headerImage: payload.headerImage || ''
            },
            profile: {
              ...mockData.profile,
              username: payload.username,
              bio: payload.bio,
              avatarImage: payload.avatarImage || '',
              picture: payload.avatarImage || '',
              headerImage: payload.headerImage || ''
            }
          };
        },
        onClose: () => {}
      })
    );

    // 1) Public banner displays user number, @username, icon, and initial preset background
    await RTL.waitFor(() => {
      assert.equal(view.getByTestId('profile-user-number').textContent.trim(), 'USER #0042');
      assert.equal(view.getByTestId('profile-handle').textContent.trim(), '@maya_neon');
      assert.equal(
        view.getByTestId('public-profile-banner').getAttribute('data-header-preset'),
        'cyber-grid'
      );
    });

    // 2) Open Edit Profile, select Sunset Voxel header preset, and upload a PNG bio image
    RTL.fireEvent.click(view.getByTestId('profile-edit-btn'));
    RTL.fireEvent.click(view.getByRole('button', { name: /Header preset: Sunset Voxel/i }));
    assert.equal(
      view.getByTestId('public-profile-banner').getAttribute('data-header-preset'),
      'sunset-voxel'
    );

    // Enter a valid HTTPS bio image URL & check live avatar preview updates immediately
    RTL.fireEvent.change(view.getByLabelText('Bio image URL'), {
      target: { value: 'https://cdn.example.com/maya-avatar.png' }
    });
    assert.equal(
      view.getByTestId('profile-banner-avatar-img').getAttribute('src'),
      'https://cdn.example.com/maya-avatar.png'
    );

    // Also test uploading a real PNG file into the bio image input
    const pngBytes = Buffer.from(TINY_PNG.split(',')[1], 'base64');
    const avatarFile = new globalThis.window.File([pngBytes], 'avatar.png', { type: 'image/png' });
    await RTL.act(async () => {
      RTL.fireEvent.change(view.getByTestId('profile-avatar-file-input'), {
        target: { files: [avatarFile] }
      });
    });

    await RTL.waitFor(() => {
      assert.equal(view.getByTestId('profile-banner-avatar-img').getAttribute('src'), TINY_PNG);
    });

    // Save profile and verify payload includes avatarImage + headerImage
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('profile-save-btn'));
    });

    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0].avatarImage, TINY_PNG);
    assert.equal(savedPayloads[0].headerImage, 'preset:sunset-voxel');
    assert.equal(
      view.getByTestId('public-profile-banner').getAttribute('data-header-preset'),
      'sunset-voxel'
    );
    cleanup();
  });

  test('MobileMapSheet shows manage gear and inline click-to-rename title only for lands owned by the logged-in user', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const managedIds = [];
    const renamedCalls = [];

    const user = {
      id: 'google:owner-7',
      username: 'sky_artist',
      walletAddress: '0x1111111111111111111111111111111111111111'
    };
    const parcels = [
      {
        parcelId: 'GLAND-OWNED01',
        customName: 'Sunset Lot',
        description: 'My corner plaza',
        centerLat: 37.775,
        centerLng: -122.419,
        ownerSub: 'google:owner-7',
        stewardStatus: 'awakened',
        sculptureCount: 0
      },
      {
        parcelId: 'GLAND-OTHER02',
        customName: 'Stranger Park',
        description: 'Someone else owns this',
        centerLat: 37.776,
        centerLng: -122.419,
        ownerSub: 'google:someone-else',
        stewardStatus: 'awakened',
        sculptureCount: 0
      }
    ];

    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        user,
        ownedParcelIds: ['GLAND-OWNED01'],
        config: {},
        location: { lat: 37.775, lng: -122.419 },
        areaFilterMode: 'nearby',
        mapParcels: parcels,
        displayedMapSculptures: [],
        areaSculpturesSorted: [],
        onManageLand: (pid) => managedIds.push(pid),
        onRenameLand: async (land, nextName) => {
          renamedCalls.push({ parcelId: land.parcelId, nextName });
        },
        onShowHint: () => {},
        onClose: () => {}
      })
    );

    // Only the owned land renders the manage gear & clickable rename title
    const cards = view.getAllByTestId('mobile-land-card');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].getAttribute('data-owned'), 'true');
    assert.equal(cards[1].getAttribute('data-owned'), 'false');

    const gears = view.getAllByTestId('land-manage-gear-btn');
    assert.equal(gears.length, 1);
    RTL.fireEvent.click(gears[0]);
    assert.deepEqual(managedIds, ['GLAND-OWNED01']);

    const renameTriggers = view.getAllByTestId('land-title-edit-trigger');
    assert.equal(renameTriggers.length, 1);

    // Click title -> opens inline rename input, Escape cancels
    RTL.fireEvent.click(renameTriggers[0]);
    const input1 = view.getByLabelText('Rename land');
    assert.equal(input1.value, 'Sunset Lot');
    RTL.fireEvent.keyDown(input1, { key: 'Escape' });
    assert.equal(view.queryByTestId('land-inline-rename-form'), null);

    // Click title again -> type new name with :fire: emoji shortcode and save
    RTL.fireEvent.click(view.getByTestId('land-title-edit-trigger'));
    const input2 = view.getByLabelText('Rename land');
    RTL.fireEvent.change(input2, { target: { value: 'Neon Courtyard :fire:', selectionStart: 21 } });
    assert.equal(input2.value, 'Neon Courtyard 🔥');

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('land-inline-rename-save'));
    });

    assert.deepEqual(renamedCalls, [{ parcelId: 'GLAND-OWNED01', nextName: 'Neon Courtyard 🔥' }]);
    assert.equal(view.queryByTestId('land-inline-rename-form'), null);
    assert.ok(view.getByTestId('land-title-edit-trigger').textContent.includes('Neon Courtyard 🔥'));

    // Signed-out user sees NO gear and NO clickable rename trigger
    cleanup();
    const guestView = RTL.render(
      React.createElement(MobileMapSheet, {
        user: null,
        ownedParcelIds: [],
        config: {},
        location: { lat: 37.775, lng: -122.419 },
        areaFilterMode: 'nearby',
        mapParcels: parcels,
        displayedMapSculptures: [],
        areaSculpturesSorted: [],
        onManageLand: () => {},
        onClose: () => {}
      })
    );
    assert.equal(guestView.queryAllByTestId('land-manage-gear-btn').length, 0);
    assert.equal(guestView.queryAllByTestId('land-title-edit-trigger').length, 0);
    cleanup();
  });

  test('MobileMapSheet switches cleanly between 2D and 3D isometric map views and keeps all buttons working when Full Map is expanded', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const { default: MobileParcelVisitView } = await loadJsxModule(
      'client/src/components/studio/MobileParcelVisitView.jsx'
    );

    const parcels = [
      {
        parcelId: 'GLAND-9R16561P',
        customName: 'Magnolia Lot',
        centerLat: 39.738873,
        centerLng: -121.847904,
        stewardStatus: 'awakened',
        volume: {
          centerLat: 39.738873,
          centerLng: -121.847904,
          widthMeters: 2.82,
          depthMeters: 2.94,
          heightMeters: 1.92,
          footprintAreaSqM: 8.29
        }
      },
      {
        parcelId: 'GLAND-SECOND02',
        customName: 'Plaza Two',
        centerLat: 39.7392,
        centerLng: -121.8475,
        stewardStatus: 'awakened',
        volume: {
          centerLat: 39.7392,
          centerLng: -121.8475,
          widthMeters: 14,
          depthMeters: 14,
          heightMeters: 18,
          footprintAreaSqM: 196
        }
      }
    ];
    const sculptures = [
      {
        id: 'sc-mag-ui',
        title: 'Magnolia 👶',
        parcelId: 'GLAND-9R16561P',
        lat: 39.738873,
        lng: -121.847904,
        voxelCount: 268,
        voxels: [
          { x: -2.15, y: 0.45, z: 0.1, color: '#ff3e7f' },
          { x: 0.15, y: 2.0, z: 2.5, color: '#00f5d4' }
        ]
      }
    ];

    const selectedParcels = [];
    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        config: {},
        location: { lat: 39.7389, lng: -121.8479 },
        areaFilterMode: 'nearby',
        mapParcels: parcels,
        displayedMapSculptures: sculptures,
        areaSculpturesSorted: sculptures,
        onSelectParcel: (pid) => selectedParcels.push(pid),
        onShowHint: () => {},
        onClose: () => {}
      })
    );

    // 1) Compact dimensions show decimal precision for <10m fitted lands (2.8×2.9×1.9 m · 8.3 m²)
    assert.ok(view.container.textContent.includes('2.8×2.9×1.9 m · 8.3 m²'));

    // 2) Starts in 2D map with 3D toggle & Full Map buttons active
    assert.ok(view.getByTestId('mobile-map-3d-toggle-btn'));
    assert.equal(view.queryByTestId('mobile-iso-3d-map'), null);

    // 3) Clicking 3D switches to isometric 3D map with 2D toggle, 90° orbit, Fit, Me & Full buttons
    RTL.fireEvent.click(view.getByTestId('mobile-map-3d-toggle-btn'));
    assert.ok(view.getByTestId('mobile-iso-3d-map'));
    assert.ok(view.getByTestId('mobile-map-2d-toggle-btn'));
    assert.ok(view.getByTestId('mobile-map-orbit-btn'));
    assert.ok(view.getByTestId('mobile-map-fit-btn'));
    assert.ok(view.getByTestId('mobile-map-me-btn'));
    assert.ok(view.getByTestId('mobile-map-fullscreen-btn'));

    // Orbit 90° updates compass bearing cleanly
    const beforeOrbitText = view.getByTestId('mobile-iso-3d-map').textContent;
    RTL.fireEvent.click(view.getByTestId('mobile-map-orbit-btn'));
    const afterOrbitText = view.getByTestId('mobile-iso-3d-map').textContent;
    assert.notEqual(beforeOrbitText, afterOrbitText);

    // 4) Expand Full Map -> full-screen state keeps ALL 3D & 2D toggle buttons working!
    RTL.fireEvent.click(view.getByTestId('mobile-map-expand-header-btn'));
    assert.equal(view.getByTestId('mobile-map-canvas').getAttribute('data-map-expanded'), 'fullscreen');
    assert.ok(view.getByTestId('mobile-map-fullscreen-dock'));
    assert.equal(view.queryByTestId('mobile-nearest-lands-list'), null);

    // Switch 3D -> 2D WHILE full-screen expanded
    RTL.fireEvent.click(view.getByTestId('mobile-map-2d-toggle-btn'));
    assert.equal(view.queryByTestId('mobile-iso-3d-map'), null);
    assert.ok(view.getByTestId('mobile-map-3d-toggle-btn'));
    assert.equal(view.getByTestId('mobile-map-canvas').getAttribute('data-map-expanded'), 'fullscreen');

    // Switch 2D -> 3D WHILE still full-screen expanded
    RTL.fireEvent.click(view.getByTestId('mobile-map-3d-toggle-btn'));
    assert.ok(view.getByTestId('mobile-iso-3d-map'));
    assert.equal(view.getByTestId('mobile-map-canvas').getAttribute('data-map-expanded'), 'fullscreen');

    // Exit Full Map using the in-map ⤡ button -> list returns and 3D map stays active
    RTL.fireEvent.click(view.getByTestId('mobile-map-fullscreen-btn'));
    assert.equal(view.getByTestId('mobile-map-canvas').getAttribute('data-map-expanded'), 'compact');
    assert.ok(view.getByTestId('mobile-nearest-lands-list'));

    // Switch back to 2D, then click "3D Map" button on Land Card #2 -> jumps to 3D focused on Land #2
    RTL.fireEvent.click(view.getByTestId('mobile-map-2d-toggle-btn'));
    const card3dBtns = view.getAllByTestId('land-card-3d-map-btn');
    assert.equal(card3dBtns.length, 2);
    RTL.fireEvent.click(card3dBtns[1]);
    assert.ok(view.getByTestId('mobile-iso-3d-map'));
    assert.ok(selectedParcels.includes('GLAND-SECOND02'));
    cleanup();

    // 5) MobileParcelVisitView auto-opens in 3D isometric mode and supports full-screen + 2D <-> 3D toggle cleanly
    const visitView = RTL.render(
      React.createElement(MobileParcelVisitView, {
        parcel: parcels[0],
        sculptures,
        userLocation: { lat: 39.7389, lng: -121.8479 },
        onClose: () => {}
      })
    );
    assert.ok(visitView.getByTestId('mobile-iso-3d-map'));
    assert.ok(visitView.getByTestId('mobile-map-2d-toggle-btn'));
    RTL.fireEvent.click(visitView.getByTestId('mobile-map-fullscreen-btn'));
    assert.ok(visitView.getByTestId('mobile-map-2d-toggle-btn'));
    RTL.fireEvent.click(visitView.getByTestId('mobile-map-2d-toggle-btn'));
    assert.equal(visitView.queryByTestId('mobile-iso-3d-map'), null);
    assert.ok(visitView.getByTestId('mobile-map-3d-toggle-btn'));
    RTL.fireEvent.click(visitView.getByTestId('mobile-map-3d-toggle-btn'));
    assert.ok(visitView.getByTestId('mobile-iso-3d-map'));
    cleanup();
  });

  test('StudioHudTopBar shows On/Near Land pill on camera view and hides non-useful buttons while interacting with a land', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );

    const nearbyLand = {
      parcelId: 'GLAND-9R16561P',
      customName: 'Magnolia Lot',
      displayName: 'Magnolia Lot',
      description: 'Backyard voxel garden',
      centerLat: 39.738873,
      centerLng: -121.847904,
      edgeDistanceMeters: 0,
      distanceMeters: 0,
      isInside: true,
      isNear: true,
      isOwned: true,
      isFrozen: false,
      dimensionsLabel: '2.8×2.9×1.9 m · 8.3 m²',
      stewardUsername: 'bigdog',
      stewardType: 'human',
      humanContributorCount: 2,
      googleMapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=39.738873,-121.847904',
      expiration: { state: 'permanent', urgent: false, badgeText: 'Permanent', detailText: 'Permanent land' },
      sculptures: [
        { id: 'sc-mag', title: 'Magnolia 👶', voxelCount: 268, creatorName: 'BigDog' }
      ]
    };
    const secondLand = {
      ...nearbyLand,
      parcelId: 'GLAND-SECOND02',
      customName: 'Frozen Courtyard',
      displayName: 'Frozen Courtyard',
      isInside: false,
      isOwned: false,
      isFrozen: true,
      edgeDistanceMeters: 12,
      sculptures: []
    };

    const inspected = [];
    const exited = [];
    const baseProps = {
      user: { id: 'google:u1', name: 'BigDog', username: 'bigdog' },
      mode: 'draw',
      dockOpen: false,
      location: { lat: 39.738873, lng: -121.847904 },
      voxels: [],
      quickSculpt: false,
      hasOwnedLand: true,
      ownedLandCount: 1,
      cameraReady: true,
      originStatus: { originBlocked: false, reason: '' },
      sceneScan: { optimal: true },
      nearbyCount: 1,
      nearbyCameraLand: nearbyLand,
      nearbyCameraLandCount: 2,
      onInspectArLand: (l) => inspected.push(l.parcelId),
      onExitArLand: () => exited.push(true),
      onOpenAreaMap: () => {}
    };

    // 1) Initial camera drawing view: live On Land pill + normal HUD controls visible
    const view1 = RTL.render(
      React.createElement(StudioHudTopBar, { ...baseProps, isInteractingWithLand: false })
    );
    const pill = view1.getByTestId('ar-nearby-land-pill');
    assert.ok(pill.textContent.includes('On Land:'));
    assert.ok(pill.textContent.includes('Magnolia Lot'));
    assert.ok(view1.getByTestId('mobile-pair-hub-btn'));
    assert.ok(view1.getByLabelText('Open Nearest Lands Map'));
    RTL.fireEvent.click(pill);
    assert.deepEqual(inspected, ['GLAND-9R16561P']);
    cleanup();

    // 2) Interacting with land: non-useful buttons temporarily hidden; Back to Draw pill active
    const view2 = RTL.render(
      React.createElement(StudioHudTopBar, { ...baseProps, isInteractingWithLand: true })
    );
    assert.ok(view2.getByTestId('ar-land-exit-top-btn'));
    assert.equal(view2.queryByTestId('mobile-pair-hub-btn'), null);
    assert.equal(view2.queryByTestId('mobile-profile-btn'), null);
    assert.equal(view2.queryByLabelText('Open Nearest Lands Map'), null);
    assert.equal(view2.queryByLabelText('Info and Terms'), null);
    assert.equal(view2.queryByLabelText('Open Tutorial Guide'), null);
    assert.equal(view2.queryByLabelText('Land Management'), null);
    assert.equal(view2.queryByTestId('ar-nearby-land-pill'), null);
    RTL.fireEvent.click(view2.getByTestId('ar-land-exit-top-btn'));
    assert.equal(exited.length, 1);
    cleanup();

    // 3) ARLandInspectorPanel renders full details, inline rename for owner, sculptures & actions
    const calls = { draw: [], map3d: [], manage: [], rename: [], switched: [], closed: 0 };
    const panel = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: nearbyLand,
        nearbyLands: [nearbyLand, secondLand],
        onSelectNearbyLand: (l) => calls.switched.push(l.parcelId),
        onDrawHere: (l) => calls.draw.push(l.parcelId),
        onOpen3DMap: (l) => calls.map3d.push(l.parcelId),
        onManageLand: (pid) => calls.manage.push(pid),
        onRenameLand: async (l, name) => calls.rename.push({ parcelId: l.parcelId, name }),
        onShowHint: () => {},
        onClose: () => {
          calls.closed += 1;
        }
      })
    );
    assert.ok(panel.getByTestId('ar-land-inspector'));
    assert.ok(panel.getByTestId('ar-land-proximity-badge').textContent.includes('Inside Land'));
    assert.ok(panel.getByTestId('ar-land-owned-badge'));
    assert.ok(panel.getByTestId('ar-land-meta-chips').textContent.includes('2.8×2.9×1.9 m · 8.3 m²'));
    assert.equal(panel.getAllByTestId('ar-land-sculpture-row').length, 1);

    // Inline rename directly from camera view
    RTL.fireEvent.click(panel.getByTestId('ar-land-title-edit-trigger'));
    const renameInput = panel.getByLabelText('Rename land');
    RTL.fireEvent.change(renameInput, { target: { value: 'Secret Garden :sparkles:', selectionStart: 24 } });
    assert.equal(renameInput.value, 'Secret Garden ✨');
    await RTL.act(async () => {
      RTL.fireEvent.click(panel.getByTestId('ar-land-rename-save'));
    });
    assert.deepEqual(calls.rename, [{ parcelId: 'GLAND-9R16561P', name: 'Secret Garden ✨' }]);

    RTL.fireEvent.click(panel.getByTestId('ar-land-draw-btn'));
    RTL.fireEvent.click(panel.getByTestId('ar-land-3d-map-btn'));
    RTL.fireEvent.click(panel.getByTestId('ar-land-manage-btn'));
    RTL.fireEvent.click(panel.getByLabelText('Next nearby land'));
    RTL.fireEvent.click(panel.getByTestId('ar-land-close-btn'));
    assert.deepEqual(calls.draw, ['GLAND-9R16561P']);
    assert.deepEqual(calls.map3d, ['GLAND-9R16561P']);
    assert.deepEqual(calls.manage, ['GLAND-9R16561P']);
    assert.deepEqual(calls.switched, ['GLAND-SECOND02']);
    assert.equal(calls.closed, 1);
    cleanup();

    // 4) Frozen non-owned land hides Draw Here & Manage & inline rename cleanly
    const frozenPanel = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: secondLand,
        nearbyLands: [nearbyLand, secondLand],
        onDrawHere: () => {},
        onManageLand: () => {},
        onClose: () => {}
      })
    );
    assert.equal(frozenPanel.queryByTestId('ar-land-draw-btn'), null);
    assert.equal(frozenPanel.queryByTestId('ar-land-manage-btn'), null);
    assert.equal(frozenPanel.queryByTestId('ar-land-title-edit-trigger'), null);
    cleanup();
  });

  test('ProfileModal hides Gmail fallback picture, renders default GRAFFILAND icon, and shows quick + buttons on unset banner & bio image', async () => {
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');
    const mockData = {
      profile: {
        id: 'u-fresh',
        username: 'fresh_creator',
        displayName: 'Fresh Creator',
        bio: '',
        picture: 'https://lh3.googleusercontent.com/raw-gmail-photo.png',
        avatarImage: '',
        headerImage: '',
        userNumber: 77,
        userNumberLabel: '#0077',
        accountType: 'human',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        joinedAt: '2026-11-01T00:00:00Z'
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
      actions: []
    };

    const view = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'fresh_creator',
        user: { id: 'u-fresh', username: 'fresh_creator', name: 'Fresh Creator', userNumber: 77 },
        fetchProfileFn: async () => mockData,
        onClose: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('profile-default-avatar'));
    });
    // Must NEVER fall back to Gmail picture
    assert.equal(view.queryByTestId('profile-banner-avatar-img'), null);
    // Unset avatar & header show quick "+" buttons for owner
    const addBannerBtn = view.getByTestId('profile-add-header-btn');
    const addAvatarBtn = view.getByTestId('profile-add-avatar-btn');
    assert.ok(addBannerBtn);
    assert.ok(addAvatarBtn);

    // Clicking "+" on avatar enters profile edit mode directly
    RTL.fireEvent.click(addAvatarBtn);
    assert.ok(view.getByTestId('profile-edit-form'));
    cleanup();
  });

  test('NotificationCenter renders bell + badge, mint readiness banner, settings & browser push toggle', async () => {
    const { default: NotificationCenter } = await loadJsxModule(
      'client/src/components/NotificationCenter.jsx'
    );
    const origFetch = globalThis.fetch;
    const origNotification = globalThis.Notification;
    const savedPrefs = [];
    const sentNative = [];

    function MockNotification(title, opts) {
      sentNative.push({ title, opts });
    }
    MockNotification.permission = 'default';
    MockNotification.requestPermission = async () => {
      MockNotification.permission = 'granted';
      return 'granted';
    };
    globalThis.Notification = MockNotification;
    globalThis.window.Notification = MockNotification;

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/notifications/preferences') && opts.method === 'PATCH') {
        const body = JSON.parse(opts.body || '{}');
        savedPrefs.push(body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            preferences: {
              sculpture_on_land: true,
              mint_slots_unlocked: true,
              mint_limit_reached: true,
              land_expiring: true,
              land_activity: true,
              browser_push_enabled: false,
              ...body
            }
          })
        };
      }
      if (u.includes('/api/notifications/read') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ unreadCount: 0 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          unreadCount: 1,
          preferences: {
            sculpture_on_land: true,
            mint_slots_unlocked: true,
            mint_limit_reached: true,
            land_expiring: true,
            land_activity: true,
            browser_push_enabled: false
          },
          mintStatus: {
            usedSlots: 1,
            maxSlots: 3,
            remainingSlots: 2,
            canMintDesktop: true
          },
          notifications: [
            {
              id: 'n-1',
              category: 'sculpture_on_land',
              severity: 'info',
              title: '🎨 New sculpture on "Sunset Plaza"',
              message: 'Maya placed "Crystal Arch" on your land.',
              parcelId: 'GLAND-9Q8YYK9P',
              actionType: 'open_land',
              actionLabel: 'Inspect Land',
              read: false,
              createdAt: new Date().toISOString()
            }
          ]
        })
      };
    };

    try {
      const actions = [];
      const view = RTL.render(
        React.createElement(NotificationCenter, {
          user: { id: 'u-notif', name: 'Notif User' },
          variant: 'desktop',
          onAction: (item) => actions.push(item)
        })
      );

      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('notif-unread-badge').textContent, '1');
      });

      RTL.fireEvent.click(view.getByRole('button', { name: /Notifications/i }));
      assert.ok(view.getByText(/2\/3 free Desktop slots open/i));
      assert.ok(view.getByText(/New sculpture on "Sunset Plaza"/i));

      // Switch to Settings tab and enable Browser Notifications
      RTL.fireEvent.click(view.getByRole('tab', { name: /Settings/i }));
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByRole('button', { name: /Turn On/i }));
      });
      await RTL.waitFor(() => {
        assert.ok(savedPrefs.some((p) => p.browser_push_enabled === true));
      });
      assert.ok(sentNative.length >= 1, 'Expected browser confirmation notification');

      // Switch back to Inbox and trigger action
      RTL.fireEvent.click(view.getByRole('tab', { name: /Inbox/i }));
      RTL.fireEvent.click(view.getByRole('button', { name: /Inspect Land/i }));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].parcelId, 'GLAND-9Q8YYK9P');
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      globalThis.Notification = origNotification;
      globalThis.window.Notification = origNotification;
    }
  });

  test('Main swipe menu exposes Brush, Pencil & moved canvas features while bottom-right Palette configures block size & preset colors', async () => {
    const { KEY_TOOLS } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const { default: StudioDockDrawer } = await loadJsxModule(
      'client/src/components/studio/StudioDockDrawer.jsx'
    );

    const ids = KEY_TOOLS.map((t) => t.id);
    for (const requiredId of [
      'brush',
      'pencil',
      'stack',
      'erase',
      'undo',
      'clear',
      'transform',
      'recenter',
      'preview',
      'drafts',
      'occlusion',
      'pair',
      'agent',
      'publish'
    ]) {
      assert.ok(ids.includes(requiredId), `Expected "${requiredId}" in bottom-center KEY_TOOLS`);
    }

    const picked = { tool: 'brush', size: 1, color: '#00f5d4', material: 'matte', reach: 1.8 };
    let isOpen = false;
    const renderDrawer = () =>
      React.createElement(StudioDockDrawer, {
        dockOpen: isOpen,
        onToggleDock: () => {
          isOpen = !isOpen;
        },
        mode: 'draw',
        tool: picked.tool,
        onSelectDrawTool: (t) => {
          picked.tool = t;
        },
        blockSize: picked.size,
        setBlockSize: (s) => {
          picked.size = s;
        },
        color: picked.color,
        setColor: (c) => {
          picked.color = c;
        },
        material: picked.material,
        setMaterial: (m) => {
          picked.material = m;
        },
        reachMeters: picked.reach,
        setReachMeters: (r) => {
          picked.reach = r;
        }
      });

    const view = RTL.render(renderDrawer());
    assert.equal(view.queryByTestId('brush-options-popup'), null);
    RTL.fireEvent.click(view.getByTestId('palette-options-toggle'));
    view.rerender(renderDrawer());

    assert.ok(view.getByTestId('brush-options-popup'));
    RTL.fireEvent.click(view.getByTestId('palette-select-pencil'));
    RTL.fireEvent.click(view.getByTestId('block-size-xl'));
    RTL.fireEvent.click(view.getByRole('button', { name: 'Color Red' }));
    RTL.fireEvent.click(view.getByRole('button', { name: /Neon/i }));
    RTL.fireEvent.click(view.getByRole('button', { name: '2.4m' }));

    assert.equal(picked.tool, 'pencil');
    assert.equal(picked.size, 2);
    assert.equal(picked.color, '#ef4444');
    assert.equal(picked.material, 'neon');
    assert.equal(picked.reach, 2.4);
    cleanup();
  });

  test('MobileMapSheet and ProfileModal always render the owner latest land name and never expose internal GLAND codes', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const { default: ProfileModal } = await loadJsxModule(
      'client/src/components/ProfileModal.jsx'
    );

    const sheetView = RTL.render(
      React.createElement(MobileMapSheet, {
        user: { id: 'u-bigdog', name: 'BigDog', username: 'bigdog' },
        ownedParcelIds: ['GLAND-9R16561P'],
        location: { lat: 39.7388, lng: -121.8478 },
        areaFilterMode: 'nearby',
        mapParcels: [
          {
            parcelId: 'GLAND-9R16561P',
            customName: 'Twin Palms',
            centerLat: 39.7388,
            centerLng: -121.8478,
            ownerSub: 'u-bigdog',
            stewardUsername: 'bigdog',
            stewardStatus: 'awakened',
            sculptureCount: 1,
            volume: { widthMeters: 14, depthMeters: 14, heightMeters: 18, footprintAreaSqM: 196 }
          },
          {
            parcelId: 'GLAND-9R1652RD',
            customName: 'DRUGDEN',
            centerLat: 39.7283,
            centerLng: -121.8388,
            ownerSub: 'u-bigdog',
            stewardUsername: 'bigdog',
            stewardStatus: 'awakened',
            sculptureCount: 1,
            volume: { widthMeters: 67.7, depthMeters: 73.7, heightMeters: 100.2, footprintAreaSqM: 4989 }
          }
        ],
        displayedMapSculptures: [
          {
            id: 'sc-magnolia',
            title: 'Magnolia',
            parcelId: 'GLAND-9R16561P',
            parcelName: 'Twin Palms',
            landDisplayName: 'Twin Palms',
            lat: 39.73887,
            lng: -121.8479,
            voxelCount: 268,
            polScore: 97
          }
        ],
        onClose: () => {}
      })
    );

    assert.ok(sheetView.getByText('Twin Palms'));
    assert.ok(sheetView.getByText('DRUGDEN'));
    assert.equal(sheetView.queryByText(/GLAND-9R16561P/i), null);
    assert.equal(sheetView.queryByText(/GLAND-9R1652RD/i), null);
    assert.equal(sheetView.queryByText(/9R16561P/i), null);
    cleanup();

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/profiles/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              id: 'u-bigdog',
              userNumber: 7,
              userNumberLabel: '#0007',
              username: 'bigdog',
              displayName: 'BigDog',
              bio: 'Sculpting in 3D AR',
              picture: '',
              avatarImage: '',
              headerImage: '',
              accountType: 'human',
              stats: { landsCount: 1, sculpturesCount: 1, totalBlocks: 268, xp: 100 }
            },
            lands: [
              {
                parcelId: 'GLAND-9R16561P',
                customName: 'Twin Palms',
                displayName: 'Twin Palms',
                sculptureCount: 1,
                stewardStatus: 'awakened'
              }
            ],
            sculptures: [
              {
                id: 'sc-magnolia',
                title: 'Magnolia',
                parcelId: 'GLAND-9R16561P',
                parcelName: 'Twin Palms',
                landDisplayName: 'Twin Palms',
                voxelCount: 268,
                createdAt: '2026-11-21T00:00:00Z'
              }
            ],
            actions: []
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const profView = RTL.render(
        React.createElement(ProfileModal, {
          handle: 'bigdog',
          currentUser: null,
          onClose: () => {}
        })
      );
      await RTL.waitFor(() => {
        assert.ok(profView.getByText('Twin Palms'));
      });
      assert.equal(profView.queryByText(/GLAND-9R16561P/i), null);

      RTL.fireEvent.click(profView.getByRole('tab', { name: /Sculptures/i }));
      await RTL.waitFor(() => {
        assert.ok(profView.getByText('Magnolia'));
      });
      assert.ok(profView.getByText(/Twin Palms/i));
      assert.equal(profView.queryByText(/GLAND-9R16561P/i), null);
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('PlotVisitView auto-opens in isometric mode with clickable land & side artwork labels, expandable details, and logged-in management', async () => {
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');
    const parcel = {
      parcelId: 'GLAND-9R1652RD',
      customName: 'DRUGDEN',
      displayName: 'DRUGDEN',
      description: 'Isometric art plaza',
      ownerSub: 'google:owner-42',
      stewardUsername: 'bigdog',
      stewardType: 'human',
      stewardStatus: 'awakened',
      frozen: false,
      centerLat: 39.7388,
      centerLng: -121.8479,
      volume: {
        centerLat: 39.7388,
        centerLng: -121.8479,
        widthMeters: 14,
        depthMeters: 14,
        heightMeters: 18
      }
    };
    const sculptures = [
      {
        id: 'sc-tree-1',
        parcelId: 'GLAND-9R1652RD',
        title: 'Christmas Tree',
        description: 'Custom holiday GLB sculpture',
        modelType: 'custom-3d',
        customModel: { format: 'glb', sizeBytes: 120000 },
        creatorSub: 'google:owner-42',
        creatorName: '@bigdog',
        lat: 39.73881,
        lng: -121.84792,
        polScore: 98,
        createdAt: '2026-11-21T00:00:00Z'
      },
      {
        id: 'sc-mag-2',
        parcelId: 'GLAND-9R1652RD',
        title: 'Magnolia',
        description: 'Voxel garden bloom',
        voxelCount: 268,
        creatorSub: 'google:artist-9',
        creatorName: '@maya',
        lat: 39.73879,
        lng: -121.84788,
        polScore: 95,
        createdAt: '2026-11-21T00:00:00Z'
      }
    ];

    // 1) Logged-out desktop visitor: auto isometric mode, floating land + side artwork labels, expandable details, no management controls
    const guestView = RTL.render(
      React.createElement(PlotVisitView, {
        variant: 'desktop',
        parcel,
        sculptures,
        user: null,
        onRequestLogin: () => {},
        onSelectSculpture: () => {},
        onClose: () => {}
      })
    );
    assert.ok(guestView.getByTestId('desktop-plot-visit-view'));
    assert.ok(guestView.getByTestId('mobile-iso-3d-map'));
    assert.equal(guestView.getByTestId('mobile-iso-3d-map').getAttribute('data-map-mode'), '3d');
    assert.ok(guestView.getByTestId('plot-land-label'));
    const artworkCallouts = guestView.getAllByTestId('plot-artwork-label');
    assert.equal(artworkCallouts.length, 2);
    assert.equal(guestView.queryByText(/GLAND-9R1652RD/i), null);
    assert.ok(guestView.getByTestId('plot-signin-btn'));
    assert.equal(guestView.queryByTestId('plot-land-management'), null);
    assert.ok(guestView.getByTestId('plot-land-details'));

    // Click side artwork label -> expands that artwork's details below
    RTL.fireEvent.click(artworkCallouts[0]);
    assert.ok(guestView.getByTestId('plot-artwork-details'));
    assert.equal(guestView.queryByTestId('plot-artwork-management'), null);

    // Click floating Land Label -> switches cleanly back to Land details
    RTL.fireEvent.click(guestView.getByTestId('plot-land-label'));
    assert.ok(guestView.getByTestId('plot-land-details'));

    // Collapse and re-expand details drawer cleanly
    RTL.fireEvent.click(guestView.getByTestId('plot-details-toggle'));
    assert.equal(guestView.queryByTestId('plot-land-details'), null);
    RTL.fireEvent.click(guestView.getByTestId('plot-details-toggle'));
    assert.ok(guestView.getByTestId('plot-land-details'));
    cleanup();

    // 2) Logged-in land owner: sees Land Management + Artwork Management and can rename, freeze, edit, hide, and remove inline
    const origFetch = globalThis.fetch;
    const apiCalls = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      apiCalls.push({ url: u, method: opts.method || 'GET', body: opts.body });
      if (u.includes('/api/lands/GLAND-9R1652RD/update')) {
        const body = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            parcel: { ...parcel, customName: body.customName, displayName: body.customName, description: body.description }
          })
        };
      }
      if (u.includes('/api/lands/GLAND-9R1652RD/settings')) {
        const body = JSON.parse(opts.body || '{}');
        return { ok: true, status: 200, json: async () => ({ settings: { frozen: Boolean(body.frozen) } }) };
      }
      if (u.includes('/api/sculptures/sc-tree-1/visibility')) {
        const body = JSON.parse(opts.body || '{}');
        return { ok: true, status: 200, json: async () => ({ sculpture: { ...sculptures[0], hidden: Boolean(body.hidden) } }) };
      }
      if (u.includes('/api/sculptures/sc-tree-1') && opts.method === 'PUT') {
        const body = JSON.parse(opts.body || '{}');
        return { ok: true, status: 200, json: async () => ({ sculpture: { ...sculptures[0], title: body.title, description: body.description } }) };
      }
      if (u.includes('/api/sculptures/sc-tree-1') && opts.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    try {
      const updates = [];
      const ownerView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures,
          user: { id: 'google:owner-42', username: 'bigdog' },
          ownedParcelIds: ['GLAND-9R1652RD'],
          onOpenManageLand: () => {},
          onOpenAddLandItem: () => {},
          onSelectSculpture: () => {},
          onPlotUpdated: (payload) => updates.push(payload),
          onClose: () => {}
        })
      );

      assert.ok(ownerView.getByTestId('plot-owner-badge'));
      assert.ok(ownerView.getByTestId('plot-land-management'));

      // Rename land inline -> floating land label updates immediately
      RTL.fireEvent.click(ownerView.getByTestId('plot-land-edit-btn'));
      RTL.fireEvent.change(ownerView.getByLabelText('Edit land name'), {
        target: { value: 'Golden Plaza' }
      });
      await RTL.act(async () => {
        RTL.fireEvent.click(ownerView.getByTestId('plot-land-save-btn'));
      });
      await RTL.waitFor(() => {
        assert.ok(ownerView.getByTestId('plot-land-label').textContent.includes('Golden Plaza'));
      });

      // Freeze land inline
      await RTL.act(async () => {
        RTL.fireEvent.click(ownerView.getByTestId('plot-land-freeze-btn'));
      });
      await RTL.waitFor(() => {
        assert.ok(ownerView.getByText(/Unfreeze Land/i));
      });

      // Select artwork via side label -> Artwork Management appears -> Edit title, Hide, and Remove
      const treeLabel = ownerView
        .getAllByTestId('plot-artwork-label')
        .find((el) => el.getAttribute('data-sculpture-id') === 'sc-tree-1');
      assert.ok(treeLabel);
      RTL.fireEvent.click(treeLabel);
      assert.ok(ownerView.getByTestId('plot-artwork-management'));

      RTL.fireEvent.click(ownerView.getByTestId('plot-artwork-edit-btn'));
      RTL.fireEvent.change(ownerView.getByLabelText('Edit artwork title'), {
        target: { value: 'Winter Pine' }
      });
      await RTL.act(async () => {
        RTL.fireEvent.click(ownerView.getByTestId('plot-artwork-save-btn'));
      });
      await RTL.waitFor(() => {
        assert.ok(ownerView.getByTestId('plot-artwork-details').textContent.includes('Winter Pine'));
      });

      await RTL.act(async () => {
        RTL.fireEvent.click(ownerView.getByTestId('plot-artwork-visibility-btn'));
      });
      await RTL.waitFor(() => {
        assert.ok(ownerView.getByText(/Unhide Artwork/i));
      });

      RTL.fireEvent.click(ownerView.getByTestId('plot-artwork-remove-btn'));
      await RTL.act(async () => {
        RTL.fireEvent.click(ownerView.getByTestId('plot-artwork-confirm-remove-btn'));
      });
      await RTL.waitFor(() => {
        assert.ok(ownerView.getByTestId('plot-land-details'));
      });

      assert.ok(apiCalls.some((c) => c.url.includes('/update')));
      assert.ok(apiCalls.some((c) => c.url.includes('/settings')));
      assert.ok(apiCalls.some((c) => c.method === 'PUT' && c.url.includes('/sc-tree-1')));
      assert.ok(apiCalls.some((c) => c.url.includes('/visibility')));
      assert.ok(apiCalls.some((c) => c.method === 'DELETE' && c.url.includes('/sc-tree-1')));
      assert.ok(updates.length >= 5);
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('SculptureModal exposes Modify, Scale, Move & Remove studio for logged-in owners with live sibling push and bounds guard', async () => {
    const { default: SculptureModal } = await loadJsxModule('client/src/components/SculptureModal.jsx');
    const scTree = {
      id: 'sc-tree-modal',
      parcelId: 'GLAND-9R1652RD',
      parcelName: 'DRUGDEN',
      landDisplayName: 'DRUGDEN',
      title: 'Christmas Tree',
      description: 'Holiday centerpiece',
      creatorSub: 'google:owner-99',
      ownerAddress: '0x0000000000000000000000000000000000000099',
      recipientAddress: '0x0000000000000000000000000000000000000099',
      modelType: 'custom-3d',
      scale: 1,
      customModel: { format: 'glb', scale: 1, rotationY: 0 },
      meshStats: { bbox: { width: 2, height: 3, depth: 2 } },
      lat: 39.72836,
      lng: -121.83889,
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 1 },
      polScore: 95,
      currentRev: 1,
      chain: { chainName: 'Robinhood Chain Testnet', chainId: 46630, tokenId: '8', royaltyPercent: 5 },
      ipfs: { metadataUri: 'ipfs://QmMeta', gatewayUrl: '' },
      viewerIsLandOwner: true
    };
    const scGift = {
      id: 'sc-gift-sibling',
      parcelId: 'GLAND-9R1652RD',
      title: 'Wrapped Gift',
      modelType: 'custom-3d',
      scale: 1,
      customModel: { format: 'glb', scale: 1, rotationY: 0 },
      meshStats: { bbox: { width: 2, height: 2, depth: 2 } },
      lat: 39.72836,
      lng: -121.83889,
      anchorOffset: { dx: 2.3, dy: 0, dz: 0, yaw: 0, scale: 1 }
    };
    const parcelPayload = {
      parcel: {
        parcelId: 'GLAND-9R1652RD',
        customName: 'DRUGDEN',
        displayName: 'DRUGDEN',
        ownerSub: 'google:owner-99',
        volume: {
          centerLat: 39.72836,
          centerLng: -121.83889,
          widthMeters: 10,
          depthMeters: 10,
          heightMeters: 12,
          rotationDeg: 0
        }
      },
      sculptures: [scTree, scGift]
    };

    const origFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
      if (u.includes('/api/lands/GLAND-9R1652RD')) {
        return { ok: true, status: 200, json: async () => parcelPayload };
      }
      if (u.includes('/api/sculptures/sc-tree-modal') && opts.method === 'PUT') {
        const body = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sculpture: { ...scTree, title: body.title, scale: body.scale, anchorOffset: body.anchorOffset },
            pushedSiblings: [{ id: scGift.id, title: scGift.title, dx: 3.9, dy: 0, dz: 0 }]
          })
        };
      }
      if (u.includes('/api/sculptures/sc-tree-modal') && opts.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes('/api/sculptures/sc-tree-modal') && (!opts.method || opts.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ sculpture: scTree }) };
      }
      return { ok: true, status: 200, json: async () => ({ revisions: [] }) };
    };

    try {
      // 1) Logged-out guest sees Sign In bar and NO transform studio
      const guest = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: scTree,
          user: null,
          config: null,
          onRequestLogin: () => {},
          onClose: () => {}
        })
      );
      assert.ok(guest.getByTestId('sculpture-guest-signin-bar'));
      assert.equal(guest.queryByTestId('sculpture-transform-studio'), null);
      cleanup();

      // 2) Logged-in owner sees Modify/Scale/Move/Remove studio immediately below 3D viewer
      let deletedId = '';
      const owner = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: scTree,
          user: { id: 'google:owner-99', walletAddress: '0x0000000000000000000000000000000000000099' },
          config: null,
          onSculptureUpdated: () => {},
          onSculptureDeleted: (id) => {
            deletedId = id;
          },
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(owner.getByTestId('sculpture-transform-studio'));
        assert.ok(owner.getByText(/1 other placed item untouched/i));
      });

      // Scale up to 2.8x -> pushes Wrapped Gift gently inside bounds
      RTL.fireEvent.change(owner.getByTestId('sculpture-scale-input'), { target: { value: '2.8' } });
      await RTL.waitFor(() => {
        assert.ok(owner.getByTestId('sculpture-placement-status').textContent.includes('Wrapped Gift'));
      });

      // Oversize to 12x -> blocked cleanly & Fit Max Safe restores valid scale
      RTL.fireEvent.change(owner.getByTestId('sculpture-scale-input'), { target: { value: '12' } });
      await RTL.waitFor(() => {
        assert.ok(owner.getByTestId('sculpture-placement-blocked'));
      });
      assert.equal(owner.getByTestId('sculpture-save-transform-btn').disabled, true);
      RTL.fireEvent.click(owner.getByTestId('sculpture-fit-max-scale-btn'));
      await RTL.waitFor(() => {
        assert.equal(owner.queryByTestId('sculpture-placement-blocked'), null);
        assert.equal(owner.getByTestId('sculpture-save-transform-btn').disabled, false);
      });

      // Save artwork changes -> PUT /api/sculptures/sc-tree-modal includes scale & anchorOffset
      await RTL.act(async () => {
        RTL.fireEvent.click(owner.getByTestId('sculpture-save-transform-btn'));
      });
      const putCall = calls.find((c) => c.method === 'PUT' && c.url.includes('/sc-tree-modal'));
      assert.ok(putCall);
      const putPayload = JSON.parse(putCall.body);
      assert.ok(putPayload.scale > 1);
      assert.ok(putPayload.anchorOffset);

      // Two-step Remove Artwork -> calls DELETE and notifies parent
      RTL.fireEvent.click(owner.getByTestId('sculpture-remove-btn'));
      await RTL.act(async () => {
        RTL.fireEvent.click(owner.getByTestId('sculpture-confirm-remove-btn'));
      });
      await RTL.waitFor(() => {
        assert.equal(deletedId, 'sc-tree-modal');
      });
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('ProfileModal hides Google display names, renders user icon + @username, and pre-populates logged-in Username & Bio fields immediately', async () => {
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');
    const loggedInUser = {
      id: 'google:115933089146422565011',
      name: 'drawing "The Drawing Show" show',
      username: 'bigdog',
      bio: 'Sculpting giant voxel bros in Chico CA',
      avatarImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      userNumber: 1,
      walletAddress: '0x1111111111111111111111111111111111111111'
    };

    const view = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'bigdog',
        user: loggedInUser,
        initialEditing: true,
        fetchProfileFn: async () => ({
          profile: {
            id: loggedInUser.id,
            userNumber: 1,
            userNumberLabel: '#0001',
            username: 'bigdog',
            displayName: '@bigdog',
            bio: 'Sculpting giant voxel bros in Chico CA',
            avatarImage: loggedInUser.avatarImage,
            headerImage: '',
            walletAddress: loggedInUser.walletAddress,
            accountType: 'human',
            joinedAt: '2026-01-01T00:00:00Z'
          },
          stats: { landCount: 1, sculptureCount: 1, totalBlocks: 120, totalXp: 250 },
          lands: [],
          sculptures: [],
          listings: [],
          actions: []
        }),
        checkUsernameFn: async (u) => ({ available: true, username: u }),
        onClose: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('profile-edit-form'));
    });

    // Must NEVER expose Google first/last name anywhere in ProfileModal
    assert.ok(!view.container.textContent.includes('The Drawing Show'));
    assert.ok(view.container.textContent.includes('@bigdog'));
    // User icon renders beside username in header
    assert.ok(view.getByTestId('user-handle-badge').querySelector('img'));

    // Logged-in Username and Bio fields MUST be pre-populated immediately (never empty)
    const usernameField = view.getByLabelText('Username');
    const bioField = view.getByLabelText('Bio');
    assert.equal(usernameField.value, 'bigdog');
    assert.equal(bioField.value, 'Sculpting giant voxel bros in Chico CA');
    cleanup();
  });

  test('SculptureModal pins 3D model stage at top above scrollable modifiers, enables 3D gizmo bars & points, and pre-populates land curation note', async () => {
    const { default: SculptureModal } = await loadJsxModule('client/src/components/SculptureModal.jsx');
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sculptures/sc-sticky-1')) {
        return new Response(
          JSON.stringify({
            sculpture: {
              id: 'sc-sticky-1',
              title: 'Squiggle Bro',
              description: 'Neon voxel friend on 2nd St',
              creatorSub: 'google:owner-1',
              creatorUsername: 'bigdog',
              creatorName: '@bigdog',
              creatorAvatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              recipientAddress: '0x2222222222222222222222222222222222222222',
              parcelId: 'GLAND-9R1652WM',
              parcelName: 'Squiggle Bro Land',
              landDisplayName: 'Squiggle Bro Land',
              lat: 39.730204,
              lng: -121.840674,
              voxelCount: 4,
              voxels: [
                { x: -0.5, y: 0, z: -0.5, color: '#00f5d4' },
                { x: 0.5, y: 1.0, z: 0.5, color: '#ffd166' }
              ],
              scale: 1,
              anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0 },
              viewerCanContribute: true,
              viewerIsLandOwner: true,
              polScore: 98,
              chain: { tokenId: '1', simulated: true, chainName: 'Robinhood Chain Testnet' },
              ipfs: { metadataCid: 'bafy123', modelCid: 'bafy456' }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/api/lands/GLAND-9R1652WM')) {
        return new Response(
          JSON.stringify({
            parcel: {
              parcelId: 'GLAND-9R1652WM',
              customName: 'Squiggle Bro Land',
              displayName: 'Squiggle Bro Land',
              description: 'Chico downtown voxel corner',
              curationNote: 'Chico downtown voxel corner',
              volume: {
                parcelId: 'GLAND-9R1652WM',
                centerLat: 39.730204,
                centerLng: -121.840674,
                widthMeters: 6,
                depthMeters: 6,
                heightMeters: 8
              }
            },
            sculptures: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/revisions')) {
        return new Response(JSON.stringify({ revisions: [], currentRev: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const view = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: {
            id: 'sc-sticky-1',
            title: 'Squiggle Bro',
            description: 'Neon voxel friend on 2nd St',
            creatorSub: 'google:owner-1',
            creatorUsername: 'bigdog',
            creatorName: '@bigdog',
            recipientAddress: '0x2222222222222222222222222222222222222222',
            parcelId: 'GLAND-9R1652WM',
            parcelName: 'Squiggle Bro Land',
            lat: 39.730204,
            lng: -121.840674,
            voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
            viewerCanContribute: true,
            viewerIsLandOwner: true,
            chain: { tokenId: '1', simulated: true },
            ipfs: { metadataCid: 'bafy123' }
          },
          user: {
            id: 'google:owner-1',
            username: 'bigdog',
            name: 'Google Full Name Should Hide',
            walletAddress: '0x2222222222222222222222222222222222222222'
          },
          config: { chain: { network: { name: 'Robinhood Chain Testnet' } } },
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(view.getByTestId('sculpture-sticky-stage'));
        assert.ok(view.getByTestId('sculpture-scroll-body'));
        assert.ok(view.getByTestId('sculpture-gizmo-hud'));
      });

      // Sticky stage wraps the 3D viewer, separate from the scrollable modifier body below it
      const sticky = view.getByTestId('sculpture-sticky-stage');
      const scrollBody = view.getByTestId('sculpture-scroll-body');
      assert.ok(sticky.contains(view.getByTestId('sculpture-viewer-3d')));
      assert.ok(scrollBody.contains(view.getByTestId('sculpture-transform-studio')));
      assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-edit-gizmo'), 'on');
      assert.ok(view.getByTestId('sculpture-gizmo-hud').textContent.includes('Corners: Scale'));

      // Toggle 3D bars & points off and back on
      RTL.fireEvent.click(view.getByTestId('sculpture-gizmo-toggle'));
      assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-edit-gizmo'), 'off');
      RTL.fireEvent.click(view.getByTestId('sculpture-gizmo-toggle'));
      assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-edit-gizmo'), 'on');

      // Land curation name & description are pre-populated for logged-in land owner
      await RTL.waitFor(() => {
        const noteInput = view.getByPlaceholderText(/Land note or curator statement/i);
        assert.equal(noteInput.value, 'Chico downtown voxel corner');
      });

      // Never exposes Google full name; displays @bigdog with icon
      assert.ok(!view.container.textContent.includes('Google Full Name Should Hide'));
      assert.ok(sticky.textContent.includes('@bigdog'));
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('SculptureChatDrawer renders clean 3-tab navigation (Chat, Pinned, Access) with @username + user icon and never Google names', async () => {
    const { default: SculptureChatDrawer } = await loadJsxModule(
      'client/src/components/SculptureChatDrawer.jsx'
    );
    const view = RTL.render(
      React.createElement(SculptureChatDrawer, {
        sculpture: {
          id: 'sc-chat-ui-1',
          title: 'Squiggle Bro',
          description: 'Talk to visitors on 2nd St',
          creatorSub: 'google:owner-1',
          creatorUsername: 'bigdog',
          creatorName: '@bigdog',
          parcelId: 'GLAND-9R1652WM',
          parcelName: 'Squiggle Bro Land',
          distanceMeters: 4
        },
        user: null,
        initialPinData: {
          unlocked: true,
          pins: [
            {
              id: 'pin-1',
              text: 'Welcome to Squiggle Bro Land!',
              authorName: '@bigdog',
              authorUsername: 'bigdog'
            }
          ],
          meta: { hasPins: true, batchSeq: 1, ipfsCid: 'bafypin1234567890' }
        },
        onRequestLogin: () => {},
        onClose: () => {}
      })
    );

    assert.ok(view.getByTestId('sculpture-chat-drawer'));
    assert.ok(view.getByTestId('chat-tab-messages'));
    assert.ok(view.getByTestId('chat-tab-pins'));
    assert.ok(view.getByTestId('chat-tab-access'));
    assert.ok(view.container.textContent.includes('@bigdog'));

    // Navigate to Pinned tab and verify pinned note renders cleanly without cluttering main chat
    RTL.fireEvent.click(view.getByTestId('chat-tab-pins'));
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('chat-panel-pins'));
      assert.ok(view.getByTestId('chat-panel-pins').textContent.includes('Welcome to Squiggle Bro Land!'));
    });

    // Navigate to Access tab and verify security summary renders
    RTL.fireEvent.click(view.getByTestId('chat-tab-access'));
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('chat-panel-access'));
      assert.ok(view.getByTestId('chat-panel-access').textContent.includes('AES-256-GCM'));
    });

    cleanup();
  });
});
