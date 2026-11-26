import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import { buildLandSharePageHtml, renderLandOgPng } from '../shared/landOgImage.mjs';
import { buildLandShareToXUrl } from '../client/src/utils/clipboard.js';

describe('Land Property Tag X (Twitter) Share & Dynamic 1200x630 PNG OG Cards', () => {
  let dom;
  let RTL;
  let outTmpDir;

  before(async () => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/?parcel=GLAND-CIRCLE1&slug=circle-land'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.SVGElement = dom.window.SVGElement;
    globalThis.Event = dom.window.Event;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.PointerEvent = dom.window.MouseEvent;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.getComputedStyle = dom.window.getComputedStyle;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    if (!globalThis.navigator) {
      globalThis.navigator = dom.window.navigator;
    }
    RTL = await import('@testing-library/react');
    outTmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-xog-'));
  });

  after(() => {
    try {
      RTL?.cleanup();
    } catch {
      // ignore
    }
    dom?.window?.close();
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
  });

  async function loadJsxModule(relPath) {
    const absIn = path.resolve(relPath);
    const outFile = path.join(outTmpDir, `${path.basename(relPath, '.jsx')}-${Date.now()}.mjs`);
    await esbuild.build({
      entryPoints: [absIn],
      outfile: outFile,
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      platform: 'browser',
      external: ['react', 'react-dom', 'react-dom/client', 'three', 'leaflet', 'maplibre-gl'],
      define: {
        'import.meta.env.VITE_API_BASE': JSON.stringify('https://graffiland-api.maxinfeld-artshow.workers.dev')
      },
      plugins: [
        {
          name: 'stub-css',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'css-stub'
            }));
            build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({
              contents: '',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.svg': 'dataurl' }
    });
    return import(`file://${outFile.replace(/\\/g, '/')}`);
  }

  test('renderLandOgPng generates a valid 1200x630 RGBA PNG for populated and empty lands', async () => {
    const parcel = {
      parcelId: 'GLAND-CIRCLE1',
      customName: 'CIRCLE LAND',
      ownerUsername: 'bigdog',
      volume: { widthMeters: 22, depthMeters: 20, heightMeters: 31 }
    };
    const sculptures = [
      {
        id: 'sc-1',
        title: 'Neon Spire',
        anchorOffset: { dx: 2, dz: -1 },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }]
      }
    ];

    const populatedPng = await renderLandOgPng({ parcel, sculptures });
    assert.ok(populatedPng instanceof Uint8Array);
    assert.ok(populatedPng.byteLength > 2000, 'Expected non-trivial compressed PNG');
    // Standard PNG 8-byte magic header
    assert.deepEqual(Array.from(populatedPng.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    // IHDR width & height = 1200 x 630
    const view = new DataView(populatedPng.buffer, populatedPng.byteOffset, populatedPng.byteLength);
    assert.equal(view.getUint32(16, false), 1200);
    assert.equal(view.getUint32(20, false), 630);
    // Ends with IEND chunk
    const tail = new TextDecoder().decode(populatedPng.subarray(populatedPng.byteLength - 8, populatedPng.byteLength - 4));
    assert.equal(tail, 'IEND');

    const emptyPng = await renderLandOgPng({ parcel: { parcelId: 'GLAND-EMPTY1', customName: 'Open Plaza' }, sculptures: [] });
    assert.deepEqual(Array.from(emptyPng.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test('buildLandSharePageHtml emits complete X summary_large_image & Open Graph tags and redirects cleanly', () => {
    const html = buildLandSharePageHtml({
      parcelId: 'GLAND-CIRCLE1',
      parcel: { parcelId: 'GLAND-CIRCLE1', customName: 'CIRCLE LAND' },
      sculptures: [{ id: 'sc-1', hidden: false }],
      apiOrigin: 'https://graffiland-api.maxinfeld-artshow.workers.dev',
      publicUrl: 'https://spray.land'
    });

    assert.match(html, /property="og:title" content="CIRCLE LAND — View &amp; Build in 3D on SPRAY\.LAND"/);
    assert.match(html, /property="og:image" content="https:\/\/graffiland-api\.maxinfeld-artshow\.workers\.dev\/api\/og\/land\/GLAND-CIRCLE1\.png\?v=/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /name="twitter:image" content="https:\/\/graffiland-api\.maxinfeld-artshow\.workers\.dev\/api\/og\/land\/GLAND-CIRCLE1\.png\?v=/);
    assert.match(html, /hand this land to your AI agent to add 3D models/i);
    assert.match(html, /https:\/\/spray\.land\/\?parcel=GLAND-CIRCLE1&amp;slug=circle-land/);
  });

  test('buildLandShareToXUrl builds clear X intent link with property name, OG share URL, and view/add + AI agent CTA', () => {
    const xUrl = buildLandShareToXUrl({
      parcelId: 'GLAND-CIRCLE1',
      customName: 'CIRCLE LAND',
      apiBase: 'https://graffiland-api.maxinfeld-artshow.workers.dev'
    });
    const parsed = new URL(xUrl);
    assert.equal(parsed.hostname, 'twitter.com');
    assert.equal(parsed.pathname, '/intent/tweet');
    const text = parsed.searchParams.get('text') || '';
    const sharedUrl = parsed.searchParams.get('url') || '';
    assert.match(text, /CIRCLE LAND/);
    assert.match(text, /view/i);
    assert.match(text, /add/i);
    assert.match(text, /agent/i);
    assert.match(text, /3D models/i);
    assert.equal(
      sharedUrl,
      'https://graffiland-api.maxinfeld-artshow.workers.dev/share/land/GLAND-CIRCLE1?slug=circle-land'
    );
  });

  test('PlotVisitView property tag and header render X logo buttons linking to the land OG share intent', async () => {
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');
    const parcel = {
      parcelId: 'GLAND-CIRCLE1',
      customName: 'CIRCLE LAND',
      centerLat: 39.73322,
      centerLng: -121.84035,
      volume: {
        parcelId: 'GLAND-CIRCLE1',
        centerLat: 39.73322,
        centerLng: -121.84035,
        widthMeters: 24,
        depthMeters: 24,
        heightMeters: 20
      }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ parcel, sculptures: [] })
    });

    try {
      const view = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          parcel,
          sculptures: [],
          allParcels: [parcel],
          onClose: () => {}
        })
      );

      const headerXBtn = view.getByTestId('plot-share-x-btn');
      const labelXBtn = view.getByTestId('plot-land-label-x-btn');
      for (const link of [headerXBtn, labelXBtn]) {
        const href = link.getAttribute('href') || '';
        assert.match(href, /^https:\/\/twitter\.com\/intent\/tweet\?/);
        const u = new URL(href);
        assert.match(u.searchParams.get('text') || '', /CIRCLE LAND/);
        assert.match(u.searchParams.get('text') || '', /AI agent add 3D models/i);
        assert.match(u.searchParams.get('url') || '', /\/share\/land\/GLAND-CIRCLE1/);
        assert.ok(link.querySelector('svg'), 'X share button should render the X SVG logo');
      }
      RTL.cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
