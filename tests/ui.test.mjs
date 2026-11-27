import assert from 'node:assert/strict';
import fs from 'node:fs';
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

describe('SPRAY.LAND React UI Components (jsdom + Testing Library)', () => {
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

  test('FirstRunTutorialModal progresses steps without Simple/Quick Sculpt mode and passes dontShowAgain flag', async () => {
    const { default: FirstRunTutorialModal } = await loadJsxModule(
      'client/src/components/studio/FirstRunTutorialModal.jsx'
    );
    let closedWith = null;
    const view = RTL.render(
      React.createElement(FirstRunTutorialModal, {
        onClose: (dontShow) => {
          closedWith = dontShow;
        }
      })
    );

    assert.ok(view.getByTestId('brand-logo-lockup'));
    assert.equal(/welcome/i.test(view.container.textContent || ''), false);
    assert.equal(/quick sculpt|pro hud|simple studio/i.test(view.container.textContent || ''), false);
    assert.equal(Boolean(view.queryByRole('checkbox')), false);
    assert.ok(view.getByText(/1\. Aim & Lock Your Starting Surface/i));
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: Surface Scan & Anchor Details/i }));
    assert.ok(view.getByText(/Proof of Location locks your real-world spot/i));

    RTL.fireEvent.click(view.getByText(/Next Step/i));
    assert.ok(view.getByText(/2\. Sculpt 4x Blocks, Search 3D Items, or Hand Off to AI/i));

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

    assert.ok(view.getByTestId('brand-logo-lockup'));
    assert.ok(view.getByTestId('info-guide-tip-callout'));
    assert.ok(view.getByRole('tab', { name: /Desktop Map & 3D Land/i }));
    assert.ok(view.getByRole('tab', { name: /Mobile AR Studio/i }));
    assert.ok(view.getByTestId('info-guide-desktop'));
    assert.ok(view.getByText(/Draw, Shape & Mint 3D Land/i));
    assert.ok(view.getByText(/mint up to 21 free starter plots/i));
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: Map Camera, Zoom & Search/i }));
    assert.ok(view.getByText(/Fit Draft/i));
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
    assert.ok(view.getByTestId('brand-logo-lockup'));
    assert.ok(
      view.getByText(
        /Make art in 3D in the real world — make your own land and help develop others/i
      )
    );
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

  test('FirstVisitWelcomeOverlay shows SPRAY.LAND brand lockup with no Welcome, clear Human/AI copy, "i" info hint & magenta Quick Start', async () => {
    const { default: FirstVisitWelcomeOverlay } = await loadJsxModule(
      'client/src/components/FirstVisitWelcomeOverlay.jsx'
    );
    const exploreCalls = [];
    let agentConnected = false;
    const view = RTL.render(
      React.createElement(FirstVisitWelcomeOverlay, {
        isMobile: false,
        onExplore: (dontShow) => {
          exploreCalls.push(dontShow);
        },
        onConnectAgent: () => {
          agentConnected = true;
        }
      })
    );

    // Official Voxel Spray Can lockup logo, NO "Welcome" wording, crisp tagline + "i" hint + Human/AI notes
    assert.ok(view.getByTestId('brand-logo-lockup'));
    assert.ok(view.getByTestId('welcome-free-land-banner').textContent.includes('MINT FREE LAND by making art!'));
    assert.ok(
      view.getByTestId('welcome-hero-tagline').textContent.includes(
        'Make art in 3D in the real world — make your own land and help develop others.'
      )
    );
    assert.ok(
      view.getByTestId('welcome-info-hint').textContent.includes(
        'icon can give you info about how something works'
      )
    );
    assert.ok(view.getByText(/Make art on the land in person IRL, and invite others/i));
    assert.ok(view.getByText(/Invite your agents to add art to the land/i));
    assert.ok(view.getByTestId('welcome-step-1'));
    assert.ok(view.getByText(/Claim Free 3D Land/i));
    assert.ok(view.container.querySelector('.welcome-step-svg'));

    const initialVisibleText = view.container.textContent || '';
    for (const forbidden of [
      'Welcome',
      'welcome',
      'isometric',
      '.GLB',
      'voxel',
      'MCP',
      'EVM',
      '90% Seller',
      'Explore the Map'
    ]) {
      assert.equal(
        initialVisibleText.includes(forbidden),
        false,
        `Expected term "${forbidden}" to be hidden from main intro card`
      );
    }

    // Magenta Quick Start button replaces Explore the Map
    const quickStartBtn = view.getByTestId('welcome-quick-start-btn');
    assert.ok(quickStartBtn.textContent.includes('Quick Start'));
    assert.ok(quickStartBtn.className.includes('btn-magenta'));

    // Clicking the header "i" button reveals technical details & sale split
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: How SPRAY\.LAND Works/i }));
    assert.ok(view.getByRole('tooltip'));
    assert.ok(view.getByRole('tooltip').textContent.includes('90% Seller'));
    assert.ok(view.getByRole('tooltip').textContent.includes('graffiland-mcp'));
    assert.equal(exploreCalls.length, 0);

    // Click through all 3 illustrated walkthrough steps and verify Back works
    RTL.fireEvent.click(view.getByRole('button', { name: /Next Step \(2\/3\)/i }));
    assert.ok(view.getByTestId('welcome-step-2'));
    assert.ok(view.getByText(/Make Art — Mint Free Land/i));

    RTL.fireEvent.click(view.getByRole('button', { name: /Next Step \(3\/3\)/i }));
    assert.ok(view.getByTestId('welcome-step-3'));
    assert.ok(view.getByText(/Invite & Develop Together/i));

    RTL.fireEvent.click(view.getByRole('button', { name: /Back/i }));
    assert.ok(view.getByTestId('welcome-step-2'));
    assert.equal(exploreCalls.length, 0);

    assert.ok(view.getByText(/^For Humans$/i));
    assert.ok(view.getByText(/^For AI Agents$/i));

    // Clicking inside the card or opening a role "i" tooltip keeps the overlay open & shows extra details
    RTL.fireEvent.click(view.getByText(/^For Humans$/i));
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: How Humans Play/i }));
    assert.ok(view.getByRole('tooltip'));
    assert.ok(view.getByText(/21 free starter plots/i));
    assert.equal(exploreCalls.length, 0);

    // Starting a pointer press inside the card and releasing on the backdrop must NOT close it
    const backdrop = view.getByRole('dialog', { name: /SPRAY\.LAND first-visit overview/i });
    const cardEl = view.container.querySelector('.welcome-overlay-card');
    RTL.fireEvent.pointerDown(cardEl);
    RTL.fireEvent.click(backdrop);
    assert.equal(exploreCalls.length, 0);

    // Onboarding no longer shows "Don't show again" checkbox or Guide & Help button
    assert.equal(Boolean(view.queryByRole('checkbox')), false);
    assert.equal(Boolean(view.queryByRole('button', { name: /Guide & Help/i })), false);

    // Clicking genuinely on the backdrop dismisses and saves seen preference (true)
    RTL.fireEvent.pointerDown(backdrop);
    RTL.fireEvent.click(backdrop);
    assert.equal(exploreCalls.length, 1);
    assert.equal(exploreCalls[0], true);

    // Pressing Escape dismisses cleanly with true
    RTL.fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    assert.equal(exploreCalls.length, 2);
    assert.equal(exploreCalls[1], true);

    RTL.fireEvent.click(view.getByRole('button', { name: /Connect AI/i }));
    assert.equal(agentConnected, true);

    RTL.fireEvent.click(view.getByRole('button', { name: /Quick Start/i }));
    assert.equal(exploreCalls.length, 3);
    assert.equal(exploreCalls[2], true);
    cleanup();

    // Mobile onboarding omits Quick Camera Guide, Skip to Camera, Guide & Help, and Don't show again checkbox,
    // and finishes cleanly via Next Step -> Next Step -> Get Started
    const mobileExploreCalls = [];
    const mobileView = RTL.render(
      React.createElement(FirstVisitWelcomeOverlay, {
        isMobile: true,
        onExplore: (dontShow) => {
          mobileExploreCalls.push(dontShow);
        }
      })
    );
    assert.equal(Boolean(mobileView.queryByRole('checkbox')), false);
    assert.equal(Boolean(mobileView.queryByRole('button', { name: /Quick Camera Guide/i })), false);
    assert.equal(Boolean(mobileView.queryByRole('button', { name: /Skip to Camera/i })), false);
    assert.equal(Boolean(mobileView.queryByRole('button', { name: /Guide & Help/i })), false);
    RTL.fireEvent.click(mobileView.getByRole('button', { name: /Next Step \(2\/3\)/i }));
    RTL.fireEvent.click(mobileView.getByRole('button', { name: /Next Step \(3\/3\)/i }));
    const getStartedBtn = mobileView.getByTestId('welcome-get-started-btn');
    assert.ok(getStartedBtn.className.includes('btn-magenta'));
    RTL.fireEvent.click(getStartedBtn);
    assert.deepEqual(mobileExploreCalls, [true]);
    cleanup();
  });

  test('BrandLogo and web favicon/OG metadata use official Voxel Spray Can brand kit per BRAND.md', async () => {
    const { default: BrandLogo } = await loadJsxModule('client/src/components/BrandLogo.jsx');

    // Lockup default
    const lockupView = RTL.render(React.createElement(BrandLogo, { variant: 'lockup', height: 34 }));
    const lockupImg = lockupView.getByTestId('brand-logo-lockup');
    assert.equal(lockupImg.getAttribute('alt'), 'SPRAY.LAND');
    assert.equal(lockupImg.getAttribute('data-brand-asset'), 'lockup');
    assert.ok(String(lockupImg.getAttribute('src') || '').startsWith('data:image/svg+xml'));
    cleanup();

    // Mark <= 48px must automatically use simplified mark-small asset (per BRAND.md)
    const smallMarkView = RTL.render(React.createElement(BrandLogo, { variant: 'mark', size: 32, decorative: true }));
    const smallMarkImg = smallMarkView.getByTestId('brand-logo-mark');
    assert.equal(smallMarkImg.getAttribute('data-brand-asset'), 'mark-small');
    assert.equal(smallMarkImg.getAttribute('aria-hidden'), 'true');
    cleanup();

    // Mark > 48px uses full detail mark
    const largeMarkView = RTL.render(React.createElement(BrandLogo, { variant: 'mark', size: 64 }));
    const largeMarkImg = largeMarkView.getByTestId('brand-logo-mark');
    assert.equal(largeMarkImg.getAttribute('data-brand-asset'), 'mark');
    cleanup();

    // Stacked & wordmark variants
    const stackedView = RTL.render(React.createElement(BrandLogo, { variant: 'stacked', height: 88 }));
    assert.equal(stackedView.getByTestId('brand-logo-stacked').getAttribute('data-brand-asset'), 'stacked');
    cleanup();

    // Official favicon & OG social assets wired in client/index.html and present in client/public/
    const fs = await import('node:fs');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/favicon.svg"'));
    assert.ok(indexHtml.includes('href="/apple-touch-icon.png"'));
    assert.ok(indexHtml.includes('https://spray.land/og-image.png'));
    assert.equal(indexHtml.includes('rx=\'22\''), false, 'Old green pixel SVG favicon should be removed');

    for (const rel of [
      'client/public/favicon.svg',
      'client/public/favicon.ico',
      'client/public/favicon-32.png',
      'client/public/apple-touch-icon.png',
      'client/public/icon-512.png',
      'client/public/og-image.png'
    ]) {
      const stat = fs.statSync(path.join(ROOT, rel));
      assert.ok(stat.size > 200, `Expected non-empty brand asset at ${rel}`);
    }
  });

  test('DesktopLandBuilderPanel validates unique titles, compacts sliders, blocks pre-mint copy, shows post-mint copy tools & 21-free limit card without mobile callout buttons', async () => {
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
        mintLimitError: {
          usedSlots: 21,
          maxSlots: 21,
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
    assert.ok(limitsCard.textContent.includes('21 free human claims'));
    assert.equal(view.queryByRole('button', { name: /Copy Parcel Link/i }), null);
    assert.equal(view.queryByRole('button', { name: /🏷️ Title/i }), null);

    // 2) 21-free limit notification card renders with unbuilt land + "Want to claim land right now?" copy WITHOUT buttons
    const limitNotif = view.getByTestId('mint-limit-notification');
    assert.ok(limitNotif.textContent.includes('21/21'));
    assert.ok(limitNotif.textContent.includes('Want to claim land right now?'));
    assert.equal(view.queryByTestId('mint-limit-pair-mobile-btn'), null);
    assert.equal(view.queryByTestId('mint-limit-mobile-link'), null);
    assert.equal(view.queryByRole('button', { name: /Pair Phone via QR/i }), null);
    assert.equal(view.queryByRole('link', { name: /Open Mobile Studio/i }), null);

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

    // Agent prompt section is placed ABOVE the Add Manually fold-down, which starts collapsed
    const agentSection = view.getByTestId('add-item-agent-section');
    const manualSection = view.getByTestId('add-item-manual-section');
    const docOrder = agentSection.compareDocumentPosition(manualSection);
    assert.ok(
      Boolean(docOrder & globalThis.Node.DOCUMENT_POSITION_FOLLOWING),
      'Expected AI Agent Prompt section to render strictly above Add Manually fold-down'
    );
    const manualToggle = view.getByTestId('add-item-manual-toggle');
    assert.equal(manualToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(view.queryByTestId('add-item-manual-body'), null);

    // Pre-copy readiness validation strip is visible right away
    const copyValidation = view.getByTestId('add-item-copy-validation');
    assert.ok(copyValidation.textContent.includes('Land ID & 3D bounds'));
    assert.ok(copyValidation.textContent.includes('Pairing code included'));

    // Copy immediately from the top Agent Prompt card -> verified copy validation banner + button state
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByRole('button', { name: /Copy 3D Item Agent Prompt/i }));
    });
    assert.equal(copied.length, 1);
    assert.ok(copied[0].includes('GLP-1111-2222-3333-4444'));
    assert.ok(view.getByTestId('copy-validation-confirmed').textContent.includes('Copied & verified'));
    assert.ok(view.getByTestId('copy-agent-prompt-btn').textContent.includes('Copied to Clipboard'));

    // Expand the "Add Manually" fold-down -> reveals formats, title, URL validator & upload controls
    RTL.fireEvent.click(manualToggle);
    assert.equal(manualToggle.getAttribute('aria-expanded'), 'true');
    assert.ok(view.getByTestId('add-item-manual-body'));

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

    // Copy again after customizing title inside Add Manually -> prompt reflects custom title
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('copy-agent-prompt-btn'));
    });
    assert.equal(copied.length, 2);
    assert.ok(copied[1].includes('Neon Dragon Arch'));

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

      // Oversized model shows warning + optional one-click "Fit to Land" button (never silent autoscale)
      globalThis.fetch = async (url) => {
        if (String(url).includes('/api/models/validate-url')) {
          return {
            ok: true,
            json: async () => ({
              valid: true,
              format: 'glb',
              byteLength: 88000,
              stats: {
                triangleCount: 2400,
                bbox: { width: 40, height: 60, depth: 40 },
                bboxUnits: 'native-meters'
              },
              suggestedTitle: 'Giant Colossus',
              modelUrl: 'https://assets.example.com/giant-colossus.glb'
            })
          };
        }
        return { ok: true, json: async () => ({}) };
      };
      RTL.fireEvent.change(view.getByLabelText('3D Model URL'), {
        target: { value: 'https://assets.example.com/giant-colossus.glb' }
      });
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByRole('button', { name: /^Validate Link$/i }));
      });
      assert.ok(view.getByTestId('model-land-fit-warning'));
      const fitBtn = view.getByTestId('fit-model-to-land-btn');
      assert.ok(fitBtn.textContent.includes('Fit to Land'));
      RTL.fireEvent.click(fitBtn);
      assert.equal(view.queryByTestId('model-land-fit-warning'), null, 'Warning clears after user clicks Fit to Land');
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

    // 1) Far away -> details start hidden by default; expanding shows Navigate (with distance badge on left), View in AR & Make Art hidden
    const farView = RTL.render(
      React.createElement(MobileParcelVisitView, {
        parcel: baseParcel,
        sculptures: [{ id: 's1', title: 'Neon Spire', voxelCount: 24, lat: 37.7749, lng: -122.4194 }],
        userLocation: { lat: 37.81, lng: -122.42 },
        onClose: () => {}
      })
    );
    assert.equal(farView.queryByTestId('plot-land-details'), null);
    assert.ok(farView.getByTestId('plot-land-label-nav-btn'));
    RTL.fireEvent.click(farView.getByTestId('plot-details-toggle'));
    assert.ok(farView.getAllByText('Sunset Neon Courtyard').length >= 2);
    assert.ok(farView.getByText(/Sculpture park overlooking Market St/i));
    assert.ok(farView.getAllByRole('link', { name: /Navigate/i }).length >= 1);
    assert.equal(farView.queryByRole('button', { name: /View in AR/i }), null);
    assert.equal(farView.queryByRole('button', { name: /Make Art on This Property/i }), null);
    cleanup();

    // 2) Near + Open -> View in AR AND Make Art on This Property both shown once details expanded
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
    RTL.fireEvent.click(nearOpen.getByTestId('plot-details-toggle'));
    assert.ok(nearOpen.getByTestId('parcel-proximity-near'));
    RTL.fireEvent.click(nearOpen.getByRole('button', { name: /View in AR/i }));
    RTL.fireEvent.click(nearOpen.getByRole('button', { name: /Make Art on This Property/i }));
    assert.equal(viewedAr, true);
    assert.equal(madeArt, true);
    cleanup();

    // 3) Near + Frozen -> View in AR shown, Make Art hidden + frozen notice shown once details expanded
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
    RTL.fireEvent.click(nearFrozen.getByTestId('plot-details-toggle'));
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

    // Cards start compact/closed by default so multiple lands show inline, with Share on the right top
    assert.equal(cards[0].getAttribute('data-expanded'), 'false');
    assert.equal(cards[1].getAttribute('data-expanded'), 'false');
    assert.equal(view.queryByTestId('mobile-land-card-details'), null);
    assert.equal(view.getAllByTestId('land-card-share-btn').length, 2);

    // US coordinates (San Francisco) default to Imperial (ft / mi) in compact card header!
    const distBadges = view.getAllByTestId('land-distance-badge');
    assert.match(distBadges[0].textContent, /\b(ft|mi)\b/);
    assert.match(distBadges[1].textContent, /\b(ft|mi)\b/);

    // Expiration countdown renders ONLY for non-permanent lands (no redundant Permanent badge!)
    const expBadges = view.getAllByTestId('land-expiration-badge');
    assert.equal(expBadges.length, 1);
    assert.ok(expBadges[0].textContent.includes('1d 18h left'));
    assert.equal(view.queryByText(/Permanent/i), null);

    // Compact US imperial dimensions show once in the card header
    assert.ok(cards[0].querySelector('[data-testid="land-compact-meta"]').textContent.includes('79×52×118 ft'));

    // Clicking the card's #1 number focuses that land on the top map AND opens the card
    const rankBtns = view.getAllByTestId('land-card-rank-btn');
    assert.equal(rankBtns[0].textContent.trim(), '#1');
    RTL.fireEvent.click(rankBtns[0]);
    assert.deepEqual(focusedParcels, ['GLAND-NEAR']);
    assert.equal(cards[0].getAttribute('data-expanded'), 'true');
    assert.equal(cards[1].getAttribute('data-expanded'), 'false');
    assert.ok(view.getByTestId('land-expiration-detail').textContent.includes('2x First-Spark XP'));

    // Clicking the triangle on card #2 opens/closes card #2 separately WITHOUT changing map focus!
    const triangleBtns = view.getAllByTestId('land-card-expand-toggle');
    RTL.fireEvent.click(triangleBtns[1]);
    assert.equal(cards[1].getAttribute('data-expanded'), 'true');
    assert.deepEqual(focusedParcels, ['GLAND-NEAR']);

    // Land details show steward/quests/contributors without duplicating dimensions already shown in card header
    const card0Details = cards[0].querySelector('[data-testid="mobile-land-card-details"]');
    assert.equal(card0Details.textContent.includes('79×52×118 ft'), false);
    assert.ok(cards[0].textContent.includes('PainterBot'));
    assert.ok(cards[0].querySelector('[data-testid="user-handle-badge"]'));
    assert.ok(cards[0].textContent.includes('2 open quests'));
    assert.ok(cards[1].textContent.includes('3 contributors'));

    // Every expanded land card includes a Navigate link pointing to its Google Maps directions URL
    const gmapsLinks = view.getAllByTestId('land-google-maps-link');
    assert.equal(gmapsLinks.length, 2);
    assert.ok(gmapsLinks[0].textContent.includes('Navigate'));
    assert.equal(gmapsLinks[0].textContent.includes('Google Maps'), false);
    assert.ok(gmapsLinks[0].getAttribute('href').startsWith('https://www.google.com/maps/dir/?api=1&destination=37.775500'));
    assert.ok(gmapsLinks[1].getAttribute('href').startsWith('https://www.google.com/maps/dir/?api=1&destination=37.795500'));

    // Nested sculptures appear directly under GLAND-NEAR with full metadata
    const nestedItems = view.getAllByTestId('land-sculpture-item');
    assert.equal(nestedItems.length, 2);
    assert.ok(nestedItems[0].textContent.includes('Prism Arch'));
    assert.ok(nestedItems[0].textContent.includes('142 blocks'));
    assert.ok(nestedItems[0].textContent.includes('PoL 94'));
    assert.ok(nestedItems[1].textContent.includes('GLB 3D · 3,200 tris'));

    // Target land (Focus Map) button is removed; clicking property name when not logged in targets the land!
    assert.equal(view.queryByRole('button', { name: /Focus Map/i }), null);
    const nameTargetBtns = view.getAllByTestId('land-title-target-trigger');
    assert.equal(nameTargetBtns.length, 2);
    RTL.fireEvent.click(nameTargetBtns[1]);
    assert.deepEqual(focusedParcels, ['GLAND-NEAR', 'GLAND-FAR']);
    // Redundant explicit "3D" button is removed from artwork items; clicking the item window opens it directly
    assert.equal(RTL.within(nestedItems[0]).queryByRole('button', { name: /^\s*3D\s*$/i }), null);
    RTL.fireEvent.click(nestedItems[0]);
    assert.deepEqual(selectedSculptures, ['sc-voxel-1']);

    // Clicking triangle on card #2 again collapses it cleanly
    RTL.fireEvent.click(triangleBtns[1]);
    assert.equal(cards[1].getAttribute('data-expanded'), 'false');

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
      assert.match(view.getByTestId('land-preview-scale').textContent, /\b(ft|mi)\b/);

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

    // Signed-out user sees NO gear and NO rename trigger; clicking property name targets the land on the map
    cleanup();
    const guestTargeted = [];
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
        onSelectParcel: (pid) => guestTargeted.push(pid),
        onManageLand: () => {},
        onClose: () => {}
      })
    );
    assert.equal(guestView.queryAllByTestId('land-manage-gear-btn').length, 0);
    assert.equal(guestView.queryAllByTestId('land-title-edit-trigger').length, 0);
    const guestNameTargets = guestView.getAllByTestId('land-title-target-trigger');
    assert.equal(guestNameTargets.length, 2);
    RTL.fireEvent.click(guestNameTargets[1]);
    assert.deepEqual(guestTargeted, ['GLAND-OTHER02']);
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

    // 1) Compact dimensions show once in the card header (9.3×9.6×6.3 ft) and are not duplicated inside expanded details
    assert.ok(view.container.textContent.includes('9.3×9.6×6.3 ft'));
    const toggleBtns = view.getAllByTestId('land-card-expand-toggle');
    RTL.fireEvent.click(toggleBtns[0]);
    assert.equal(
      view.getByTestId('mobile-land-card-details').textContent.includes('9.3×9.6×6.3 ft'),
      false
    );

    // 2) Defaults to 3D isometric map immediately with 2D toggle, 90° orbit, Fit, Me & Full buttons
    assert.ok(view.getByTestId('mobile-iso-3d-map'));
    assert.ok(view.getByTestId('mobile-map-2d-toggle-btn'));
    assert.equal(view.queryByTestId('mobile-map-3d-toggle-btn'), null);
    assert.ok(view.getByTestId('mobile-map-orbit-btn'));
    assert.ok(view.getByTestId('mobile-map-fit-btn'));
    assert.ok(view.getByTestId('mobile-map-me-btn'));
    assert.ok(view.getByTestId('mobile-map-fullscreen-btn'));

    // 3) Switching 3D -> 2D -> 3D toggles cleanly in compact mode
    RTL.fireEvent.click(view.getByTestId('mobile-map-2d-toggle-btn'));
    assert.equal(view.queryByTestId('mobile-iso-3d-map'), null);
    assert.ok(view.getByTestId('mobile-map-3d-toggle-btn'));
    RTL.fireEvent.click(view.getByTestId('mobile-map-3d-toggle-btn'));
    assert.ok(view.getByTestId('mobile-iso-3d-map'));
    assert.ok(view.getByTestId('mobile-map-2d-toggle-btn'));

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

    // Switch back to 2D, expand Card #2 via triangle -> redundant per-item "3D Map" button is removed on all expanded cards!
    RTL.fireEvent.click(view.getByTestId('mobile-map-2d-toggle-btn'));
    const reopenedToggles = view.getAllByTestId('land-card-expand-toggle');
    RTL.fireEvent.click(reopenedToggles[1]);
    assert.equal(view.queryAllByTestId('land-card-3d-map-btn').length, 0);
    // Selecting Card #2 via its rank badge and toggling the map's 3D button still focuses Land #2 in 3D
    const rankBtns = view.getAllByTestId('land-card-rank-btn');
    RTL.fireEvent.click(rankBtns[1]);
    RTL.fireEvent.click(view.getByTestId('mobile-map-3d-toggle-btn'));
    assert.ok(view.getByTestId('mobile-iso-3d-map'));
    assert.ok(selectedParcels.includes('GLAND-SECOND02'));
    cleanup();

    // 4b) Explicit initialDimensionMode="2d" override still opens in 2D cleanly
    const explicit2dView = RTL.render(
      React.createElement(MobileMapSheet, {
        config: {},
        location: { lat: 39.7389, lng: -121.8479 },
        areaFilterMode: 'nearby',
        initialDimensionMode: '2d',
        mapParcels: parcels,
        displayedMapSculptures: sculptures,
        areaSculpturesSorted: sculptures,
        onSelectParcel: () => {},
        onShowHint: () => {},
        onClose: () => {}
      })
    );
    assert.ok(explicit2dView.getByTestId('mobile-map-3d-toggle-btn'));
    assert.equal(explicit2dView.queryByTestId('mobile-iso-3d-map'), null);
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

    // 1) Initial camera drawing view inside an existing land: shows unmistakable "Adding Art to:" label at top
    const view1 = RTL.render(
      React.createElement(StudioHudTopBar, { ...baseProps, isInteractingWithLand: false })
    );
    const pill = view1.getByTestId('ar-nearby-land-pill');
    assert.ok(pill.textContent.includes('Adding Art to:'));
    assert.ok(pill.textContent.includes('Magnolia Lot'));
    assert.equal(pill.getAttribute('data-adding-to-land'), 'true');
    assert.ok(view1.getByTestId('mobile-pair-hub-btn'));
    assert.ok(view1.getByLabelText('Open Nearest Lands Map'));
    RTL.fireEvent.click(pill);
    assert.deepEqual(inspected, ['GLAND-9R16561P']);
    cleanup();

    // 1b) In preview mode inside the same land, pill reads "On Land:"
    const view1Preview = RTL.render(
      React.createElement(StudioHudTopBar, {
        ...baseProps,
        mode: 'preview',
        isInteractingWithLand: false
      })
    );
    const previewPill = view1Preview.getByTestId('ar-nearby-land-pill');
    assert.ok(previewPill.textContent.includes('On Land:'));
    assert.ok(previewPill.textContent.includes('Magnolia Lot'));
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

  test('ProfileModal hides Gmail fallback picture, renders default SPRAY.LAND icon, and shows quick + buttons on unset banner & bio image', async () => {
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
      assert.equal(Boolean(view.queryByText(/free Desktop slots open/i)), false);
      assert.equal(Boolean(view.queryByTestId('notif-mint-land-btn')), false);
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
      React.createElement(
        'div',
        null,
        React.createElement('div', { 'data-testid': 'outside-studio-area' }, 'AR viewport'),
        React.createElement(StudioDockDrawer, {
          dockOpen: isOpen,
          onToggleDock: () => {
            isOpen = !isOpen;
          },
          onCloseDock: () => {
            isOpen = false;
          },
          tool: picked.tool,
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
        })
      );

    const view = RTL.render(renderDrawer());
    assert.equal(view.queryByTestId('brush-options-popup'), null);
    RTL.fireEvent.click(view.getByTestId('palette-options-toggle'));
    view.rerender(renderDrawer());

    assert.ok(view.getByTestId('brush-options-popup'));
    // Brush, Pencil, and Eraser options live strictly in center bottom KEY_TOOLS, never inside the palette
    assert.equal(view.queryByTestId('palette-select-brush'), null);
    assert.equal(view.queryByTestId('palette-select-pencil'), null);
    assert.equal(view.queryByTestId('palette-select-erase'), null);

    RTL.fireEvent.click(view.getByTestId('block-size-xl'));
    RTL.fireEvent.click(view.getByRole('button', { name: 'Color Red' }));
    RTL.fireEvent.click(view.getByRole('button', { name: /Neon/i }));
    RTL.fireEvent.click(view.getByRole('button', { name: '2.4m' }));

    assert.equal(picked.size, 2);
    assert.equal(picked.color, '#ef4444');
    assert.equal(picked.material, 'neon');
    assert.equal(picked.reach, 2.4);

    // Clicking off the Paint & Brush Kit minimizes it cleanly back to its icon
    RTL.fireEvent.mouseDown(view.getByTestId('outside-studio-area'));
    view.rerender(renderDrawer());
    assert.equal(isOpen, false);
    assert.equal(view.queryByTestId('brush-options-popup'), null);
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

    assert.ok(sheetView.getAllByText('Twin Palms').length >= 1);
    assert.ok(sheetView.getAllByText('DRUGDEN').length >= 1);
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
    assert.ok(guestView.getByTestId('plot-land-label-nav-btn'));
    const artworkCallouts = guestView.getAllByTestId('plot-artwork-label');
    assert.equal(artworkCallouts.length, 2);
    assert.equal(guestView.queryByText(/GLAND-9R1652RD/i), null);
    // Details are hidden by default until user clicks Show Details
    assert.equal(guestView.queryByTestId('plot-land-details'), null);
    RTL.fireEvent.click(guestView.getByTestId('plot-details-toggle'));
    assert.ok(guestView.getByTestId('plot-signin-btn'));
    assert.equal(guestView.queryByTestId('plot-land-management'), null);
    assert.ok(guestView.getByTestId('plot-land-details'));
    assert.equal(guestView.queryByText(/Copy Share Link/i), null);

    // Click side artwork label -> selects artwork, centers isometrically, and updates expanded details
    RTL.fireEvent.click(artworkCallouts[0]);
    assert.ok(guestView.getByTestId('plot-artwork-details'));
    assert.equal(guestView.queryByTestId('plot-artwork-management'), null);

    // Click floating Land Label -> re-centers land isometrically and switches cleanly back to Land details
    RTL.fireEvent.click(guestView.getByTestId('plot-land-label'));
    assert.ok(guestView.getByTestId('plot-land-details'));

    // Collapse and re-expand details drawer cleanly
    RTL.fireEvent.click(guestView.getByTestId('plot-details-toggle'));
    assert.equal(guestView.queryByTestId('plot-land-details'), null);
    RTL.fireEvent.click(guestView.getByTestId('plot-details-toggle'));
    assert.ok(guestView.getByTestId('plot-land-details'));
    cleanup();

    // 1b) Freshly minted land WITHOUT items shows explicit "Copy Link" directly on the floating land label
    const copiedEmptyLinks = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          copiedEmptyLinks.push(text);
        }
      },
      configurable: true
    });
    const emptyLandView = RTL.render(
      React.createElement(PlotVisitView, {
        variant: 'desktop',
        parcel: { ...parcel, customName: 'VOYAGE', sculptureCount: 0 },
        sculptures: [],
        user: null,
        onRequestLogin: () => {},
        onSelectSculpture: () => {},
        onClose: () => {}
      })
    );
    const labelCopyBtn = emptyLandView.getByTestId('plot-land-label-copy-btn');
    assert.ok(
      labelCopyBtn.textContent.includes('Copy Link'),
      `Expected empty minted land top label to show Copy Link button, got: ${labelCopyBtn.textContent}`
    );
    await RTL.act(async () => {
      RTL.fireEvent.click(labelCopyBtn);
    });
    assert.equal(copiedEmptyLinks.length, 1);
    assert.ok(
      copiedEmptyLinks[0].includes('voyage') || copiedEmptyLinks[0].includes('GLAND-9R1652RD'),
      `Expected copied share URL to point to the parcel, got: ${copiedEmptyLinks[0]}`
    );
    assert.ok(
      labelCopyBtn.textContent.includes('Copied'),
      `Expected label copy button to show Copied confirmation, got: ${labelCopyBtn.textContent}`
    );
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

      RTL.fireEvent.click(ownerView.getByTestId('plot-details-toggle'));
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

  test('LandIsometricPreview & MobileIsometricMap render clickable directional edge-arrow labels for selectable neighboring lands without showing other lands wireframes', async () => {
    const { default: LandIsometricPreview } = await loadJsxModule(
      'client/src/components/LandIsometricPreview.jsx'
    );
    const { default: MobileIsometricMap } = await loadJsxModule(
      'client/src/components/studio/MobileIsometricMap.jsx'
    );

    const squiggleLand = {
      parcelId: 'GLAND-9R1652WM',
      customName: 'Squiggle Bro Land',
      geohash: '9r1652wm',
      centerLat: 39.7302,
      centerLng: -121.84067,
      volume: {
        parcelId: 'GLAND-9R1652WM',
        centerLat: 39.7302,
        centerLng: -121.84067,
        widthMeters: 5,
        depthMeters: 2.3,
        heightMeters: 2,
        rotationDeg: 0
      },
      sculptures: []
    };
    const twinPalms = {
      parcelId: 'GLAND-TWINPALM',
      customName: 'Twin Palms',
      geohash: '9r1652wp',
      centerLat: 39.73032,
      centerLng: -121.84023,
      volume: {
        parcelId: 'GLAND-TWINPALM',
        centerLat: 39.73032,
        centerLng: -121.84023,
        widthMeters: 12,
        depthMeters: 10,
        heightMeters: 8,
        rotationDeg: 0
      },
      sculptures: []
    };
    const drugden = {
      parcelId: 'GLAND-DRUGDEN1',
      customName: 'DRUGDEN',
      geohash: '9r1652w9',
      centerLat: 39.7296,
      centerLng: -121.8414,
      volume: {
        parcelId: 'GLAND-DRUGDEN1',
        centerLat: 39.7296,
        centerLng: -121.8414,
        widthMeters: 10,
        depthMeters: 10,
        heightMeters: 6,
        rotationDeg: 0
      },
      sculptures: []
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ shortLabel: '112 W 2nd St, Chico, CA' })
    });

    try {
      // 1) LandIsometricPreview shows clickable directional edge-arrow pills for neighboring lands
      let selectedInPreview = null;
      const preview = RTL.render(
        React.createElement(LandIsometricPreview, {
          parcel: squiggleLand,
          allParcels: [squiggleLand, twinPalms, drugden],
          onSelectParcel: (p) => {
            selectedInPreview = p;
          }
        })
      );

      await RTL.waitFor(() => {
        const arrows = preview.getAllByTestId('neighbor-edge-arrow');
        assert.equal(arrows.length, 2, 'Expected 2 neighbor edge-arrow labels');
      });

      const twinArrow = preview
        .getAllByTestId('neighbor-edge-arrow')
        .find((el) => el.getAttribute('data-parcel-id') === 'GLAND-TWINPALM');
      assert.ok(twinArrow, 'Expected edge-arrow button pointing to Twin Palms');
      assert.ok(twinArrow.textContent.includes('Twin Palms'));
      assert.ok(['left', 'right', 'top', 'bottom'].includes(twinArrow.getAttribute('data-edge-side')));
      assert.ok(twinArrow.querySelector('svg.neighbor-edge-arrow-svg'));

      RTL.fireEvent.click(twinArrow);
      assert.equal(selectedInPreview?.parcelId, 'GLAND-TWINPALM');
      cleanup();

      // 2) MobileIsometricMap shows clickable directional edge-arrow labels for neighboring lands
      let selectedInMobile = null;
      const mobileIso = RTL.render(
        React.createElement(MobileIsometricMap, {
          parcels: [squiggleLand, twinPalms, drugden],
          sculptures: [],
          selectedParcelId: 'GLAND-9R1652WM',
          onSelectParcel: (p) => {
            selectedInMobile = p;
          }
        })
      );

      await RTL.waitFor(() => {
        const arrows = mobileIso.getAllByTestId('neighbor-edge-arrow');
        assert.ok(arrows.length >= 1, 'Expected neighbor edge arrows on MobileIsometricMap');
      });

      const mobileTwinArrow = mobileIso
        .getAllByTestId('neighbor-edge-arrow')
        .find((el) => el.getAttribute('data-parcel-id') === 'GLAND-TWINPALM');
      assert.ok(mobileTwinArrow, 'Expected Twin Palms edge arrow on MobileIsometricMap');
      RTL.fireEvent.click(mobileTwinArrow);
      assert.equal(selectedInMobile?.parcelId, 'GLAND-TWINPALM');
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Desktop NeighborEdgeArrowsOverlay draws same-color leader lines for on-screen tags and keeps off-screen land/sculpture tags clickable on edges', async () => {
    const { default: NeighborEdgeArrowsOverlay } = await loadJsxModule(
      'client/src/components/NeighborEdgeArrowsOverlay.jsx'
    );

    const onScreenParcel = { parcelId: 'GLAND-ONSCREEN', customName: 'Plaza East' };
    const offScreenParcel = { parcelId: 'GLAND-OFFSCREEN', customName: 'West Annex' };
    const onScreenSc = { id: 'sc-on-9', title: 'Holo Fox' };
    const offScreenSc = { id: 'sc-off-9', title: 'Sky Totem' };

    const items = [
      {
        id: 'land:GLAND-ONSCREEN',
        kind: 'land',
        parcelId: 'GLAND-ONSCREEN',
        parcel: onScreenParcel,
        sculptureId: '',
        sculpture: null,
        label: 'Plaza East',
        fullLabel: 'Plaza East',
        distanceLabel: '42m',
        x: 610,
        y: 185,
        width: 112,
        height: 28,
        side: 'on-screen',
        placement: 'on-screen',
        arrowDeg: 90,
        targetX: 610,
        targetY: 235,
        fromX: 610,
        fromY: 199,
        accentColor: '#ffb703',
        dotColor: '#fff3c4',
        textColor: '#fff3c4'
      },
      {
        id: 'sculpture:sc-on-9',
        kind: 'sculpture',
        parcelId: '',
        parcel: null,
        sculptureId: 'sc-on-9',
        sculpture: onScreenSc,
        label: 'Holo Fox',
        fullLabel: 'Holo Fox',
        distanceLabel: '18m',
        x: 340,
        y: 260,
        width: 108,
        height: 28,
        side: 'on-screen',
        placement: 'on-screen',
        arrowDeg: 90,
        targetX: 340,
        targetY: 310,
        fromX: 340,
        fromY: 274,
        accentColor: '#00f5d4',
        dotColor: '#eafffc',
        textColor: '#d9fff9'
      },
      {
        id: 'land:GLAND-OFFSCREEN',
        kind: 'land',
        parcelId: 'GLAND-OFFSCREEN',
        parcel: offScreenParcel,
        sculptureId: '',
        sculpture: null,
        label: 'West Annex',
        fullLabel: 'West Annex',
        distanceLabel: '210m',
        x: 60,
        y: 240,
        edgeInsetX: 6,
        width: 118,
        height: 28,
        side: 'left',
        placement: 'edge',
        arrowDeg: 180,
        targetX: null,
        targetY: null,
        fromX: null,
        fromY: null,
        accentColor: '#7dd3fc',
        dotColor: '#e0f2fe',
        textColor: '#e0f2fe'
      },
      {
        id: 'sculpture:sc-off-9',
        kind: 'sculpture',
        parcelId: '',
        parcel: null,
        sculptureId: 'sc-off-9',
        sculpture: offScreenSc,
        label: 'Sky Totem',
        fullLabel: 'Sky Totem',
        distanceLabel: '95m',
        x: 840,
        y: 200,
        edgeInsetX: 6,
        width: 110,
        height: 28,
        side: 'right',
        placement: 'edge',
        arrowDeg: 0,
        targetX: null,
        targetY: null,
        fromX: null,
        fromY: null,
        accentColor: '#00f5d4',
        dotColor: '#eafffc',
        textColor: '#d9fff9'
      }
    ];

    const pickedParcels = [];
    const pickedSculptures = [];
    const view = RTL.render(
      React.createElement(NeighborEdgeArrowsOverlay, {
        arrows: items,
        viewportWidth: 900,
        viewportHeight: 520,
        onSelectParcel: (p) => pickedParcels.push(p.parcelId),
        onSelectSculpture: (s) => pickedSculptures.push(s.id)
      })
    );

    try {
      const leaders = view.getAllByTestId('neighbor-tag-leader-line');
      assert.equal(leaders.length, 2, 'Only the 2 on-screen tags should render SVG leader lines');

      const landLeader = leaders.find((el) => el.getAttribute('data-parcel-id') === 'GLAND-ONSCREEN');
      const scLeader = leaders.find((el) => el.getAttribute('data-sculpture-id') === 'sc-on-9');
      assert.ok(landLeader && scLeader);

      const allBtns = view.getAllByTestId('neighbor-edge-arrow');
      assert.equal(allBtns.length, 4);

      const onLandBtn = allBtns.find((el) => el.getAttribute('data-parcel-id') === 'GLAND-ONSCREEN');
      const onScBtn = allBtns.find((el) => el.getAttribute('data-sculpture-id') === 'sc-on-9');
      const offLandBtn = allBtns.find((el) => el.getAttribute('data-parcel-id') === 'GLAND-OFFSCREEN');
      const offScBtn = allBtns.find((el) => el.getAttribute('data-sculpture-id') === 'sc-off-9');

      // Exact same color between tag and its pointer line
      assert.equal(onLandBtn.getAttribute('data-placement'), 'on-screen');
      assert.equal(onLandBtn.getAttribute('data-tag-color'), '#ffb703');
      assert.equal(landLeader.getAttribute('data-line-color'), '#ffb703');
      assert.equal(landLeader.querySelectorAll('line')[1].getAttribute('stroke'), '#ffb703');
      assert.ok(onLandBtn.querySelector('.neighbor-onscreen-dot'));

      assert.equal(onScBtn.getAttribute('data-placement'), 'on-screen');
      assert.equal(onScBtn.getAttribute('data-tag-color'), '#00f5d4');
      assert.equal(scLeader.getAttribute('data-line-color'), '#00f5d4');
      assert.equal(scLeader.querySelectorAll('line')[1].getAttribute('stroke'), '#00f5d4');

      // Off-screen tags stay pinned to viewport edges with directional arrows
      assert.equal(offLandBtn.getAttribute('data-placement'), 'edge');
      assert.equal(offLandBtn.getAttribute('data-edge-side'), 'left');
      assert.ok(offLandBtn.querySelector('svg.neighbor-edge-arrow-svg'));
      assert.equal(offScBtn.getAttribute('data-placement'), 'edge');
      assert.equal(offScBtn.getAttribute('data-edge-side'), 'right');
      assert.ok(offScBtn.querySelector('svg.neighbor-edge-arrow-svg'));

      // Clicking both on-screen & edge tags navigates to the land or sculpture
      RTL.fireEvent.click(onLandBtn);
      RTL.fireEvent.click(offLandBtn);
      RTL.fireEvent.click(onScBtn);
      RTL.fireEvent.click(offScBtn);
      assert.deepEqual(pickedParcels, ['GLAND-ONSCREEN', 'GLAND-OFFSCREEN']);
      assert.deepEqual(pickedSculptures, ['sc-on-9', 'sc-off-9']);
    } finally {
      cleanup();
    }
  });

  test('Clickable artwork labels in PlotVisitView, LandIsometricPreview, and ARLandInspectorPanel navigate directly to the 3D art view', async () => {
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');
    const { default: LandIsometricPreview } = await loadJsxModule(
      'client/src/components/LandIsometricPreview.jsx'
    );
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );

    const boomBox = {
      id: '3c7b2205-c842-4e15-8216-7017e554766d',
      title: 'Boom Box',
      description: '80s stereo boombox',
      modelType: 'custom-3d',
      customModel: { format: 'glb', ipfsCid: 'Qmf4oL8L9ZGbqDwgoY2fDgwzQ8JK1me55L2iy6kGxMiFfP' },
      parcelId: 'GLAND-9R1652WM',
      lat: 39.7302,
      lng: -121.84067
    };
    const parcel = {
      parcelId: 'GLAND-9R1652WM',
      customName: 'Squiggle Bro Land',
      geohash: '9r1652wm',
      centerLat: 39.7302,
      centerLng: -121.84067,
      volume: {
        parcelId: 'GLAND-9R1652WM',
        centerLat: 39.7302,
        centerLng: -121.84067,
        widthMeters: 5,
        depthMeters: 2.3,
        heightMeters: 2,
        rotationDeg: 0
      },
      sculptures: [boomBox]
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ parcels: [parcel], shortLabel: '112 W 2nd St, Chico, CA' })
    });

    try {
      // 1) PlotVisitView: clicking the view button on the side artwork label (OR clicking label twice OR title) opens art view
      const openedFromPlot = [];
      const plotView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures: [boomBox],
          allParcels: [parcel],
          onSelectSculpture: (sc) => openedFromPlot.push(sc.id),
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(plotView.getByTestId('plot-artwork-view-btn'));
      });
      // Direct 1-click jump via view badge on the artwork label
      RTL.fireEvent.click(plotView.getByTestId('plot-artwork-view-btn'));
      assert.deepEqual(openedFromPlot, [boomBox.id]);

      // First click on label selects & centers object isometrically; expanding details exposes title button -> art view
      RTL.fireEvent.click(plotView.getByTestId('plot-artwork-label'));
      RTL.fireEvent.click(plotView.getByTestId('plot-details-toggle'));
      await RTL.waitFor(() => {
        assert.ok(plotView.getByTestId('plot-artwork-title-btn'));
      });
      RTL.fireEvent.click(plotView.getByTestId('plot-artwork-title-btn'));
      assert.deepEqual(openedFromPlot, [boomBox.id, boomBox.id]);

      // Second click on already-selected artwork label also opens art view
      RTL.fireEvent.click(plotView.getByTestId('plot-artwork-label'));
      assert.deepEqual(openedFromPlot, [boomBox.id, boomBox.id, boomBox.id]);
      cleanup();

      // 2) LandIsometricPreview: clickable artwork label pill opens art view directly
      let openedFromPreview = '';
      const preview = RTL.render(
        React.createElement(LandIsometricPreview, {
          parcel,
          allParcels: [parcel],
          onSelectSculpture: (sc) => {
            openedFromPreview = sc.id;
          }
        })
      );
      const previewArtBtn = preview.getByTestId('preview-artwork-label');
      assert.ok(previewArtBtn.textContent.includes('Boom Box'));
      RTL.fireEvent.click(previewArtBtn);
      assert.equal(openedFromPreview, boomBox.id);
      cleanup();

      // 3) ARLandInspectorPanel: clicking artwork title label opens art view directly
      let openedFromAr = '';
      const arInspector = RTL.render(
        React.createElement(ARLandInspectorPanel, {
          land: { ...parcel, isInside: true, isOwned: true },
          onInspectSculpture: (sc) => {
            openedFromAr = sc.id;
          },
          onClose: () => {}
        })
      );
      const arArtBtn = arInspector.getByTestId('ar-land-artwork-label');
      assert.ok(arArtBtn.textContent.includes('Boom Box'));
      RTL.fireEvent.click(arArtBtn);
      assert.equal(openedFromAr, boomBox.id);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Map compass matches sibling icon width, land lines use magenta, coords sit in land header (not details), GPS button removed, and distance + info icon sit inline with Directions', async () => {
    const { default: PlotVisitView } = await loadJsxModule(
      'client/src/components/PlotVisitView.jsx'
    );
    const { default: LandIsometricPreview } = await loadJsxModule(
      'client/src/components/LandIsometricPreview.jsx'
    );
    const { default: MobileIsometricMap } = await loadJsxModule(
      'client/src/components/studio/MobileIsometricMap.jsx'
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ shortLabel: 'West 2nd St, Chico' })
    });

    const parcel = {
      parcelId: 'GLAND-MAGENTA-1',
      customName: 'Squiggle Bro Land',
      description: 'Downtown Chico voxel landmark',
      centerLat: 39.7302,
      centerLng: -121.84067,
      volume: {
        centerLat: 39.7302,
        centerLng: -121.84067,
        widthMeters: 5,
        depthMeters: 3,
        heightMeters: 3,
        corners: [
          [-121.8407, 39.73018],
          [-121.84064, 39.73018],
          [-121.84064, 39.73022],
          [-121.8407, 39.73022]
        ]
      }
    };

    try {
      // 1) PlotVisitView (far away): top bar has ONLY land name, status, share, and close; location & dimensions live inside the "i" icon
      const plotView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'mobile',
          parcel,
          sculptures: [],
          userLocation: { lat: 39.74, lng: -121.84067 },
          onRequestLogin: () => {},
          onClose: () => {}
        })
      );

      // Top bar contains land name, status badge, views counter (non-button), share button, and close button
      const header = plotView.getByTestId('plot-visit-header');
      assert.ok(header.textContent.includes('Squiggle Bro Land'));
      assert.ok(header.contains(plotView.getByTestId('plot-status-badge')));
      assert.ok(header.contains(plotView.getByTestId('plot-views-counter')));
      assert.ok(header.contains(plotView.getByTestId('plot-share-btn')));
      assert.ok(header.contains(plotView.getByTestId('plot-close-btn')));
      assert.equal(header.querySelectorAll('button').length, 2, 'Top bar should only have Share and Close buttons');
      assert.equal(header.textContent.includes('39.7302'), false, 'Location coords must not appear in top bar');
      assert.equal(header.textContent.includes('ft'), false, 'Dimensions must not appear in top bar');
      assert.equal(header.textContent.includes('Sign In'), false, 'Sign In must not appear in top bar');
      assert.equal(plotView.queryByTestId('plot-header-coords'), null);

      RTL.fireEvent.click(plotView.getByTestId('plot-details-toggle'));
      const landDetails = plotView.getByTestId('plot-land-details');
      assert.equal(landDetails.textContent.includes('39.7302, -121.8407'), false);
      // Permanent label is hidden and dimensions are tucked cleanly inside the "i" icon
      assert.equal(plotView.queryByText(/Permanent/i), null);
      assert.equal(landDetails.textContent.includes('📐'), false);

      // Refresh GPS button is removed
      assert.equal(plotView.queryByRole('button', { name: /Refresh GPS/i }), null);

      // Directions row contains distance tag on the LEFT of Navigate button
      const dirRow = plotView.getByTestId('parcel-directions-row');
      const navLink = dirRow.querySelector('a');
      assert.ok(navLink?.textContent.includes('Navigate'));
      assert.equal(navLink?.textContent.includes('Get Directions'), false);
      const distBadge = plotView.getByTestId('parcel-proximity-far');
      assert.ok(dirRow.contains(distBadge));
      assert.ok(
        Boolean(distBadge.compareDocumentPosition(navLink) & 4),
        'Expected distance badge to appear on the left of the Navigate button'
      );
      assert.ok(distBadge.textContent.includes('away'));

      // Extra metadata "i" icon lives cleanly beside the author name & date
      const authorMetaRow = plotView.getByTestId('plot-author-meta-row');
      const infoWrap = plotView.getByTestId('parcel-directions-info');
      assert.ok(authorMetaRow.contains(infoWrap));
      // Location, dimensions & unlock hint are NOT shown raw until the "i" icon is clicked
      assert.equal(plotView.queryByText(/Walk near this property to unlock View in AR/i), null);
      assert.equal(plotView.queryByTestId('plot-info-coords'), null);
      assert.equal(plotView.queryByTestId('plot-info-dimensions'), null);
      const infoBtn = infoWrap.querySelector('button');
      assert.ok(infoBtn);
      RTL.fireEvent.click(infoBtn);
      assert.ok(plotView.getByTestId('plot-info-coords').textContent.includes('39.7302, -121.8407'));
      assert.ok(plotView.getByTestId('plot-info-dimensions').textContent.includes('ft'));
      assert.ok(plotView.getByTestId('plot-info-in-person-views'));
      assert.ok(plotView.getByTestId('plot-info-page-views'));
      assert.ok(plotView.getByText(/Walk near this property to unlock View in AR/i));
      cleanup();

      // 2) LandIsometricPreview: compass icon is 12px wide, coords live in header (not facts grid), SVG lines are magenta
      const preview = RTL.render(
        React.createElement(LandIsometricPreview, {
          parcel,
          allParcels: [parcel]
        })
      );
      const compassBtn = preview.getByTestId('land-preview-compass-btn');
      const compassSvg = compassBtn.querySelector('svg');
      assert.equal(compassSvg.getAttribute('width'), '12');
      assert.equal(compassSvg.getAttribute('height'), '12');

      const previewCoords = preview.getByTestId('land-preview-coords');
      assert.ok(previewCoords.closest('.land-preview-header'));
      assert.equal(preview.container.querySelectorAll('.land-preview-fact').length, 2);

      const fallbackSvg = preview.getByTestId('land-preview-svg-fallback').querySelector('svg');
      assert.ok(fallbackSvg.innerHTML.includes('#ff1f8f'), 'Expected magenta land boundary lines');
      cleanup();

      // 3) MobileIsometricMap: compass chip uses XeroIcon 12px & SVG fallback land lines are magenta
      const isoMap = RTL.render(
        React.createElement(MobileIsometricMap, {
          parcels: [parcel],
          sculptures: [],
          selectedParcelId: parcel.parcelId
        })
      );
      const isoCompassChip = isoMap.getByTestId('mobile-iso-compass-chip');
      assert.ok(isoCompassChip.querySelector('img, span'));
      const isoSvg = isoMap.getByTestId('mobile-iso-svg-fallback').querySelector('svg');
      assert.ok(isoSvg.innerHTML.includes('#ff1f8f'), 'Expected magenta land lines in MobileIsometricMap');
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Location-based measurement units default to US feet/miles and update live across UI when changed in Settings', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );
    const { setStoredUnitPreference } = await import('../client/src/utils/measurementUnits.js');

    setStoredUnitPreference('auto');
    try {
      const usParcel = {
        parcelId: 'GLAND-CHICO01',
        customName: 'Squiggle Bro Land',
        centerLat: 39.7302,
        centerLng: -121.84067,
        volume: {
          widthMeters: 10,
          depthMeters: 10,
          heightMeters: 10,
          footprintAreaSqM: 100
        },
        stewardStatus: 'awakened',
        sculptureCount: 1
      };
      const euParcel = {
        parcelId: 'GLAND-PARIS01',
        customName: 'Montmartre Plaza',
        centerLat: 48.8867,
        centerLng: 2.3431,
        volume: {
          widthMeters: 10,
          depthMeters: 10,
          heightMeters: 10,
          footprintAreaSqM: 100
        },
        stewardStatus: 'awakened',
        sculptureCount: 1
      };

      // 1) In USA (Chico, CA), Auto defaults to feet & miles (33×33×33 ft)
      const combined = RTL.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(MobileMapSheet, {
            location: { lat: 39.7311, lng: -121.84067 },
            mapParcels: [usParcel],
            displayedMapSculptures: [],
            areaSculpturesSorted: [],
            onClose: () => {}
          }),
          React.createElement(InfoTermsModal, {
            config: {},
            user: null,
            initialTab: 'account',
            onClose: () => {}
          })
        )
      );

      assert.match(combined.getByTestId('land-distance-badge').textContent, /\b(ft|mi)\b/);
      assert.ok(combined.getByTestId('land-compact-meta').textContent.includes('33×33×33 ft'));

      // 2) User switches to Metric in Settings -> live MobileMapSheet immediately switches to meters & km!
      RTL.fireEvent.click(combined.getByTestId('unit-pref-btn-metric'));
      assert.match(combined.getByTestId('land-distance-badge').textContent, /\b(m|km)\b/);
      assert.ok(combined.getByTestId('land-compact-meta').textContent.includes('10×10×10 m'));

      // 3) User switches back to Auto -> returns to US feet & miles immediately
      RTL.fireEvent.click(combined.getByTestId('unit-pref-btn-auto'));
      assert.match(combined.getByTestId('land-distance-badge').textContent, /\b(ft|mi)\b/);
      cleanup();

      // 4) In Europe (Paris), Auto defaults to Metric (m & km)
      const parisView = RTL.render(
        React.createElement(MobileMapSheet, {
          location: { lat: 48.8876, lng: 2.3431 },
          mapParcels: [euParcel],
          displayedMapSculptures: [],
          areaSculpturesSorted: [],
          onClose: () => {}
        })
      );
      assert.match(parisView.getByTestId('land-distance-badge').textContent, /\b(m|km)\b/);
      assert.ok(parisView.getByTestId('land-compact-meta').textContent.includes('10×10×10 m'));
      cleanup();
    } finally {
      setStoredUnitPreference('auto');
      cleanup();
    }
  });

  test('DirectLinkIntroOverlay shows clean agent-copy & free-land Google sign-in intro and dismisses via close box, backdrop click, Escape, or Google Sign In', async () => {
    const { default: DirectLinkIntroOverlay, DIRECT_LINK_INTRO_COPY } = await loadJsxModule(
      'client/src/components/DirectLinkIntroOverlay.jsx'
    );

    // Copy must be ultra-clean (<= 2 sentences) and tell visitors they can copy the land for their agent + sign in with Google for free land
    const sentences = DIRECT_LINK_INTRO_COPY.trim()
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean);
    assert.ok(sentences.length >= 2 && sentences.length <= 3, `Expected <= 3 sentences, got ${sentences.length}`);
    assert.match(DIRECT_LINK_INTRO_COPY, /copy this land/i);
    assert.match(DIRECT_LINK_INTRO_COPY, /agent/i);
    assert.match(DIRECT_LINK_INTRO_COPY, /3d models/i);
    assert.match(DIRECT_LINK_INTRO_COPY, /sign in with google/i);
    assert.match(DIRECT_LINK_INTRO_COPY, /free/i);

    let closeCount = 0;
    let signInCount = 0;
    const view = RTL.render(
      React.createElement(DirectLinkIntroOverlay, {
        onClose: () => {
          closeCount += 1;
        },
        onSignIn: () => {
          signInCount += 1;
        }
      })
    );

    assert.ok(view.getByTestId('brand-logo-lockup'));
    assert.equal(view.getByTestId('direct-link-intro-text').textContent.trim(), DIRECT_LINK_INTRO_COPY);
    assert.ok(view.getByTestId('direct-link-intro-copy-btn'));
    assert.match(view.getByTestId('direct-link-intro-signin-btn').textContent || '', /Sign in with Google/i);

    // Clicking inside the card must NOT dismiss
    RTL.fireEvent.click(view.getByTestId('direct-link-intro-card'));
    assert.equal(closeCount, 0);

    // Top-right close box closes cleanly
    RTL.fireEvent.click(view.getByTestId('direct-link-intro-close-btn'));
    assert.equal(closeCount, 1);

    // Clicking off on the backdrop closes cleanly
    const backdrop = view.getByTestId('direct-link-intro-backdrop');
    RTL.fireEvent.pointerDown(backdrop, { target: backdrop });
    RTL.fireEvent.click(backdrop, { target: backdrop });
    assert.equal(closeCount, 2);

    // Pressing Escape closes cleanly
    RTL.fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    assert.equal(closeCount, 3);

    // Google Sign In button fires onSignIn
    RTL.fireEvent.click(view.getByTestId('direct-link-intro-signin-btn'));
    assert.equal(signInCount, 1);
    cleanup();
  });

  test('Dock includes Eraser, SprayBrushIntroModal explains spray-can brush, and Pencil replaces hit blocks + moves up to select adjacent stacking spaces', async () => {
    const THREE = await import('three');
    const { default: StudioDockDrawer } = await loadJsxModule(
      'client/src/components/studio/StudioDockDrawer.jsx'
    );
    const { default: SprayBrushIntroModal } = await loadJsxModule(
      'client/src/components/studio/SprayBrushIntroModal.jsx'
    );
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');

    // 1) Palette keeps Brush/Pencil/Eraser out (they stay in center ToolCarouselBar), exposes spray guide '?' & minimizes on click-off
    let selectedTool = 'brush';
    let guideOpened = 0;
    let dockOpen = true;
    const renderDock = () =>
      React.createElement(
        'div',
        null,
        React.createElement('div', { 'data-testid': 'dock-outside-target' }, 'outside'),
        React.createElement(StudioDockDrawer, {
          dockOpen,
          onToggleDock: () => {
            dockOpen = !dockOpen;
          },
          onCloseDock: () => {
            dockOpen = false;
          },
          tool: selectedTool,
          onOpenBrushGuide: () => {
            guideOpened += 1;
          },
          blockSize: 1,
          setBlockSize: () => {},
          color: '#00f5d4',
          setColor: () => {},
          material: 'matte',
          setMaterial: () => {},
          reachMeters: 1.8,
          setReachMeters: () => {}
        })
      );
    const dockView = RTL.render(renderDock());
    assert.equal(dockView.queryByTestId('palette-select-brush'), null);
    assert.equal(dockView.queryByTestId('palette-select-pencil'), null);
    assert.equal(dockView.queryByTestId('palette-select-erase'), null);
    RTL.fireEvent.click(dockView.getByTestId('palette-brush-guide-btn'));
    assert.equal(guideOpened, 1);
    selectedTool = 'erase';
    dockView.rerender(renderDock());
    assert.ok(dockView.getByText(/Eraser active below/i));
    RTL.fireEvent.pointerDown(dockView.getByTestId('dock-outside-target'));
    dockView.rerender(renderDock());
    assert.equal(dockOpen, false);
    assert.equal(dockView.queryByTestId('brush-options-popup'), null);
    cleanup();

    // 2) SprayBrushIntroModal explains how to use phone like a spray can & dismisses cleanly
    let closedGuide = 0;
    const guideView = RTL.render(
      React.createElement(SprayBrushIntroModal, {
        onClose: () => {
          closedGuide += 1;
        }
      })
    );
    assert.ok(guideView.getByTestId('spray-brush-guide-modal'));
    assert.match(guideView.getByTestId('spray-brush-guide-modal').textContent, /spray can/i);
    assert.match(guideView.getByTestId('spray-brush-guide-modal').textContent, /Hold to spray/i);
    RTL.fireEvent.click(guideView.getByTestId('spray-brush-guide-start-btn'));
    assert.equal(closedGuide, 1);
    RTL.fireEvent.click(guideView.getByTestId('spray-brush-guide-close-btn'));
    assert.equal(closedGuide, 2);
    RTL.fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    assert.equal(closedGuide, 3);
    cleanup();

    // 3) useVoxelBrush: Pencil replaces aimed block in-place & moving phone up selects open top slot for stacking
    const CanvasCtor = globalThis.window.HTMLCanvasElement;
    const origGetContext = CanvasCtor.prototype.getContext;
    CanvasCtor.prototype.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      drawImage: () => {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
      clearRect: () => {},
      fillRect: () => {}
    });

    try {
      const camera = new THREE.PerspectiveCamera(68, 1, 0.05, 120);
      camera.position.set(0, 0, 2.2);
      camera.lookAt(0, 0, 0.4);
      camera.updateMatrixWorld(true);
      const draftGroup = new THREE.Group();

      let hookApi = null;
      function BrushHarness() {
        const api = useVoxelBrush({
          config: {},
          initialDraft: {
            voxels: [{ x: 0, y: 0, z: 0.4, color: '#ef4444', material: 'matte', scale: 1 }],
            color: '#00f5d4',
            material: 'neon'
          },
          user: null,
          location: null,
          locationRef: { current: null },
          cameraReady: true,
          sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
          polRef: { current: { analyzeSurfacePatch: () => null } },
          rawOrientationRef: { current: null },
          fallbackEulerRef: { current: { yaw: 0, pitch: 0 } },
          enterFullscreen: () => {},
          setSensorBanner: () => {},
          showTemporaryHint: () => {},
          canvasHostRef: { current: null },
          cameraRef: { current: camera },
          draftGroupRef: { current: draftGroup },
          transformBoxRef: { current: null },
          surfaceMarkerRef: { current: null },
          shadowPlaneRef: { current: null },
          gridHelperRef: { current: null },
          nearbyGroupRef: { current: null },
          arTargetedIdRef: { current: '' },
          setArTargetedSculpture: () => {},
          arPinPreview: null,
          openCameraSelectedChat: () => {}
        });
        hookApi = api;
        return null;
      }

      RTL.render(React.createElement(BrushHarness));
      draftGroup.updateMatrixWorld(true);

      // Switch to Pencil while aiming directly at the placed Red block at (0, 0, 0.4)
      await RTL.act(async () => {
        hookApi.selectKeyTool('pencil');
      });
      const replaceTarget = hookApi.computeTargetVoxel();
      assert.ok(replaceTarget);
      assert.equal(replaceTarget.action, 'replace');
      assert.equal(replaceTarget.replaceExisting, true);
      assert.deepEqual({ x: replaceTarget.x, y: replaceTarget.y, z: replaceTarget.z }, { x: 0, y: 0, z: 0.4 });
      assert.equal(replaceTarget.nearbySlots.length, 6);

      // Apply Pencil replace -> replaces color/material in place and updates Three.js mesh material!
      const oldMeshMat = draftGroup.children[0].material;
      await RTL.act(async () => {
        hookApi.applyVoxelAction(replaceTarget);
      });
      assert.equal(hookApi.voxels.length, 1);
      assert.equal(hookApi.voxels[0].color, '#00f5d4');
      assert.equal(hookApi.voxels[0].material, 'neon');
      assert.notEqual(draftGroup.children[0].material, oldMeshMat);

      // Move phone UP slightly to aim above the block at (0, 0.05, 0.4) -> selects open top space!
      camera.lookAt(0, 0.05, 0.4);
      camera.updateMatrixWorld(true);
      const stackTarget = hookApi.computeTargetVoxel();
      assert.ok(stackTarget);
      assert.equal(stackTarget.action, 'add');
      assert.equal(stackTarget.adjacentFace, 'top');
      assert.deepEqual({ x: stackTarget.x, y: stackTarget.y, z: stackTarget.z }, { x: 0, y: 0.05, z: 0.4 });

      await RTL.act(async () => {
        hookApi.applyVoxelAction(stackTarget);
      });
      assert.equal(hookApi.voxels.length, 2);
      assert.equal(hookApi.voxels[1].y, 0.05);

      // Switch to Eraser and erase the top block cleanly
      await RTL.act(async () => {
        hookApi.selectKeyTool('erase');
      });
      draftGroup.updateMatrixWorld(true);
      const eraseTarget = hookApi.computeTargetVoxel(true);
      assert.ok(eraseTarget && eraseTarget.action === 'erase');
      await RTL.act(async () => {
        hookApi.applyVoxelAction(eraseTarget);
      });
      assert.equal(hookApi.voxels.length, 1);

      // 4) Human drawing & Lock & Scale strictly enforce the 250ft x 250ft (76.2m x 76.2m) horizontal cap
      await RTL.act(async () => {
        // Adding a block 70m away along +X stays under 76.2m (250ft) -> allowed
        hookApi.applyVoxelBatch([{ action: 'add', x: 70, y: 0, z: 0.4, scale: 1 }]);
      });
      assert.equal(hookApi.voxels.length, 2);

      await RTL.act(async () => {
        // Adding a block at x = 76.5m would make width 76.55m (> 76.2m / 250ft) -> rejected
        hookApi.applyVoxelBatch([{ action: 'add', x: 76.5, y: 0, z: 0.4, scale: 1 }]);
      });
      assert.equal(hookApi.voxels.length, 2, 'Blocks exceeding 250ft width must be blocked');

      await RTL.act(async () => {
        // Adding a block at z = 77.0m would make depth > 76.2m (250ft) -> rejected
        hookApi.applyVoxelBatch([{ action: 'add', x: 0, y: 0, z: 77.0, scale: 1 }]);
      });
      assert.equal(hookApi.voxels.length, 2, 'Blocks exceeding 250ft depth must be blocked');

      // Entering Lock & Scale and requesting 2.0x on a 70m sculpture clamps scale <= 76.2 / 70 (~1.088)
      await RTL.act(async () => {
        hookApi.enterTransformMode();
      });
      await RTL.act(async () => {
        hookApi.setArtTransform((p) => ({ ...p, scale: 2 }));
      });
      assert.ok(
        hookApi.artTransform.scale <= 1.09 && hookApi.artTransform.scale >= 1.05,
        `Expected Lock & Scale to clamp 70m sculpture <= 250ft (scale ~1.088), got ${hookApi.artTransform.scale}`
      );
    } finally {
      CanvasCtor.prototype.getContext = origGetContext;
      cleanup();
    }
  });

  test('Land view shows side sculpture labels with leader lines & direct links, land tag links strictly to top center, and Full View unlocks free 3D/2D navigation', async () => {
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');
    const { default: MobileIsometricMap } = await loadJsxModule(
      'client/src/components/studio/MobileIsometricMap.jsx'
    );
    const { default: LandIsometricPreview } = await loadJsxModule(
      'client/src/components/LandIsometricPreview.jsx'
    );

    const sculptures = [
      {
        id: 'sc-side-left',
        title: 'Crystal Beacon',
        modelType: 'custom-3d',
        customModel: { format: 'glb', scale: 1 },
        parcelId: 'GLAND-SIDE0001',
        lat: 39.7302,
        lng: -121.84075
      },
      {
        id: 'sc-side-right',
        title: 'Neon Archway',
        modelType: 'voxel',
        voxelCount: 24,
        parcelId: 'GLAND-SIDE0001',
        lat: 39.73022,
        lng: -121.8406
      }
    ];
    const parcel = {
      parcelId: 'GLAND-SIDE0001',
      customName: 'Skyline Terrace',
      geohash: '9r1652wm',
      centerLat: 39.7302,
      centerLng: -121.84067,
      volume: {
        parcelId: 'GLAND-SIDE0001',
        centerLat: 39.7302,
        centerLng: -121.84067,
        widthMeters: 16,
        depthMeters: 14,
        heightMeters: 12,
        rotationDeg: 0
      },
      sculptures
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ parcels: [parcel], shortLabel: 'Skyline Terrace, Chico, CA' })
    });

    try {
      // 1) PlotVisitView: Land tag leader line strictly targets top-center of land boundary,
      // side sculpture labels appear on left/right with leader lines & real ?sculpture=<id> links
      const openedIds = [];
      const plotView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures,
          allParcels: [parcel],
          onSelectSculpture: (sc) => openedIds.push(sc.id),
          onClose: () => {}
        })
      );

      const landLine = plotView.getByTestId('plot-land-leader-line');
      assert.equal(landLine.getAttribute('data-target'), 'top-center');
      assert.ok(Number(landLine.getAttribute('y2')) < 140, 'Top-center leader endpoint must sit on top face, not bottom center');

      const leaderLines = plotView.getAllByTestId('plot-artwork-leader-line');
      assert.equal(leaderLines.length, 2, 'Expected leader line for every placed sculpture');

      const artLinks = plotView.getAllByTestId('plot-artwork-view-btn');
      assert.equal(artLinks.length, 2);
      for (const link of artLinks) {
        assert.equal(link.tagName, 'A', 'Sculpture side callout link must be a real anchor <a> element');
        const scId = link.getAttribute('data-sculpture-id');
        assert.ok(
          String(link.getAttribute('href') || '').includes(`sculpture=${scId}`),
          `Expected anchor href to link to sculpture=${scId}`
        );
      }

      // Clicking Full View unlocks free 3D navigation (no isometric snapping) & switches HUD chip to 3D FREE
      assert.equal(plotView.getByTestId('mobile-iso-3d-map').getAttribute('data-free-nav'), 'false');
      assert.equal(plotView.getByTestId('mobile-iso-mode-chip').textContent.trim(), '3D ISO');
      RTL.fireEvent.click(plotView.getByTestId('mobile-map-fullscreen-btn'));
      assert.equal(plotView.getByTestId('mobile-iso-3d-map').getAttribute('data-free-nav'), 'true');
      assert.equal(plotView.getByTestId('mobile-iso-mode-chip').textContent.trim(), '3D FREE');
      assert.ok(plotView.getByTestId('mobile-map-fit-btn'), 'Explicit Fit recenter button stays available in Full View');

      // Switching 3D -> 2D while in Full View keeps explicit Fit recenter button & fullscreen active
      RTL.fireEvent.click(plotView.getByTestId('mobile-map-2d-toggle-btn'));
      assert.equal(plotView.queryByTestId('mobile-iso-3d-map'), null);
      assert.ok(plotView.getByTestId('mobile-map-3d-toggle-btn'));
      assert.ok(plotView.getByTestId('mobile-map-fit-btn'), '2D land view exposes explicit Fit recenter button');

      // Switching back 2D -> 3D while in Full View stays in free-nav mode (no isometric snap)
      RTL.fireEvent.click(plotView.getByTestId('mobile-map-3d-toggle-btn'));
      assert.equal(plotView.getByTestId('mobile-iso-3d-map').getAttribute('data-free-nav'), 'true');
      cleanup();

      // 2) MobileIsometricMap (non-showcase MobileMapSheet land view) ALSO shows side sculpture labels with lines & links
      const mobileIso = RTL.render(
        React.createElement(MobileIsometricMap, {
          parcels: [parcel],
          sculptures,
          selectedParcelId: parcel.parcelId,
          onSelectSculpture: (sc) => openedIds.push(sc.id),
          onOpenSculptureView: (sc) => openedIds.push(sc.id)
        })
      );
      assert.equal(mobileIso.getByTestId('plot-land-leader-line').getAttribute('data-target'), 'top-center');
      assert.equal(mobileIso.getAllByTestId('plot-artwork-leader-line').length, 2);
      const sheetLinks = mobileIso.getAllByTestId('plot-artwork-view-btn');
      assert.equal(sheetLinks.length, 2);
      assert.equal(sheetLinks[0].tagName, 'A');
      cleanup();

      // 3) LandIsometricPreview ALSO shows side sculpture labels with lines & direct links and top-center land line
      const preview = RTL.render(
        React.createElement(LandIsometricPreview, {
          parcel,
          allParcels: [parcel],
          onSelectSculpture: (sc) => openedIds.push(sc.id)
        })
      );
      assert.equal(preview.getByTestId('plot-land-leader-line').getAttribute('data-target'), 'top-center');
      assert.equal(preview.getAllByTestId('plot-artwork-leader-line').length, 2);
      const prevLinks = preview.getAllByTestId('plot-artwork-view-btn');
      assert.equal(prevLinks.length, 2);
      assert.equal(prevLinks[0].tagName, 'A');
      assert.ok(String(prevLinks[0].getAttribute('href') || '').includes('sculpture='));
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('InfoTermsModal explains 72h agent reclaim, 28d inactivity, exact in-person ways, non-reopening slots, 3h alerts, and links to LandArchiveModal', async () => {
    const InfoTermsModal = (await loadJsxModule('client/src/components/InfoTermsModal.jsx')).default;
    const LandArchiveModal = (await loadJsxModule('client/src/components/LandArchiveModal.jsx')).default;

    let archiveOpened = false;
    const infoView = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: { termsVersion: '2026-11-24.v4', termsText: [] } },
        user: null,
        onOpenArchive: () => {
          archiveOpened = true;
        },
        onClose: () => {}
      })
    );

    const card = infoView.getByTestId('info-land-lifecycle-card');
    assert.ok(card.textContent.includes('No Timer — Permanent'));
    assert.ok(card.textContent.includes('never expire or get recycled'));
    assert.ok(card.textContent.includes('Land Made First'));
    assert.ok(card.textContent.includes('72-hour timer'));
    assert.ok(card.textContent.includes('28-day timer'));
    assert.ok(card.textContent.includes('3 hours before'));
    assert.ok(card.textContent.includes('do not reopen'));
    assert.ok(card.textContent.includes('Draw & Publish Art Manually in Mobile AR'));
    assert.ok(card.textContent.includes('In-Person Mobile AR Land Check-In'));
    assert.ok(card.textContent.includes('Camera-Locked AR Location Chat'));
    assert.ok(card.textContent.includes('Unlock Parcel-Locked Pinned Notes'));

    const archiveLink = infoView.getByTestId('info-open-archive-link');
    assert.equal(archiveLink.getAttribute('href'), '?archive=1');
    RTL.fireEvent.click(archiveLink);
    assert.equal(archiveOpened, true);
    cleanup();

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        if (String(url).includes('/api/archive')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              counts: { total: 1, agent72h: 1, inactivity28d: 0 },
              archives: [
                {
                  id: 'arch_demo123',
                  parcelId: 'GLAND-9Q8YYK8D',
                  landName: 'Neon Ghost Plaza',
                  stewardName: 'Archon Bot',
                  stewardType: 'agent',
                  archiveReason: 'agent_72h_no_human_interaction',
                  archiveReasonLabel:
                    'Archived & reclaimed: agent-created land had no verified in-person human interaction within 72 hours of minting.',
                  centerLat: 37.7749,
                  centerLng: -122.4194,
                  volume: { widthMeters: 14, depthMeters: 14, heightMeters: 18 },
                  sculptureCount: 1,
                  sculpturesSnapshot: [
                    {
                      id: 'sc-arch-1',
                      title: 'Agent 3D Monolith',
                      modelType: 'custom-3d',
                      modelFormat: 'glb',
                      layerRole: 'steward_stage'
                    }
                  ],
                  hadHumanInteraction: false,
                  freeSlotForfeited: true,
                  claimedAt: '2026-11-20T00:00:00.000Z',
                  expiredAt: '2026-11-23T00:00:00.000Z',
                  archivedAt: '2026-11-23T00:01:00.000Z',
                  lastHumanInteractionAt: ''
                }
              ]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };

      const archView = RTL.render(
        React.createElement(LandArchiveModal, {
          onClose: () => {}
        })
      );
      const item = await archView.findByTestId('land-archive-item');
      assert.ok(item.textContent.includes('Neon Ghost Plaza'));
      assert.ok(item.textContent.includes('72h No Human Visit'));
      assert.ok(item.textContent.includes('Slot not reopened'));

      RTL.fireEvent.click(archView.getByRole('button', { name: /Details \(1 art\)/i }));
      assert.ok(archView.getByText('Agent 3D Monolith'));
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Lock & Scale sits immediately after Erase and exposes Z-axis rotation slider & reset', async () => {
    const { KEY_TOOLS } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const { default: ToolCarouselBar } = await loadJsxModule(
      'client/src/components/studio/ToolCarouselBar.jsx'
    );

    const ids = KEY_TOOLS.map((t) => t.id);
    assert.equal(
      ids.indexOf('transform'),
      ids.indexOf('erase') + 1,
      `Expected Lock & Scale (transform) immediately after erase, got order: ${ids.join(' -> ')}`
    );

    let transformState = { scale: 1, rotYDeg: 15, rotZDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 };
    const setTransform = (updater) => {
      transformState = typeof updater === 'function' ? updater(transformState) : updater;
    };

    const view = RTL.render(
      React.createElement(ToolCarouselBar, {
        quickSculpt: false,
        activeKeyTool: 'transform',
        toolAvailability: { transform: { usable: true, reason: '' } },
        canTouch: true,
        swipeDragPx: 0,
        isDraggingKey: false,
        painting: false,
        mode: 'transform',
        dockOpen: false,
        voxelsLength: 12,
        artTransform: transformState,
        onSetArtTransform: setTransform,
        onToggleTransformLock: () => {},
        onStepKeyTool: () => {},
        onKeyPointerDown: () => {},
        onKeyPointerMove: () => {},
        onKeyPointerUp: () => {},
        onKeyPointerCancel: () => {}
      })
    );

    const zSlider = view.getByTestId('transform-rotz-slider');
    assert.ok(zSlider, 'Expected Z-axis rotation slider in Lock & Scale bar');
    RTL.fireEvent.change(zSlider, { target: { value: '48' } });
    assert.equal(transformState.rotZDeg, 48);

    RTL.fireEvent.click(view.getByRole('button', { name: 'Reset' }));
    assert.equal(transformState.rotZDeg, 0);
    assert.equal(transformState.rotYDeg, 0);
    assert.equal(transformState.scale, 1);
    cleanup();
  });

  test('NotificationCenter auto-dismisses seen alerts without Mark all read, renders art links, and opens Mint Info modal', async () => {
    const { default: NotificationCenter } = await loadJsxModule(
      'client/src/components/NotificationCenter.jsx'
    );
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );

    const origFetch = globalThis.fetch;
    const readCalls = [];
    let markedReadOnServer = false;

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/notifications/read') && opts.method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        readCalls.push(body);
        markedReadOnServer = true;
        return { ok: true, status: 200, json: async () => ({ unreadCount: 0 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          unreadCount: markedReadOnServer ? 0 : 1,
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
              id: 'n-art-1',
              category: 'sculpture_on_land',
              severity: 'info',
              title: '🎨 New art "Solar Arch" on "Twin Palms"',
              message: '@maya minted "Solar Arch" on "Twin Palms", a Virtual Land you contributed to.',
              parcelId: 'GLAND-9Q8YYK9P',
              sculptureId: 'sc-solar-1',
              actionType: 'open_sculpture',
              actionLabel: 'View Art',
              meta: {
                sculptureUrl: '?sculpture=sc-solar-1',
                parcelUrl: '?parcel=GLAND-9Q8YYK9P'
              },
              read: markedReadOnServer,
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
          user: { id: 'u-auto', name: 'Auto Dismiss User' },
          variant: 'desktop',
          onAction: (item) => actions.push(item)
        })
      );

      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('notif-unread-badge').textContent, '1');
      });

      // Open inbox -> auto-marks read immediately, no manual "Mark all read" button
      RTL.fireEvent.click(view.getByRole('button', { name: /Notifications/i }));
      assert.equal(view.queryByRole('button', { name: /Mark all read/i }), null);

      await RTL.waitFor(() => {
        assert.ok(readCalls.some((c) => Array.isArray(c.ids) && c.ids.includes('n-art-1')));
        assert.equal(view.queryByTestId('notif-unread-badge'), null);
      });

      // Direct artwork link + land link are present while open
      const artLink = view.getByTestId('notif-art-link');
      assert.equal(artLink.getAttribute('href'), '?sculpture=sc-solar-1');
      const landLink = view.getByTestId('notif-land-link');
      assert.equal(landLink.getAttribute('href'), '?parcel=GLAND-9Q8YYK9P');

      // Closing popover dismisses the seen notifications automatically
      RTL.fireEvent.click(view.getByRole('button', { name: /Close notifications/i }));
      RTL.fireEvent.click(view.getByRole('button', { name: /Notifications/i }));
      assert.equal(view.queryByTestId('notif-art-link'), null);
      assert.ok(view.getByText(/You’re all caught up!/i));

      // Mint Ready banner is no longer shown inside Notifications (moved to User Profile)
      assert.equal(Boolean(view.queryByTestId('notif-mint-land-btn')), false);
      assert.equal(Boolean(view.queryByText(/Mint Ready/i)), false);
      cleanup();

      let startedMapMint = false;
      const infoView = RTL.render(
        React.createElement(InfoTermsModal, {
          config: { policy: {} },
          user: { id: 'u-auto', name: 'Auto Dismiss User' },
          initialTab: 'mint',
          onStartMapMint: () => {
            startedMapMint = true;
          },
          onClose: () => {}
        })
      );
      const mintGuide = infoView.getByTestId('info-mint-guide');
      assert.ok(mintGuide.textContent.includes('Draw Art Outdoors in Mobile AR'));
      assert.ok(mintGuide.textContent.includes('Draw a 3D Box on the Map First'));
      assert.ok(mintGuide.textContent.includes('Unlock More Slots'));
      RTL.fireEvent.click(infoView.getByTestId('info-mint-start-map-btn'));
      assert.equal(startedMapMint, true);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('MobileMapSheet marks lands as seen when expanded or navigated so map counter hides them', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );

    const seenCalls = [];
    const sampleParcel = {
      parcelId: 'GLAND-SEEN001',
      customName: 'Sunset Lot',
      centerLat: 37.7749,
      centerLng: -122.4194,
      stewardType: 'human',
      stewardStatus: 'awakened',
      hadHumanInteraction: true,
      inactivityExpiresAt: ''
    };
    const sampleSculpture = {
      id: 'sc-seen-1',
      title: 'Glow Cube',
      parcelId: 'GLAND-SEEN001',
      lat: 37.7749,
      lng: -122.4194
    };

    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        user: null,
        ownedParcelIds: [],
        config: {},
        location: { lat: 37.7749, lng: -122.4194 },
        areaFilterMode: 'all',
        setAreaFilterMode: () => {},
        mapLoading: false,
        loadPublicMapData: () => {},
        displayedMapSculptures: [sampleSculpture],
        areaSculpturesSorted: [sampleSculpture],
        mapParcels: [sampleParcel],
        mapSelectedSculpture: null,
        selectedParcelId: '',
        focusParcelTick: 0,
        onSelectParcel: () => {},
        onSelectSculpture: () => {},
        onMarkLandSeen: (pid, count) => seenCalls.push({ pid, count }),
        onShowHint: () => {},
        onClose: () => {}
      })
    );

    const expandToggle = view.getByTestId('land-card-expand-toggle');
    RTL.fireEvent.click(expandToggle);
    assert.ok(
      seenCalls.some((c) => c.pid === 'GLAND-SEEN001' && c.count === 1),
      `Expected expanding land card to call onMarkLandSeen, got ${JSON.stringify(seenCalls)}`
    );

    const navLink = view.getByTestId('land-google-maps-link');
    RTL.fireEvent.click(navLink);
    assert.ok(
      seenCalls.filter((c) => c.pid === 'GLAND-SEEN001').length >= 2,
      'Expected clicking Navigate link to also mark land seen'
    );
    cleanup();
  });

  test('ARLandInspectorPanel renders strictly ONE land chat button ABOVE the sculpture section and zero chat icons per artwork', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { default: SculptureChatDrawer } = await loadJsxModule(
      'client/src/components/SculptureChatDrawer.jsx'
    );

    const multiArtLand = {
      parcelId: 'GLAND-ONECHAT1',
      customName: 'Farmers Market',
      centerLat: 39.728,
      centerLng: -121.838,
      isInside: true,
      isOwned: true,
      distanceMeters: 4,
      sculptures: [
        {
          id: 'sc-art-1',
          title: 'Veggie Row',
          parcelId: 'GLAND-ONECHAT1',
          lat: 39.728,
          lng: -121.838,
          chatSummary: { initialized: false, messageCount: 3 }
        },
        {
          id: 'sc-art-2',
          title: 'Pumpkin Arch',
          parcelId: 'GLAND-ONECHAT1',
          lat: 39.72801,
          lng: -121.83801,
          chatSummary: { initialized: true, messageCount: 3 }
        },
        {
          id: 'sc-art-3',
          title: 'Carrot Tower',
          parcelId: 'GLAND-ONECHAT1',
          lat: 39.72802,
          lng: -121.83802,
          chatSummary: { initialized: false, messageCount: 3 }
        }
      ]
    };

    const openedChats = [];
    const view = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: multiArtLand,
        onDrawHere: () => {},
        onInspectSculpture: () => {},
        onOpenLandChat: (land, target) => openedChats.push({ parcelId: land.parcelId, targetId: target.id }),
        onClose: () => {}
      })
    );

    // Strictly ONE chat icon/button on the entire land panel
    const chatButtons = view.getAllByTestId('ar-land-chat-btn');
    assert.equal(chatButtons.length, 1, 'Expected strictly one Land Chat button per land');
    assert.ok(chatButtons[0].textContent.includes('Land Chat (3)'));

    // Zero chat buttons inside the sculptures section (none per artwork!)
    const sculpturesSection = view.getByTestId('ar-land-sculptures-list');
    assert.equal(
      sculpturesSection.querySelectorAll('button[aria-label*="Chat"], button[aria-label*="chat"]').length,
      0,
      'Sculpture rows must NOT have individual per-artwork chat icons'
    );
    const chatEmojiImgsInSculptures = Array.from(sculpturesSection.querySelectorAll('img')).filter((img) =>
      String(img.getAttribute('src') || '').includes('1f4ac')
    );
    assert.equal(
      chatEmojiImgsInSculptures.length,
      0,
      'No 💬 chat icon should appear inside the sculptures list'
    );

    // The single Land Chat button must sit ABOVE the sculpture section in DOM order
    const relPos = chatButtons[0].compareDocumentPosition(sculpturesSection);
    assert.ok(
      Boolean(relPos & globalThis.window.Node.DOCUMENT_POSITION_FOLLOWING),
      'Land Chat button must appear above the sculptures section'
    );

    // Clicking Land Chat targets the canonical initialized sculpture on the land
    RTL.fireEvent.click(chatButtons[0]);
    assert.deepEqual(openedChats, [{ parcelId: 'GLAND-ONECHAT1', targetId: 'sc-art-2' }]);
    cleanup();

    // Empty land (0 sculptures) still renders one Land Chat button targeting the parcel itself
    const emptyOpened = [];
    const emptyView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: { ...multiArtLand, parcelId: 'GLAND-EMPTYCHAT', sculptures: [] },
        onOpenLandChat: (land, target) => emptyOpened.push({ parcelId: land.parcelId, targetId: target.id }),
        onClose: () => {}
      })
    );
    RTL.fireEvent.click(emptyView.getByTestId('ar-land-chat-btn'));
    assert.deepEqual(emptyOpened, [{ parcelId: 'GLAND-EMPTYCHAT', targetId: 'GLAND-EMPTYCHAT' }]);
    cleanup();

    // SculptureChatDrawer titles the board by the Land name ("Farmers Market") as a Land Chat
    const drawerView = RTL.render(
      React.createElement(SculptureChatDrawer, {
        sculpture: {
          id: 'sc-art-2',
          title: 'Pumpkin Arch',
          parcelId: 'GLAND-ONECHAT1',
          parcelName: 'Farmers Market'
        },
        user: null,
        onRequestLogin: () => {},
        onClose: () => {}
      })
    );
    assert.equal(drawerView.container.querySelector('.chat-board-title')?.textContent, 'Farmers Market');
    assert.ok(drawerView.container.textContent.includes('Land Chat'));
    cleanup();
  });

  test('SculptureModal lets user rotate sculpture vertically to measure its height and notifies on save', async () => {
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );
    const { default: SettingsSavedToast } = await loadJsxModule(
      'client/src/components/SettingsSavedToast.jsx'
    );

    const flatSculpture = {
      id: 'sc-vert-measure',
      title: 'Long Surfboard',
      description: 'Flat board for vertical measurement',
      creatorSub: 'user-vert-1',
      creatorName: 'VertArtist',
      recipientAddress: '0x1111111111111111111111111111111111111111',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      modelType: 'custom-3d',
      scale: 1,
      lat: 39.7307,
      lng: -121.8383,
      parcelId: 'GLAND-VERT01',
      parcelName: 'Measure Plaza',
      geohash: '9r1658b0',
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0, scale: 1 },
      meshStats: { bbox: { width: 4, height: 0.5, depth: 6 } },
      customModel: { format: 'glb', scale: 1, rotationY: 0 },
      chain: { chainId: 46630, contractAddress: '0x000', tokenId: 1, txHash: '0xabc', simulated: true, royaltyPercent: 5 },
      ipfs: { metadataCid: 'bafy1', modelCid: 'bafy2', imageCid: 'bafy3' },
      voxels: []
    };

    const savedPayloads = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = String(init.method || 'GET').toUpperCase();
      if (u.includes('/api/sculptures/sc-vert-measure') && method === 'PUT') {
        const body = JSON.parse(init.body || '{}');
        savedPayloads.push(body);
        return {
          ok: true,
          json: async () => ({
            sculpture: {
              ...flatSculpture,
              title: body.title,
              description: body.description,
              scale: body.scale,
              anchorOffset: body.anchorOffset,
              meshStats: {
                ...flatSculpture.meshStats,
                transformScale: body.scale,
                transformPitch: body.anchorOffset?.pitch || 0,
                transformRoll: body.anchorOffset?.roll || 0
              }
            },
            pushedSiblings: []
          })
        };
      }
      if (u.includes('/api/sculptures/sc-vert-measure')) {
        return { ok: true, json: async () => ({ sculpture: flatSculpture }) };
      }
      if (u.includes('/api/lands/GLAND-VERT01')) {
        return {
          ok: true,
          json: async () => ({
            parcel: {
              parcelId: 'GLAND-VERT01',
              customName: 'Measure Plaza',
              ownerSub: 'user-vert-1',
              volume: {
                centerLat: 39.7307,
                centerLng: -121.8383,
                widthMeters: 16,
                depthMeters: 16,
                heightMeters: 18,
                rotationDeg: 0
              }
            },
            sculptures: [flatSculpture]
          })
        };
      }
      if (u.includes('/pins/seal')) {
        return { ok: true, json: async () => ({ meta: null, encryptedBatch: null }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(SculptureModal, {
            sculpture: flatSculpture,
            user: { id: 'user-vert-1', walletAddress: '0x1111111111111111111111111111111111111111' },
            config: {},
            onClose: () => {}
          }),
          React.createElement(SettingsSavedToast)
        )
      );

      // Initial flat orientation: height is 0.5m
      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-measured-height-m'), '0.500');
      });
      assert.ok(view.getByTestId('sculpture-rotate-pitch'));
      assert.ok(view.getByTestId('sculpture-rotate-roll'));
      assert.ok(view.getByTestId('sculpture-vertical-measure-readout').textContent.includes('0.5m H'));

      // Click Stand Vertical (+90° X) -> depth (6m) stands vertically!
      RTL.fireEvent.click(view.getByTestId('sculpture-stand-vertical-x-btn'));
      assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-measured-height-m'), '6.000');
      assert.ok(view.getByTestId('sculpture-vertical-measure-readout').textContent.includes('6m H'));
      assert.ok(view.getByTestId('sculpture-vertical-height-badge').textContent.includes('Tilt X 90°'));

      // Click Stand Side (+90° Z) -> width (4m) stands vertically!
      RTL.fireEvent.click(view.getByTestId('sculpture-stand-vertical-z-btn'));
      assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-measured-height-m'), '4.000');
      assert.ok(view.getByTestId('sculpture-vertical-measure-readout').textContent.includes('4m H'));
      assert.ok(view.getByTestId('sculpture-vertical-height-badge').textContent.includes('Z 90°'));

      // Save artwork changes -> sends roll: 90 and notifies BOTH inline and via global SettingsSavedToast
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByTestId('sculpture-save-transform-btn'));
      });
      await RTL.waitFor(() => {
        assert.equal(savedPayloads.length, 1);
        assert.equal(savedPayloads[0].anchorOffset.pitch, 0);
        assert.equal(savedPayloads[0].anchorOffset.roll, 90);
        assert.ok(view.getByTestId('sculpture-save-notice').textContent.includes('saved'));
        assert.ok(view.getByTestId('settings-saved-toast').textContent.includes('saved'));
      });

      // Reset to flat 0° restores 0.5m height
      RTL.fireEvent.click(view.getByTestId('sculpture-level-flat-btn'));
      assert.equal(view.getByTestId('sculpture-viewer-3d').getAttribute('data-measured-height-m'), '0.500');
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Saving settings displays visible inline and floating toast notifications across all settings controls', async () => {
    const { default: MeasurementUnitSetting } = await loadJsxModule(
      'client/src/components/MeasurementUnitSetting.jsx'
    );
    const { default: NotificationCenter } = await loadJsxModule(
      'client/src/components/NotificationCenter.jsx'
    );
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );
    const { default: SettingsSavedToast } = await loadJsxModule(
      'client/src/components/SettingsSavedToast.jsx'
    );

    // 1) MeasurementUnitSetting notifies inline + floating toast
    const unitView = RTL.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(MeasurementUnitSetting),
        React.createElement(SettingsSavedToast)
      )
    );
    RTL.fireEvent.click(unitView.getByTestId('unit-pref-btn-metric'));
    assert.ok(unitView.getByTestId('unit-setting-saved').textContent.includes('Saved'));
    assert.ok(unitView.getByTestId('settings-saved-toast').textContent.includes('Measurement units saved'));
    cleanup();

    // 2) NotificationCenter Settings tab notifies when toggling a category preference
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = String(init.method || 'GET').toUpperCase();
      if (u.includes('/api/notifications/preferences') && method === 'PATCH') {
        const patch = JSON.parse(init.body || '{}');
        return {
          ok: true,
          json: async () => ({
            preferences: {
              sculpture_on_land: true,
              mint_slots_unlocked: true,
              mint_limit_reached: true,
              land_expiring: true,
              land_activity: true,
              browser_push_enabled: false,
              ...patch
            }
          })
        };
      }
      if (u.includes('/api/notifications')) {
        return {
          ok: true,
          json: async () => ({
            notifications: [],
            unreadCount: 0,
            preferences: {
              sculpture_on_land: true,
              mint_slots_unlocked: true,
              mint_limit_reached: true,
              land_expiring: true,
              land_activity: true,
              browser_push_enabled: false
            }
          })
        };
      }
      if (u.includes('/api/lands/mine')) {
        return {
          ok: true,
          json: async () => ({
            parcels: [
              {
                parcelId: 'GLAND-SET01',
                customName: 'Settings Park',
                description: 'Original',
                centerLat: 37.7793,
                centerLng: -122.4193,
                settings: { allowAgentErase: true, allowContributorEdits: true, frozen: false },
                securityPolicy: { requirePasskeyUnlock: false, requireOrbUnlock: false, minOrbInliers: 8 },
                sculptures: [],
                contributors: [],
                eligibleVisitors: []
              }
            ]
          })
        };
      }
      if (u.includes('/api/passkeys/status')) {
        return { ok: true, json: async () => ({ passkeys: [] }) };
      }
      if (u.includes('/api/auth/payout')) {
        return {
          ok: true,
          json: async () => ({
            user: {
              id: 'u-settings',
              email: 'settings@graffiland.test',
              walletAddress: '0x1111111111111111111111111111111111111111',
              customPayoutAddress: ''
            }
          })
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const notifView = RTL.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(NotificationCenter, { user: { id: 'u-settings', name: 'Tester' } }),
          React.createElement(SettingsSavedToast)
        )
      );
      RTL.fireEvent.click(notifView.getByRole('button', { name: /Notifications/i }));
      RTL.fireEvent.click(notifView.getByRole('tab', { name: /Settings/i }));
      const checkboxes = notifView.container.querySelectorAll('.notif-pref-list input[type="checkbox"]');
      assert.ok(checkboxes.length >= 1);
      await RTL.act(async () => {
        RTL.fireEvent.click(checkboxes[0]);
      });
      await RTL.waitFor(() => {
        assert.ok(notifView.getByTestId('notif-settings-saved').textContent.includes('Saved:'));
        assert.ok(notifView.getByTestId('settings-saved-toast').textContent.includes('Saved:'));
      });
      cleanup();

      // 3) LandManagementModal notifies right next to Save Land Settings button + global toast
      const landView = RTL.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(LandManagementModal, {
            user: { id: 'u-settings', walletAddress: '0x1111' },
            onClose: () => {}
          }),
          React.createElement(SettingsSavedToast)
        )
      );
      await RTL.waitFor(() => {
        assert.ok(landView.getByTestId('land-mgmt-save-settings-btn'));
      });
      await RTL.act(async () => {
        RTL.fireEvent.click(landView.getByTestId('land-mgmt-save-settings-btn'));
      });
      await RTL.waitFor(() => {
        assert.ok(
          landView.getByTestId('land-settings-saved-inline').textContent.includes('Saved settings for')
        );
        assert.ok(
          landView.getByTestId('settings-saved-toast').textContent.includes('Saved settings for')
        );
      });
      cleanup();

      // 4) InfoTermsModal Account & Settings tab notifies when saving payout recipient setting
      const infoView = RTL.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(InfoTermsModal, {
            config: {},
            user: {
              id: 'u-settings',
              email: 'settings@graffiland.test',
              walletAddress: '0x1111111111111111111111111111111111111111',
              customPayoutAddress: ''
            },
            initialTab: 'account',
            onUserUpdate: () => {},
            onClose: () => {}
          }),
          React.createElement(SettingsSavedToast)
        )
      );
      await RTL.act(async () => {
        RTL.fireEvent.click(infoView.getByRole('button', { name: /Save Recipient/i }));
      });
      await RTL.waitFor(() => {
        assert.ok(
          infoView.getByTestId('account-settings-saved').textContent.includes('embedded wallet')
        );
        assert.ok(
          infoView.getByTestId('settings-saved-toast').textContent.includes('embedded wallet')
        );
      });
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('MobileMapSheet clicking blank areas of nearest land cards highlights, selects, and centers the land in the map view above without hijacking interactive controls', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );

    const selectedCalls = [];
    const seenCalls = [];
    const managedCalls = [];

    const user = {
      id: 'google:owner-9',
      username: 'market_steward',
      walletAddress: '0x2222222222222222222222222222222222222222'
    };
    const parcels = [
      {
        parcelId: 'GLAND-FARM01',
        customName: 'FARMERS MARKET 🌳',
        description: 'Open market courtyard',
        centerLat: 39.7285,
        centerLng: -121.8375,
        ownerSub: 'google:owner-9',
        stewardStatus: 'dormant',
        sculptureCount: 1,
        volume: {
          centerLat: 39.7285,
          centerLng: -121.8375,
          widthMeters: 28,
          depthMeters: 96,
          heightMeters: 18,
          footprintAreaSqM: 2688
        }
      },
      {
        parcelId: 'GLAND-DEN02',
        customName: 'DRUGDEN 🏧',
        description: 'Downtown corner parcel',
        centerLat: 39.7299,
        centerLng: -121.8391,
        ownerSub: 'google:other-steward',
        stewardStatus: 'awakened',
        sculptureCount: 2,
        volume: {
          centerLat: 39.7299,
          centerLng: -121.8391,
          widthMeters: 67,
          depthMeters: 73,
          heightMeters: 100,
          footprintAreaSqM: 4891
        }
      }
    ];
    const sculptures = [
      {
        id: 'sc-farm-1',
        title: 'Veggie Row',
        parcelId: 'GLAND-FARM01',
        lat: 39.7285,
        lng: -121.8375,
        voxelCount: 40
      },
      {
        id: 'sc-den-1',
        title: 'Santa Bunny',
        parcelId: 'GLAND-DEN02',
        lat: 39.7299,
        lng: -121.8391,
        voxelCount: 60
      },
      {
        id: 'sc-den-2',
        title: 'Christmas Tree',
        parcelId: 'GLAND-DEN02',
        lat: 39.72995,
        lng: -121.83905,
        voxelCount: 80
      }
    ];

    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        user,
        ownedParcelIds: ['GLAND-FARM01'],
        config: {},
        location: { lat: 39.7284, lng: -121.8374 },
        areaFilterMode: 'nearby',
        mapParcels: parcels,
        displayedMapSculptures: sculptures,
        areaSculpturesSorted: sculptures,
        onSelectParcel: (pid) => selectedCalls.push(pid),
        onMarkLandSeen: (pid, count) => seenCalls.push({ pid, count }),
        onManageLand: (pid) => managedCalls.push(pid),
        onShowHint: () => {},
        onClose: () => {}
      })
    );

    const cards = view.getAllByTestId('mobile-land-card');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].getAttribute('data-parcel-id'), 'GLAND-FARM01');
    assert.equal(cards[1].getAttribute('data-parcel-id'), 'GLAND-DEN02');

    // Initially neither card is explicitly selected, map focuses closest (#1)
    assert.equal(cards[0].getAttribute('data-selected'), 'false');
    assert.equal(cards[1].getAttribute('data-selected'), 'false');
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focus-tick'), '0');

    // 1) Clicking the compact metadata strip (blank non-interactive area) on card #2 highlights, selects & centers #2
    const metaStrips = view.getAllByTestId('land-compact-meta');
    RTL.fireEvent.click(metaStrips[1]);

    assert.equal(cards[0].getAttribute('data-selected'), 'false');
    assert.equal(cards[0].classList.contains('is-selected'), false);
    assert.equal(cards[1].getAttribute('data-selected'), 'true');
    assert.equal(cards[1].classList.contains('is-selected'), true);
    assert.deepEqual(selectedCalls, ['GLAND-DEN02']);
    assert.deepEqual(seenCalls, [{ pid: 'GLAND-DEN02', count: 2 }]);
    assert.equal(view.getByTestId('mobile-map-canvas').getAttribute('data-focused-parcel-id'), 'GLAND-DEN02');
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focused-parcel-id'), 'GLAND-DEN02');
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focus-tick'), '1');
    assert.ok(view.getByTestId('mobile-iso-3d-map').textContent.includes('DRUGDEN'));

    // 2) Clicking the outer blank card area of owned card #1 switches highlight & re-centers map on #1
    RTL.fireEvent.click(cards[0]);
    assert.equal(cards[0].getAttribute('data-selected'), 'true');
    assert.equal(cards[0].classList.contains('is-selected'), true);
    assert.equal(cards[1].getAttribute('data-selected'), 'false');
    assert.equal(cards[1].classList.contains('is-selected'), false);
    assert.deepEqual(selectedCalls, ['GLAND-DEN02', 'GLAND-FARM01']);
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focused-parcel-id'), 'GLAND-FARM01');
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focus-tick'), '2');
    assert.ok(view.getByTestId('mobile-iso-3d-map').textContent.includes('FARMERS MARKET'));

    // 3) Clicking card #1 blank area again advances focus tick so map re-centers even if dragged away
    RTL.fireEvent.click(metaStrips[0]);
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focus-tick'), '3');
    assert.equal(selectedCalls.length, 3);

    // 4) Interactive controls inside the card (expand triangle, manage gear, inline rename trigger + input)
    //    must NOT trigger card blank-area selection or duplicate onSelectParcel calls
    const countBeforeButtons = selectedCalls.length;
    const expandBtns = view.getAllByTestId('land-card-expand-toggle');
    RTL.fireEvent.click(expandBtns[1]);
    assert.equal(cards[1].getAttribute('data-expanded'), 'true');
    assert.equal(selectedCalls.length, countBeforeButtons);

    RTL.fireEvent.click(view.getByTestId('land-manage-gear-btn'));
    assert.deepEqual(managedCalls, ['GLAND-FARM01']);
    assert.equal(selectedCalls.length, countBeforeButtons);

    // Open inline rename on owned card #1 and click inside the input — must stay open and not fire onSelectParcel
    RTL.fireEvent.click(view.getByTestId('land-title-edit-trigger'));
    const renameInput = view.getByLabelText('Rename land');
    RTL.fireEvent.click(renameInput);
    assert.ok(view.getByTestId('land-inline-rename-form'));
    assert.equal(selectedCalls.length, countBeforeButtons);

    // Clicking blank area of card #2 while card #1 is renaming closes card #1's rename form and centers card #2
    RTL.fireEvent.click(cards[1]);
    assert.equal(view.queryByTestId('land-inline-rename-form'), null);
    assert.equal(cards[1].getAttribute('data-selected'), 'true');
    assert.equal(view.getByTestId('mobile-iso-3d-map').getAttribute('data-focused-parcel-id'), 'GLAND-DEN02');
    assert.equal(selectedCalls.length, countBeforeButtons + 1);

    // 5) Clicking the non-owned title button still calls onSelectParcel exactly once (no double fire from article onClick)
    const countBeforeTitle = selectedCalls.length;
    RTL.fireEvent.click(view.getByTestId('land-title-target-trigger'));
    assert.equal(selectedCalls.length, countBeforeTitle + 1);
    assert.equal(selectedCalls[selectedCalls.length - 1], 'GLAND-DEN02');

    // 6) Also works identically in 2D map mode
    RTL.fireEvent.click(view.getByTestId('mobile-map-2d-toggle-btn'));
    RTL.fireEvent.click(cards[0]);
    assert.equal(cards[0].getAttribute('data-selected'), 'true');
    assert.equal(view.getByTestId('mobile-map-canvas').getAttribute('data-focused-parcel-id'), 'GLAND-FARM01');
    cleanup();
  });

  test('DesktopHub renders Land-default folder tabs with emoji icons (no Around You) and zooms map to sculpture land on selection', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');

    const origFetch = globalThis.fetch;
    localStorage.removeItem('graffiland_desktop_session_v1');

    const mockSculptures = [
      {
        id: 'sc-desk-1',
        title: 'Neon Archway',
        description: 'Glowing archway sculpture',
        parcelId: 'GLAND-DESK01',
        parcelName: 'Civic Plaza',
        lat: 37.7793,
        lng: -122.4193,
        voxelCount: 64,
        polScore: 95
      },
      {
        id: 'sc-desk-2',
        title: 'Sky Totem',
        description: 'Tall voxel tower',
        parcelId: 'GLAND-DESK02',
        parcelName: 'Sunset Strip',
        lat: 37.781,
        lng: -122.416,
        voxelCount: 112,
        polScore: 98
      }
    ];
    const mockParcels = [
      {
        parcelId: 'GLAND-DESK01',
        customName: 'Civic Plaza',
        description: 'Downtown civic art square',
        centerLat: 37.7793,
        centerLng: -122.4193,
        ownerSub: 'google:desk-owner',
        stewardStatus: 'awakened',
        sculptureCount: 1,
        volume: {
          centerLat: 37.7793,
          centerLng: -122.4193,
          widthMeters: 20,
          depthMeters: 25,
          heightMeters: 18,
          footprintAreaSqM: 500
        }
      },
      {
        parcelId: 'GLAND-DESK02',
        customName: 'Sunset Strip',
        description: 'Community mural lot',
        centerLat: 37.781,
        centerLng: -122.416,
        ownerSub: 'google:someone-else',
        stewardStatus: 'dormant',
        leaseExpiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        sculptureCount: 1,
        volume: {
          centerLat: 37.781,
          centerLng: -122.416,
          widthMeters: 30,
          depthMeters: 40,
          heightMeters: 24,
          footprintAreaSqM: 1200
        }
      }
    ];

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sculptures')) {
        return { ok: true, json: async () => ({ sculptures: mockSculptures }) };
      }
      if (u.includes('/api/parcels')) {
        return { ok: true, json: async () => ({ parcels: mockParcels }) };
      }
      if (u.includes('/api/quests/nearby')) {
        return { ok: true, json: async () => ({ quests: [] }) };
      }
      if (u.includes('/api/marketplace/listings')) {
        return { ok: true, json: async () => ({ listings: [] }) };
      }
      if (u.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      if (u.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcelCount: 1, parcels: [mockParcels[0]] }) };
      }
      if (u.includes('/api/lands/GLAND-DESK02')) {
        return {
          ok: true,
          json: async () => ({ parcel: mockParcels[1], sculptures: [mockSculptures[1]] })
        };
      }
      if (u.includes('/api/mcp/pairings')) {
        return { ok: true, json: async () => ({ mcpActive: false, activePairing: null, pairings: [] }) };
      }
      if (u.includes('/api/notifications')) {
        return { ok: true, json: async () => ({ notifications: [], unreadCount: 0, preferences: {} }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          config: {},
          user: { id: 'google:desk-owner', username: 'desk_creator' },
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );

      // 1) Folder tabs put Land FIRST as default, Sculptures SECOND, with emoji icons and NO "Around You" text
      const tablist = view.getByTestId('desktop-nearby-category-tabs');
      const tabButtons = tablist.querySelectorAll('[role="tab"]');
      assert.equal(tabButtons.length, 2);
      assert.equal(tabButtons[0].getAttribute('data-testid'), 'desktop-nearby-tab-land');
      assert.equal(tabButtons[1].getAttribute('data-testid'), 'desktop-nearby-tab-sculptures');
      assert.ok(tabButtons[0].querySelector('.xero-icon'), 'Land folder tab must render an emoji icon');
      assert.ok(tabButtons[1].querySelector('.xero-icon'), 'Sculptures folder tab must render an emoji icon');

      const landTab = view.getByTestId('desktop-nearby-tab-land');
      const sculpturesTab = view.getByTestId('desktop-nearby-tab-sculptures');
      assert.equal(landTab.getAttribute('aria-selected'), 'true');
      assert.equal(sculpturesTab.getAttribute('aria-selected'), 'false');
      assert.equal(
        view.container.querySelector('.desktop-nearby-header').textContent.includes('Around You'),
        false,
        'Header must NOT display "Around You"'
      );

      // 2) Land list loads by default with counts, Owned badge & land details
      await RTL.waitFor(() => {
        const landsList = view.getByTestId('desktop-nearby-lands-list');
        assert.ok(landsList.textContent.includes('Civic Plaza'));
        assert.ok(landsList.textContent.includes('Sunset Strip'));
        assert.ok(landsList.textContent.includes('Owned'));
      });

      // 3) Clicking a Land item highlights it and updates MapView3D selected parcel
      const landCards = view.getAllByTestId('desktop-land-item');
      assert.equal(landCards.length, 2);
      RTL.fireEvent.click(landCards[0]);
      assert.equal(landCards[0].getAttribute('data-selected'), 'true');
      assert.equal(landCards[1].getAttribute('data-selected'), 'false');
      assert.equal(
        view.container.querySelector('.map3d-stage')?.getAttribute('data-selected-parcel-id'),
        'GLAND-DESK01'
      );

      // 4) Quests tab is removed; switching to Market then clicking the Sculptures folder tab returns cleanly to Sculptures list
      assert.equal(Boolean(view.queryByRole('button', { name: /Quests/i })), false);
      RTL.fireEvent.click(view.getByRole('button', { name: /Market \(0\)/i }));
      assert.equal(Boolean(view.queryByTestId('desktop-nearby-lands-list')), false);
      RTL.fireEvent.click(sculpturesTab);
      assert.equal(sculpturesTab.getAttribute('aria-selected'), 'true');
      assert.equal(landTab.getAttribute('aria-selected'), 'false');
      const scList = view.getByTestId('desktop-nearby-sculptures-list');
      assert.ok(scList.textContent.includes('Neon Archway'));
      assert.ok(scList.textContent.includes('Sky Totem'));

      // 5) Selecting a sculpture ("Sky Totem" on GLAND-DESK02) zooms the map into that sculpture's land,
      //    and closing the sculpture modal keeps the map focused & selected on that property
      const skyTotemBtn = Array.from(scList.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Sky Totem')
      );
      assert.ok(skyTotemBtn);
      RTL.fireEvent.click(skyTotemBtn);
      const mapStage = view.container.querySelector('.map3d-stage');
      assert.equal(mapStage?.getAttribute('data-selected-parcel-id'), 'GLAND-DESK02');
      assert.equal(mapStage?.getAttribute('data-focus-parcel-id'), 'GLAND-DESK02');
      assert.equal(Number(mapStage?.getAttribute('data-focus-lat')), 37.781);
      assert.equal(Number(mapStage?.getAttribute('data-focus-lng')), -122.416);
      assert.ok(Number(mapStage?.getAttribute('data-focus-zoom')) >= 18);

      // Close sculpture modal -> map stays zoomed/selected on GLAND-DESK02
      const closeScBtn = view.getByRole('button', { name: /Close sculpture/i });
      RTL.fireEvent.click(closeScBtn);
      assert.equal(mapStage?.getAttribute('data-selected-parcel-id'), 'GLAND-DESK02');
      assert.equal(mapStage?.getAttribute('data-focus-parcel-id'), 'GLAND-DESK02');

      // 6) Nav pairing button says "Pairing" (no QR subtitle), opens with MCP section already expanded, and Last Viewed does NOT appear in nav or sidebar
      const pairBtn = view.getByTestId('nav-pair-phone-btn');
      const pairBtnText = pairBtn.textContent.trim();
      assert.equal(pairBtnText, 'Pairing');
      assert.ok(!pairBtnText.includes('QR') && !pairBtnText.includes('Large 3D View'));
      RTL.fireEvent.click(pairBtn);
      assert.ok(view.getByTestId('pair-phone-modal'));
      assert.equal(view.getByTestId('pair-agent-reveal-toggle').getAttribute('aria-expanded'), 'true');
      assert.ok(view.getByTestId('pair-agent-structured-steps'));
      RTL.fireEvent.click(view.getByRole('button', { name: /Close pairing modal/i }));
      assert.equal(view.container.querySelector('.desktop-nav').textContent.includes('Last Viewed'), false);
      assert.equal(
        view.container.querySelector('.desktop-nearby-panel').textContent.includes('Last Viewed'),
        false
      );
    } finally {
      globalThis.fetch = origFetch;
      localStorage.removeItem('graffiland_desktop_session_v1');
      localStorage.removeItem('graffiland_user_history_v1:google:desk-owner');
      localStorage.removeItem('graffiland_user_history_v1:guest');
      cleanup();
    }
  });

  test('ProfileModal shows owner Last Viewed items and History of Actions with reopen and clear controls', async () => {
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');
    const historyMod = await import(pathToFileURL(path.join(ROOT, 'client/src/utils/userHistory.js')).href);

    const ownerUser = {
      id: 'google:hist-user-1',
      username: 'history_artist'
    };
    historyMod.clearLastViewedItems(ownerUser.id);
    historyMod.clearUserActionHistory(ownerUser.id);
    historyMod.clearLastViewedItems('guest');
    historyMod.clearUserActionHistory('guest');

    historyMod.recordLastViewedItem(ownerUser.id, {
      kind: 'sculpture',
      id: 'sc-hist-1',
      sculptureId: 'sc-hist-1',
      parcelId: 'GLAND-HIST01',
      title: 'Solar Dragon',
      subtitle: 'Market Plaza'
    });
    historyMod.recordLastViewedItem(ownerUser.id, {
      kind: 'land',
      id: 'GLAND-HIST01',
      parcelId: 'GLAND-HIST01',
      title: 'Market Plaza',
      subtitle: '80×80×60 ft'
    });
    historyMod.recordUserAction(ownerUser.id, {
      type: 'mint_land',
      icon: '🏗️',
      title: 'Minted land "Market Plaza"',
      detail: '24×24×18m',
      parcelId: 'GLAND-HIST01',
      linkLabel: 'Land'
    });

    const reopenedSculptures = [];
    const reopenedLands = [];

    try {
      const view = RTL.render(
        React.createElement(ProfileModal, {
          handle: 'history_artist',
          user: ownerUser,
          config: {},
          fetchProfileFn: async () => ({
            profile: {
              id: ownerUser.id,
              username: ownerUser.username,
              bio: 'Testing history',
              userNumber: 12
            },
            stats: { landCount: 0, sculptureCount: 0, actionCount: 1, totalBlocks: 0 },
            lands: [],
            sculptures: [],
            listings: [],
            actions: [
              {
                id: 'srv-act-1',
                icon: '🧊',
                title: 'Published Solar Dragon',
                detail: 'Market Plaza',
                sculptureId: 'sc-hist-1',
                createdAt: '2026-11-20T12:00:00.000Z'
              }
            ]
          }),
          onSelectSculpture: (sc) => reopenedSculptures.push(sc),
          onOpenLand: (land) => reopenedLands.push(land),
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(view.getByTestId('profile-tab-last-viewed'));
      });

      // 1) Last Viewed tab lists both viewed land & sculpture and allows 1-click reopening
      RTL.fireEvent.click(view.getByTestId('profile-tab-last-viewed'));
      const viewedList = view.getByTestId('profile-last-viewed-list');
      assert.ok(viewedList.textContent.includes('Market Plaza'));
      assert.ok(viewedList.textContent.includes('Solar Dragon'));
      const openBtns = view.getAllByTestId('profile-last-viewed-open-btn');
      assert.equal(openBtns.length, 2);
      RTL.fireEvent.click(openBtns[0]);
      RTL.fireEvent.click(openBtns[1]);
      assert.equal(reopenedLands.length + reopenedSculptures.length, 2);

      // 2) Action History tab combines local action history + server actions
      RTL.fireEvent.click(view.getByTestId('profile-tab-actions'));
      const actionsList = view.getByTestId('profile-actions-list');
      assert.ok(actionsList.textContent.includes('History of Actions'));
      assert.ok(actionsList.textContent.includes('Minted land "Market Plaza"'));
      assert.ok(actionsList.textContent.includes('Published Solar Dragon'));

      // 3) Clear Local removes local actions while keeping server actions intact
      RTL.fireEvent.click(view.getByTestId('profile-clear-actions-btn'));
      assert.equal(actionsList.textContent.includes('Minted land "Market Plaza"'), false);
      assert.ok(actionsList.textContent.includes('Published Solar Dragon'));

      // 4) Clear removes Last Viewed items cleanly
      RTL.fireEvent.click(view.getByTestId('profile-tab-last-viewed'));
      RTL.fireEvent.click(view.getByTestId('profile-clear-last-viewed-btn'));
      assert.ok(view.getByTestId('profile-last-viewed-list').textContent.includes('No recently viewed items'));
    } finally {
      historyMod.clearLastViewedItems(ownerUser.id);
      historyMod.clearUserActionHistory(ownerUser.id);
      cleanup();
    }
  });

  test('PlotVisitView lets signed-in land holder approve/reject pending land transactions directly on the land page and notifies when re-pair is needed', async () => {
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const origFetch = globalThis.fetch;
    const ownerUser = {
      id: 'google:landholder-99',
      username: 'land_holder',
      walletAddress: '0x3333333333333333333333333333333333333333'
    };
    const parcel = {
      parcelId: 'GLAND-9R1652SD',
      customName: 'Artists Studio Box',
      description: 'Direct plot visit test',
      centerLat: 39.7285,
      centerLng: -121.8375,
      ownerSub: ownerUser.id,
      stewardStatus: 'awakened',
      volume: {
        centerLat: 39.7285,
        centerLng: -121.8375,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 18,
        footprintAreaSqM: 400
      }
    };

    const signedIds = [];
    const rejectedIds = [];
    const repairClicks = [];
    let plotUpdatedCount = 0;

    let currentPending = [
      {
        id: 'sigreq-approve-1',
        parcelId: 'GLAND-9R1652SD',
        parcelName: 'Artists Studio Box',
        action: 'create_sculpture',
        agentName: 'BuilderBot',
        summaryTitle: 'Place "Neon Monolith"',
        summaryDescription: 'Add GLB 3D model on "Artists Studio Box".',
        status: 'pending',
        ownerAddress: ownerUser.walletAddress,
        canonicalMessage: 'Approve Neon Monolith',
        expiresAt: new Date(Date.now() + 45 * 60_000).toISOString()
      },
      {
        id: 'sigreq-reject-2',
        parcelId: 'GLAND-9R1652SD',
        parcelName: 'Artists Studio Box',
        action: 'update_land_settings',
        agentName: 'BuilderBot',
        summaryTitle: 'Freeze Land',
        summaryDescription: 'Freeze land on "Artists Studio Box".',
        status: 'pending',
        ownerAddress: ownerUser.walletAddress,
        canonicalMessage: 'Freeze land',
        expiresAt: new Date(Date.now() + 45 * 60_000).toISOString()
      }
    ];

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = String(opts.method || 'GET').toUpperCase();
      if (u.includes('/api/signatures/pending')) {
        return { ok: true, json: async () => ({ requests: currentPending }) };
      }
      if (u.includes('/api/mcp/pairings')) {
        return {
          ok: true,
          json: async () => ({
            mcpActive: false,
            activePairing: null,
            latestPairing: { code: 'GLP-OLD1-OLD2-OLD3-OLD4', status: 'expired', agentName: 'BuilderBot' },
            needsRepair: true,
            expiringSoon: false,
            repairReason: 'expired',
            pairings: []
          })
        };
      }
      if (u.includes('/mobile-sign') && method === 'POST') {
        const match = u.match(/requests\/([^/]+)\/mobile-sign/);
        if (match) {
          signedIds.push(match[1]);
          currentPending = currentPending.filter((r) => r.id !== match[1]);
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes('/reject') && method === 'POST') {
        const match = u.match(/requests\/([^/]+)\/reject/);
        if (match) {
          rejectedIds.push(match[1]);
          currentPending = currentPending.filter((r) => r.id !== match[1]);
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes('/api/lands/GLAND-9R1652SD')) {
        return {
          ok: true,
          json: async () => ({
            parcel,
            sculptures: [
              {
                id: 'sc-approved-1',
                title: 'Neon Monolith',
                parcelId: 'GLAND-9R1652SD',
                voxelCount: 24
              }
            ]
          })
        };
      }
      if (u.includes('/api/parcels')) {
        return { ok: true, json: async () => ({ parcels: [parcel] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures: [],
          allParcels: [parcel],
          user: ownerUser,
          ownedParcelIds: ['GLAND-9R1652SD'],
          config: {},
          onOpenPair: (info) => repairClicks.push(info),
          onPlotUpdated: () => {
            plotUpdatedCount += 1;
          },
          onClose: () => {}
        })
      );

      // 1) Signed-in land holder expands details and sees pending transactions card & re-pair alert right on the land view
      RTL.fireEvent.click(view.getByTestId('plot-details-toggle'));
      await RTL.waitFor(() => {
        assert.ok(view.getByTestId('plot-pending-approvals'));
        assert.equal(view.getAllByTestId('plot-pending-approval-item').length, 2);
        assert.ok(view.getByTestId('plot-repair-notice'));
      });
      assert.ok(view.getByTestId('plot-pending-approvals').textContent.includes('Place "Neon Monolith"'));
      assert.ok(view.getByTestId('plot-repair-notice').textContent.includes('expired'));

      // 2) Clicking Re-pair Now triggers onOpenPair callback
      RTL.fireEvent.click(view.getByTestId('plot-repair-btn'));
      assert.equal(repairClicks.length, 1);

      // 3) Clicking Approve & Execute approves the first transaction & refreshes the land
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getAllByTestId('plot-approve-tx-btn')[0]);
      });
      await RTL.waitFor(() => {
        assert.deepEqual(signedIds, ['sigreq-approve-1']);
        assert.equal(view.getAllByTestId('plot-pending-approval-item').length, 1);
      });
      assert.ok(plotUpdatedCount >= 1);

      // 4) Clicking Reject rejects the second transaction & clears the pending card
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByTestId('plot-reject-tx-btn'));
      });
      await RTL.waitFor(() => {
        assert.deepEqual(rejectedIds, ['sigreq-reject-2']);
        assert.equal(view.queryByTestId('plot-pending-approvals'), null);
      });
      cleanup();

      // 5) Mobile StudioHudTopBar displays Re-pair needed pill & opens MobilePairApprovalDropdown with Re-pair banner
      const hudView = RTL.render(
        React.createElement(StudioHudTopBar, {
          user: ownerUser,
          mode: 'draw',
          dockOpen: false,
          location: null,
          pairedCode: '',
          voxels: [],
          quickSculpt: false,
          hasOwnedLand: true,
          ownedLandCount: 1,
          originStatus: { originBlocked: false, isSecure: true, isTrusted: true },
          sceneScan: { active: false },
          surfaceAnchor: { locked: false },
          mcpPairingsState: {
            mcpActive: false,
            activePairing: null,
            needsRepair: true,
            repairReason: 'expired',
            pairings: []
          },
          repairNotice: {
            kind: 'mcp',
            reason: 'expired',
            code: 'GLP-OLD1-OLD2-OLD3-OLD4',
            message: 'Your AI agent pairing expired — tap Pair to re-pair.'
          },
          pendingSignatures: [],
          signatureHistory: []
        })
      );
      const repairPill = hudView.getByTestId('mobile-repair-pill');
      assert.ok(repairPill.textContent.includes('Re-pair needed'));
      RTL.fireEvent.click(repairPill);
      const repairBanner = hudView.getByTestId('mobile-repair-banner');
      assert.ok(repairBanner.textContent.includes('Re-pair Needed'));
      cleanup();

      // 6) MobilePairApprovalDropdown displays inline approval error + 1-tap Auto-Fit & Approve button
      const autoFitCalls = [];
      const errHudView = RTL.render(
        React.createElement(StudioHudTopBar, {
          user: ownerUser,
          mode: 'draw',
          dockOpen: false,
          location: null,
          pairedCode: '',
          voxels: [],
          quickSculpt: false,
          hasOwnedLand: true,
          ownedLandCount: 1,
          originStatus: { originBlocked: false, isSecure: true, isTrusted: true },
          sceneScan: { active: false },
          surfaceAnchor: { locked: false },
          mcpPairingsState: { mcpActive: true, activePairing: { code: 'GLP-1111-2222-3333-4444' }, pairings: [] },
          pendingSignatures: [
            {
              id: 'sigreq-oversized-1',
              action: 'create_sculpture',
              parcelId: 'GLAND-9R1652SD',
              parcelName: 'ARTISTSSHITBOX',
              summaryTitle: 'Place "Sprinkle Poo"',
              summaryDescription: 'Add GLB 3D model on "ARTISTSSHITBOX".',
              agentName: 'land-builder-agent',
              ownerAddress: ownerUser.walletAddress,
              canonicalMessage: 'sign-oversized',
              expiresAt: new Date(Date.now() + 3600000).toISOString()
            }
          ],
          pendingSigErrors: {
            'sigreq-oversized-1': {
              message: 'Scale 6× exceeds the 18.2×19.7×18m land bounds (max 1.927×).',
              code: 'exceeds_land_bounds',
              maxSafeScale: 1.927
            }
          },
          onMobileSignPending: (item, opts) => autoFitCalls.push({ id: item.id, opts }),
          signatureHistory: []
        })
      );
      RTL.fireEvent.click(errHudView.getByTestId('mobile-pair-hub-btn'));
      const inlineErr = errHudView.getByTestId('mobile-approval-error');
      assert.ok(inlineErr.textContent.includes('1.927×'));
      const autoFitBtn = errHudView.getByTestId('mobile-autofit-approve-btn');
      assert.ok(autoFitBtn.textContent.includes('Auto-Fit (1.927×) & Approve'));
      RTL.fireEvent.click(autoFitBtn);
      assert.deepEqual(autoFitCalls, [{ id: 'sigreq-oversized-1', opts: { autoFitScale: true } }]);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      localStorage.removeItem('graffiland_user_history_v1:google:landholder-99');
      cleanup();
    }
  });

  test('Map theme defaults to dark mode across 3D MapLibre and 2D Leaflet styles and supports live toggling', async () => {
    const {
      DEFAULT_MAP_THEME,
      MAP_THEME_STORAGE_KEY,
      OPENFREEMAP_DARK_STYLE,
      OPENFREEMAP_LIGHT_STYLE,
      applyGraffilandMapLibreTheme,
      getLeafletTileConfig,
      getMapLibreStyleForTheme,
      getStoredMapTheme,
      setStoredMapTheme
    } = await import('../client/src/utils/mapTheme.js');

    localStorage.removeItem(MAP_THEME_STORAGE_KEY);
    assert.equal(DEFAULT_MAP_THEME, 'dark');
    assert.equal(getStoredMapTheme(), 'dark');
    assert.equal(getMapLibreStyleForTheme(), OPENFREEMAP_DARK_STYLE);
    const darkLeafletCfg = getLeafletTileConfig();
    assert.ok(darkLeafletCfg.url.includes('tile.openstreetmap.org'));
    assert.equal(darkLeafletCfg.isDarkFilter, true);
    assert.ok(!darkLeafletCfg.url.includes('cartocdn.com'));

    // Applying dark theme harmonizes paint properties and injects building-3d extrusion layer before first symbol
    const addedLayers = [];
    const paintCalls = [];
    const mockMap = {
      getLayer: (id) => (id === 'building-3d' ? null : { id }),
      getSource: (id) => (id === 'openmaptiles' ? { id } : null),
      getStyle: () => ({ layers: [{ id: 'background', type: 'background' }, { id: 'water_name', type: 'symbol' }] }),
      setPaintProperty: (id, prop, val) => paintCalls.push({ id, prop, val }),
      addLayer: (layer, beforeId) => addedLayers.push({ layer, beforeId })
    };
    applyGraffilandMapLibreTheme(mockMap, { theme: 'dark', showBuildings: true, buildingOpacity: 0.78 });
    assert.ok(paintCalls.some((c) => c.id === 'background' && c.val === '#090d18'));
    assert.equal(addedLayers.length, 1);
    assert.equal(addedLayers[0].layer.id, 'building-3d');
    assert.equal(addedLayers[0].layer.type, 'fill-extrusion');
    assert.equal(addedLayers[0].beforeId, 'water_name');

    // Toggling to light mode switches styles cleanly and persists, then resets cleanly back to dark
    setStoredMapTheme('light');
    assert.equal(getStoredMapTheme(), 'light');
    assert.equal(getMapLibreStyleForTheme('light'), OPENFREEMAP_LIGHT_STYLE);
    assert.ok(getLeafletTileConfig('light').url.includes('tile.openstreetmap.org'));
    localStorage.removeItem(MAP_THEME_STORAGE_KEY);
  });

  test('Pending sculpture mint transactions show temporary "Preview" labels on maps, 3D preview modal, and direct Approve/Reject inside NotificationCenter', async () => {
    const { buildPendingPreviewSculptures } = await import(
      '../client/src/utils/pendingApprovalPreview.js'
    );
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');
    const { default: NotificationCenter } = await loadJsxModule(
      'client/src/components/NotificationCenter.jsx'
    );
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    const ownerUser = {
      id: 'google:preview-owner',
      username: 'preview_owner',
      walletAddress: '0x1111111111111111111111111111111111111111'
    };
    const parcel = {
      parcelId: 'GLAND-PREV01',
      customName: 'Preview Plaza',
      ownerSub: ownerUser.id,
      centerLat: 37.782,
      centerLng: -122.412,
      volume: {
        parcelId: 'GLAND-PREV01',
        centerLat: 37.782,
        centerLng: -122.412,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 18
      }
    };
    const pendingGlbReq = {
      id: 'sigreq-glb-preview-1',
      status: 'pending',
      action: 'create_sculpture',
      parcelId: 'GLAND-PREV01',
      parcelName: 'Preview Plaza',
      landDisplayName: 'Preview Plaza',
      ownerAddress: ownerUser.walletAddress,
      agentName: 'art-agent',
      summaryTitle: 'Place "Crystal Phoenix"',
      summaryDescription: 'Add GLB 3D model on "Preview Plaza".',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createdAt: new Date().toISOString(),
      payload: {
        title: 'Crystal Phoenix',
        description: 'Glowing crystal sculpture awaiting owner approval.',
        modelFormat: 'glb',
        modelUrl: 'https://example.com/crystal-phoenix.glb',
        modelScale: 1.5,
        anchorOffset: { dx: 1, dy: 0, dz: -1, yaw: 30 }
      }
    };
    const pendingVoxelReq = {
      id: 'sigreq-vox-preview-2',
      status: 'pending',
      action: 'create_sculpture',
      parcelId: 'GLAND-PREV01',
      parcelName: 'Preview Plaza',
      ownerAddress: ownerUser.walletAddress,
      agentName: 'voxel-bot',
      summaryTitle: 'Place "Voxel Beacon"',
      summaryDescription: 'Add 2-block voxel sculpture on "Preview Plaza".',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createdAt: new Date().toISOString(),
      payload: {
        title: 'Voxel Beacon',
        description: 'Temporary voxel preview.',
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4' },
          { x: 0, y: 1, z: 0, color: '#ff1f8f' }
        ]
      }
    };
    const nonSculptureReq = {
      id: 'sigreq-rename-3',
      status: 'pending',
      action: 'update_parcel',
      parcelId: 'GLAND-PREV01',
      payload: { customName: 'Renamed Plaza' }
    };

    // 1) Pure converter produces preview sculptures for both GLB (with auth proxy URL) and voxel pending mints, skipping non-sculpture actions
    const previews = buildPendingPreviewSculptures(
      [pendingGlbReq, pendingVoxelReq, nonSculptureReq],
      { parcels: [parcel] }
    );
    assert.equal(previews.length, 2);
    assert.equal(previews[0].isPendingPreview, true);
    assert.equal(previews[0].pendingRequestId, 'sigreq-glb-preview-1');
    assert.equal(previews[0].modelType, 'custom-3d');
    assert.equal(previews[0].customModel.format, 'glb');
    assert.equal(
      previews[0].customModel.proxyUrl,
      '/api/signatures/requests/sigreq-glb-preview-1/preview-model'
    );
    assert.equal(previews[0].lat, 37.782);
    assert.equal(previews[0].lng, -122.412);
    assert.equal(previews[1].modelType, 'voxel');
    assert.equal(previews[1].voxels.length, 2);

    const origFetch = globalThis.fetch;
    const signedCalls = [];
    const rejectedCalls = [];
    let simulateBoundsErrOnce = true;

    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const body = init.body ? JSON.parse(init.body) : {};
      if (u.includes('/api/signatures/pending')) {
        return {
          ok: true,
          json: async () => ({ requests: [pendingGlbReq, pendingVoxelReq] })
        };
      }
      if (u.includes('/api/mcp/pairings')) {
        return { ok: true, json: async () => ({ mcpActive: true, pairings: [] }) };
      }
      if (u.includes('/api/notifications/read')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes('/api/notifications')) {
        return {
          ok: true,
          json: async () => ({
            notifications: [
              {
                id: 'notif-sig-1',
                category: 'land_activity',
                severity: 'action',
                title: '✍️ Approval needed: Place "Crystal Phoenix"',
                message: 'art-agent requested "Place Crystal Phoenix" on "Preview Plaza". Preview on the map or approve right here.',
                parcelId: 'GLAND-PREV01',
                actionType: 'open_land_approval',
                actionLabel: 'Preview on Land',
                read: false,
                createdAt: new Date().toISOString(),
                meta: {
                  requestId: 'sigreq-glb-preview-1',
                  action: 'create_sculpture',
                  hasSculpturePreview: true
                }
              }
            ],
            unreadCount: 1,
            preferences: {}
          })
        };
      }
      if (u.includes('/api/signatures/requests/sigreq-glb-preview-1/mobile-sign')) {
        signedCalls.push({ id: 'sigreq-glb-preview-1', body });
        if (simulateBoundsErrOnce && !body.autoFitScale) {
          simulateBoundsErrOnce = false;
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'Scale 1.5× exceeds bounds (max 0.95×).',
              code: 'exceeds_land_bounds',
              maxSafeScale: 0.95
            })
          };
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            autoFittedScale: body.autoFitScale ? 0.95 : null,
            result: { sculpture: { id: 'sc-minted-phoenix', title: 'Crystal Phoenix' } }
          })
        };
      }
      if (u.includes('/api/signatures/requests/sigreq-vox-preview-2/reject')) {
        rejectedCalls.push('sigreq-vox-preview-2');
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes('/api/lands/GLAND-PREV01')) {
        return { ok: true, json: async () => ({ parcel, sculptures: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true, parcels: [parcel] }) };
    };

    try {
      // 2) PlotVisitView renders temporary "Preview" labels on the map & selector pills + "Preview 3D" button
      const openedPreviews = [];
      const plotView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures: [],
          allParcels: [parcel],
          user: ownerUser,
          ownedParcelIds: ['GLAND-PREV01'],
          onSelectSculpture: (sc) => openedPreviews.push(sc),
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        const badges = plotView.getAllByTestId('map-preview-badge');
        assert.ok(badges.length >= 1);
        assert.equal(badges[0].textContent.trim(), 'Preview');
      });
      assert.ok(plotView.getAllByTestId('plot-preview-label').length >= 1);
      assert.ok(plotView.getAllByTestId('plot-tab-preview').length === 2);
      RTL.fireEvent.click(plotView.getByTestId('plot-details-toggle'));
      RTL.fireEvent.click(plotView.getAllByTestId('plot-preview-tx-btn')[0]);
      assert.equal(openedPreviews.length, 1);
      assert.equal(openedPreviews[0].isPendingPreview, true);
      assert.equal(openedPreviews[0].title, 'Crystal Phoenix');
      cleanup();

      // 3) SculptureModal in pending preview mode shows "Preview" badge + Approve & Mint / Reject controls
      const modalApproved = [];
      const modalView = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: previews[0],
          user: ownerUser,
          config: {},
          onApprovePending: (req) => modalApproved.push(req.id),
          onClose: () => {}
        })
      );
      assert.equal(modalView.getByTestId('preview-modal-badge').textContent.trim(), 'Preview');
      assert.ok(modalView.getByTestId('sculpture-preview-approval-bar'));
      RTL.fireEvent.click(modalView.getByTestId('preview-modal-approve-btn'));
      assert.deepEqual(modalApproved, ['sigreq-glb-preview-1']);
      cleanup();

      // 4) NotificationCenter allows direct Approve (including Auto-Fit retry), Reject, and Preview right from the menu
      const resolvedEvents = [];
      const notifActions = [];
      const notifView = RTL.render(
        React.createElement(NotificationCenter, {
          user: ownerUser,
          variant: 'desktop',
          pendingApprovals: [pendingGlbReq, pendingVoxelReq],
          onApprovalResolved: (ev) => resolvedEvents.push(ev),
          onAction: (act) => notifActions.push(act)
        })
      );

      // Open notification popover -> shows both persisted notification AND synthetic pending approval
      await RTL.act(async () => {
        RTL.fireEvent.click(notifView.getByRole('button', { name: /Notifications/i }));
      });
      await RTL.waitFor(() => {
        assert.equal(notifView.getAllByTestId('notif-inline-approve-btn').length, 2);
      });

      // Clicking Preview triggers preview_pending_sculpture action
      RTL.fireEvent.click(notifView.getAllByTestId('notif-preview-btn')[0]);
      assert.equal(notifActions.length, 1);
      assert.equal(notifActions[0].actionType, 'preview_pending_sculpture');

      // Reopen popover, approve Crystal Phoenix -> first attempt triggers inline Auto-Fit button, second click approves!
      await RTL.act(async () => {
        RTL.fireEvent.click(notifView.getByRole('button', { name: /Notifications/i }));
      });
      const phoenixCard = notifView.container.querySelector('[data-request-id="sigreq-glb-preview-1"]');
      assert.ok(phoenixCard);
      await RTL.act(async () => {
        RTL.fireEvent.click(phoenixCard.querySelector('[data-testid="notif-inline-approve-btn"]'));
      });
      await RTL.waitFor(() => {
        assert.ok(notifView.getByTestId('notif-approval-error').textContent.includes('0.95×'));
        assert.ok(notifView.getByTestId('notif-autofit-approve-btn'));
      });
      await RTL.act(async () => {
        RTL.fireEvent.click(notifView.getByTestId('notif-autofit-approve-btn'));
      });
      await RTL.waitFor(() => {
        assert.equal(resolvedEvents.length, 1);
        assert.equal(resolvedEvents[0].type, 'approved');
        assert.equal(resolvedEvents[0].requestId, 'sigreq-glb-preview-1');
      });
      assert.equal(signedCalls.length, 2);
      assert.equal(signedCalls[1].body.autoFitScale, true);

      // Reject second pending transaction directly from the notification menu
      const voxelCard = notifView.container.querySelector('[data-request-id="sigreq-vox-preview-2"]');
      assert.ok(voxelCard);
      await RTL.act(async () => {
        RTL.fireEvent.click(voxelCard.querySelector('[data-testid="notif-inline-reject-btn"]'));
      });
      await RTL.waitFor(() => {
        assert.deepEqual(rejectedCalls, ['sigreq-vox-preview-2']);
        assert.equal(resolvedEvents.length, 2);
        assert.equal(resolvedEvents[1].type, 'rejected');
      });
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Gallery tab renders sculpture thumbnails (direct preview, isometric voxel & 3D model) and clicking a thumbnail loads that sculpture', async () => {
    const { projectVoxelsToIsoCubes } = await import(
      '../client/src/utils/sculptureThumbnailRenderer.js'
    );
    const { default: SculptureThumbnail } = await loadJsxModule(
      'client/src/components/SculptureThumbnail.jsx'
    );
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');

    // 1) Pure isometric projection generates shaded cube faces for voxel sculptures
    const cubes = projectVoxelsToIsoCubes([
      { x: 0, y: 0, z: 0, color: '#00f5d4' },
      { x: 0, y: 0.2, z: 0, color: '#ff1f8f' }
    ]);
    assert.equal(cubes.length, 2);
    assert.ok(cubes[0].top && cubes[0].left && cubes[0].right);

    // 2) SculptureThumbnail renders direct preview image, color voxel SVG, and custom-3d badge
    const directThumbView = RTL.render(
      React.createElement(SculptureThumbnail, {
        sculpture: {
          id: 'thumb-direct-1',
          title: 'Captured Statue',
          previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          voxelCount: 12
        }
      })
    );
    assert.equal(
      directThumbView.getByTestId('gallery-sculpture-thumb').getAttribute('data-thumb-kind'),
      'image'
    );
    assert.ok(directThumbView.getByRole('img', { name: /Preview of Captured Statue/i }));
    cleanup();

    const voxelThumbView = RTL.render(
      React.createElement(SculptureThumbnail, {
        sculpture: {
          id: 'thumb-voxel-2',
          title: 'Prism Spire',
          voxels: [
            { x: 0, y: 0, z: 0, color: '#00f5d4' },
            { x: 0, y: 0.2, z: 0, color: '#ffd166' }
          ],
          voxelCount: 2
        }
      })
    );
    assert.equal(
      voxelThumbView.getByTestId('gallery-sculpture-thumb').getAttribute('data-thumb-kind'),
      'voxel-iso'
    );
    assert.ok(voxelThumbView.container.querySelectorAll('polygon').length >= 6);
    cleanup();

    // 3) DesktopHub Gallery tab displays thumbnail cards and clicking one loads that exact sculpture
    const origFetch = globalThis.fetch;
    localStorage.removeItem('graffiland_desktop_session_v1');
    const mockSculptures = [
      {
        id: 'gal-sc-1',
        title: 'Emerald Spire',
        description: 'Voxel spire with saved preview',
        parcelId: 'GLAND-GAL01',
        parcelName: 'Gallery Court',
        lat: 37.78,
        lng: -122.415,
        previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
        voxelCount: 1,
        polScore: 97
      },
      {
        id: 'gal-sc-2',
        title: 'Solar Monolith',
        description: 'Custom GLB sculpture',
        parcelId: 'GLAND-GAL02',
        parcelName: 'Sun Deck',
        lat: 37.782,
        lng: -122.412,
        modelType: 'custom-3d',
        customModel: { format: 'glb', downloadUrl: '' },
        polScore: 99
      }
    ];
    const mockParcels = [
      { parcelId: 'GLAND-GAL01', customName: 'Gallery Court', centerLat: 37.78, centerLng: -122.415 },
      { parcelId: 'GLAND-GAL02', customName: 'Sun Deck', centerLat: 37.782, centerLng: -122.412 }
    ];

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sculptures/gal-sc-2')) {
        return { ok: true, json: async () => ({ sculpture: mockSculptures[1] }) };
      }
      if (u.includes('/api/sculptures')) {
        return { ok: true, json: async () => ({ sculptures: mockSculptures }) };
      }
      if (u.includes('/api/parcels')) {
        return { ok: true, json: async () => ({ parcels: mockParcels }) };
      }
      if (u.includes('/api/lands/GLAND-GAL02')) {
        return { ok: true, json: async () => ({ parcel: mockParcels[1], sculptures: [mockSculptures[1]] }) };
      }
      if (u.includes('/api/quests/nearby')) return { ok: true, json: async () => ({ quests: [] }) };
      if (u.includes('/api/marketplace/listings')) return { ok: true, json: async () => ({ listings: [] }) };
      if (u.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          config: {},
          user: null,
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(view.getByRole('button', { name: /^Gallery$/i }));
      });
      RTL.fireEvent.click(view.getByRole('button', { name: /^Gallery$/i }));

      await RTL.waitFor(() => {
        const cards = view.getAllByTestId('desktop-gallery-card');
        assert.equal(cards.length, 2);
      });
      const thumbs = view.getAllByTestId('gallery-sculpture-thumb');
      assert.equal(thumbs.length, 2);
      assert.equal(thumbs[0].getAttribute('data-thumb-kind'), 'image');

      // Clicking the second gallery card loads "Solar Monolith" in SculptureModal and focuses its land
      const monolithCard = view.container.querySelector('[data-sculpture-id="gal-sc-2"]');
      assert.ok(monolithCard);
      RTL.fireEvent.click(monolithCard);

      await RTL.waitFor(() => {
        const modal = view.getByTestId('sculpture-modal');
        assert.ok(modal.textContent.includes('Solar Monolith'));
      });
      assert.equal(
        view.container.querySelector('.map3d-stage')?.getAttribute('data-selected-parcel-id'),
        'GLAND-GAL02'
      );
    } finally {
      globalThis.fetch = origFetch;
      localStorage.removeItem('graffiland_desktop_session_v1');
      cleanup();
    }
  });

  test('Land Management tab is hidden until user has paired on both Desktop and Mobile HUD', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    // 1) Mobile StudioHudTopBar hides Land Management pill when unpaired even if user owns lands
    const mobileBase = {
      user: { id: 'google:u-pair', name: 'Owner', username: 'owner1' },
      mode: 'draw',
      dockOpen: false,
      location: { lat: 37.78, lng: -122.41 },
      voxels: [],
      quickSculpt: false,
      hasOwnedLand: true,
      ownedLandCount: 3,
      cameraReady: true,
      originStatus: { originBlocked: false, reason: '' },
      sceneScan: { optimal: true },
      nearbyCount: 1,
      pairedCode: '',
      mcpPairingsState: { mcpActive: false, pairings: [] },
      onOpenLandManage: () => {},
      onOpenAreaMap: () => {}
    };

    const mobileUnpaired = RTL.render(React.createElement(StudioHudTopBar, mobileBase));
    assert.equal(mobileUnpaired.queryByLabelText('Land Management'), null);
    cleanup();

    // Paired via phone live-mirror code -> Land Management pill appears
    const mobilePhonePaired = RTL.render(
      React.createElement(StudioHudTopBar, { ...mobileBase, pairedCode: 'PAIR42' })
    );
    assert.ok(mobilePhonePaired.getByLabelText('Land Management'));
    cleanup();

    // Paired via MCP active -> Land Management pill appears
    const mobileMcpPaired = RTL.render(
      React.createElement(StudioHudTopBar, {
        ...mobileBase,
        mcpPairingsState: { mcpActive: true, activePairing: { code: 'GLP-1234-5678-9012-3456' }, pairings: [] }
      })
    );
    assert.ok(mobileMcpPaired.getByLabelText('Land Management'));
    cleanup();

    // 2) DesktopHub hides Land Management nav button until paired, and shows it once paired
    const origFetch = globalThis.fetch;
    localStorage.removeItem('graffiland_desktop_session_v1');
    let mockMcpActive = false;
    const ownerUser = {
      id: 'google:owner-pair-1',
      name: 'Pair Owner',
      username: 'pairowner',
      walletAddress: '0x1111111111111111111111111111111111111111'
    };
    const mockOwnedParcel = {
      parcelId: 'GLAND-PAIR01',
      customName: 'Paired Lot',
      ownerUserId: ownerUser.id,
      ownerAddress: ownerUser.walletAddress,
      centerLat: 37.78,
      centerLng: -122.415,
      volume: {
        centerLat: 37.78,
        centerLng: -122.415,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 16,
        rotationDeg: 0
      }
    };

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcelCount: 1, parcels: [mockOwnedParcel] }) };
      }
      if (u.includes('/api/mcp/pairings')) {
        return {
          ok: true,
          json: async () => ({
            mcpActive: mockMcpActive,
            activePairing: mockMcpActive ? { code: 'GLP-AAAA-BBBB-CCCC-DDDD', status: 'connected' } : null,
            pairings: mockMcpActive ? [{ code: 'GLP-AAAA-BBBB-CCCC-DDDD', status: 'connected' }] : []
          })
        };
      }
      if (u.includes('/api/signatures/pending')) return { ok: true, json: async () => ({ requests: [] }) };
      if (u.includes('/api/notifications')) return { ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) };
      if (u.includes('/api/sculptures')) return { ok: true, json: async () => ({ sculptures: [] }) };
      if (u.includes('/api/parcels')) return { ok: true, json: async () => ({ parcels: [mockOwnedParcel] }) };
      if (u.includes('/api/quests/nearby')) return { ok: true, json: async () => ({ quests: [] }) };
      if (u.includes('/api/marketplace/listings')) return { ok: true, json: async () => ({ listings: [] }) };
      if (u.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      // Unpaired: owns 1 parcel, but Land Management nav tab must remain hidden
      const unpairedView = RTL.render(
        React.createElement(DesktopHub, {
          config: {},
          user: ownerUser,
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );
      await RTL.waitFor(() => {
        assert.ok(unpairedView.getByTestId('nav-pair-phone-btn'));
        assert.ok(unpairedView.getAllByText('Paired Lot').length > 0);
      });
      assert.equal(unpairedView.queryByTestId('nav-land-management-btn'), null);
      cleanup();

      // Paired (mcpActive: true): Land Management nav tab now appears
      mockMcpActive = true;
      const pairedView = RTL.render(
        React.createElement(DesktopHub, {
          config: {},
          user: ownerUser,
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );
      await RTL.waitFor(() => {
        const lmBtn = pairedView.getByTestId('nav-land-management-btn');
        assert.ok(lmBtn.textContent.includes('Land Management (1)'));
      });
    } finally {
      globalThis.fetch = origFetch;
      localStorage.removeItem('graffiland_desktop_session_v1');
      cleanup();
    }
  });

  test('Draft land undo (Ctrl+Z/Cmd+Z), delete unminted (Delete/Backspace), and duplicate copy/paste (Ctrl+C/Ctrl+V)', async () => {
    const {
      createPastedDraftFromTemplate,
      pruneDraftIdsFromHistory
    } = await loadJsxModule('client/src/utils/draftLandHistory.js');
    const { footprintsOverlap, validateAndNormalizeLandVolume } = await import(
      '../shared/landVolume.mjs'
    );
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');

    // 1) Pure helper checks: pasted duplicate preserves dimensions/rotation, never overlaps, and increments Copy name cleanly
    const sourceDraft = {
      id: 'draft-src-1',
      centerLat: 37.775,
      centerLng: -122.419,
      widthMeters: 26,
      depthMeters: 18,
      heightMeters: 22,
      zScale: 1.375,
      rotationDeg: 35,
      customName: 'Neon Plaza',
      description: 'Corner terrace'
    };
    const copy1 = createPastedDraftFromTemplate(sourceDraft, {
      existingDrafts: [sourceDraft],
      existingParcels: [],
      idFactory: () => 'draft-copy-1'
    });
    assert.equal(copy1.id, 'draft-copy-1');
    assert.equal(copy1.widthMeters, 26);
    assert.equal(copy1.depthMeters, 18);
    assert.equal(copy1.heightMeters, 22);
    assert.equal(copy1.rotationDeg, 35);
    assert.equal(copy1.customName, 'Neon Plaza Copy');
    const vSrc = validateAndNormalizeLandVolume({ ...sourceDraft, lat: sourceDraft.centerLat, lng: sourceDraft.centerLng }).volume;
    const vCopy1 = validateAndNormalizeLandVolume({ ...copy1, lat: copy1.centerLat, lng: copy1.centerLng }).volume;
    assert.equal(footprintsOverlap(vSrc, vCopy1), false);

    const copy2 = createPastedDraftFromTemplate(sourceDraft, {
      existingDrafts: [sourceDraft, copy1],
      existingParcels: [],
      idFactory: () => 'draft-copy-2'
    });
    assert.equal(copy2.customName, 'Neon Plaza Copy 2');
    const vCopy2 = validateAndNormalizeLandVolume({ ...copy2, lat: copy2.centerLat, lng: copy2.centerLng }).volume;
    assert.equal(footprintsOverlap(vSrc, vCopy2), false);
    assert.equal(footprintsOverlap(vCopy1, vCopy2), false);

    // Pruning minted draft IDs prevents undo from resurrecting an already-minted parcel
    const pruned = pruneDraftIdsFromHistory(
      [
        { drafts: [sourceDraft], selectedDraftId: sourceDraft.id, label: 'Edit land' },
        { drafts: [sourceDraft, copy1], selectedDraftId: copy1.id, label: 'Paste land' }
      ],
      [sourceDraft.id]
    );
    assert.equal(pruned.length, 2);
    assert.equal(pruned[0].drafts.length, 0);
    assert.equal(pruned[1].drafts.length, 1);
    assert.equal(pruned[1].drafts[0].id, copy1.id);

    // 2) Full DesktopHub keyboard + toolbar integration
    const origFetch = globalThis.fetch;
    localStorage.removeItem('graffiland_desktop_session_v1');
    const ownerUser = {
      id: 'google:draft-kbd-user',
      name: 'Land Builder',
      username: 'landbuilder',
      walletAddress: '0x2222222222222222222222222222222222222222'
    };
    const existingMinted = {
      parcelId: 'GLAND-MINTED1',
      customName: 'Already Minted Lot',
      ownerUserId: ownerUser.id,
      ownerAddress: ownerUser.walletAddress,
      centerLat: 37.79,
      centerLng: -122.40,
      volume: {
        centerLat: 37.79,
        centerLng: -122.40,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 16,
        rotationDeg: 0
      }
    };

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcelCount: 1, parcels: [existingMinted] }) };
      }
      if (u.includes('/api/mcp/pairings')) return { ok: true, json: async () => ({ mcpActive: false, pairings: [] }) };
      if (u.includes('/api/signatures/pending')) return { ok: true, json: async () => ({ requests: [] }) };
      if (u.includes('/api/notifications')) return { ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) };
      if (u.includes('/api/sculptures')) return { ok: true, json: async () => ({ sculptures: [] }) };
      if (u.includes('/api/parcels')) return { ok: true, json: async () => ({ parcels: [existingMinted] }) };
      if (u.includes('/api/quests/nearby')) return { ok: true, json: async () => ({ quests: [] }) };
      if (u.includes('/api/marketplace/listings')) return { ok: true, json: async () => ({ listings: [] }) };
      if (u.includes('/api/agents/leaderboard')) return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      if (u.includes('/api/lands/check-name')) return { ok: true, json: async () => ({ available: true }) };
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          config: {},
          user: ownerUser,
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );

      // Open Mint Land mode and add one unminted square
      await RTL.waitFor(() => {
        assert.ok(view.getAllByRole('button', { name: /Mint Land/i }).length > 0);
      });
      RTL.fireEvent.click(view.getAllByRole('button', { name: /Mint Land/i })[0]);
      await RTL.waitFor(() => {
        assert.ok(view.getByRole('button', { name: /\+ Add Square/i }));
      });
      RTL.fireEvent.click(view.getByRole('button', { name: /\+ Add Square/i }));
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(1\//));
      });

      // Rename the draft inside the input; pressing Delete inside the input MUST NOT delete the land
      const nameInput = view.container.querySelector('#land-square-name-input');
      assert.ok(nameInput);
      RTL.fireEvent.change(nameInput, { target: { value: 'Solar Terrace' } });
      RTL.fireEvent.keyDown(nameInput, { key: 'Delete' });
      RTL.fireEvent.keyDown(nameInput, { key: 'Backspace' });
      assert.ok(view.getByText(/Draft Plots \(1\//));

      // Ctrl+C then Ctrl+V on window duplicates the selected land with non-overlapping coords & "Copy" title
      RTL.fireEvent.keyDown(globalThis.window, { key: 'c', ctrlKey: true });
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Copied "Solar Terrace"/i));
      });
      RTL.fireEvent.keyDown(globalThis.window, { key: 'v', ctrlKey: true });
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(2\//));
        assert.equal(view.container.querySelector('#land-square-name-input')?.value, 'Solar Terrace Copy');
      });

      // Pressing Delete removes the selected unminted duplicate
      RTL.fireEvent.keyDown(globalThis.window, { key: 'Delete' });
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(1\//));
      });

      // Pressing Cmd+Z (metaKey + z) brings the deleted unminted land right back!
      RTL.fireEvent.keyDown(globalThis.window, { key: 'z', metaKey: true });
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(2\//));
        assert.equal(view.container.querySelector('#land-square-name-input')?.value, 'Solar Terrace Copy');
      });

      // Clicking the Undo toolbar button undoes the paste back to 1 draft
      RTL.fireEvent.click(view.getByTestId('land-undo-btn'));
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(1\//));
      });

      // Pressing Backspace deletes the remaining unminted draft, and Ctrl+Z restores it even from 0 drafts
      RTL.fireEvent.keyDown(globalThis.window, { key: 'Backspace' });
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(0\//));
      });
      assert.equal(view.getByTestId('land-undo-btn').disabled, false);
      RTL.fireEvent.keyDown(globalThis.window, { key: 'z', ctrlKey: true });
      await RTL.waitFor(() => {
        assert.ok(view.getByText(/Draft Plots \(1\//));
      });
    } finally {
      globalThis.fetch = origFetch;
      localStorage.removeItem('graffiland_desktop_session_v1');
      cleanup();
    }
  });

  test('Clicking minted land label or 3D boundary opens detailed PlotVisitView, and Pairing windows expose clickable codes & Copy icon buttons', async () => {
    const { hitTestMintedParcelPrism } = await loadJsxModule('client/src/utils/map3dProjection.js');
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
    const { default: MobilePairApprovalDropdown } = await loadJsxModule(
      'client/src/components/studio/MobilePairApprovalDropdown.jsx'
    );

    // 1) Pure 3D prism boundary + interior hit-test check
    const sampleGeom = {
      bottom: [
        { x: 100, y: 200 },
        { x: 200, y: 200 },
        { x: 200, y: 300 },
        { x: 100, y: 300 }
      ],
      top: [
        { x: 100, y: 120 },
        { x: 200, y: 120 },
        { x: 200, y: 220 },
        { x: 100, y: 220 }
      ]
    };
    const boundaryHit = hitTestMintedParcelPrism(150, 122, sampleGeom, 10);
    assert.ok(boundaryHit?.hit && boundaryHit.onBoundary);
    const interiorHit = hitTestMintedParcelPrism(150, 250, sampleGeom, 10);
    assert.ok(interiorHit?.hit);
    const miss = hitTestMintedParcelPrism(40, 40, sampleGeom, 10);
    assert.equal(miss, null);

    // 2) DesktopHub: clicking a minted land label opens detailed PlotVisitView; Pairing modal copies MCP & Phone codes via code click or Copy icon button
    const origFetch = globalThis.fetch;
    const origClipboard = globalThis.navigator.clipboard;
    const copiedTexts = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          copiedTexts.push(String(text));
        }
      }
    });
    localStorage.removeItem('graffiland_desktop_session_v1');
    sessionStorage.setItem('graffiland_desktop_pair_code_v1', 'K9P4M2');

    const ownerUser = {
      id: 'google:label-click-owner',
      name: 'Detail Owner',
      username: 'detailowner',
      walletAddress: '0x3333333333333333333333333333333333333333'
    };
    const mintedParcel = {
      parcelId: 'GLAND-DET001',
      customName: 'Sunset Courtyard',
      description: 'Open rooftop sculpture plaza.',
      ownerUserId: ownerUser.id,
      ownerAddress: ownerUser.walletAddress,
      centerLat: 37.78,
      centerLng: -122.415,
      volume: {
        centerLat: 37.78,
        centerLng: -122.415,
        widthMeters: 22,
        depthMeters: 20,
        heightMeters: 16,
        rotationDeg: 0
      }
    };
    const mockMcpCode = 'GLP-7777-8888-9999-AAAA';

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/GLAND-DET001')) {
        return { ok: true, json: async () => ({ parcel: mintedParcel, sculptures: [] }) };
      }
      if (u.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcelCount: 1, parcels: [mintedParcel] }) };
      }
      if (u.includes('/api/mcp/pairings')) {
        return {
          ok: true,
          json: async () => ({
            mcpActive: true,
            activePairing: { code: mockMcpCode, status: 'connected' },
            pairings: [{ code: mockMcpCode, status: 'connected' }]
          })
        };
      }
      if (u.includes('/api/signatures/pending')) return { ok: true, json: async () => ({ requests: [] }) };
      if (u.includes('/api/notifications')) return { ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) };
      if (u.includes('/api/sculptures')) return { ok: true, json: async () => ({ sculptures: [] }) };
      if (u.includes('/api/parcels')) return { ok: true, json: async () => ({ parcels: [mintedParcel] }) };
      if (u.includes('/api/quests/nearby')) return { ok: true, json: async () => ({ quests: [] }) };
      if (u.includes('/api/marketplace/listings')) return { ok: true, json: async () => ({ listings: [] }) };
      if (u.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          config: {},
          user: ownerUser,
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );

      // Click the minted land label directly on the map -> opens detailed PlotVisitView!
      await RTL.waitFor(() => {
        const lbl = view.getByTestId('map3d-land-label');
        assert.equal(lbl.tagName, 'BUTTON');
      });
      RTL.fireEvent.click(view.getByTestId('map3d-land-label'));
      await RTL.waitFor(() => {
        const detail = view.getByTestId('desktop-plot-visit-view');
        assert.ok(detail.textContent.includes('Sunset Courtyard'));
      });

      // Close detailed view and open Pairing window -> click code & copy button for both Phone & MCP codes
      const closeDetailBtn = view.getByRole('button', { name: /Close|Back/i });
      RTL.fireEvent.click(closeDetailBtn);
      RTL.fireEvent.click(view.getByTestId('nav-pair-phone-btn'));

      await RTL.waitFor(() => {
        assert.ok(view.getByTestId('pair-agent-code-value'));
        assert.ok(view.getByTestId('pair-agent-code-copy-btn'));
        assert.ok(view.getByTestId('pair-phone-code-value'));
        assert.ok(view.getByTestId('pair-phone-code-copy-btn'));
      });

      // Click MCP pairing code directly -> copies exact GLP code
      RTL.fireEvent.click(view.getByTestId('pair-agent-code-value'));
      await RTL.waitFor(() => {
        assert.ok(copiedTexts.includes(mockMcpCode));
      });
      // Click MCP Copy icon button -> copies exact GLP code
      copiedTexts.length = 0;
      RTL.fireEvent.click(view.getByTestId('pair-agent-code-copy-btn'));
      await RTL.waitFor(() => {
        assert.ok(copiedTexts.includes(mockMcpCode));
        assert.ok(view.getByTestId('pair-agent-code-copy-btn').textContent.includes('Copied'));
      });
      // Click Phone Pair Code value directly -> copies exact 6-char code
      copiedTexts.length = 0;
      RTL.fireEvent.click(view.getByTestId('pair-phone-code-value'));
      await RTL.waitFor(() => {
        assert.ok(copiedTexts.includes('K9P4M2'));
      });
      cleanup();

      // 3) Mobile Pairing Dropdown: both Desktop paired code & MCP code have clickable value + Copy icon button
      const mobilePairView = RTL.render(
        React.createElement(MobilePairApprovalDropdown, {
          open: true,
          activeTab: 'pair',
          onSelectTab: () => {},
          onClose: () => {},
          user: ownerUser,
          pairedCode: 'K9P4M2',
          mcpPairingsState: {
            mcpActive: true,
            activePairing: { code: mockMcpCode, status: 'connected' },
            pairings: [{ code: mockMcpCode, status: 'connected' }]
          }
        })
      );
      copiedTexts.length = 0;
      RTL.fireEvent.click(mobilePairView.getByTestId('mobile-desktop-code-value'));
      await RTL.waitFor(() => assert.ok(copiedTexts.includes('K9P4M2')));
      copiedTexts.length = 0;
      RTL.fireEvent.click(mobilePairView.getByTestId('mobile-mcp-code-copy-btn'));
      await RTL.waitFor(() => assert.ok(copiedTexts.includes(mockMcpCode)));
    } finally {
      globalThis.fetch = origFetch;
      if (origClipboard !== undefined) {
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          configurable: true,
          value: origClipboard
        });
      }
      localStorage.removeItem('graffiland_desktop_session_v1');
      sessionStorage.removeItem('graffiland_desktop_pair_code_v1');
      cleanup();
    }
  });

  test('Mobile maps use API-key-free OSM tiles (no CARTO), cap tiny-land auto-zoom, avoid WebGL context leaks, and AR keeps land sculptures grounded without GPS thrashing', async () => {
    const fsMod = await import('node:fs');
    const mapThemeMod = await import('../client/src/utils/mapTheme.js');
    const helpers = await import('../client/src/utils/landPreviewHelpers.js');
    const arHelpers = await import('../client/src/utils/arLandHelpers.js');
    const loadMlMod = await import('../client/src/utils/loadMapLibre.js');

    // 1) Zero cartocdn.com URLs in mapTheme.js (CARTO returns "API KEY REQUIRED" on spray.land)
    const mapThemeSrc = fsMod.readFileSync(
      path.join(ROOT, 'client/src/utils/mapTheme.js'),
      'utf8'
    );
    assert.ok(!/cartocdn\.com/i.test(mapThemeSrc), 'mapTheme.js must not reference cartocdn.com');
    const darkFallbackTiles =
      mapThemeMod.FALLBACK_DARK_STYLE.sources['osm-dark-fallback']?.tiles || [];
    const lightFallbackTiles =
      mapThemeMod.FALLBACK_LIGHT_STYLE.sources['osm-light-fallback']?.tiles || [];
    assert.ok(darkFallbackTiles.some((u) => u.includes('tile.openstreetmap.org')));
    assert.ok(lightFallbackTiles.some((u) => u.includes('tile.openstreetmap.org')));
    assert.equal(mapThemeMod.getLeafletTileConfig('dark').isDarkFilter, true);
    assert.equal(mapThemeMod.getLeafletTileConfig('light').isDarkFilter, false);

    // Dark-mode CSS tile filter must exist strictly on .leaflet-container:not(.is-map-light) .leaflet-tile-pane
    const cssSrc = fsMod.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    assert.ok(
      cssSrc.includes('.leaflet-container:not(.is-map-light) .leaflet-tile-pane'),
      'Dark-mode Leaflet OSM tile filter must be present in styles.css'
    );

    // 2) Small 2-5m lands on mobile viewports cap auto-zoom so surrounding streets stay visible
    const tinyLandVol = helpers.resolveParcelVolume({
      parcelId: 'GLAND-9R1652QK',
      volume: {
        centerLat: 39.7287,
        centerLng: -121.8406,
        widthMeters: 2.4,
        depthMeters: 1.1,
        heightMeters: 1.4,
        rotationDeg: 0
      }
    });
    const mobileFit = helpers.computeIsometricCameraFit(tinyLandVol, {
      viewportWidth: 360,
      viewportHeight: 240,
      viewMode: 'isometric'
    });
    assert.ok(
      mobileFit && mobileFit.zoom <= 19.6,
      `Expected mobile small-land auto-zoom <= 19.6 for street visibility, got ${mobileFit?.zoom}`
    );

    // 3) computeArSculptureVerticalY never buries voxel or custom-3D land sculptures underground
    const flatLand = { parcelId: 'GLAND-TEST', volume: { baseAltitudeM: 0, heightMeters: 18 } };
    const elevatedLand = { parcelId: 'GLAND-ELEV', volume: { baseAltitudeM: 5, heightMeters: 18 } };

    // Voxel sculpture with WGS84 vs EGM96 -30m heightAboveGroundMeters & cross-device altitude diff
    const voxelSc = {
      id: 'sc-voxel-1',
      modelType: 'voxel',
      altitude: 34.1,
      elevation: {
        deviceAltitudeMeters: 34.1,
        terrainElevationMeters: 64,
        anchorAltitudeMeters: 34.1,
        heightAboveGroundMeters: -29.9,
        sculptureVerticalMinM: -1.4
      },
      anchorOffset: { dx: 0, dy: 0, dz: 0 }
    };
    const voxelYNoAlt = arHelpers.computeArSculptureVerticalY({
      sculpture: voxelSc,
      viewerAltitude: null,
      parentLand: flatLand,
      groundY: -1.15
    });
    assert.ok(
      voxelYNoAlt >= -1.15 && voxelYNoAlt <= 2,
      `Voxel sculpture with -29.9m datum offset must stay above ground, got y=${voxelYNoAlt}`
    );
    const voxelYCrossDevice = arHelpers.computeArSculptureVerticalY({
      sculpture: voxelSc,
      viewerAltitude: 64.5, // iPhone EGM96 vs Android WGS84 34.1m (-30.4m jump)
      parentLand: flatLand,
      groundY: -1.15
    });
    assert.ok(
      voxelYCrossDevice >= -1.15 && voxelYCrossDevice <= 2,
      `Cross-device datum mismatch must not bury voxel sculpture underground, got y=${voxelYCrossDevice}`
    );

    // Custom 3D model rests squarely on land floor even if altitude differs from viewer GPS
    const customSc = {
      id: 'sc-glb-1',
      modelType: 'custom-3d',
      altitude: 36.16,
      customModel: { format: 'glb', scale: 2.5 },
      anchorOffset: { dx: 0, dy: 0, dz: 0 }
    };
    assert.equal(
      arHelpers.computeArSculptureVerticalY({
        sculpture: customSc,
        viewerAltitude: 65,
        parentLand: flatLand,
        groundY: -1.15
      }),
      -1.15
    );
    assert.equal(
      arHelpers.computeArSculptureVerticalY({
        sculpture: { ...customSc, anchorOffset: { dx: 0, dy: 1.5, dz: 0 } },
        viewerAltitude: 65,
        parentLand: elevatedLand,
        groundY: -1.15
      }),
      5.35
    );

    // 4) hasWebGLSupport caches result and immediately releases its temporary probe context
    const doc = globalThis.document;
    const win = globalThis.window;
    const origCreateEl = doc.createElement.bind(doc);
    const origUaDesc = Object.getOwnPropertyDescriptor(win.navigator, 'userAgent');
    let getCtxCalls = 0;
    let loseCtxCalls = 0;
    try {
      Object.defineProperty(win.navigator, 'userAgent', {
        configurable: true,
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1'
      });
      loadMlMod.resetWebGLSupportCache();
      doc.createElement = (tag, ...rest) => {
        const el = origCreateEl(tag, ...rest);
        if (String(tag).toLowerCase() === 'canvas') {
          el.getContext = () => {
            getCtxCalls += 1;
            return {
              getExtension: (name) =>
                name === 'WEBGL_lose_context'
                  ? { loseContext: () => { loseCtxCalls += 1; } }
                  : null
            };
          };
        }
        return el;
      };
      assert.equal(loadMlMod.hasWebGLSupport(), true);
      assert.equal(loadMlMod.hasWebGLSupport(), true);
      assert.equal(getCtxCalls, 1, 'hasWebGLSupport must cache probe after first call');
      assert.equal(loseCtxCalls, 1, 'hasWebGLSupport must release probe context via WEBGL_lose_context');
    } finally {
      doc.createElement = origCreateEl;
      if (origUaDesc) {
        Object.defineProperty(win.navigator, 'userAgent', origUaDesc);
      }
      loadMlMod.resetWebGLSupportCache();
    }

    // 5) useARPreview preserves cached sculpture entries across GPS updates & ARViewportCanvas pauses while map overlays are open
    const arPreviewSrc = fsMod.readFileSync(
      path.join(ROOT, 'client/src/hooks/useARPreview.js'),
      'utf8'
    );
    assert.ok(arPreviewSrc.includes('arSculptureEntriesRef'));
    assert.ok(arPreviewSrc.includes('computeArSculptureVerticalY'));
    const mobileStudioSrc = fsMod.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    assert.ok(mobileStudioSrc.includes('renderPaused={Boolean('));
  });

  test('Draft land 3D auto-fit zooms out for tall volumes so the top rectangle stays visible & draggable, with explicit Zoom Out & Fit Draft controls', async () => {
    const fsMod = await import('node:fs');
    const helpers = await import('../client/src/utils/landPreviewHelpers.js');

    const baseDraft = {
      centerLat: 37.7749,
      centerLng: -122.4194,
      widthMeters: 28,
      depthMeters: 30,
      heightMeters: 18,
      rotationDeg: 315
    };
    const fitShort = helpers.computeDraft3DAutoFit(baseDraft, {
      viewportWidth: 844,
      viewportHeight: 540,
      pitchDeg: 52,
      bearingDeg: -45
    });
    const fitMedium = helpers.computeDraft3DAutoFit(
      { ...baseDraft, heightMeters: 100 },
      { viewportWidth: 844, viewportHeight: 540, pitchDeg: 52, bearingDeg: -45 }
    );
    const fitMaxTall = helpers.computeDraft3DAutoFit(
      { ...baseDraft, heightMeters: 250 },
      { viewportWidth: 844, viewportHeight: 540, pitchDeg: 52, bearingDeg: -45 }
    );
    const fitHugeTower = helpers.computeDraft3DAutoFit(
      { ...baseDraft, widthMeters: 120, depthMeters: 40, heightMeters: 250 },
      { viewportWidth: 640, viewportHeight: 400, pitchDeg: 55, bearingDeg: -45 }
    );

    assert.ok(fitShort && fitMedium && fitMaxTall && fitHugeTower);
    assert.ok(
      fitMedium.zoom < fitShort.zoom - 0.8,
      `Expected 100m draft to zoom out below 18m draft (${fitShort.zoom} -> ${fitMedium.zoom})`
    );
    assert.ok(
      fitMaxTall.zoom < fitMedium.zoom - 0.8,
      `Expected 250m draft to zoom out below 100m draft (${fitMedium.zoom} -> ${fitMaxTall.zoom})`
    );
    assert.ok(
      fitMaxTall.zoom <= 16.2,
      `Expected 250m draft zoom <= 16.2 so top rectangle stays on screen, got ${fitMaxTall.zoom}`
    );
    assert.ok(
      fitMaxTall.padding.top > fitMaxTall.padding.bottom,
      'Tall 3D draft auto-fit must add top padding to center the roof below HUD controls'
    );
    assert.ok(
      fitHugeTower.zoom < fitMaxTall.zoom,
      `Larger footprint/smaller viewport should zoom out further (${fitMaxTall.zoom} -> ${fitHugeTower.zoom})`
    );

    // Isometric preview camera fit must also zoom below 14.0 for tall 250m parcels instead of clipping
    const tallPreviewVol = helpers.resolveParcelVolume({
      parcelId: 'GLAND-9Q8YYK99',
      volume: {
        centerLat: 37.7749,
        centerLng: -122.4194,
        widthMeters: 100,
        depthMeters: 50,
        heightMeters: 250,
        rotationDeg: 0
      }
    });
    const tallIsoFit = helpers.computeIsometricCameraFit(tallPreviewVol, {
      viewportWidth: 260,
      viewportHeight: 160,
      viewMode: 'isometric'
    });
    assert.ok(
      tallIsoFit && tallIsoFit.zoom < 14.0,
      `Expected tall 250m parcel preview fit on compact viewport to zoom out below z14.0, got ${tallIsoFit?.zoom}`
    );

    // MapView3D keeps unrestricted minZoom & floating Fit Draft control while omitting removed camera/zoom/iso/draw/orbit toolbar buttons
    const map3dSrc = fsMod.readFileSync(
      path.join(ROOT, 'client/src/components/MapView3D.jsx'),
      'utf8'
    );
    assert.ok(map3dSrc.includes('minZoom: 1'), 'MapView3D must explicitly allow zooming out to minZoom 1');
    assert.ok(map3dSrc.includes('data-testid="map3d-fit-draft-btn"'), 'MapView3D must expose Fit Draft button');
    assert.ok(map3dSrc.includes('data-testid="map3d-overlay-toolbar"'), 'MapView3D must float remaining compact controls on the map');
    assert.ok(map3dSrc.includes('computeDraft3DAutoFit'), 'MapView3D must auto-fit tall/wide drafts');
    assert.equal(map3dSrc.includes('data-testid="map3d-zoom-out-btn"'), false, 'MapView3D must not render removed Zoom Out toolbar button');
    assert.equal(map3dSrc.includes('data-testid="map3d-orbit-pan-toggle"'), false, 'MapView3D must not render removed Orbit Land toolbar button');
    assert.equal(map3dSrc.includes('↺ -15°'), false, 'MapView3D must not render removed rotate buttons');
    assert.equal(map3dSrc.includes('Tilt {Math.round(pitchDeg)}°'), false, 'MapView3D must not render removed tilt slider');
  });

  test('ARLandInspectorPanel greys out on-site actions when remote and notifies user to visit land in person', async () => {
    const { default: ARLandInspectorPanel, evaluateArLandActionProximity } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { subscribeSettingsSaved } = await loadJsxModule('client/src/utils/toastNotice.js');

    // 1) Pure proximity evaluator edge cases (inside, mid-range, remote, null GPS)
    const insideGate = evaluateArLandActionProximity({
      isInside: true,
      edgeDistanceMetersExact: 0,
      outOfArRange: false
    });
    assert.equal(insideGate.canDrawAtLand, true);
    assert.equal(insideGate.canCheckInAtLand, true);
    assert.equal(insideGate.canChatAtLand, true);
    assert.equal(insideGate.canAlignAtLand, true);

    const midRangeGate = evaluateArLandActionProximity({
      isInside: false,
      edgeDistanceMetersExact: 60,
      outOfArRange: false
    });
    assert.equal(midRangeGate.canDrawAtLand, false);
    assert.equal(midRangeGate.canCheckInAtLand, false);
    assert.equal(midRangeGate.canChatAtLand, true);
    assert.equal(midRangeGate.canAlignAtLand, true);

    const farGate = evaluateArLandActionProximity({
      isInside: false,
      edgeDistanceMetersExact: 1770,
      outOfArRange: true
    });
    assert.equal(farGate.canDrawAtLand, false);
    assert.equal(farGate.canCheckInAtLand, false);
    assert.equal(farGate.canChatAtLand, false);
    assert.equal(farGate.canAlignAtLand, false);

    // Null GPS must NOT coerce Number(null) -> 0 and unlock actions!
    const noGpsGate = evaluateArLandActionProximity({
      isInside: false,
      edgeDistanceMetersExact: null,
      edgeDistanceMeters: null,
      distanceMeters: null,
      outOfArRange: false
    });
    assert.equal(noGpsGate.edgeDistM, null);
    assert.equal(noGpsGate.canDrawAtLand, false);
    assert.equal(noGpsGate.canCheckInAtLand, false);
    assert.equal(noGpsGate.canChatAtLand, false);
    assert.equal(noGpsGate.canAlignAtLand, false);

    // 2) Remote land (1.1 mi away): Draw, Land Chat, Check In IRL, and Align AR are greyed out & locked
    const remoteLand = {
      parcelId: 'GLAND-DISMAL01',
      customName: 'DismalLand',
      displayName: 'DismalLand',
      description: 'might be kinda scary idn',
      centerLat: 39.7285,
      centerLng: -121.8375,
      edgeDistanceMeters: 1770,
      edgeDistanceMetersExact: 1770.2,
      distanceMeters: 1785,
      isInside: false,
      outOfArRange: true,
      isOwned: true,
      isFrozen: false,
      stewardUsername: 'bigdog',
      googleMapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=39.7285,-121.8375',
      expiration: {
        state: 'expiring',
        urgent: false,
        badgeText: '27d 20h left',
        detailText: 'Visit in person to permanently own'
      },
      sculptures: [{ id: 'sc-snarl', title: 'Steamboat Snarl', voxelCount: 410 }]
    };

    const fired = { draw: 0, chat: 0, checkIn: 0, manage: 0, inspectArt: 0 };
    const toasts = [];
    const unsub = subscribeSettingsSaved((detail) => toasts.push(detail));

    try {
      const remoteView = RTL.render(
        React.createElement(ARLandInspectorPanel, {
          land: remoteLand,
          sensorStatus: { trueNorthLocked: true, manualYawNudgeDeg: 4, needsCompassCalibration: true },
          onDrawHere: () => {
            fired.draw += 1;
          },
          onOpenLandChat: () => {
            fired.chat += 1;
          },
          onCheckInLand: async () => {
            fired.checkIn += 1;
            return true;
          },
          onManageLand: () => {
            fired.manage += 1;
          },
          onInspectSculpture: () => {
            fired.inspectArt += 1;
          },
          onAdjustCompassNudge: () => {},
          onResetCompassNudge: () => {},
          onClose: () => {}
        })
      );

      const drawBtn = remoteView.getByTestId('ar-land-draw-btn');
      const chatBtn = remoteView.getByTestId('ar-land-chat-btn');
      const checkInBtn = remoteView.getByTestId('ar-land-checkin-btn');
      const alignBtn = remoteView.getByTestId('ar-compass-align-toggle-btn');

      // All 4 in-person buttons are visually locked/greyed out (and Draw does NOT carry btn-primary)
      for (const btn of [drawBtn, chatBtn, checkInBtn, alignBtn]) {
        assert.equal(btn.getAttribute('data-locked'), 'true');
        assert.equal(btn.getAttribute('aria-disabled'), 'true');
        assert.ok(btn.className.includes('is-action-locked'));
      }
      assert.equal(drawBtn.className.includes('btn-primary'), false);
      // Align controls must NOT auto-expand while remote, even with non-zero manualYawNudgeDeg
      assert.equal(Boolean(remoteView.queryByTestId('ar-compass-nudge-controls')), false);
      // Visit lock note & recommended Navigate highlight are shown
      assert.ok(remoteView.getByTestId('ar-land-visit-lock-note').textContent.includes('Visit DismalLand in person'));
      assert.ok(remoteView.getByTestId('ar-land-gmaps-link').className.includes('is-recommended'));

      // Clicking EVERY locked button blocks the action AND emits a visit-required notification toast
      RTL.fireEvent.click(drawBtn);
      RTL.fireEvent.click(chatBtn);
      RTL.fireEvent.click(checkInBtn);
      RTL.fireEvent.click(alignBtn);

      assert.equal(fired.draw, 0, 'Remote click on Draw Here must NOT trigger onDrawHere');
      assert.equal(fired.chat, 0, 'Remote click on Land Chat must NOT trigger onOpenLandChat');
      assert.equal(fired.checkIn, 0, 'Remote click on Check In IRL must NOT trigger onCheckInLand');
      assert.equal(
        Boolean(remoteView.queryByTestId('ar-compass-nudge-controls')),
        false,
        'Remote click on Align AR must NOT expand compass nudge controls'
      );
      assert.equal(toasts.length, 4, 'Each locked button tap must emit a visit-required notification');
      assert.ok(toasts[0].message.includes('Visit DismalLand in person to draw on this land'));
      assert.equal(toasts[0].tone, 'warning');
      assert.ok(toasts[0].actionLabel.includes('Navigate'));
      assert.ok(toasts[1].message.includes('Visit DismalLand in person to join Land Chat'));
      assert.ok(toasts[2].message.includes('Visit DismalLand in person to check in IRL'));
      assert.ok(toasts[3].message.includes('Visit DismalLand in person to align this land in AR'));

      // Remote-allowed controls (Manage + View 3D artwork) continue working cleanly
      RTL.fireEvent.click(remoteView.getByTestId('ar-land-manage-btn'));
      RTL.fireEvent.click(remoteView.getByTestId('ar-land-artwork-label'));
      assert.equal(fired.manage, 1);
      assert.equal(fired.inspectArt, 1);
      cleanup();

      // 3) On-site land (isInside: true): all actions unlock and execute normally
      const localView = RTL.render(
        React.createElement(ARLandInspectorPanel, {
          land: {
            ...remoteLand,
            isInside: true,
            outOfArRange: false,
            edgeDistanceMeters: 0,
            edgeDistanceMetersExact: 0,
            distanceMeters: 2
          },
          onDrawHere: () => {
            fired.draw += 1;
          },
          onOpenLandChat: () => {
            fired.chat += 1;
          },
          onCheckInLand: async () => {
            fired.checkIn += 1;
            return true;
          },
          onAdjustCompassNudge: () => {},
          onResetCompassNudge: () => {},
          onClose: () => {}
        })
      );

      assert.equal(Boolean(localView.queryByTestId('ar-land-visit-lock-note')), false);
      const localDraw = localView.getByTestId('ar-land-draw-btn');
      assert.equal(localDraw.getAttribute('data-locked'), 'false');
      assert.ok(localDraw.className.includes('btn-primary'));
      RTL.fireEvent.click(localDraw);
      RTL.fireEvent.click(localView.getByTestId('ar-land-chat-btn'));
      await RTL.act(async () => {
        RTL.fireEvent.click(localView.getByTestId('ar-land-checkin-btn'));
      });
      RTL.fireEvent.click(localView.getByTestId('ar-compass-align-toggle-btn'));
      assert.equal(fired.draw, 1);
      assert.equal(fired.chat, 1);
      assert.equal(fired.checkIn, 1);
      assert.ok(localView.getByTestId('ar-compass-nudge-controls'));
      cleanup();
    } finally {
      unsub();
      cleanup();
    }
  });

  test('Copy link buttons use one-size-up copy icon, gear icons are one size up, and Simple/Quick mode is removed from HUD', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const ownedParcel = {
      parcelId: 'GLAND-ICONSIZE1',
      customName: 'Neon Plaza',
      displayName: 'Neon Plaza',
      centerLat: 39.7285,
      centerLng: -121.8375,
      ownerSub: 'u-me',
      stewardSub: 'u-me',
      stewardUsername: 'bigdog',
      isOwned: true,
      isInside: true,
      edgeDistanceMeters: 0,
      sculptures: [{ id: 'sc-1', title: 'Glow Arch', parcelId: 'GLAND-ICONSIZE1', voxelCount: 40 }]
    };

    // 1) MobileMapSheet: copy link uses clipboard copy icon (1f4cb) at size >= 16, gear icon (2699) at size >= 16
    const mapView = RTL.render(
      React.createElement(MobileMapSheet, {
        user: { id: 'u-me', username: 'bigdog' },
        ownedParcelIds: ['GLAND-ICONSIZE1'],
        config: {},
        location: { lat: 39.7285, lng: -121.8375 },
        areaFilterMode: 'all',
        mapParcels: [ownedParcel],
        displayedMapSculptures: ownedParcel.sculptures,
        areaSculpturesSorted: ownedParcel.sculptures,
        onManageLand: () => {},
        onClose: () => {}
      })
    );
    const shareIcon = mapView.getByTestId('land-card-share-btn').querySelector('img');
    const gearIcon = mapView.getByTestId('land-manage-gear-btn').querySelector('img');
    assert.ok(shareIcon && String(shareIcon.getAttribute('src') || '').includes('1f4cb'), 'Expected clipboard copy icon on land copy-link button');
    assert.ok(Number(shareIcon.getAttribute('width')) >= 16, `Expected upsized copy icon >=16px, got ${shareIcon.getAttribute('width')}`);
    assert.ok(gearIcon && String(gearIcon.getAttribute('src') || '').includes('2699'), 'Expected gear icon on land manage button');
    assert.ok(Number(gearIcon.getAttribute('width')) >= 16, `Expected upsized gear icon >=16px, got ${gearIcon.getAttribute('width')}`);
    cleanup();

    // 2) ARLandInspectorPanel: copy link uses clipboard copy icon (1f4cb) & gear icon (2699) one size up (>= 18px)
    const arView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: ownedParcel,
        onManageLand: () => {},
        onClose: () => {}
      })
    );
    const arCopyIcon = arView.getByTestId('ar-land-copy-link-btn').querySelector('img');
    const arGearIcon = arView.getByTestId('ar-land-manage-btn').querySelector('img');
    assert.ok(arCopyIcon && String(arCopyIcon.getAttribute('src') || '').includes('1f4cb'));
    assert.ok(Number(arCopyIcon.getAttribute('width')) >= 18);
    assert.ok(arGearIcon && String(arGearIcon.getAttribute('src') || '').includes('2699'));
    assert.ok(Number(arGearIcon.getAttribute('width')) >= 18);
    cleanup();

    // 3) StudioHudTopBar: Simple/Quick vs Pro mode toggle pill is completely removed
    const hudView = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u-me', username: 'bigdog' },
        mode: 'draw',
        dockOpen: false,
        location: { lat: 39.7285, lng: -121.8375 },
        voxels: [],
        hasOwnedLand: true,
        ownedLandCount: 1,
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true },
        nearbyCount: 0,
        onOpenAreaMap: () => {}
      })
    );
    const hudText = hudView.container.textContent || '';
    assert.equal(/\bPro\b|\bQuick\b|Simple/i.test(hudText), false, `Expected no Quick/Pro simple-mode pill in StudioHudTopBar, got: ${hudText}`);
    cleanup();
  });

  test('DesktopHub removes dismissible intro banner, Quests tab, and pool/AI steward leaderboard headers while InfoTermsModal houses AI Agent info', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
    const { default: InfoTermsModal } = await loadJsxModule('client/src/components/InfoTermsModal.jsx');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sculptures')) return { ok: true, json: async () => ({ sculptures: [] }) };
      if (u.includes('/api/parcels/mine')) return { ok: true, json: async () => ({ parcels: [], parcelCount: 0 }) };
      if (u.includes('/api/parcels')) return { ok: true, json: async () => ({ parcels: [] }) };
      if (u.includes('/api/marketplace/listings')) return { ok: true, json: async () => ({ listings: [] }) };
      if (u.includes('/api/leaderboard')) return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      if (u.includes('/api/mcp/pairings')) return { ok: true, json: async () => ({ pairings: [], mcpActive: false }) };
      if (u.includes('/api/signatures/pending')) return { ok: true, json: async () => ({ requests: [] }) };
      if (u.includes('/api/notifications')) return { ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) };
      return { ok: true, json: async () => ({}) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          config: { policy: {} },
          user: { id: 'u1', username: 'bigdog', walletAddress: '0x1111111111111111111111111111111111111111' },
          onUserUpdate: () => {},
          onLogout: () => {}
        })
      );

      // 1) Closeable DesktopIntroBanner is gone
      assert.equal(Boolean(view.queryByLabelText('Desktop Introduction and Agent Connection')), false);

      // 2) Quests tab is removed
      assert.equal(Boolean(view.queryByRole('button', { name: /Quests/i })), false);

      // 3) Leaders button is removed and replaced by top-menu trophy icon (nav-leaderboard-btn);
      //    Leaderboard omits "Human Street Artists (2% Contributor Pool)" and "AI Land Stewards (3% Steward Royalties)"
      assert.equal(Boolean(view.queryByRole('button', { name: /Leaders/i })), false);
      RTL.fireEvent.click(view.getByTestId('nav-leaderboard-btn'));
      const leadersText = view.getByLabelText('Creator Leaderboard').textContent || '';
      assert.equal(leadersText.includes('Human Street Artists (2% Contributor Pool)'), false);
      assert.equal(leadersText.includes('AI Land Stewards (3% Steward Royalties)'), false);
      assert.equal(leadersText.includes('No AI stewards registered yet'), false);

      // 4) MapView3D compact controls float directly inside .map-container (no separate .map3d-toolbar above it)
      assert.equal(Boolean(view.container.querySelector('.map3d-toolbar')), false);
      const overlayToolbar = view.getByTestId('map3d-overlay-toolbar');
      assert.ok(view.container.querySelector('.map-container')?.contains(overlayToolbar));
      assert.equal(Boolean(view.queryByRole('button', { name: /^Isometric$/i })), false);
      assert.equal(Boolean(view.queryByRole('button', { name: /Draw Land/i })), false);
      assert.equal(Boolean(view.queryByTestId('map3d-orbit-pan-toggle')), false);
      assert.equal(Boolean(view.queryByTestId('map3d-zoom-out-btn')), false);
      assert.equal(Boolean(view.queryByRole('button', { name: /North/i })), false);
      cleanup();

      // 5) InfoTermsModal houses the moved AI Agents & Collectors guide (prompts, MCP config, /llms.txt, agent.json)
      const infoView = RTL.render(
        React.createElement(InfoTermsModal, {
          config: { policy: {} },
          user: { id: 'u1', username: 'bigdog', walletAddress: '0x1111111111111111111111111111111111111111' },
          initialTab: 'guide',
          initialViewportGuide: 'agents',
          onOpenWelcome: () => {},
          onOpenPair: () => {},
          onClose: () => {}
        })
      );
      const agentsPanel = infoView.getByTestId('info-guide-agents');
      assert.ok(agentsPanel.textContent.includes('Copy Property-Agent Prompt'));
      assert.ok(agentsPanel.textContent.includes('Copy Autonomous Agent Prompt'));
      assert.ok(agentsPanel.textContent.includes('MCP Config'));
      assert.ok(agentsPanel.textContent.includes('/llms.txt'));
      assert.ok(agentsPanel.textContent.includes('agent.json'));
      assert.ok(agentsPanel.textContent.includes('Collectors'));
      assert.ok(infoView.getByTestId('info-reopen-intro-btn'));
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Notification bell reliably shows numeric counts across unread alerts, async pending approvals, and peek/close cycles; clicking approval row opens preview', async () => {
    const notifMod = await loadJsxModule('client/src/components/NotificationCenter.jsx');
    const { NotificationProvider, GlobalNotificationBell } = notifMod;

    const ownerUser = {
      id: 'u-bell-1',
      name: 'Bell Owner',
      walletAddress: '0x1111111111111111111111111111111111111111'
    };
    const pendingReq1 = {
      id: 'sigreq-bell-1',
      status: 'pending',
      action: 'create_sculpture',
      parcelId: 'GLAND-BELL01',
      landDisplayName: 'Echo Plaza',
      summaryTitle: 'Place "Neon Dragon"',
      agentName: 'VoxelBot',
      payload: {
        title: 'Neon Dragon',
        modelFormat: 'glb',
        hasAttachedModel: true
      },
      createdAt: new Date().toISOString()
    };
    const pendingReq2 = {
      id: 'sigreq-bell-2',
      status: 'pending',
      action: 'create_sculpture',
      parcelId: 'GLAND-BELL01',
      landDisplayName: 'Echo Plaza',
      summaryTitle: 'Place "Crystal Arch"',
      agentName: 'VoxelBot',
      payload: {
        title: 'Crystal Arch',
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }]
      },
      createdAt: new Date().toISOString()
    };

    const origFetch = globalThis.fetch;
    const markedReadIds = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/notifications/read') && opts.method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        if (Array.isArray(body.ids)) markedReadIds.push(...body.ids);
        return { ok: true, status: 200, json: async () => ({ unreadCount: 0 }) };
      }
      if (u.includes('/api/notifications')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            unreadCount: 2,
            preferences: {
              sculpture_on_land: true,
              mint_slots_unlocked: true,
              mint_limit_reached: true,
              land_expiring: true,
              land_activity: true,
              browser_push_enabled: false
            },
            notifications: [
              {
                id: 'n-bell-approval-1',
                category: 'land_activity',
                severity: 'action',
                title: '✍️ Approval needed: Place "Neon Dragon"',
                message: 'VoxelBot requested placing Neon Dragon.',
                parcelId: 'GLAND-BELL01',
                actionType: 'open_land_approval',
                actionLabel: 'Preview on Land',
                meta: {
                  requestId: 'sigreq-bell-1',
                  action: 'create_sculpture',
                  hasSculpturePreview: true
                },
                read: false,
                createdAt: new Date().toISOString()
              },
              {
                id: 'n-bell-art-1',
                category: 'sculpture_on_land',
                severity: 'info',
                title: '🎨 New art "Star Totem" on "Echo Plaza"',
                message: '@maya added art to your land.',
                parcelId: 'GLAND-BELL01',
                sculptureId: 'sc-star-1',
                actionType: 'open_sculpture',
                actionLabel: 'View Art',
                meta: { sculptureUrl: '?sculpture=sc-star-1', parcelUrl: '?parcel=GLAND-BELL01' },
                read: false,
                createdAt: new Date().toISOString()
              }
            ]
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      const dispatched = [];
      const renderTree = (pendingList, loaded) =>
        React.createElement(
          NotificationProvider,
          {
            user: ownerUser,
            variant: 'desktop',
            pendingApprovals: pendingList,
            pendingApprovalsLoaded: loaded,
            onAction: (act) => dispatched.push(act)
          },
          React.createElement(GlobalNotificationBell, { testId: 'test-bell-btn' })
        );

      // 1) Startup before parent finishes fetching pendingApprovals (pendingApprovals=[], loaded=false):
      //    unread approval alert is NOT dropped — bell badge immediately shows "2"!
      const view = RTL.render(renderTree([], false));
      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('notif-unread-badge').textContent, '2');
      });

      // 2) Parent finishes fetching 2 pending approvals (1 persisted + 1 synthetic) -> bell shows "3" (1 regular + 2 pending)
      view.rerender(renderTree([pendingReq1, pendingReq2], true));
      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('notif-unread-badge').textContent, '3');
      });

      // 3) Opening Inbox marks ONLY the non-approval alert read -> bell STILL shows "2" for the 2 pending approvals!
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByTestId('test-bell-btn'));
      });
      await RTL.waitFor(() => {
        assert.equal(markedReadIds.includes('n-bell-art-1'), true);
        assert.equal(markedReadIds.includes('n-bell-approval-1'), false);
        assert.equal(view.getByTestId('notif-unread-badge').textContent, '2');
      });

      // 4) Clicking the approval notification row itself (not only the Preview button) opens preview_pending_sculpture
      const approvalRow = globalThis.document.querySelector('[data-request-id="sigreq-bell-1"]');
      assert.ok(approvalRow);
      RTL.fireEvent.click(approvalRow);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].actionType, 'preview_pending_sculpture');
      assert.equal(dispatched[0].pendingRequest?.id, 'sigreq-bell-1');

      // 5) Even after closing popover to preview, bell STILL shows "2" until approved/rejected!
      assert.equal(view.getByTestId('notif-unread-badge').textContent, '2');

      // 6) Resolving 1 pending approval drops badge to "1"; resolving the last clears it cleanly
      view.rerender(renderTree([pendingReq2], true));
      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('notif-unread-badge').textContent, '1');
      });
      view.rerender(renderTree([], true));
      await RTL.waitFor(() => {
        assert.equal(Boolean(view.queryByTestId('notif-unread-badge')), false);
      });
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Isometric preview framing centers models cleanly and both label & notification preview paths open the zoomed-in isometric approval modal', async () => {
    const {
      computeIsometricModelFraming,
      ISOMETRIC_AZIMUTH_DEG,
      ISOMETRIC_ELEVATION_DEG,
      ISOMETRIC_PREVIEW_FOV_DEG
    } = await import('../client/src/utils/isometricCameraFraming.js');
    const { buildPendingPreviewSculpture } = await import(
      '../client/src/utils/pendingApprovalPreview.js'
    );
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );
    const { default: PlotVisitView } = await loadJsxModule(
      'client/src/components/PlotVisitView.jsx'
    );

    // 1) Pure isometric framing geometry: exact 45° azimuth & 35.264° elevation, tight zoomed-in scale
    const smallFrame = computeIsometricModelFraming({ width: 1.0, height: 1.0, depth: 1.0, aspect: 1.6 });
    const bigFrame = computeIsometricModelFraming({ width: 4.0, height: 4.0, depth: 4.0, aspect: 1.6 });
    assert.equal(smallFrame.fov, ISOMETRIC_PREVIEW_FOV_DEG);
    assert.equal(smallFrame.azimuthDeg, ISOMETRIC_AZIMUTH_DEG);
    assert.equal(smallFrame.elevationDeg, ISOMETRIC_ELEVATION_DEG);
    const dx = smallFrame.position[0] - smallFrame.target[0];
    const dy = smallFrame.position[1] - smallFrame.target[1];
    const dz = smallFrame.position[2] - smallFrame.target[2];
    assert.ok(Math.abs(dx - dz) < 0.001, '45° azimuth should place camera equidistant on X and Z');
    const elevDeg = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    assert.ok(
      Math.abs(elevDeg - ISOMETRIC_ELEVATION_DEG) < 0.1,
      `Expected isometric elevation ~${ISOMETRIC_ELEVATION_DEG}°, got ${elevDeg.toFixed(2)}°`
    );
    assert.ok(
      smallFrame.distance < 4.5 && bigFrame.distance > smallFrame.distance * 3.5,
      'Camera distance should zoom tightly and scale proportionally with model dimensions'
    );
    assert.ok(Math.abs(smallFrame.target[1] - 0.48) < 0.001);

    // 2) R2-staged attached custom model without inline base64 or local parcel coords still builds preview when allowFallbackCoords=true
    const stagedReq = {
      id: 'sigreq-r2-iso-1',
      status: 'pending',
      action: 'create_sculpture',
      parcelId: 'GLAND-ISO01',
      landDisplayName: 'Sky Garden',
      summaryTitle: 'Place "Obsidian Owl"',
      agentName: 'SculptAgent',
      expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
      payload: {
        title: 'Obsidian Owl',
        description: 'A sleek obsidian owl perched on a lantern.',
        hasAttachedModel: true,
        modelScale: 1.2
      }
    };
    assert.equal(buildPendingPreviewSculpture(stagedReq, { parcels: [] }), null);
    const previewSc = buildPendingPreviewSculpture(stagedReq, {
      parcels: [],
      allowFallbackCoords: true
    });
    assert.ok(previewSc);
    assert.equal(previewSc.modelType, 'custom-3d');
    assert.equal(previewSc.customModel.format, 'glb');
    assert.ok(previewSc.customModel.proxyUrl.includes('sigreq-r2-iso-1/preview-model'));

    const parcel = {
      parcelId: 'GLAND-ISO01',
      customName: 'Sky Garden',
      ownerSub: 'u-iso-1',
      centerLat: 37.775,
      centerLng: -122.419,
      volume: {
        parcelId: 'GLAND-ISO01',
        centerLat: 37.775,
        centerLng: -122.419,
        widthMeters: 24,
        depthMeters: 24,
        heightMeters: 28
      }
    };
    const ownerUser = { id: 'u-iso-1', username: 'bigdog', name: 'BigDog' };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/signatures/pending')) {
        return { ok: true, status: 200, json: async () => ({ requests: [stagedReq] }) };
      }
      if (u.includes('/api/lands/GLAND-ISO01')) {
        return { ok: true, status: 200, json: async () => ({ parcel, sculptures: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, parcels: [parcel] }) };
    };

    try {
      // 3) Clicking the PlotVisitView "Preview" label opens the 3D isometric approval modal directly on first click
      const openedFromLabel = [];
      const plotView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures: [],
          allParcels: [parcel],
          user: ownerUser,
          ownedParcelIds: ['GLAND-ISO01'],
          onSelectSculpture: (sc) => openedFromLabel.push(sc),
          onClose: () => {}
        })
      );
      await RTL.waitFor(() => {
        assert.ok(plotView.getAllByTestId('plot-preview-label').length >= 1);
      });
      RTL.fireEvent.click(plotView.getAllByTestId('plot-preview-label')[0]);
      assert.equal(openedFromLabel.length, 1);
      assert.equal(openedFromLabel[0].isPendingPreview, true);
      assert.equal(openedFromLabel[0].pendingRequestId, 'sigreq-r2-iso-1');
      cleanup();

      // 4) SculptureModal in pending preview mode defaults to zoomed-in isometric view (NOT zoomed-out land bounds)
      //    and toggles cleanly between Isometric Model and On Land views with Approve / Reject / Open Land ready
      const selectedParcels = [];
      const modalView = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: openedFromLabel[0],
          user: ownerUser,
          config: {},
          allParcels: [parcel],
          onSelectParcel: (p) => selectedParcels.push(p),
          onApprovePending: () => {},
          onRejectPending: () => {},
          onClose: () => {}
        })
      );

      const viewerEl = modalView.getByTestId('sculpture-viewer-3d');
      assert.equal(viewerEl.getAttribute('data-camera-mode'), 'isometric');
      assert.equal(viewerEl.getAttribute('data-land-bounds-preview'), 'off');
      assert.ok(modalView.getByTestId('preview-camera-toolbar'));
      assert.ok(modalView.getByTestId('preview-cam-iso-btn'));
      assert.ok(modalView.getByTestId('preview-cam-land-btn'));
      assert.ok(modalView.getByTestId('preview-cam-reset-btn'));
      assert.ok(modalView.getByTestId('preview-modal-approve-btn'));
      assert.ok(modalView.getByTestId('preview-modal-reject-btn'));

      // Switch to On Land view -> back to Isometric view
      RTL.fireEvent.click(modalView.getByTestId('preview-cam-land-btn'));
      assert.equal(viewerEl.getAttribute('data-camera-mode'), 'land');
      assert.equal(viewerEl.getAttribute('data-land-bounds-preview'), 'on');

      RTL.fireEvent.click(modalView.getByTestId('preview-cam-iso-btn'));
      assert.equal(viewerEl.getAttribute('data-camera-mode'), 'isometric');
      assert.equal(viewerEl.getAttribute('data-land-bounds-preview'), 'off');

      // Optional Open Land button navigates cleanly to the parcel
      RTL.fireEvent.click(modalView.getByTestId('preview-modal-open-land-btn'));
      assert.equal(selectedParcels.length, 1);
      assert.equal(selectedParcels[0].parcelId, 'GLAND-ISO01');
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('ProfileModal shows organized Land Mints Allowed breakdown with "i" details for owner (and hides it on other profiles)', async () => {
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');

    const ownerUser = {
      id: 'u-mint-profile',
      username: 'bigdog',
      name: 'BigDog',
      walletAddress: '0x1111111111111111111111111111111111111111'
    };
    const ownerProfilePayload = {
      profile: {
        id: 'u-mint-profile',
        userNumber: 7,
        userNumberLabel: '#0007',
        username: 'bigdog',
        displayName: '@bigdog',
        bio: 'Sculpting the city',
        walletAddress: ownerUser.walletAddress,
        accountType: 'human',
        joinedAt: '2026-01-15T00:00:00.000Z'
      },
      stats: {
        landCount: 3,
        sculptureCount: 5,
        totalBlocks: 420,
        actionCount: 8,
        awakenedLands: 1
      },
      mintStatus: {
        usedSlots: 2,
        forfeitedSlots: 0,
        maxSlots: 21,
        remainingSlots: 19,
        canMintDesktop: true,
        canClaimInPersonMobile: true,
        unbuiltParcels: [
          { parcelId: 'GLAND-UNB1', displayName: 'DismalLand' },
          { parcelId: 'GLAND-UNB2', displayName: 'Neon Corner' }
        ],
        totalOwnedParcels: 3
      },
      lands: [],
      sculptures: [],
      listings: [],
      actions: []
    };

    const openedLands = [];
    let mintGuideOpened = false;
    const view = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'bigdog',
        user: ownerUser,
        fetchProfileFn: async () => ownerProfilePayload,
        onOpenLand: (land) => openedLands.push(land),
        onOpenMintGuide: () => {
          mintGuideOpened = true;
        },
        onClose: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('profile-mint-allowance'));
    });
    assert.equal(view.getByTestId('profile-mint-status-pill').textContent.trim(), '19 / 21 open');
    assert.equal(view.getByTestId('profile-mint-remaining-val').textContent.trim(), '19');
    assert.equal(view.getByTestId('profile-mint-unbuilt-val').textContent.trim(), '2');
    assert.ok(
      view
        .getByTestId('profile-mint-summary')
        .textContent.includes('mint 19 more Desktop lands before needing human AR art')
    );

    // Extra details & unbuilt lands live cleanly inside the "i" InfoTip
    assert.equal(Boolean(view.queryByText(/28 days/i)), false);
    RTL.fireEvent.click(view.getByRole('button', { name: /Info: How Land Mint Allowances Work/i }));
    await RTL.waitFor(() => {
      assert.ok(view.getByText(/28 days/i));
      assert.ok(view.getByText(/Mobile AR \(Unlimited/i));
      assert.ok(view.getByText(/DismalLand/i));
    });

    // Clicking an unbuilt land inside "i" jumps straight to that land
    RTL.fireEvent.click(view.getByRole('button', { name: /DismalLand/i }));
    assert.equal(openedLands.length, 1);
    assert.equal(openedLands[0].parcelId, 'GLAND-UNB1');

    // Optional Mint Land shortcut works cleanly
    RTL.fireEvent.click(view.getByTestId('profile-mint-guide-btn'));
    assert.equal(mintGuideOpened, true);
    cleanup();

    // Viewing someone else's public profile does NOT show private mint allowance card
    const otherView = RTL.render(
      React.createElement(ProfileModal, {
        handle: 'maya',
        user: ownerUser,
        fetchProfileFn: async () => ({
          ...ownerProfilePayload,
          profile: { ...ownerProfilePayload.profile, id: 'u-other', username: 'maya', displayName: '@maya' }
        }),
        onClose: () => {}
      })
    );
    await RTL.waitFor(() => {
      assert.equal(otherView.getByTestId('profile-handle').textContent.trim(), '@maya');
    });
    assert.equal(Boolean(otherView.queryByTestId('profile-mint-allowance')), false);
    cleanup();
  });

  test('SculptureModal Location & Virtual Land mini-map uses the real oriented land boundary and renders no neighbor tags', async () => {
    const { resolveMiniMapLandBoundary } = await import(
      '../client/src/utils/landPreviewHelpers.js'
    );
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    // Real custom land centered on roundabout (rotated 25°), while legacy sculpture.parcelBounds is shifted far off
    const realParcel = {
      parcelId: 'GLAND-CIRCLE1',
      customName: 'CIRCLE LAND',
      volume: {
        parcelId: 'GLAND-CIRCLE1',
        centerLat: 39.73322,
        centerLng: -121.84035,
        widthMeters: 26,
        depthMeters: 26,
        heightMeters: 18,
        rotationDeg: 25
      }
    };
    const neighborParcel = {
      parcelId: 'GLAND-BARK1',
      customName: 'BARKINGLOT',
      volume: {
        parcelId: 'GLAND-BARK1',
        centerLat: 39.7305,
        centerLng: -121.8412,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 14,
        rotationDeg: 0
      }
    };
    const sculpture = {
      id: 'sc-circle-1',
      title: 'Roundabout Totem',
      description: 'Centered on CIRCLE LAND.',
      parcelId: 'GLAND-CIRCLE1',
      parcelName: 'CIRCLE LAND',
      lat: 39.73322,
      lng: -121.84035,
      // Deliberately stale/wrong geohash cell shifted northwest of the real land
      parcelBounds: {
        sw: [39.73343, -121.84078],
        ne: [39.73378, -121.84021]
      },
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }]
    };

    // 1) Pure resolver prefers the real oriented parcel volume over legacy sculpture.parcelBounds
    const boundary = resolveMiniMapLandBoundary({
      parcelDetail: realParcel,
      allParcels: [realParcel, neighborParcel],
      sculpture
    });
    assert.equal(boundary.hasVolumeBoundary, true);
    assert.equal(boundary.latLngCorners.length, 4);
    // Real rotated corners are NOT axis-aligned (distinct latitudes on adjacent corners)
    const uniqueLats = new Set(boundary.latLngCorners.map((p) => p[0].toFixed(6)));
    assert.ok(uniqueLats.size >= 3, 'Rotated land volume should preserve its oriented polygon corners');
    // SW coordinate comes from the real land volume, NOT the shifted legacy parcelBounds.sw (39.73343)
    assert.ok(boundary.sw[0] < 39.73322, 'SW latitude should sit south of the real land center');
    assert.notEqual(boundary.sw[0].toFixed(5), '39.73343');

    // 2) Rendered SculptureModal mini-map uses volume boundary SW caption and shows ZERO neighbor arrow tags
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/GLAND-CIRCLE1')) {
        return { ok: true, status: 200, json: async () => ({ parcel: realParcel, sculptures: [sculpture] }) };
      }
      if (u.includes('/api/sculptures/sc-circle-1')) {
        return { ok: true, status: 200, json: async () => ({ sculpture, transfers: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(SculptureModal, {
          sculpture,
          user: null,
          config: {},
          isDesktop: true,
          allParcels: [realParcel, neighborParcel],
          onClose: () => {}
        })
      );

      const mapWrap = view.getByTestId('mini-land-map-wrap');
      assert.equal(mapWrap.getAttribute('data-boundary-source'), 'volume');
      const swText = view.getByTestId('mini-land-map-sw').textContent || '';
      assert.ok(swText.includes(boundary.sw[0].toFixed(5)));
      assert.equal(swText.includes('39.73343'), false);

      // No neighbor arrow tags rendered on the mini-map view
      assert.equal(Boolean(view.container.querySelector('.neighbor-edge-arrows-layer')), false);
      assert.equal(Boolean(view.queryByText(/BARKINGLOT/i)), false);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('LandManagementModal displays Auto vs Custom Override ORB calibration, pack status, lighting slots, and preserves Auto mode on save', async () => {
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );
    const ownerUser = {
      id: 'user-orb-ui-1',
      name: 'Orb Tuner',
      walletAddress: '0x9999999999999999999999999999999999999001'
    };
    const securityPayloads = [];
    const parcelNoPack = {
      parcelId: 'GLAND-NOPACK01',
      geohash: 'nopack01',
      customName: 'Browser Meadow',
      description: 'Created from browser map',
      settings: { allowAgentErase: true, allowContributorEdits: true, requireApproval: false, frozen: false },
      securityPolicy: {
        parcelId: 'GLAND-NOPACK01',
        requirePasskeyUnlock: false,
        requireOrbUnlock: false,
        minOrbInliers: 4,
        maxReprojErrPx: 12.0,
        originSource: 'browser_map',
        envTier: 'open_nature',
        autoMinOrbInliers: 4,
        autoMaxReprojErrPx: 12.0,
        overrideFlag: false,
        isAuto: true,
        lightingAdaptive: true,
        hasLandmarkPack: false,
        lightingSlots: []
      },
      landmarkAnchor: { hasLandmark: false, keyframeCount: 0, featureCount: 0, lightingSlots: [] },
      contributors: [],
      eligibleVisitors: [],
      sculptures: []
    };
    const parcelCalibrated = {
      parcelId: 'GLAND-URBAN001',
      geohash: 'urban001',
      customName: 'Urban Brick Wall',
      description: 'Scanned day and night',
      settings: { allowAgentErase: true, allowContributorEdits: true, requireApproval: false, frozen: false },
      securityPolicy: {
        parcelId: 'GLAND-URBAN001',
        requirePasskeyUnlock: false,
        requireOrbUnlock: true,
        minOrbInliers: 9,
        maxReprojErrPx: 5.5,
        originSource: 'mobile_ar',
        envTier: 'dense_urban',
        autoMinOrbInliers: 9,
        autoMaxReprojErrPx: 5.5,
        overrideFlag: false,
        isAuto: true,
        lightingAdaptive: true,
        hasLandmarkPack: true,
        lightingSlots: ['daylight', 'lowlight']
      },
      landmarkAnchor: {
        hasLandmark: true,
        keyframeCount: 6,
        featureCount: 44,
        lightingSlots: ['daylight', 'lowlight']
      },
      contributors: [],
      eligibleVisitors: [],
      sculptures: []
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = String(opts.method || 'GET').toUpperCase();
      if (u.includes('/api/lands/mine')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ownerAddress: ownerUser.walletAddress,
            parcelCount: 2,
            parcels: [parcelNoPack, parcelCalibrated]
          })
        };
      }
      if (u.includes('/api/passkeys/status')) {
        return { ok: true, status: 200, json: async () => ({ passkeys: [] }) };
      }
      if (u.includes('/security') && method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        securityPayloads.push({ url: u, body });
        return { ok: true, status: 200, json: async () => ({ policy: body }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(LandManagementModal, {
          user: ownerUser,
          initialParcelId: 'GLAND-NOPACK01',
          onClose: () => {}
        })
      );

      // 1) Packless browser land shows Auto (Open Nature), No ORB Pack — Scan on Mobile, and non-blocking note
      await RTL.waitFor(() => {
        assert.ok(view.getByTestId('orb-calibration-mode-badge'));
      });
      assert.equal(view.getByTestId('orb-calibration-mode-badge').textContent, 'Auto (Open Nature)');
      assert.match(view.getByTestId('orb-pack-status-badge').textContent || '', /No ORB Pack/i);
      assert.ok(view.getByTestId('orb-nopack-cta'));

      // Saving in Auto mode MUST send useAuto:true and MUST NOT leak manual thresholds
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByTestId('land-mgmt-save-settings-btn'));
      });
      await RTL.waitFor(() => assert.equal(securityPayloads.length, 1));
      assert.equal(securityPayloads[0].body.useAuto, true);
      assert.equal(securityPayloads[0].body.overrideFlag, false);
      assert.equal(securityPayloads[0].body.minOrbInliers, undefined);
      assert.equal(securityPayloads[0].body.maxReprojErrPx, undefined);

      // 2) Editing maxReprojErrPx flips badge immediately to Custom Override and sends custom thresholds on save
      const maxErrInput = view.getByLabelText('Max ORB reprojection error px');
      const minInliersInput = view.getByLabelText('Minimum ORB inliers');
      RTL.fireEvent.change(minInliersInput, { target: { value: '12' } });
      RTL.fireEvent.change(maxErrInput, { target: { value: '4.5' } });
      assert.equal(view.getByTestId('orb-calibration-mode-badge').textContent, 'Custom Override');

      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByTestId('land-mgmt-save-settings-btn'));
      });
      await RTL.waitFor(() => assert.equal(securityPayloads.length, 2));
      assert.equal(securityPayloads[1].body.useAuto, false);
      assert.equal(securityPayloads[1].body.overrideFlag, true);
      assert.equal(securityPayloads[1].body.minOrbInliers, 12);
      assert.equal(securityPayloads[1].body.maxReprojErrPx, 4.5);

      // 3) Switching to calibrated Urban parcel shows Auto (Dense Urban) + Day + Night slots & hides no-pack CTA
      RTL.fireEvent.click(view.getByRole('tab', { name: /Urban Brick Wall/i }));
      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('orb-calibration-mode-badge').textContent, 'Auto (Dense Urban)');
      });
      assert.match(view.getByTestId('orb-pack-status-badge').textContent || '', /44 pts · Day \+ Night/);
      assert.equal(view.queryByTestId('orb-nopack-cta'), null);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('PlotVisitView hides details by default, removes Copy Share Link, adds Navigate icon to land labels, and centers tags isometrically', async () => {
    const { default: PlotVisitView } = await loadJsxModule(
      'client/src/components/PlotVisitView.jsx'
    );
    const { computeSculptureIsometricCameraFit, resolveParcelVolume } = await import(
      '../client/src/utils/landPreviewHelpers.js'
    );

    const stibblezParcel = {
      parcelId: 'GLAND-STIBB001',
      customName: 'Stibblez Land',
      description: 'Isometric art plaza',
      centerLat: 39.7302,
      centerLng: -121.8406,
      volume: {
        centerLat: 39.7302,
        centerLng: -121.8406,
        widthMeters: 18,
        depthMeters: 16,
        heightMeters: 14,
        rotationDeg: 15
      }
    };
    const neighborParcel = {
      parcelId: 'GLAND-BARK0002',
      customName: 'BARKINGLOT',
      centerLat: 39.7319,
      centerLng: -121.8421,
      volume: {
        centerLat: 39.7319,
        centerLng: -121.8421,
        widthMeters: 14,
        depthMeters: 14,
        heightMeters: 12,
        rotationDeg: 0
      }
    };
    const sculptures = [
      {
        id: 'sc-stibblez',
        parcelId: 'GLAND-STIBB001',
        title: 'Stibblez',
        voxelCount: 2478,
        lat: 39.7302,
        lng: -121.8406,
        anchorOffset: { dx: 4.5, dy: 0, dz: -3.2, yaw: 0 }
      },
      {
        id: 'sc-coffee',
        parcelId: 'GLAND-STIBB001',
        title: 'Turkey Day 2026 Coffee',
        modelType: 'custom-3d',
        customModel: { format: 'glb', scale: 1.2 },
        lat: 39.7302,
        lng: -121.8406,
        anchorOffset: { dx: -5.0, dy: 0, dz: 3.0, yaw: 0 }
      }
    ];

    // 1) computeSculptureIsometricCameraFit centers squarely on the offset 3D sculpture isometrically (pitch 55°)
    const stibVol = resolveParcelVolume(stibblezParcel);
    const objFit = computeSculptureIsometricCameraFit(sculptures[0], stibVol, {
      viewportWidth: 960,
      viewportHeight: 600
    });
    assert.ok(objFit);
    assert.equal(objFit.pitch, 55);
    assert.equal(objFit.bearing, -30); // rotationDeg (15) - 45
    assert.notEqual(
      Number(objFit.center[0]).toFixed(6),
      Number(stibVol.centerLng).toFixed(6),
      'Object isometric center must reflect anchorOffset dx/dz, not just land center'
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/GLAND-BARK0002')) {
        return { ok: true, status: 200, json: async () => ({ parcel: neighborParcel, sculptures: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel: stibblezParcel,
          sculptures,
          allParcels: [stibblezParcel, neighborParcel],
          userLocation: { lat: 39.7305, lng: -121.8409 },
          onClose: () => {}
        })
      );

      // 2) Details are hidden by default & stage gets expanded isometric view
      assert.equal(view.queryByTestId('plot-land-details'), null);
      assert.match(view.getByTestId('plot-details-toggle').textContent || '', /Show Details/i);
      const mapEl = view.getByTestId('mobile-iso-3d-map');
      const initLandTick = Number(mapEl.getAttribute('data-focus-tick') || 0);
      const initObjTick = Number(mapEl.getAttribute('data-focus-sculpture-tick') || 0);

      // 3) Land label includes the Navigate (🧭) icon pointing to Google Maps directions
      const landNavBtn = view.getByTestId('plot-land-label-nav-btn');
      assert.ok(
        landNavBtn.getAttribute('href')?.includes('google.com/maps/dir') &&
          landNavBtn.getAttribute('href')?.includes('39.730200'),
        `Expected land label Navigate link to point to Stibblez Land coords, got: ${landNavBtn.getAttribute('href')}`
      );

      // 4) Clicking an artwork tag focuses & centers that object isometrically while keeping details hidden
      const artLabels = view.getAllByTestId('plot-artwork-label');
      RTL.fireEvent.click(artLabels[0]);
      assert.equal(mapEl.getAttribute('data-focused-sculpture-id'), 'sc-stibblez');
      assert.equal(Number(mapEl.getAttribute('data-focus-sculpture-tick')), initObjTick + 1);
      assert.equal(view.queryByTestId('plot-artwork-details'), null, 'Details stay hidden by default');

      // 5) Clicking active land label re-centers the land isometrically while keeping details hidden
      RTL.fireEvent.click(view.getByTestId('plot-land-label'));
      assert.equal(Number(mapEl.getAttribute('data-focus-tick')), initLandTick + 1);
      assert.equal(mapEl.getAttribute('data-focused-sculpture-id'), '');
      assert.equal(view.queryByTestId('plot-land-details'), null);

      // 6) Clicking a neighboring land arrow switches to that land, centers it isometrically, and keeps details hidden
      const neighborArrows = view.getAllByTestId('neighbor-edge-arrow');
      assert.ok(neighborArrows.length >= 1);
      await RTL.act(async () => {
        RTL.fireEvent.click(neighborArrows[0]);
      });
      await RTL.waitFor(() => {
        assert.equal(mapEl.getAttribute('data-focused-parcel-id'), 'GLAND-BARK0002');
      });
      assert.ok(Number(mapEl.getAttribute('data-focus-tick')) > initLandTick + 1);
      assert.equal(view.queryByTestId('plot-land-details'), null);

      // 7) Expanding details confirms "Copy Share Link" button is removed
      RTL.fireEvent.click(view.getByTestId('plot-details-toggle'));
      assert.ok(view.getByTestId('plot-land-details'));
      assert.equal(view.queryByText(/Copy Share Link/i), null);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('Redundant 3D buttons are removed on artworks and mobile HUD/Publish modal clearly indicate adding art to an existing land', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { default: ProfileModal } = await loadJsxModule(
      'client/src/components/ProfileModal.jsx'
    );
    const { default: PlotVisitView } = await loadJsxModule(
      'client/src/components/PlotVisitView.jsx'
    );
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );

    const sampleSc = {
      id: 'sc-art-no3d-1',
      title: 'Turkey Day 2026 Coffee',
      description: 'Hot latte in 3D.',
      parcelId: 'GLAND-STIBBLEZ',
      parcelName: 'Stibblez Land',
      modelType: 'custom-3d',
      customModel: { format: 'glb', url: 'https://example.com/coffee.glb' },
      voxelCount: 0,
      polScore: 95,
      creatorSub: 'u-bigdog',
      creatorUsername: 'bigdog',
      creatorName: 'bigdog',
      createdAt: '2026-11-26T00:00:00Z'
    };

    const stibblezLand = {
      parcelId: 'GLAND-STIBBLEZ',
      geohash: '9r4p1234',
      displayName: 'Stibblez Land',
      customName: 'Stibblez Land',
      centerLat: 39.7302,
      centerLng: -121.8406,
      isInside: true,
      isNear: true,
      isFrozen: false,
      isOwned: false,
      edgeDistanceMeters: 0,
      distanceMeters: 0,
      sculptures: [sampleSc],
      volume: {
        parcelId: 'GLAND-STIBBLEZ',
        centerLat: 39.7302,
        centerLng: -121.8406,
        widthMeters: 54.25,
        depthMeters: 35.66,
        heightMeters: 11,
        rotationDeg: 0
      }
    };

    // 1) ARLandInspectorPanel: no "View 3D" button; clicking the artwork item window opens it directly
    const arOpened = [];
    const arView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: stibblezLand,
        nearbyLands: [stibblezLand],
        onInspectSculpture: (sc) => arOpened.push(sc.id),
        onClose: () => {}
      })
    );
    assert.equal(arView.queryByText(/View 3D/i), null);
    const scRow = arView.getByTestId('ar-land-sculpture-row');
    RTL.fireEvent.click(scRow);
    assert.deepEqual(arOpened, ['sc-art-no3d-1']);
    cleanup();

    // 2) ProfileModal Sculptures tab: no "Review 3D" button; clicking the artwork card opens it directly
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    try {
      const profileOpened = [];
      const profView = RTL.render(
        React.createElement(ProfileModal, {
          handle: 'bigdog',
          user: { id: 'u-bigdog', username: 'bigdog' },
          config: {},
          fetchProfileFn: async () => ({
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
              walletAddress: '0x1111111111111111111111111111111111111111',
              stats: { landsCount: 0, sculpturesCount: 1, totalBlocks: 0, xp: 100 }
            },
            lands: [],
            sculptures: [sampleSc],
            listings: [],
            actions: []
          }),
          onSelectSculpture: (sc) => profileOpened.push(sc.id),
          onClose: () => {}
        })
      );
      const scCard = await profView.findByTestId('profile-sculpture-item');
      assert.equal(profView.queryByText(/Review 3D/i), null);
      RTL.fireEvent.click(scCard);
      assert.deepEqual(profileOpened, ['sc-art-no3d-1']);
      cleanup();

      // 3) PlotVisitView artwork detail card: no redundant "Inspect Full 3D" button
      const plotView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel: stibblezLand,
          sculptures: [sampleSc],
          allParcels: [stibblezLand],
          onSelectSculpture: () => {},
          onClose: () => {}
        })
      );
      RTL.fireEvent.click(plotView.getByTestId('plot-artwork-label'));
      RTL.fireEvent.click(plotView.getByTestId('plot-details-toggle'));
      assert.ok(plotView.getByTestId('plot-artwork-details'));
      assert.equal(plotView.queryByTestId('plot-open-artwork-viewer-btn'), null);
      assert.equal(plotView.queryByText(/Inspect Full 3D/i), null);
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }

    // 4) StudioHudTopBar in draw mode inside existing land (normal + frozen)
    const hudDraw = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u-artist', username: 'artist' },
        mode: 'draw',
        dockOpen: false,
        voxels: [{ x: 0, y: 0, z: 0 }],
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true },
        isInteractingWithLand: false,
        nearbyCameraLand: stibblezLand,
        nearbyCameraLandCount: 1,
        onInspectArLand: () => {}
      })
    );
    const drawPill = hudDraw.getByTestId('ar-nearby-land-pill');
    assert.ok(drawPill.textContent.includes('Adding Art to:'));
    assert.ok(drawPill.textContent.includes('Stibblez Land'));
    assert.equal(drawPill.getAttribute('data-adding-to-land'), 'true');
    cleanup();

    const hudFrozen = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u-artist', username: 'artist' },
        mode: 'draw',
        dockOpen: false,
        voxels: [{ x: 0, y: 0, z: 0 }],
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true },
        isInteractingWithLand: false,
        nearbyCameraLand: { ...stibblezLand, isFrozen: true },
        nearbyCameraLandCount: 1,
        onInspectArLand: () => {}
      })
    );
    const frozenPill = hudFrozen.getByTestId('ar-nearby-land-pill');
    assert.ok(frozenPill.textContent.includes('Frozen Land:'));
    assert.ok(frozenPill.textContent.includes('Stibblez Land'));
    assert.equal(frozenPill.getAttribute('data-frozen-land'), 'true');
    cleanup();

    // 5) PublishSculptureModal clearly communicates adding art to Stibblez Land (not minting a new land)
    const basePubProps = {
      config: { policy: { titleMax: 48, descriptionMax: 240, descriptionMaxWords: 45 } },
      user: { id: 'u-artist', email: 'artist@test.com', activeMintRecipient: '0x2222222222222222222222222222222222222222' },
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
      polStats: { frames: 12, flow: 92 },
      location: { lat: 39.7302, lng: -121.8406, altitude: 60 },
      orbStatus: { features: 0, keyframes: 0 },
      passkeyCount: 0,
      passkeyBusy: false,
      title: 'Street Neon',
      setTitle: () => {},
      description: 'Painted inside Stibblez Land.',
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
      mcpPairingsState: { mcpActive: false, activePairing: null },
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
    };

    const pubView = RTL.render(
      React.createElement(PublishSculptureModal, {
        ...basePubProps,
        activeTargetLand: stibblezLand
      })
    );
    const banner = pubView.getByTestId('publish-target-land-banner');
    assert.ok(banner.textContent.includes('Adding Art to: Stibblez Land'));
    assert.ok(banner.textContent.includes('will not mint a new land'));
    const submitBtn = pubView.getByRole('button', { name: /Add Art to Stibblez Land/i });
    assert.equal(submitBtn.disabled, false);
    cleanup();

    const pubFrozenView = RTL.render(
      React.createElement(PublishSculptureModal, {
        ...basePubProps,
        activeTargetLand: { ...stibblezLand, isFrozen: true }
      })
    );
    const frozenBanner = pubFrozenView.getByTestId('publish-target-land-banner');
    assert.ok(frozenBanner.textContent.includes('Stibblez Land is frozen'));
    const frozenSubmit = pubFrozenView.getByRole('button', { name: /Land Frozen/i });
    assert.equal(frozenSubmit.disabled, true);
    cleanup();
  });

  test('AR item guidance view prevents telemetry/guidance overlap and collapses bottom inspector into a clean compact bar by default', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { default: ARLandGuidanceOverlay } = await loadJsxModule(
      'client/src/components/studio/ARLandGuidanceOverlay.jsx'
    );

    // 1) Verify CSS strictly separates top telemetry strip (+52px) from AR guidance stage (+96px)
    const cssText = fs.readFileSync(
      path.resolve(ROOT, 'client/src/styles.css'),
      'utf8'
    );
    const inspectMatch = cssText.match(/\.mobile-hud-stack\.is-land-inspect\s*\{[^}]*top:\s*calc\([^;]*\+\s*(\d+)px\)/);
    const stageMatch = cssText.match(/\.ar-guidance-stage\s*\{[^}]*top:\s*calc\([^;]*\+\s*(\d+)px\)/);
    assert.ok(inspectMatch, 'Expected .mobile-hud-stack.is-land-inspect top offset in styles.css');
    assert.ok(stageMatch, 'Expected .ar-guidance-stage top offset in styles.css');
    const telemetryTopPx = Number(inspectMatch[1]);
    const guidanceTopPx = Number(stageMatch[1]);
    assert.ok(
      guidanceTopPx - telemetryTopPx >= 36,
      `Expected >=36px separation between telemetry strip (+${telemetryTopPx}px) and AR guidance stage (+${guidanceTopPx}px)`
    );

    const land = {
      parcelId: 'GLAND-ARCLEAN1',
      displayName: 'Stibblez Land',
      customName: 'Stibblez Land',
      isInside: true,
      isFrozen: false,
      isOwned: false,
      edgeDistanceMeters: 0,
      distanceMeters: 0,
      googleMapsUrl: 'https://maps.google.com/?q=39.7302,-121.8406',
      sculptures: [
        { id: 'sc-1', title: 'Turkey Day 2026 Coffee', voxelCount: 0, modelType: 'custom-3d' },
        { id: 'sc-2', title: 'Stibblez', voxelCount: 2478 }
      ]
    };

    // 2) ARLandGuidanceOverlay renders clean legible off-screen guidance & omits .has-inspector when collapsed
    const guideView = RTL.render(
      React.createElement(ARLandGuidanceOverlay, {
        land,
        guidance: {
          inView: false,
          edge: 'right',
          instruction: 'Move camera right',
          turnDegrees: 108,
          angleDeg: 108,
          distanceMeters: 0,
          sharpnessPct: 100,
          tier: 'ultra',
          tierLabel: 'Ultra-Sharp'
        },
        hasBottomInspector: false
      })
    );
    const stageEl = guideView.getByTestId('ar-land-guidance-overlay');
    assert.equal(stageEl.className.includes('has-inspector'), false);
    const guidePill = guideView.getByTestId('ar-land-guide-pill');
    assert.ok(guidePill.textContent.includes('Stibblez Land'));
    assert.ok(guidePill.textContent.includes('Inside'));
    assert.ok(guidePill.textContent.includes('Move camera right'));
    assert.ok(guidePill.textContent.includes('108°'));
    cleanup();

    // 3) ARLandInspectorPanel with defaultExpanded={false} renders sleek compact bar & expands/hides cleanly
    const drawClicked = [];
    const panelView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land,
        defaultExpanded: false,
        onDrawHere: (l) => drawClicked.push(l.parcelId),
        onClose: () => {}
      })
    );
    const inspector = panelView.getByTestId('ar-land-inspector');
    assert.equal(inspector.getAttribute('data-expanded'), 'false');
    assert.ok(panelView.getByTestId('ar-land-compact-summary').textContent.includes('Stibblez Land'));
    assert.ok(panelView.getByTestId('ar-land-compact-summary').textContent.includes('2 artworks'));
    assert.equal(panelView.queryByTestId('ar-land-info-section'), null);
    assert.equal(panelView.queryByTestId('ar-land-actions-section'), null);

    // Quick Draw works right from compact bar
    RTL.fireEvent.click(panelView.getByTestId('ar-land-compact-draw-btn'));
    assert.deepEqual(drawClicked, ['GLAND-ARCLEAN1']);

    // Expand via Details toggle -> full info & actions appear
    RTL.fireEvent.click(panelView.getByTestId('ar-land-details-toggle'));
    assert.equal(panelView.getByTestId('ar-land-inspector').getAttribute('data-expanded'), 'true');
    assert.ok(panelView.getByTestId('ar-land-info-section'));
    assert.ok(panelView.getByTestId('ar-land-actions-section'));

    // Collapse back via Hide toggle
    RTL.fireEvent.click(panelView.getByTestId('ar-land-details-toggle'));
    assert.equal(panelView.getByTestId('ar-land-inspector').getAttribute('data-expanded'), 'false');
    assert.equal(panelView.queryByTestId('ar-land-info-section'), null);
    cleanup();
  });
});
