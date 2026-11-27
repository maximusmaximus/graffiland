/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  applySculptureRedo,
  applySculptureUndo,
  canUserModifySiblingSculpture,
  createSculptureEditSnapshot,
  createSnapshotFromSculpture,
  hasUnsavedSculptureEdits,
  pushSculptureUndoSnapshot
} from '../client/src/utils/sculptureEditHistory.js';

const ROOT = path.resolve(process.cwd());

describe('Desktop Placement Auto-Edit, Scene Ghost Switching, Undo/Redo & Esc Exit', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-ghost-edit-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
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
    dom.window.HTMLCanvasElement.prototype.getContext = () => null;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    try {
      cleanup?.();
    } catch {
      // ignore
    }
    try {
      dom?.window?.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('1. sculptureEditHistory manages snapshots, dirty checks, Undo/Redo stacks, and sibling edit permissions', () => {
    const scBase = {
      id: 'sc-1',
      title: 'Bonsai',
      description: 'Original',
      parcelId: 'GLAND-GHOST-1',
      creatorSub: 'user-a',
      customModel: { scale: 1 },
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 }
    };
    const snap0 = createSnapshotFromSculpture(scBase);
    const snap1 = createSculptureEditSnapshot({
      ...snap0,
      scale: 2.25,
      offset: { ...snap0.offset, dx: 1.5 }
    });
    const snap2 = createSculptureEditSnapshot({
      ...snap1,
      offset: { ...snap1.offset, pitch: 90 }
    });

    assert.equal(hasUnsavedSculptureEdits(snap0, snap0), false);
    assert.equal(hasUnsavedSculptureEdits(snap1, snap0), true);

    let undoStack = [];
    let redoStack = [];
    undoStack = pushSculptureUndoSnapshot(undoStack, snap0, { label: 'Scale & Move' });
    // Duplicate push is deduplicated
    undoStack = pushSculptureUndoSnapshot(undoStack, snap0, { label: 'Scale & Move' });
    assert.equal(undoStack.length, 1);

    undoStack = pushSculptureUndoSnapshot(undoStack, snap1, { label: 'Stand Vertical' });
    assert.equal(undoStack.length, 2);

    const u1 = applySculptureUndo(undoStack, redoStack, snap2);
    assert.ok(u1);
    assert.equal(u1.restored.scale, 2.25);
    assert.equal(u1.restored.offset.pitch, 0);
    assert.equal(u1.undoStack.length, 1);
    assert.equal(u1.redoStack.length, 1);

    const u2 = applySculptureUndo(u1.undoStack, u1.redoStack, u1.restored);
    assert.ok(u2);
    assert.equal(u2.restored.scale, 1);
    assert.equal(u2.restored.offset.dx, 0);
    assert.equal(hasUnsavedSculptureEdits(u2.restored, snap0), false);

    const r1 = applySculptureRedo(u2.undoStack, u2.redoStack, u2.restored);
    assert.ok(r1);
    assert.equal(r1.restored.scale, 2.25);
    assert.equal(r1.restored.offset.dx, 1.5);

    // Permission checks: creator, land owner, contributor, vs unauthorized user
    const userA = { id: 'user-a', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const userOther = { id: 'user-other', walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const parcelOwnedByOther = { parcelId: 'GLAND-GHOST-1', ownerSub: 'user-other' };

    assert.equal(
      canUserModifySiblingSculpture(scBase, { user: userA, parcelDetail: parcelOwnedByOther }),
      true,
      'Creator should be able to edit their own sibling ghost'
    );
    assert.equal(
      canUserModifySiblingSculpture(scBase, { user: userOther, parcelDetail: parcelOwnedByOther }),
      true,
      'Land owner should be able to edit any sibling ghost on their land'
    );
    assert.equal(
      canUserModifySiblingSculpture(
        { id: 'sc-stranger', parcelId: 'GLAND-GHOST-1', creatorSub: 'user-z' },
        { user: userA, parcelDetail: parcelOwnedByOther }
      ),
      false,
      'Non-creator non-land-owner without contributor permission cannot edit stranger ghost'
    );
    assert.equal(
      canUserModifySiblingSculpture(
        { id: 'sc-contrib', parcelId: 'GLAND-GHOST-1', creatorSub: 'user-z', viewerCanContribute: true },
        { user: userA, parcelDetail: parcelOwnedByOther }
      ),
      true,
      'Contributor should be able to edit ghost when viewerCanContribute is true'
    );
  });

  test('2. DesktopHub & SculptureViewer3D wire desktop auto-edit on place, real 3D ghost meshes, and keepActiveSelection guard', () => {
    const hubSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'DesktopHub.jsx'),
      'utf8'
    );
    assert.match(hubSrc, /allSculptures=\{sculptures\}/);
    assert.match(hubSrc, /if \(!extra\?\.keepActiveSelection\)\s*\{\s*setSelected\(updated\);/);
    assert.match(hubSrc, /onSculptureUploaded=\{async \(createdSculpture\) => \{[\s\S]*setAddItemParcelId\(''\);[\s\S]*openSculpture\(createdSculpture\);/);

    const viewerSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'SculptureViewer3D.jsx'),
      'utf8'
    );
    assert.match(viewerSrc, /function applyGhostMaterialToObject3D\(/);
    assert.match(viewerSrc, /siblingGhostGroupRef/);
    assert.match(viewerSrc, /siblingHitMeshesRef/);
    assert.match(viewerSrc, /onTransformStartRef\.current\?\.\(role\)/);
    assert.match(viewerSrc, /onSelectSiblingRef\.current\?\.\(clickedSiblingId\)/);
  });

  test('3. Placing an item on Desktop closes AddLandItemModal and opens SculptureModal in Modify/Scale mode with scene ghosts visible', async () => {
    const { default: AddLandItemModal } = await loadJsxModule(
      'client/src/components/AddLandItemModal.jsx'
    );
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    const parcel = {
      parcelId: 'GLAND-DESKTOP-PLACE',
      customName: 'Creator Plaza',
      ownerSub: 'user-owner',
      lat: 39.7285,
      lng: -121.8375,
      widthMeters: 20,
      depthMeters: 20,
      heightMeters: 24,
      frozen: false,
      requireApproval: false
    };
    const existingItem = {
      id: 'sc-existing-1',
      title: 'Existing Cactus',
      parcelId: parcel.parcelId,
      creatorSub: 'user-owner',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/cactus.glb' },
      anchorOffset: { dx: -4, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 },
      baseDimensions: { width: 1.2, height: 1.5, depth: 1.2 }
    };
    const newlyPlacedItem = {
      id: 'sc-placed-new',
      title: 'Banana Crate',
      description: 'Placed from catalog',
      parcelId: parcel.parcelId,
      creatorSub: 'user-owner',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/banana.glb' },
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 },
      baseDimensions: { width: 1.0, height: 1.0, depth: 1.0 }
    };

    const user = { id: 'user-owner', username: 'creator', walletAddress: '0x1111111111111111111111111111111111111111' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/catalog/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'cat-banana',
                title: 'Banana Crate',
                sourceId: 'simready-pile',
                sourceName: 'SimReady',
                modelFormat: 'glb',
                modelUrl: 'https://example.com/banana.glb',
                recommendedScale: 1
              }
            ],
            sources: [{ id: 'simready-pile', name: 'SimReady' }],
            total: 1
          })
        };
      }
      if (u.includes('/api/models/validate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, landFit: { fits: true, maxSafeScale: 8 } })
        };
      }
      if (u.includes(`/api/lands/${parcel.parcelId}/sculptures`) && opts.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ ok: true, sculpture: newlyPlacedItem })
        };
      }
      if (u.includes(`/api/lands/${parcel.parcelId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ parcel, sculptures: [existingItem, newlyPlacedItem] })
        };
      }
      if (u.includes(`/api/sculptures/${newlyPlacedItem.id}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sculpture: newlyPlacedItem })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      function DesktopPlacementHarness() {
        const [addOpen, setAddOpen] = React.useState(true);
        const [sculptures, setSculptures] = React.useState([existingItem]);
        const [selected, setSelected] = React.useState(null);

        return React.createElement(
          React.Fragment,
          null,
          addOpen &&
            React.createElement(AddLandItemModal, {
              parcel,
              existingSculptures: sculptures,
              user,
              onSculptureUploaded: async (created) => {
                if (created?.id) {
                  setSculptures((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
                  setAddOpen(false);
                  setSelected(created);
                }
              },
              onClose: () => setAddOpen(false)
            }),
          selected &&
            React.createElement(SculptureModal, {
              sculpture: selected,
              user,
              config: {},
              allParcels: [parcel],
              allSculptures: sculptures,
              onSelectSculpture: (sc) => setSelected(sc),
              onClose: () => setSelected(null)
            })
        );
      }

      RTL.render(React.createElement(DesktopPlacementHarness));

      // Wait for catalog item card to load inside AddLandItemModal, select it, then click Place
      const itemCard = await RTL.waitFor(() => {
        const card = document.querySelector('[data-testid="catalog-item-card-cat-banana"]');
        assert.ok(card, 'Catalog item card should render');
        return card;
      });
      RTL.fireEvent.click(itemCard);

      const placeBtn = await RTL.waitFor(() => {
        const btn = document.querySelector('[data-testid="catalog-place-selected-btn"]');
        assert.ok(btn, 'Catalog Place selected button should render');
        return btn;
      });
      RTL.fireEvent.click(placeBtn);

      // Should immediately close AddLandItemModal and open SculptureModal in Modify, Scale & Move mode
      await RTL.waitFor(() => {
        assert.equal(document.querySelector('[data-testid="add-land-item-modal"]'), null);
        const modal = document.querySelector('[data-testid="sculpture-modal"]');
        assert.ok(modal, 'SculptureModal should open immediately after desktop placement');
        assert.equal(modal.getAttribute('data-active-sculpture-id'), newlyPlacedItem.id);
        assert.ok(
          document.querySelector('[data-testid="sculpture-transform-studio"]'),
          'Modify, Scale & Move Artwork studio should be open'
        );
        // Existing sibling item appears as a scene ghost!
        const ghostChip = document.querySelector(
          `[data-testid="viewer-ghost-chip-${existingItem.id}"]`
        );
        assert.ok(ghostChip, 'Existing placed scene object should appear as a ghost');
        assert.equal(ghostChip.getAttribute('data-can-edit'), 'true');
      });
    } finally {
      cleanup();
      globalThis.fetch = origFetch;
    }
  });

  test('4. Clicking an editable ghost auto-saves current sculpture and switches live to edit it (read-only ghost stays locked)', async () => {
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    const user = {
      id: 'user-alice',
      username: 'alice',
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };
    const parcel = {
      parcelId: 'GLAND-GHOST-SWITCH',
      customName: 'Shared Gallery',
      ownerSub: 'user-landlord', // Alice is NOT land owner, so she can edit only her own items A & B, NOT Bob's C!
      lat: 39.7285,
      lng: -121.8375,
      widthMeters: 24,
      depthMeters: 24,
      heightMeters: 24
    };
    const scA = {
      id: 'sc-a',
      title: 'Alice Bonsai',
      description: 'Desc A',
      parcelId: parcel.parcelId,
      creatorSub: 'user-alice',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/a.glb' },
      anchorOffset: { dx: -5, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 },
      baseDimensions: { width: 1.2, height: 1.2, depth: 1.2 }
    };
    const scB = {
      id: 'sc-b',
      title: 'Alice Lamp',
      description: 'Desc B',
      parcelId: parcel.parcelId,
      creatorSub: 'user-alice',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1.5, downloadUrl: '/api/models/b.glb' },
      anchorOffset: { dx: 5, dy: 0, dz: 0, yaw: 45, pitch: 0, roll: 0 },
      baseDimensions: { width: 1.0, height: 1.6, depth: 1.0 }
    };
    const scC = {
      id: 'sc-c',
      title: 'Bob Statue',
      description: 'Desc C',
      parcelId: parcel.parcelId,
      creatorSub: 'user-bob',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/c.glb' },
      anchorOffset: { dx: 0, dy: 0, dz: 6, yaw: 0, pitch: 0, roll: 0 },
      baseDimensions: { width: 1.0, height: 1.8, depth: 1.0 }
    };

    const putCalls = [];
    const updatedEvents = [];
    const selectedEvents = [];

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes(`/api/lands/${parcel.parcelId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ parcel, sculptures: [scA, scB, scC] })
        };
      }
      if (u.includes('/api/sculptures/sc-a') && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        putCalls.push({ id: 'sc-a', body });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sculpture: {
              ...scA,
              title: body.title,
              description: body.description,
              customModel: { ...scA.customModel, scale: body.scale },
              anchorOffset: { ...body.anchorOffset }
            },
            pushedSiblings: []
          })
        };
      }
      if (u.includes('/api/sculptures/sc-a')) {
        return { ok: true, status: 200, json: async () => ({ sculpture: scA }) };
      }
      if (u.includes('/api/sculptures/sc-b')) {
        return { ok: true, status: 200, json: async () => ({ sculpture: scB }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      function SwitchHarness() {
        const [active, setActive] = React.useState(scA);
        const [list, setList] = React.useState([scA, scB, scC]);
        return React.createElement(SculptureModal, {
          sculpture: active,
          user,
          config: {},
          allParcels: [parcel],
          allSculptures: list,
          onSelectSculpture: (nextSc) => {
            selectedEvents.push(nextSc.id);
            setActive(nextSc);
          },
          onSculptureUpdated: (updated, extra = {}) => {
            updatedEvents.push({ id: updated.id, keepActiveSelection: Boolean(extra.keepActiveSelection) });
            if (!extra.keepActiveSelection) setActive(updated);
            setList((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
          },
          onClose: () => {}
        });
      }

      RTL.render(React.createElement(SwitchHarness));

      // Wait for ghost chips to render
      const ghostB = await RTL.waitFor(() => {
        const el = document.querySelector('[data-testid="viewer-ghost-chip-sc-b"]');
        assert.ok(el, 'Editable ghost B should be visible');
        return el;
      });
      const ghostC = document.querySelector('[data-testid="viewer-ghost-chip-sc-c"]');
      assert.ok(ghostC, 'Non-editable ghost C should also be visible');
      assert.equal(ghostB.getAttribute('data-can-edit'), 'true');
      assert.equal(ghostC.getAttribute('data-can-edit'), 'false');
      assert.equal(ghostC.disabled, true);

      // Edit sculpture A: change scale and Move X
      const scaleSlider = document.querySelector('[data-testid="sculpture-scale-slider"]');
      const dxSlider = document.querySelector('[data-testid="sculpture-move-dx"]');
      RTL.fireEvent.change(scaleSlider, { target: { value: '2.4' } });
      RTL.fireEvent.change(dxSlider, { target: { value: '-2.5' } });

      assert.ok(
        document.querySelector('[data-testid="sculpture-unsaved-badge"]'),
        'Unsaved badge should appear after modifying A'
      );

      // Click ghost B -> must auto-save A first, then switch live to edit B!
      RTL.fireEvent.click(ghostB);

      await RTL.waitFor(() => {
        const modal = document.querySelector('[data-testid="sculpture-modal"]');
        assert.equal(modal.getAttribute('data-active-sculpture-id'), 'sc-b');
      });

      assert.equal(putCalls.length, 1, 'Should auto-save sculpture A via PUT before switching');
      assert.equal(putCalls[0].id, 'sc-a');
      assert.equal(putCalls[0].body.scale, 2.4);
      assert.equal(putCalls[0].body.anchorOffset.dx, -2.5);
      assert.deepEqual(updatedEvents, [{ id: 'sc-a', keepActiveSelection: true }]);
      assert.deepEqual(selectedEvents, ['sc-b']);

      // Sculpture A is now a ghost in the scene while B is active with its own scale (1.5) & yaw (45)
      const ghostA = document.querySelector('[data-testid="viewer-ghost-chip-sc-a"]');
      assert.ok(ghostA, 'Previously edited sculpture A should now appear as a ghost');
      assert.equal(ghostA.getAttribute('data-can-edit'), 'true');
      const scaleInputB = document.querySelector('[data-testid="sculpture-scale-input"]');
      assert.equal(Number(scaleInputB.value), 1.5);
      assert.equal(
        document.querySelector('[data-testid="sculpture-modal"]').getAttribute('data-has-unsaved'),
        'false'
      );
    } finally {
      cleanup();
      globalThis.fetch = origFetch;
    }
  });

  test('5. Undo & Redo work via both Ctrl+Z/Ctrl+Y keyboard shortcuts and studio buttons', async () => {
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    const user = { id: 'user-undo', walletAddress: '0x1111111111111111111111111111111111111111' };
    const parcel = {
      parcelId: 'GLAND-UNDO',
      customName: 'Undo Land',
      ownerSub: 'user-undo',
      lat: 39.7285,
      lng: -121.8375,
      widthMeters: 20,
      depthMeters: 20,
      heightMeters: 24
    };
    const sc = {
      id: 'sc-undo-1',
      title: 'Undo Target',
      description: 'Desc',
      parcelId: parcel.parcelId,
      creatorSub: 'user-undo',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/u.glb' },
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 },
      baseDimensions: { width: 1, height: 1, depth: 1 }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes(`/api/lands/${parcel.parcelId}`)) {
        return { ok: true, status: 200, json: async () => ({ parcel, sculptures: [sc] }) };
      }
      if (u.includes(`/api/sculptures/${sc.id}`)) {
        return { ok: true, status: 200, json: async () => ({ sculpture: sc }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      RTL.render(
        React.createElement(SculptureModal, {
          sculpture: sc,
          user,
          config: {},
          allParcels: [parcel],
          allSculptures: [sc],
          onClose: () => {}
        })
      );

      const undoBtn = document.querySelector('[data-testid="sculpture-undo-btn"]');
      const redoBtn = document.querySelector('[data-testid="sculpture-redo-btn"]');
      assert.equal(undoBtn.disabled, true);
      assert.equal(redoBtn.disabled, true);

      // Step 1: Scale -> 2
      RTL.fireEvent.change(document.querySelector('[data-testid="sculpture-scale-slider"]'), {
        target: { value: '2' }
      });
      // Step 2: Move X -> 1.8
      RTL.fireEvent.change(document.querySelector('[data-testid="sculpture-move-dx"]'), {
        target: { value: '1.8' }
      });
      // Step 3: Stand Vertical (+90° X)
      RTL.fireEvent.click(document.querySelector('[data-testid="sculpture-stand-vertical-x-btn"]'));
      // Step 4: Reset Center & 1×
      RTL.fireEvent.click(document.querySelector('[data-testid="sculpture-reset-transform-btn"]'));

      assert.equal(Number(document.querySelector('[data-testid="sculpture-scale-input"]').value), 1);
      assert.equal(undoBtn.disabled, false);

      // Undo #1 via Ctrl+Z -> restores Step 3 (scale 2, dx 1.8, pitch 90)
      RTL.fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      assert.equal(Number(document.querySelector('[data-testid="sculpture-scale-input"]').value), 2);
      assert.equal(Number(document.querySelector('[data-testid="sculpture-move-dx"]').value), 1.8);
      assert.equal(
        Number(document.querySelector('[data-testid="sculpture-rotate-pitch-input"]').value),
        90
      );

      // Undo #2 via Undo button -> restores pitch 0
      RTL.fireEvent.click(undoBtn);
      assert.equal(
        Number(document.querySelector('[data-testid="sculpture-rotate-pitch-input"]').value),
        0
      );
      assert.equal(Number(document.querySelector('[data-testid="sculpture-move-dx"]').value), 1.8);

      // Undo #3 via Ctrl+Z -> restores dx 0
      RTL.fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      assert.equal(Number(document.querySelector('[data-testid="sculpture-move-dx"]').value), 0);
      assert.equal(Number(document.querySelector('[data-testid="sculpture-scale-input"]').value), 2);

      // Undo #4 via Ctrl+Z -> restores original scale 1 & clean state
      RTL.fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      assert.equal(Number(document.querySelector('[data-testid="sculpture-scale-input"]').value), 1);
      assert.equal(undoBtn.disabled, true);
      assert.equal(
        document.querySelector('[data-testid="sculpture-modal"]').getAttribute('data-has-unsaved'),
        'false'
      );

      // Redo via Ctrl+Y and Redo button
      assert.equal(redoBtn.disabled, false);
      RTL.fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
      assert.equal(Number(document.querySelector('[data-testid="sculpture-scale-input"]').value), 2);
      RTL.fireEvent.click(redoBtn);
      assert.equal(Number(document.querySelector('[data-testid="sculpture-move-dx"]').value), 1.8);
    } finally {
      cleanup();
      globalThis.fetch = origFetch;
    }
  });

  test('6. Pressing Esc exits SculptureModal WITHOUT saving unsaved edits (and respects open InfoTip popovers)', async () => {
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    const user = { id: 'user-esc', walletAddress: '0x2222222222222222222222222222222222222222' };
    const parcel = {
      parcelId: 'GLAND-ESC',
      customName: 'Esc Land',
      ownerSub: 'user-esc',
      lat: 39.7285,
      lng: -121.8375,
      widthMeters: 20,
      depthMeters: 20,
      heightMeters: 24
    };
    const sc = {
      id: 'sc-esc-1',
      title: 'Unsaved Draft Art',
      description: 'Original desc',
      parcelId: parcel.parcelId,
      creatorSub: 'user-esc',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/e.glb' },
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 },
      baseDimensions: { width: 1, height: 1, depth: 1 }
    };

    let putCallCount = 0;
    let closeCallCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (opts.method === 'PUT') {
        putCallCount += 1;
      }
      if (u.includes(`/api/lands/${parcel.parcelId}`)) {
        return { ok: true, status: 200, json: async () => ({ parcel, sculptures: [sc] }) };
      }
      if (u.includes(`/api/sculptures/${sc.id}`)) {
        return { ok: true, status: 200, json: async () => ({ sculpture: sc }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      RTL.render(
        React.createElement(SculptureModal, {
          sculpture: sc,
          user,
          config: {},
          allParcels: [parcel],
          allSculptures: [sc],
          onClose: () => {
            closeCallCount += 1;
          }
        })
      );

      // Make unsaved edits to scale and title
      RTL.fireEvent.change(document.querySelector('[data-testid="sculpture-scale-slider"]'), {
        target: { value: '3.2' }
      });
      assert.equal(
        document.querySelector('[data-testid="sculpture-modal"]').getAttribute('data-has-unsaved'),
        'true'
      );

      // If an InfoTip tooltip is open, Esc lets InfoTip close first without exiting SculptureModal
      const fakeTip = document.createElement('div');
      fakeTip.setAttribute('data-info-tip-mode', 'popover');
      document.body.appendChild(fakeTip);
      RTL.fireEvent.keyDown(window, { key: 'Escape' });
      assert.equal(closeCallCount, 0, 'Esc should not close SculptureModal while an InfoTip is open');
      fakeTip.remove();

      // Now press Esc -> exits SculptureModal immediately WITHOUT calling PUT save!
      RTL.fireEvent.keyDown(window, { key: 'Escape' });
      assert.equal(closeCallCount, 1, 'Esc should close SculptureModal');
      assert.equal(putCallCount, 0, 'Esc must NOT save unsaved edits on exit');
    } finally {
      cleanup();
      globalThis.fetch = origFetch;
    }
  });
});
