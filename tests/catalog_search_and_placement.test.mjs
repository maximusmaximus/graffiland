import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  buildCatalogEmojiGlb,
  CATALOG_SOURCES,
  extractCatalogEmojiId,
  resetCatalogCacheForTests,
  resolveCatalogItemReference,
  search3dAssetCatalog
} from '../shared/catalogSearchService.mjs';
import { buildEmojiGlbFromPngBytes } from '../shared/glb.mjs';
import {
  extractCustomModelInput,
  inspectCustomModelStats,
  validateModelBytesByFormat
} from '../shared/model3d.mjs';
import { MCP_TOOLS } from '../shared/mcp/toolSchemas.mjs';
import {
  buildAutonomousAgentPrompt,
  buildLandAdd3DItemAgentPrompt,
  buildPropertyOwnerPrompt
} from '../shared/landSignatureMessage.mjs';
import { buildLlmsTxt, buildWellKnownAgentCard } from '../shared/agentService.mjs';
import { buildObjectFittedLandVolume } from '../shared/landVolume.mjs';
import { validatePublishPayload } from '../server/services/moderation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Minimal valid 1x1 PNG bytes for deterministic offline emoji GLB tests
const TINY_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

function makeMockCatalogFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes('simready-pile/main/assets.json')) {
      return new Response(
        JSON.stringify([
          'chair_office_a01',
          'appliance_toaster_a01',
          'food_produce_banana_m01',
          'plant_cactus_a01'
        ]),
        { status: 200 }
      );
    }
    if (u.includes('pixels/main/src/data/atlas-ids.json')) {
      return new Response(
        JSON.stringify(['acoustic_guitar', 'cactus', 'dragon_egg', 'fire_sword', 'office_chair']),
        { status: 200 }
      );
    }
    if (u.includes('xeroemoji-pile/main/src/data/top500.ts')) {
      return new Response(
        'export const TOP_EMOJI_IDS = ["1f525","1f335","1f3b8","1f680","1f451"] as const;',
        { status: 200 }
      );
    }
    if (u.includes('/png/') && u.endsWith('.png')) {
      return new Response(TINY_PNG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      });
    }
    return new Response('Not found', { status: 404 });
  };
}

describe('3D Asset Catalog Search, Quantized GLB BBox, 3D Emoji GLB & MCP Integration', () => {
  test('1. search3dAssetCatalog queries SimReady, Pixels, and XeroEmoji with ranked results & source filters', async () => {
    resetCatalogCacheForTests();
    const fetchImpl = makeMockCatalogFetch();

    // Empty query returns balanced featured items across all 3 repos
    const featured = await search3dAssetCatalog({
      query: '',
      source: 'all',
      limit: 6,
      apiOrigin: 'https://api.spray.land',
      fetchImpl
    });
    assert.equal(featured.items.length, 6);
    const featuredSources = new Set(featured.items.map((it) => it.source));
    assert.ok(featuredSources.has('simready'));
    assert.ok(featuredSources.has('pixels'));
    assert.ok(featuredSources.has('xeroemoji'));

    // Cross-repo keyword search ("cactus" matches SimReady, Pixels, and XeroEmoji 🌵 1f335!)
    const cactusRes = await search3dAssetCatalog({
      query: 'cactus',
      source: 'all',
      limit: 6,
      apiOrigin: 'https://api.spray.land',
      fetchImpl
    });
    assert.ok(cactusRes.items.length >= 3, `Expected matches across all 3 repos, got ${cactusRes.items.length}`);
    const cactusSources = new Set(cactusRes.items.map((it) => it.source));
    assert.ok(cactusSources.has('simready'), 'Expected SimReady cactus match');
    assert.ok(cactusSources.has('pixels'), 'Expected Pixels cactus match');
    assert.ok(cactusSources.has('xeroemoji'), 'Expected XeroEmoji cactus match');

    // Source-filtered search
    const onlyPixels = await search3dAssetCatalog({
      query: 'guitar',
      source: 'pixels',
      limit: 6,
      apiOrigin: 'https://api.spray.land',
      fetchImpl
    });
    assert.equal(onlyPixels.items.length, 1);
    assert.equal(onlyPixels.items[0].id, 'pixels:acoustic_guitar');
    assert.ok(
      onlyPixels.items[0].modelUrl.includes('huggingface.co/datasets/codepawl/pixel-atlas-glb')
    );

    // XeroEmoji item provides SVG preview & /api/catalog/emoji/<id>.glb URL
    const emojiRes = await search3dAssetCatalog({
      query: 'fire',
      source: 'xeroemoji',
      limit: 6,
      apiOrigin: 'https://api.spray.land',
      fetchImpl
    });
    const fire = emojiRes.items.find((it) => it.rawId === '1f525');
    assert.ok(fire, 'Expected Fire emoji (1f525)');
    assert.equal(fire.modelUrl, 'https://api.spray.land/api/catalog/emoji/1f525.glb');
    assert.ok(fire.previewImageUrl.includes('xeroemoji'));
    assert.equal(CATALOG_SOURCES.simready.repo, 'maximusmaximus/simready-pile');
    assert.equal(CATALOG_SOURCES.pixels.repo, 'maximusmaximus/pixels');
    assert.equal(CATALOG_SOURCES.xeroemoji.repo, 'maximusmaximus/xeroemoji-pile');
  });

  test('2. buildEmojiGlbFromPngBytes & buildCatalogEmojiGlb produce valid 1m glTF 2.0 .glb binaries & resolveCatalogItemReference works', async () => {
    const glb = buildEmojiGlbFromPngBytes(TINY_PNG_BYTES, { emojiId: '1f525', title: 'Fire' });
    assert.equal(validateModelBytesByFormat('glb', glb), null);
    const inspected = inspectCustomModelStats('glb', glb);
    assert.equal(inspected.error, null);
    assert.equal(inspected.stats.textureCount, 1);
    assert.equal(inspected.stats.triangleCount, 16);
    assert.deepEqual(inspected.stats.bbox, { width: 1, height: 1, depth: 0.12 });

    const built = await buildCatalogEmojiGlb('1f525', { fetchImpl: makeMockCatalogFetch() });
    assert.equal(built.emojiId, '1f525');
    assert.equal(validateModelBytesByFormat('glb', built.bytes), null);

    // Catalog item resolution
    const refPx = resolveCatalogItemReference({ catalogItemId: 'pixels:dragon_egg' });
    assert.equal(refPx?.source, 'pixels');
    assert.ok(refPx?.modelUrl.endsWith('/dragon_egg/dragon_egg.glb'));
    const refEmoji = resolveCatalogItemReference({
      catalogItemId: 'xeroemoji:1f525',
      apiOrigin: 'https://api.spray.land'
    });
    assert.equal(refEmoji?.modelUrl, 'https://api.spray.land/api/catalog/emoji/1f525.glb');
    assert.equal(extractCatalogEmojiId({ modelUrl: refEmoji.modelUrl }), '1f525');

    // extractCustomModelInput accepts catalogItemId cleanly
    const extracted = extractCustomModelInput({ catalogItemId: 'simready:chair_office_a01', modelScale: 1.5 });
    assert.equal(extracted.provided, true);
    assert.equal(extracted.error, null);
    assert.equal(extracted.customModel.format, 'glb');
    assert.equal(extracted.customModel.scale, 1.5);
    assert.ok(extracted.customModel.externalUrl.includes('simready-pile@main/glb/chair_office_a01.glb'));
  });

  test('3. inspectCustomModelStats honors KHR_mesh_quantization normalized SHORT accessors & mobile publish validation accepts catalog items', () => {
    // Build minimal GLB JSON chunk with normalized INT16 POSITION accessor (like Pixel Art Atlas & ABO)
    const gltfObj = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [0.5, 0.5, 0.5] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [
        {
          type: 'VEC3',
          componentType: 5122, // SHORT
          normalized: true,
          count: 3,
          min: [-16384, -32767, -8192],
          max: [16384, 32767, 8192]
        }
      ]
    };
    const jsonRaw = new TextEncoder().encode(JSON.stringify(gltfObj));
    const jsonPad = (jsonRaw.length + 3) & ~3;
    const glb = new Uint8Array(12 + 8 + jsonPad);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, glb.length, true);
    dv.setUint32(12, jsonPad, true);
    dv.setUint32(16, 0x4e4f534a, true);
    glb.set(jsonRaw, 20);
    for (let i = jsonRaw.length; i < jsonPad; i += 1) glb[20 + i] = 0x20;

    const res = inspectCustomModelStats('glb', glb);
    assert.equal(res.error, null);
    assert.ok(res.stats.bbox.height >= 0.99 && res.stats.bbox.height <= 1.01, `Expected ~1.0m height, got ${res.stats.bbox.height}`);
    assert.ok(res.stats.bbox.width >= 0.49 && res.stats.bbox.width <= 0.51, `Expected ~0.5m width, got ${res.stats.bbox.width}`);

    // Mobile publish payload validator accepts catalogItemId with 0 voxels
    const pubVal = validatePublishPayload({
      title: 'Pixel Guitar',
      description: 'Placed ready-made 3D guitar model in AR',
      termsAccepted: true,
      catalogItemId: 'pixels:acoustic_guitar',
      voxels: []
    });
    assert.equal(pubVal.ok, true, `Expected valid catalog mobile publish, errors: ${pubVal.errors.join(', ')}`);
    assert.equal(pubVal.hasCustomModel, true);

    // buildObjectFittedLandVolume respects modelBbox * scale for catalog items
    const vol = buildObjectFittedLandVolume({
      lat: 39.73,
      lng: -121.84,
      voxels: [],
      modelBbox: { width: 2.0, depth: 1.5, height: 3.0 },
      scale: 2.0,
      paddingFraction: 0.1
    });
    assert.ok(vol.widthMeters >= 4.7 && vol.widthMeters <= 4.9, `Expected ~4.8m width, got ${vol.widthMeters}`);
    assert.ok(vol.heightMeters >= 7.1 && vol.heightMeters <= 7.3, `Expected ~7.2m height, got ${vol.heightMeters}`);
  });

  test('4. MCP tool schemas, AI agent prompts, /llms.txt, agent.json & README advertise search_3d_catalog and all 3 repos', () => {
    const searchTool = MCP_TOOLS.find((t) => t.name === 'search_3d_catalog');
    assert.ok(searchTool, 'MCP_TOOLS must register search_3d_catalog');
    assert.ok(searchTool.description.includes('simready-pile'));
    assert.ok(searchTool.description.includes('pixels'));
    assert.ok(searchTool.description.includes('xeroemoji-pile'));

    const loadTool = MCP_TOOLS.find((t) => t.name === 'load_3d_model_on_land');
    assert.ok(loadTool.inputSchema.properties.catalogItemId, 'load_3d_model_on_land must accept catalogItemId');

    const addPrompt = buildLandAdd3DItemAgentPrompt({ parcel: { parcelId: 'GLAND-TEST1' } });
    assert.ok(addPrompt.includes('search_3d_catalog'));
    assert.ok(addPrompt.includes('simready-pile'));

    const ownerPrompt = buildPropertyOwnerPrompt({ pairingCode: 'GLP-TEST', ownerAddress: '0x0' });
    assert.ok(ownerPrompt.includes('search_3d_catalog'));

    const autoPrompt = buildAutonomousAgentPrompt({});
    assert.ok(autoPrompt.includes('search_3d_catalog'));

    const llms = buildLlmsTxt('https://api.spray.land');
    assert.ok(llms.includes('/api/catalog/search'));
    assert.ok(llms.includes('search_3d_catalog'));

    const card = buildWellKnownAgentCard('https://api.spray.land');
    assert.equal(card.endpoints.catalogSearch, 'https://api.spray.land/api/catalog/search');

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('simready-pile'));
    assert.ok(readme.includes('pixels'));
    assert.ok(readme.includes('xeroemoji-pile'));
    assert.ok(readme.includes('search_3d_catalog'));
  });
});

describe('Desktop "Search to Add" & Mobile Search -> Auto-Scale UI (jsdom + Testing Library)', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-catalog-search-'));
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
    dom.window.HTMLCanvasElement.prototype.getContext = (type) => {
      if (type === '2d') {
        return {
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: () => {},
          clearRect: () => {},
          drawImage: () => {},
          getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
        };
      }
      return null;
    };
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    globalThis.fetch = origFetch;
    dom?.window?.close();
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
  });

  test('5. AddLandItemModal places "Search to Add" strictly between AI Agent Prompt & Add Manually and places one item at a time', async () => {
    const { default: AddLandItemModal } = await loadJsxModule('client/src/components/AddLandItemModal.jsx');
    const createdPayloads = [];
    const uploadedSculptures = [];

    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/catalog/search')) {
        return new Response(
          JSON.stringify({
            query: 'cactus',
            source: 'all',
            totalMatches: 3,
            items: [
              {
                id: 'simready:plant_cactus_a01',
                rawId: 'plant_cactus_a01',
                source: 'simready',
                sourceName: 'SimReady Pile',
                title: 'Plant Cactus (A01)',
                modelFormat: 'glb',
                modelUrl: 'https://cdn.jsdelivr.net/gh/maximusmaximus/simready-pile@main/glb/plant_cactus_a01.glb',
                previewImageUrl: null,
                recommendedScale: 1
              },
              {
                id: 'pixels:cactus',
                rawId: 'cactus',
                source: 'pixels',
                sourceName: 'Pixels Atlas',
                title: 'Cactus',
                modelFormat: 'glb',
                modelUrl: 'https://huggingface.co/datasets/codepawl/pixel-atlas-glb/resolve/main/objects/cactus/cactus.glb',
                previewImageUrl: null,
                recommendedScale: 1
              },
              {
                id: 'xeroemoji:1f335',
                rawId: '1f335',
                source: 'xeroemoji',
                sourceName: 'XeroEmoji Pile',
                title: '🌵 Cactus',
                modelFormat: 'glb',
                modelUrl: 'https://api.spray.land/api/catalog/emoji/1f335.glb',
                previewImageUrl: 'https://cdn.jsdelivr.net/gh/maximusmaximus/xeroemoji@v1.0.2/svg/1f335.svg',
                recommendedScale: 1
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (u.includes('/api/models/validate-url')) {
        return new Response(
          JSON.stringify({
            valid: true,
            format: 'glb',
            byteLength: 12000,
            stats: { bbox: { width: 1, depth: 1, height: 1 } },
            landFit: { fits: true, maxSafeScale: 10 }
          }),
          { status: 200 }
        );
      }
      if (u.includes('/api/lands/GLAND-CAT1/sculptures') && init?.method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        createdPayloads.push(body);
        return new Response(
          JSON.stringify({
            sculpture: { id: 'sc-placed-1', title: body.title, parcelId: 'GLAND-CAT1' }
          }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    let view;
    await RTL.act(async () => {
      view = RTL.render(
        React.createElement(AddLandItemModal, {
          parcel: {
            parcelId: 'GLAND-CAT1',
            customName: 'Desert Yard',
            ownerSub: 'u-1',
            volume: { widthMeters: 20, depthMeters: 20, heightMeters: 20 }
          },
          user: { id: 'u-1', username: 'bigdog' },
          onSculptureUploaded: (sc) => uploadedSculptures.push(sc),
          onClose: () => {}
        })
      );
    });
    await RTL.waitFor(() => {
      assert.ok(view.getByTestId('catalog-item-card-pixels:cactus'));
    });

    // Verify exact DOM order: AI Agent Prompt -> Search to Add -> Add Manually
    const agentSection = view.getByTestId('add-item-agent-section');
    const searchSection = view.getByTestId('catalog-search-box');
    const manualSection = view.getByTestId('add-item-manual-section');
    assert.ok(
      Boolean(agentSection.compareDocumentPosition(searchSection) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING),
      'Search to Add must appear AFTER AI Agent Prompt'
    );
    assert.ok(
      Boolean(searchSection.compareDocumentPosition(manualSection) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING),
      'Search to Add must appear BEFORE Add Manually'
    );

    // Pick ONE item at a time: selecting Pixels Cactus then clicking XeroEmoji Cactus switches single selection
    const pixelCard = view.getByTestId('catalog-item-card-pixels:cactus');
    const emojiCard = view.getByTestId('catalog-item-card-xeroemoji:1f335');
    RTL.fireEvent.click(pixelCard);
    assert.equal(pixelCard.getAttribute('aria-selected'), 'true');
    assert.equal(emojiCard.getAttribute('aria-selected'), 'false');

    RTL.fireEvent.click(emojiCard);
    assert.equal(pixelCard.getAttribute('aria-selected'), 'false');
    assert.equal(emojiCard.getAttribute('aria-selected'), 'true');

    // Place the selected item on land
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('catalog-place-selected-btn'));
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(createdPayloads.length, 1);
    assert.equal(createdPayloads[0].catalogItemId, 'xeroemoji:1f335');
    assert.equal(uploadedSculptures.length, 1);
    cleanup();
  });

  test('6. Mobile Studio exposes Search (🔍) icon, places 3D item, auto-switches to Lock & Scale, and resumes Draw/Publish cleanly', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    const { default: MobileCatalogSearchModal } = await loadJsxModule(
      'client/src/components/studio/MobileCatalogSearchModal.jsx'
    );
    const { default: ToolCarouselBar } = await loadJsxModule(
      'client/src/components/studio/ToolCarouselBar.jsx'
    );
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );

    // 6a) StudioHudTopBar renders magnifying glass Search icon button
    let searchClicks = 0;
    const hudView = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u-1', username: 'bigdog' },
        mode: 'draw',
        dockOpen: false,
        location: { lat: 39.73, lng: -121.84 },
        voxels: [],
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true },
        onOpenCatalogSearch: () => {
          searchClicks += 1;
        }
      })
    );
    const searchBtn = hudView.getByTestId('mobile-catalog-search-btn');
    RTL.fireEvent.click(searchBtn);
    assert.equal(searchClicks, 1);
    cleanup();

    // 6b) MobileCatalogSearchModal + useVoxelBrush auto-switch to scaling tooling ('transform') on place,
    //     commit transform on ✅ Draw back to 'draw', and keep Publish usable!
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/catalog/search')) {
        return new Response(
          JSON.stringify({
            query: '',
            totalMatches: 1,
            items: [
              {
                id: 'pixels:dragon_egg',
                rawId: 'dragon_egg',
                source: 'pixels',
                sourceName: 'Pixels Atlas',
                title: 'Dragon Egg',
                modelFormat: 'glb',
                modelUrl: 'https://huggingface.co/datasets/codepawl/pixel-atlas-glb/resolve/main/objects/dragon_egg/dragon_egg.glb',
                previewImageUrl: null,
                recommendedScale: 1
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    let latestBrush = null;
    let committedTransforms = [];

    function MobileFlowHarness() {
      const [searchOpen, setSearchOpen] = React.useState(true);
      const [placedItem, setPlacedItem] = React.useState(null);
      const pivotRef = React.useRef({ x: 0, y: 0, z: -1.8 });
      const dummyRef = React.useRef(null);

      const brush = useVoxelBrush({
        config: { policy: {} },
        initialDraft: {},
        user: { id: 'u-1', username: 'bigdog' },
        location: { lat: 39.73, lng: -121.84 },
        cameraReady: true,
        sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
        calibrationReady: true,
        showTemporaryHint: () => {},
        canvasHostRef: dummyRef,
        cameraRef: dummyRef,
        draftGroupRef: dummyRef,
        transformBoxRef: dummyRef,
        surfaceMarkerRef: dummyRef,
        shadowPlaneRef: dummyRef,
        gridHelperRef: dummyRef,
        nearbyGroupRef: dummyRef,
        arTargetedIdRef: dummyRef,
        hasPlacedCatalogItem: Boolean(placedItem),
        placedCatalogPivotRef: pivotRef,
        onCommitCatalogTransform: (tr) => committedTransforms.push({ ...tr }),
        onClearCatalogItem: () => setPlacedItem(null)
      });
      latestBrush = brush;

      return React.createElement(
        'div',
        null,
        searchOpen &&
          React.createElement(MobileCatalogSearchModal, {
            placedItem,
            onPlaceItem: (item) => {
              setPlacedItem({ ...item, scale: 1 });
              setSearchOpen(false);
              brush.enterTransformMode({ pivotOverride: { x: 0, y: 0, z: -1.8 } });
            },
            onClose: () => setSearchOpen(false)
          }),
        React.createElement(ToolCarouselBar, {
          activeKeyTool: brush.activeKeyTool,
          toolAvailability: brush.toolAvailability,
          canTouch: true,
          swipeDragPx: 0,
          isDraggingKey: false,
          painting: false,
          mode: brush.mode,
          dockOpen: false,
          voxelsLength: brush.voxels.length,
          placedCatalogItem: placedItem,
          artTransform: brush.artTransform,
          onSetArtTransform: brush.setArtTransform,
          onToggleTransformLock: brush.toggleTransformLock,
          onStepKeyTool: brush.stepKeyTool,
          onKeyPointerDown: () => {},
          onKeyPointerMove: () => {},
          onKeyPointerUp: () => {},
          onKeyPointerCancel: () => {}
        })
      );
    }

    let flowView;
    await RTL.act(async () => {
      flowView = RTL.render(React.createElement(MobileFlowHarness));
    });
    await RTL.waitFor(() => {
      assert.ok(flowView.getByTestId('catalog-item-card-pixels:dragon_egg'));
    });

    // Pick Dragon Egg and tap Place & Scale
    RTL.fireEvent.click(flowView.getByTestId('catalog-item-card-pixels:dragon_egg'));
    await RTL.act(async () => {
      RTL.fireEvent.click(flowView.getByTestId('catalog-place-selected-btn'));
      await new Promise((r) => setTimeout(r, 20));
    });

    // Automatically switched into scaling tooling (transform mode) & shows Scale Dragon Egg bar
    assert.equal(latestBrush.mode, 'transform');
    assert.ok(flowView.getByRole('region', { name: /Scale and transform art piece/i }).textContent.includes('Dragon Egg'));
    assert.equal(latestBrush.toolAvailability.publish.usable, true, 'Publish must be enabled after placing a 3D catalog item');

    // Adjust scale and tap ✅ Draw -> commits transform and resumes draw mode cleanly
    await RTL.act(async () => {
      latestBrush.setArtTransform((prev) => ({ ...prev, scale: 1.45, rotYDeg: 30 }));
    });
    await RTL.act(async () => {
      RTL.fireEvent.click(flowView.getByRole('button', { name: /^Draw$/i }));
    });
    assert.equal(latestBrush.mode, 'draw', 'Expected return to draw mode so user can paint more or mint');
    assert.equal(committedTransforms.length, 1);
    assert.equal(committedTransforms[0].scale, 1.45);
    assert.equal(committedTransforms[0].rotYDeg, 30);
    cleanup();

    // 6c) InfoTermsModal documents Search to Add across Desktop & Mobile guides
    const infoDesktop = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: {} },
        initialTab: 'guide',
        initialViewportGuide: 'desktop',
        onClose: () => {}
      })
    );
    assert.ok(infoDesktop.container.textContent.includes('Search to Add 3D Items'));
    cleanup();

    const infoMobile = RTL.render(
      React.createElement(InfoTermsModal, {
        config: { policy: {} },
        initialTab: 'guide',
        initialViewportGuide: 'mobile',
        onClose: () => {}
      })
    );
    assert.ok(infoMobile.container.textContent.includes('Search & Place 3D Items in AR'));
    cleanup();
  });
});
