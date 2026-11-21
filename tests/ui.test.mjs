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
          build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({
            contents: '',
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

  test('DesktopLandBuilderPanel renders limits, sliders, and multi-property agent export callbacks', async () => {
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

    const updates = [];
    const minted = [];
    const view = RTL.render(
      React.createElement(DesktopLandBuilderPanel, {
        draftParcels: [p1, p2],
        ownedParcels: [],
        selectedDraftId: 'draft-1',
        drawMode: false,
        onToggleDrawMode: () => {},
        onAddDraftAtCenter: () => {},
        onSelectDraft: () => {},
        onUpdateDraft: (id, patch) => updates.push({ id, patch }),
        onRemoveDraft: () => {},
        onClearDrafts: () => {},
        onMintDraft: (draft) => minted.push(draft.parcelId),
        onMintAll: () => {},
        cameraBearingDeg: 315,
        user: { id: 'u1', name: 'Land Creator' }
      })
    );

    const limitsCard = view.getByTestId('land-limits-card');
    assert.ok(limitsCard.textContent.includes('5,000 m²'));
    assert.ok(limitsCard.textContent.includes('500,000 m³'));
    assert.ok(limitsCard.textContent.includes('3 free human claims'));
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: 3D Land Limits & Rules/i }));
    assert.ok(view.getByRole('tooltip'));
    assert.ok(view.getByText(/AI agents pay own gas/i));

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

    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Copy All Properties for Agent/i }));
    });
    const previewBox = view.getByLabelText('Agent properties prompt preview');
    assert.ok(previewBox.value.includes('Total Selected Properties: 2'));
    assert.ok(previewBox.value.includes(p1.parcelId));
    assert.ok(previewBox.value.includes(p2.parcelId));
    assert.ok(previewBox.value.includes(JSON.stringify(p1.corners)));

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
    assert.ok(view.getByText(/slug=golden-gate-plaza/i));

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
    assert.ok(farView.getByText('Sunset Neon Courtyard'));
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
});
