import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as THREE from 'three';
import {
  fetchModelBytesFromGateways,
  validateModelBytesByFormat
} from '../shared/model3d.mjs';
import { serializeSculptureRow } from '../shared/sculpture.mjs';
import { parseCustomModelBytes } from '../client/src/utils/customModelLoader.js';
import {
  buildDefaultHudReservedRects,
  rectsOverlap
} from '../client/src/utils/canvasLabelLayout.js';
import { computeNeighborEdgeArrows } from '../client/src/utils/neighborEdgeArrows.js';

if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent extends Event {};
}

function buildMinimalGlbBytes(padExtraBytes = 0) {
  // Valid glTF 2.0 single triangle mesh (3 vertices x 3 float32 = 36 bytes)
  const positions = new Float32Array([0, 0, 0, 1.5, 0, 0, 0.75, 1.8, 0.4]);
  const binRaw = new Uint8Array(positions.byteLength + padExtraBytes);
  binRaw.set(new Uint8Array(positions.buffer), 0);
  const binPadLen = Math.ceil(binRaw.length / 4) * 4;
  const binChunk = new Uint8Array(binPadLen);
  binChunk.set(binRaw, 0);

  const gltf = {
    asset: { version: '2.0', generator: 'graffiland-test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'BoomBoxTestNode' }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            mode: 4
          }
        ]
      }
    ],
    buffers: [{ byteLength: binChunk.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1.5, 1.8, 0.4]
      }
    ]
  };

  const jsonBytesRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadLen = Math.ceil(jsonBytesRaw.length / 4) * 4;
  const jsonChunk = new Uint8Array(jsonPadLen);
  jsonChunk.fill(0x20);
  jsonChunk.set(jsonBytesRaw, 0);

  const totalLen = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonChunk, 20);
  const binOff = 20 + jsonChunk.length;
  view.setUint32(binOff, binChunk.length, true);
  view.setUint32(binOff + 4, 0x004e4942, true); // 'BIN\0'
  out.set(binChunk, binOff + 8);
  return out;
}

function buildMinimalGltfEmbeddedBytes() {
  const positions = new Float32Array([0, 0, 0, 1.2, 0, 0, 0.6, 1.4, 0.2]);
  const b64 = Buffer.from(positions.buffer).toString('base64');
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1.2, 1.4, 0.2]
      }
    ]
  };
  return new TextEncoder().encode(JSON.stringify(gltf));
}

function buildMinimalBinaryStlBytes({ colored = false, trailingPad = 0 } = {}) {
  const total = 84 + 50 + trailingPad;
  const out = new Uint8Array(total);
  const headerText = colored ? 'COLOR=1234' : 'GRAFFILAND STL';
  out.set(new TextEncoder().encode(headerText), 0);
  const view = new DataView(out.buffer);
  view.setUint32(80, 1, true); // 1 triangle
  let off = 84;
  // Normal
  view.setFloat32(off, 0, true);
  view.setFloat32(off + 4, 0, true);
  view.setFloat32(off + 8, 1, true);
  off += 12;
  // 3 vertices
  const verts = [
    [0, 0, 0],
    [1.6, 0, 0],
    [0.8, 1.2, 0.3]
  ];
  for (const [x, y, z] of verts) {
    view.setFloat32(off, x, true);
    view.setFloat32(off + 4, y, true);
    view.setFloat32(off + 8, z, true);
    off += 12;
  }
  // Attribute byte count (bit 15 set + RGB555 color if colored)
  view.setUint16(off, colored ? 0x8000 | (31 << 10) | (12 << 5) | 6 : 0, true);
  return out;
}

describe('All 5 Custom 3D Formats (.glb, .gltf, .obj, .stl, .ply) & Gateway Model Resolution', () => {
  test('parseCustomModelBytes cleanly parses .glb, .gltf, .obj, .stl (ASCII + binary + padded), and .ply (mesh + point cloud)', async () => {
    // 1) .glb
    const glbBytes = buildMinimalGlbBytes();
    const glbParsed = await parseCustomModelBytes(glbBytes, 'glb', { format: 'glb', scale: 1 });
    assert.ok(glbParsed?.object3d);
    let glbMeshCount = 0;
    glbParsed.object3d.traverse((o) => {
      if (o.isMesh) glbMeshCount += 1;
    });
    assert.ok(glbMeshCount >= 1, 'Expected parsed GLB to contain at least 1 mesh');
    assert.ok(glbParsed.baseSize.height > 0.5 && Math.abs(glbParsed.bounds.min.y) < 1e-3);

    // 2) .gltf (UTF-8 JSON with embedded data URI buffer)
    const gltfBytes = buildMinimalGltfEmbeddedBytes();
    const gltfParsed = await parseCustomModelBytes(gltfBytes, 'gltf', { format: 'gltf', scale: 1 });
    assert.ok(gltfParsed?.object3d);
    let gltfMeshCount = 0;
    gltfParsed.object3d.traverse((o) => {
      if (o.isMesh) gltfMeshCount += 1;
    });
    assert.ok(gltfMeshCount >= 1, 'Expected parsed GLTF JSON to contain at least 1 mesh');

    // 3) .obj (upgrades untextured Phong default material to PBR MeshStandardMaterial with DoubleSide)
    const objBytes = new TextEncoder().encode(
      ['o BoomBoxHull', 'v 0 0 0', 'v 2 0 0', 'v 1 1.5 0.5', 'f 1 2 3'].join('\n')
    );
    const objParsed = await parseCustomModelBytes(objBytes, 'obj', { format: 'obj', scale: 1 });
    assert.ok(objParsed?.object3d);
    let objStandardDoubleSided = false;
    objParsed.object3d.traverse((o) => {
      if (o.isMesh && o.material?.isMeshStandardMaterial && o.material.side === THREE.DoubleSide) {
        objStandardDoubleSided = true;
      }
    });
    assert.equal(
      objStandardDoubleSided,
      true,
      'Expected untextured OBJ mesh to upgrade cleanly to double-sided PBR MeshStandardMaterial'
    );

    // 4) .stl (ASCII + Binary with minor trailing padding)
    const asciiStl = new TextEncoder().encode(
      [
        'solid test',
        'facet normal 0 0 1',
        '  outer loop',
        '    vertex 0 0 0',
        '    vertex 1 0 0',
        '    vertex 0.5 1.2 0.3',
        '  endloop',
        'endfacet',
        'endsolid test'
      ].join('\n')
    );
    assert.equal(validateModelBytesByFormat('stl', asciiStl), null);
    const asciiStlParsed = await parseCustomModelBytes(asciiStl, 'stl', { format: 'stl' });
    assert.ok(asciiStlParsed?.object3d);

    const paddedBinaryStl = buildMinimalBinaryStlBytes({ colored: true, trailingPad: 16 });
    assert.equal(
      validateModelBytesByFormat('stl', paddedBinaryStl),
      null,
      'Expected binary STL with minor trailing padding to pass format validation'
    );
    const binStlParsed = await parseCustomModelBytes(paddedBinaryStl, 'stl', { format: 'stl' });
    assert.ok(binStlParsed?.object3d);
    let stlHasMesh = false;
    binStlParsed.object3d.traverse((o) => {
      if (o.isMesh && o.material?.side === THREE.DoubleSide) stlHasMesh = true;
    });
    assert.equal(stlHasMesh, true);

    // 5a) .ply triangle mesh -> renders as THREE.Mesh
    const plyMeshText = [
      'ply',
      'format ascii 1.0',
      'element vertex 3',
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header',
      '0 0 0 255 80 80',
      '1 0 0 80 255 80',
      '0.5 1.2 0.2 80 120 255',
      '3 0 1 2'
    ].join('\n');
    const plyMeshParsed = await parseCustomModelBytes(
      new TextEncoder().encode(plyMeshText),
      'ply',
      { format: 'ply' }
    );
    let plyMeshNodes = 0;
    plyMeshParsed.object3d.traverse((o) => {
      if (o.isMesh) plyMeshNodes += 1;
    });
    assert.ok(plyMeshNodes >= 1, 'Expected triangle PLY to render as THREE.Mesh');

    // 5b) .ply point cloud (no element face) -> renders as visible THREE.Points (NEVER empty mesh!)
    const plyCloudText = [
      'ply',
      'format ascii 1.0',
      'element vertex 4',
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'end_header',
      '0 0 0 0 245 212',
      '1 0 0 255 183 3',
      '0 1 0 255 62 127',
      '0 0 1 125 211 252'
    ].join('\n');
    const plyCloudParsed = await parseCustomModelBytes(
      new TextEncoder().encode(plyCloudText),
      'ply',
      { format: 'ply' }
    );
    let plyPointsNodes = 0;
    plyCloudParsed.object3d.traverse((o) => {
      if (o.isPoints && o.material?.isPointsMaterial) plyPointsNodes += 1;
    });
    assert.ok(
      plyPointsNodes >= 1,
      'Expected vertex-only PLY point cloud to render as visible THREE.Points with PointsMaterial'
    );
  });

  test('fetchModelBytesFromGateways skips failing/HTML gateways and returns verified real GLB bytes', async () => {
    const realGlb = buildMinimalGlbBytes(512);
    const seenUrls = [];
    const mockFetch = async (url) => {
      seenUrls.push(String(url));
      if (seenUrls.length === 1) {
        return { ok: false, status: 504, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (seenUrls.length === 2) {
        const html = new TextEncoder().encode('<!DOCTYPE html><html><body>Gateway Timeout</body></html>');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          arrayBuffer: async () => html.buffer
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'model/gltf-binary' }),
        arrayBuffer: async () => realGlb.buffer
      };
    };

    const fetched = await fetchModelBytesFromGateways({
      cid: 'Qmf4oL8L9ZGbqDwgoY2fDgwzQ8JK1me55L2iy6kGxMiFfP',
      gatewayBase: 'https://primary.example/ipfs',
      format: 'glb',
      fetchImpl: mockFetch
    });
    assert.ok(fetched, 'Expected fallback gateway to return valid GLB');
    assert.equal(fetched.bytes.length, realGlb.length);
    assert.equal(seenUrls.length, 3);
    assert.ok(seenUrls[2].includes('ipfs.filebase.io'));
  });

  test('serializeSculptureRow appends deterministic ?cid= cache-buster to custom 3D model downloadUrl', () => {
    const sc = serializeSculptureRow({
      id: '3c7b2205-c842-4e15-8216-7017e554766d',
      title: 'Boom Box',
      description: '80s Boombox',
      lat: 39.7302,
      lng: -121.8406,
      geohash: '9r1652wm',
      parcel_id: 'GLAND-9R1652WM',
      voxels_json: '[]',
      voxel_count: 0,
      custom_model_format: 'glb',
      custom_model_cid: 'Qmf4oL8L9ZGbqDwgoY2fDgwzQ8JK1me55L2iy6kGxMiFfP',
      custom_model_bytes: 421460
    });
    assert.equal(sc.modelType, 'custom-3d');
    assert.equal(
      sc.customModel.downloadUrl,
      '/api/sculptures/3c7b2205-c842-4e15-8216-7017e554766d/model?cid=Qmf4oL8L9ZGbqDwg'
    );
    assert.equal(
      sc.modelGlbUrl,
      '/api/sculptures/3c7b2205-c842-4e15-8216-7017e554766d/model.glb?cid=Qmf4oL8L9ZGbqDwg'
    );
  });

  test('Express /api/sculptures/:id/model serves real >180KB GLB from IPFS gateway (never a 1-voxel fake box) and returns 502 if unreachable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-boombox-'));
    const realLargeGlb = buildMinimalGlbBytes(210 * 1024); // > 180 KB inline DB threshold!
    let gatewayAlive = true;

    const testCid = 'QmBoomBoxTestSim1234567890ABCDEF1234567890ABCD';
    const fakeGateway = http.createServer((req, res) => {
      if (!gatewayAlive) {
        res.statusCode = 504;
        res.end('timeout');
        return;
      }
      if (req.url?.includes(testCid)) {
        res.setHeader('Content-Type', 'model/gltf-binary');
        res.end(Buffer.from(realLargeGlb));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((resolve) => fakeGateway.listen(0, '127.0.0.1', resolve));
    const gwPort = fakeGateway.address().port;
    const prevGw = process.env.IPFS_GATEWAY;
    const prevDbPath = process.env.GRAFFILAND_DB_PATH;
    const prevIpfsDir = process.env.GRAFFILAND_IPFS_DIR;
    process.env.GRAFFILAND_DB_PATH = path.join(tmpDir, 'boombox.sqlite');
    process.env.GRAFFILAND_IPFS_DIR = path.join(tmpDir, 'ipfs');
    process.env.IPFS_GATEWAY = `http://127.0.0.1:${gwPort}/ipfs`;
    process.env.PINATA_JWT = '';

    const { createAppServer } = await import('../server/index.mjs');
    const { getDb } = await import('../server/db.mjs');
    const db = getDb();
    const srv = createAppServer();
    await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
    const apiPort = srv.server.address().port;

    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (
          id, email, name, username, wallet_address, encrypted_wallet_json, created_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'google:u1',
        'bigdog@example.com',
        'Big Dog',
        'bigdog',
        '0x1111111111111111111111111111111111111111',
        '{}',
        now,
        now
      );

      const insertSculpture = (id, title, modelCid = testCid, gatewayUrl = `http://127.0.0.1:${gwPort}/ipfs/${testCid}`) => {
        db.prepare(
          `INSERT INTO sculptures (
            id, title, description, creator_sub, creator_name, creator_email, recipient_address,
            lat, lng, altitude, parcel_id, geohash, place_name, voxels_json, voxel_count,
            pol_score, pol_json, proof_hash, preview_data_url,
            ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url,
            chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain,
            royalty_bps, royalty_receiver, hidden, terms_accepted_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run(
          id,
          title,
          'Large >180KB GLB model',
          'google:u1',
          '@bigdog',
          'bigdog@example.com',
          '0x1111111111111111111111111111111111111111',
          39.7302,
          -121.8406,
          60,
          'GLAND-9R1652WM',
          '9r1652wm',
          'Chico, CA',
          '[]',
          0,
          95,
          '{}',
          `proof-${id}`,
          '',
          'QmMetaCidTest1234567890',
          modelCid,
          'QmImgCidTest1234567890',
          gatewayUrl,
          46630,
          'Robinhood Chain Testnet',
          '0x2222222222222222222222222222222222222222',
          '1',
          '0xabc',
          1,
          500,
          '0x3333333333333333333333333333333333333333',
          '1.0',
          now
        );
      };

      // Insert a Boom Box style custom-3d sculpture (>180KB, empty inline_b64, pinned model_cid)
      insertSculpture('boombox-live-sim', 'Boom Box');
      db.prepare(
        `INSERT INTO sculpture_models (
          sculpture_id, parcel_id, model_format, mime_type, source_type, model_url,
          model_cid, model_uri, inline_b64, byte_length, scale, rotation_y, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'boombox-live-sim',
        'GLAND-9R1652WM',
        'glb',
        'model/gltf-binary',
        'base64',
        '',
        testCid,
        `ipfs://${testCid}`,
        '',
        realLargeGlb.length,
        1,
        0,
        now
      );

      // 1st request -> fetched from IPFS gateway and locally cached!
      const res1 = await fetch(`http://127.0.0.1:${apiPort}/api/sculptures/boombox-live-sim/model`);
      assert.equal(res1.status, 200);
      assert.equal(res1.headers.get('x-model-source'), 'ipfs-gateway');
      const body1 = new Uint8Array(await res1.arrayBuffer());
      assert.equal(
        body1.length,
        realLargeGlb.length,
        'Expected exact full >180KB GLB bytes, NEVER a 1,776-byte 1-voxel fallback box!'
      );
      assert.equal(body1[0], 0x67);
      assert.equal(body1[1], 0x6c);
      assert.equal(body1[2], 0x54);
      assert.equal(body1[3], 0x46);

      // 2nd request -> served instantly from local-ipfs cache even if gateway goes offline!
      gatewayAlive = false;
      const res2 = await fetch(`http://127.0.0.1:${apiPort}/api/sculptures/boombox-live-sim/model`);
      assert.equal(res2.status, 200);
      assert.equal(res2.headers.get('x-model-source'), 'local-ipfs');
      const body2 = new Uint8Array(await res2.arrayBuffer());
      assert.equal(body2.length, realLargeGlb.length);

      // Unreachable custom-3d asset -> MUST return 502 no-store (NEVER silently fall through to a 1-voxel box!)
      insertSculpture('boombox-missing', 'Missing GLB', '', '');
      db.prepare(
        `INSERT INTO sculpture_models (
          sculpture_id, parcel_id, model_format, mime_type, source_type, model_url,
          model_cid, model_uri, inline_b64, byte_length, scale, rotation_y, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'boombox-missing',
        'GLAND-9R1652WM',
        'glb',
        'model/gltf-binary',
        'base64',
        '',
        '',
        '',
        '',
        0,
        1,
        0,
        now
      );

      const resMissing = await fetch(
        `http://127.0.0.1:${apiPort}/api/sculptures/boombox-missing/model`
      );
      assert.equal(resMissing.status, 502);
      assert.match(resMissing.headers.get('cache-control') || '', /no-store/i);

      // Also verify Cloudflare Worker /api/sculptures/:id/model gateway resolution + KV backfill + 502 guard!
      const worker = (await import('../worker/src/index.js')).default;
      const kvStore = new Map();
      const pendingWaitUntils = [];
      const mockCtx = { waitUntil: (p) => pendingWaitUntils.push(p) };
      const mockEnv = {
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        WALLET_ENCRYPTION_KEY: 'test-wallet-key-0123456789abcdef',
        IPFS_GATEWAY: `http://127.0.0.1:${gwPort}/ipfs`,
        IPFS_KV: {
          get: async (key, type) => {
            const entry = kvStore.get(key);
            if (!entry) return null;
            const val = entry.value;
            return type === 'arrayBuffer' ? val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength) : val;
          },
          getWithMetadata: async (key, type) => {
            const entry = kvStore.get(key);
            if (!entry) return { value: null, metadata: null };
            const val = entry.value;
            return {
              value: type === 'arrayBuffer' ? val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength) : val,
              metadata: entry.metadata || null
            };
          },
          put: async (key, val, opts = {}) => {
            kvStore.set(key, {
              value: typeof val === 'string' ? val : new Uint8Array(val),
              metadata: opts?.metadata || null
            });
          }
        },
        DB: {
          prepare: (sql) => ({
            bind: (...args) => ({
              first: async () => {
                if (sql.includes('FROM sculpture_models')) {
                  if (args[0] === 'worker-boombox') {
                    return {
                      sculpture_id: 'worker-boombox',
                      model_format: 'glb',
                      mime_type: 'model/gltf-binary',
                      source_type: 'base64',
                      model_url: '',
                      model_cid: testCid,
                      inline_b64: ''
                    };
                  }
                  if (args[0] === 'worker-missing') {
                    return {
                      sculpture_id: 'worker-missing',
                      model_format: 'glb',
                      mime_type: 'model/gltf-binary',
                      source_type: 'base64',
                      model_url: '',
                      model_cid: '',
                      inline_b64: ''
                    };
                  }
                  return null;
                }
                if (sql.includes('FROM sculptures')) {
                  return { id: args[0], voxels_json: '[]' };
                }
                return null;
              },
              all: async () => ({ results: [] }),
              run: async () => ({ success: true })
            })
          })
        }
      };

      gatewayAlive = true;
      const wRes1 = await worker.fetch(
        new Request('https://api.example/api/sculptures/worker-boombox/model'),
        mockEnv,
        mockCtx
      );
      assert.equal(wRes1.status, 200);
      assert.equal(wRes1.headers.get('x-model-source'), 'ipfs-gateway');
      const wBytes1 = new Uint8Array(await wRes1.arrayBuffer());
      assert.equal(wBytes1.length, realLargeGlb.length);
      await Promise.all(pendingWaitUntils);

      // 2nd Worker fetch succeeds from edge KV cache even with gateway offline!
      gatewayAlive = false;
      const wRes2 = await worker.fetch(
        new Request('https://api.example/api/sculptures/worker-boombox/model'),
        mockEnv,
        mockCtx
      );
      assert.equal(wRes2.status, 200);
      assert.equal(wRes2.headers.get('x-model-source'), 'kv-cache');
      const wBytes2 = new Uint8Array(await wRes2.arrayBuffer());
      assert.equal(wBytes2.length, realLargeGlb.length);

      // Unreachable Worker custom-3d model returns 502 no-store (never a fake 1-voxel box!)
      const wResMissing = await worker.fetch(
        new Request('https://api.example/api/sculptures/worker-missing/model'),
        mockEnv,
        mockCtx
      );
      assert.equal(wResMissing.status, 502);
      assert.match(wResMissing.headers.get('cache-control') || '', /no-store/i);
    } finally {
      if (prevGw === undefined) delete process.env.IPFS_GATEWAY;
      else process.env.IPFS_GATEWAY = prevGw;
      if (prevDbPath === undefined) delete process.env.GRAFFILAND_DB_PATH;
      else process.env.GRAFFILAND_DB_PATH = prevDbPath;
      if (prevIpfsDir === undefined) delete process.env.GRAFFILAND_IPFS_DIR;
      else process.env.GRAFFILAND_IPFS_DIR = prevIpfsDir;
      await new Promise((resolve) => srv.server.close(resolve));
      await new Promise((resolve) => fakeGateway.close(resolve));
      try {
        db.close?.();
      } catch {
        // ignore
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore transient Windows file lock on temp sqlite
      }
    }
  });
});

describe('Focused Map Neighbor Edge Arrows (No Other-Land Lines + Zero HUD Overlap)', () => {
  const focusedLand = {
    parcel: { parcelId: 'GLAND-9R1652WM', customName: 'Squiggle Bro Land' },
    volume: {
      parcelId: 'GLAND-9R1652WM',
      centerLat: 39.7302,
      centerLng: -121.84067,
      widthMeters: 5,
      depthMeters: 2.3,
      heightMeters: 2
    }
  };

  const neighbors = [
    {
      parcel: { parcelId: 'GLAND-EAST', customName: 'Twin Palms' },
      volume: { parcelId: 'GLAND-EAST', centerLat: 39.7302, centerLng: -121.84021 } // ~39m East
    },
    {
      parcel: { parcelId: 'GLAND-NORTH', customName: 'DRUGDEN' },
      volume: { parcelId: 'GLAND-NORTH', centerLat: 39.7308, centerLng: -121.84067 } // ~67m North
    },
    {
      parcel: { parcelId: 'GLAND-WEST', customName: 'Post Office VR' },
      volume: { parcelId: 'GLAND-WEST', centerLat: 39.7302, centerLng: -121.8418 } // ~97m West
    },
    {
      parcel: { parcelId: 'GLAND-SOUTH', customName: 'Olde BCACTV' },
      volume: { parcelId: 'GLAND-SOUTH', centerLat: 39.7291, centerLng: -121.84067 } // ~122m South
    }
  ];

  test('places directional arrows on exact cardinal viewport edges, rotates with camera bearing, and avoids behind-camera flips', () => {
    const vw = 540;
    const vh = 280;
    const reservedRects = buildDefaultHudReservedRects({ stageWidth: vw, stageHeight: vh });

    // North-up (bearing = 0°): East neighbor -> right edge (~0°), West -> left edge (~180°)
    const arrowsNorthUp = computeNeighborEdgeArrows({
      focusedEntry: focusedLand,
      otherEntries: neighbors,
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: 0,
      reservedRects
    });
    assert.equal(arrowsNorthUp.length, 4);
    const eastArrow = arrowsNorthUp.find((a) => a.parcelId === 'GLAND-EAST');
    const westArrow = arrowsNorthUp.find((a) => a.parcelId === 'GLAND-WEST');
    assert.ok(eastArrow);
    assert.ok(westArrow);
    assert.equal(eastArrow.side, 'right');
    assert.ok(Math.abs(eastArrow.arrowDeg) <= 10, `Expected East arrow ~0°, got ${eastArrow.arrowDeg}`);
    assert.equal(westArrow.side, 'left');
    assert.ok(
      Math.abs(Math.abs(westArrow.arrowDeg) - 180) <= 10,
      `Expected West arrow ~±180°, got ${westArrow.arrowDeg}`
    );

    // Rotated camera (bearing = +90°, East is now UP on screen): East neighbor -> top edge (~-90°)
    const arrowsEastUp = computeNeighborEdgeArrows({
      focusedEntry: focusedLand,
      otherEntries: [neighbors[0]],
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: 90,
      reservedRects
    });
    assert.equal(arrowsEastUp.length, 1);
    assert.equal(arrowsEastUp[0].side, 'top');
    assert.ok(
      Math.abs(arrowsEastUp[0].arrowDeg + 90) <= 10,
      `Expected East arrow pointing up (~-90°) when bearing=90°, got ${arrowsEastUp[0].arrowDeg}`
    );

    // Behind-camera pitched projection flip: mock projectLngLat returns inverted X for East neighbor
    // computeNeighborEdgeArrows MUST ignore the inverted projection and keep true right-pointing direction!
    const arrowsFlippedProj = computeNeighborEdgeArrows({
      focusedEntry: focusedLand,
      otherEntries: [neighbors[0]],
      projectLngLat: (lng) => (lng > -121.8405 ? { x: -400, y: 140 } : { x: 270, y: 140 }),
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: 0,
      reservedRects
    });
    assert.equal(arrowsFlippedProj.length, 1);
    assert.equal(arrowsFlippedProj[0].side, 'right');
    assert.ok(Math.abs(arrowsFlippedProj[0].arrowDeg) <= 10);
  });

  test('guarantees ZERO overlap with HUD controls AND sibling neighbor arrows on compact 350x220 mobile map stage', () => {
    const vw = 350;
    const vh = 220;
    const reservedRects = buildDefaultHudReservedRects({ stageWidth: vw, stageHeight: vh });
    // Cluster 4 neighbors all in the same Northeast direction to stress collision avoidance
    const clusteredNeighbors = [0, 1, 2, 3].map((i) => ({
      parcel: { parcelId: `GLAND-NE-${i}`, customName: `Neighbor Plaza ${i + 1}` },
      volume: {
        parcelId: `GLAND-NE-${i}`,
        centerLat: 39.7302 + (i + 1) * 0.0003,
        centerLng: -121.84067 + (i + 1) * 0.00035
      }
    }));

    const placed = computeNeighborEdgeArrows({
      focusedEntry: focusedLand,
      otherEntries: clusteredNeighbors,
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: -45,
      reservedRects
    });

    assert.ok(placed.length >= 2, `Expected at least 2 placed neighbor arrows, got ${placed.length}`);
    const arrowRects = placed.map((a) => ({
      x: a.x - a.width / 2,
      y: a.y - a.height / 2,
      w: a.width,
      h: a.height
    }));

    for (let i = 0; i < arrowRects.length; i++) {
      for (const hud of reservedRects) {
        assert.equal(
          rectsOverlap(arrowRects[i], hud, 4),
          false,
          `Neighbor arrow ${placed[i].label} overlapped HUD rect ${JSON.stringify(hud)}`
        );
      }
      for (let j = i + 1; j < arrowRects.length; j++) {
        assert.equal(
          rectsOverlap(arrowRects[i], arrowRects[j], 4),
          false,
          `Neighbor arrows ${placed[i].label} and ${placed[j].label} overlapped each other`
        );
      }
    }
  });
});
