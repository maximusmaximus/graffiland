import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { computeLandOgContentSig } from '../../../shared/landOgImage.mjs';
import { buildVoxelGroup, disposeObject3D } from '../components/VoxelEngine3D.js';
import { resolveApiUrl } from './api.js';
import {
  enforceCrispTexturesAndShading,
  loadCustomModelObject
} from './customModelLoader.js';

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 315;
const MAX_CACHE_ENTRIES = 80;
const MAX_3D_SCULPTURES = 12;

const previewCache = new Map();
const inflightByKey = new Map();
let renderChain = Promise.resolve();
let sharedLandCtx = null;
let webglUnavailable = false;

function setCacheEntry(key, value) {
  if (!key || !value) return;
  if (previewCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = previewCache.keys().next().value;
    if (oldest) previewCache.delete(oldest);
  }
  previewCache.set(key, value);
}

function resolveLandMetrics(land) {
  const vol = land?.volume || {};
  const widthM = Math.max(4, Math.min(200, Number(vol.widthMeters || 12)));
  const depthM = Math.max(4, Math.min(200, Number(vol.depthMeters || 12)));
  const heightM = Math.max(3, Math.min(60, Number(vol.heightMeters || 8)));
  return { widthM, depthM, heightM };
}

function getVisibleSculptures(land, sculpturesOverride) {
  const list = Array.isArray(sculpturesOverride)
    ? sculpturesOverride
    : Array.isArray(land?.sculptures)
    ? land.sculptures
    : [];
  return list.filter((s) => s && !s.hidden);
}

export function getLandPreviewSignature(
  land,
  sculpturesOverride = null,
  { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}
) {
  if (!land) return '';
  const visible = getVisibleSculptures(land, sculpturesOverride);
  const contentSig = computeLandOgContentSig({ parcel: land, sculptures: visible });
  const voxelFlag = visible.map((s) => (Array.isArray(s.voxels) ? s.voxels.length : 0)).join(',');
  return `${land.parcelId || 'land'}|${contentSig}|${voxelFlag}|${width}x${height}`;
}

export function getCachedLandPreview(
  land,
  sculpturesOverride = null,
  { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}
) {
  const sig = getLandPreviewSignature(land, sculpturesOverride, { width, height });
  return sig ? previewCache.get(sig) || '' : '';
}

function computeLocalPlacement(sc, index, total, widthM, depthM) {
  const ao = sc?.anchorOffset || {};
  const hasExplicitOffset =
    Number.isFinite(Number(ao.dx)) &&
    Number.isFinite(Number(ao.dz)) &&
    (Math.abs(Number(ao.dx || 0)) > 0.001 || Math.abs(Number(ao.dz || 0)) > 0.001);

  if (hasExplicitOffset) {
    return {
      dx: Math.max(-widthM * 0.44, Math.min(widthM * 0.44, Number(ao.dx || 0))),
      dy: Math.max(0, Number(ao.dy || 0)),
      dz: Math.max(-depthM * 0.44, Math.min(depthM * 0.44, Number(ao.dz || 0))),
      yaw: Number(ao.yaw || 0),
      pitch: Number(ao.pitch || 0),
      roll: Number(ao.roll || 0),
      scale: Math.max(0.25, Math.min(8, Number(ao.scale ?? sc?.customModel?.scale ?? sc?.scale ?? 1)))
    };
  }

  // Spread un-offset artworks evenly in a picturesque low-angle showcase grid
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, total))));
  const rows = Math.max(1, Math.ceil(Math.max(1, total) / cols));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const spreadX = total === 1 ? 0 : ((col + 0.5) / cols - 0.5) * widthM * 0.68;
  const spreadZ = total === 1 ? 0 : ((row + 0.5) / rows - 0.5) * depthM * 0.68;
  return {
    dx: spreadX,
    dy: Math.max(0, Number(ao.dy || 0)),
    dz: spreadZ,
    yaw: Number(ao.yaw || 0),
    pitch: Number(ao.pitch || 0),
    roll: Number(ao.roll || 0),
    scale: Math.max(0.25, Math.min(8, Number(ao.scale ?? sc?.customModel?.scale ?? sc?.scale ?? 1)))
  };
}

/**
 * Pure-SVG low-angle isometric land preview fitting the parcel prism and up to 14 sculptures.
 * Renders instantaneously on first paint (and in non-WebGL / JSDOM environments) while the
 * WebGL 3D offscreen snapshot warms up in the background.
 */
export function buildLandLowAngleSvgDataUrl(land, sculpturesOverride = null) {
  const { widthM, depthM, heightM } = resolveLandMetrics(land);
  const visible = getVisibleSculptures(land, sculpturesOverride).slice(0, 14);
  const isOwnedOrPermanent =
    land?.stewardStatus === 'permanent' ||
    Boolean(land?.hadHumanInteraction) ||
    Boolean(land?.landDeed);
  const accent = land?.isFrozen || land?.frozen
    ? '#7dd3fc'
    : isOwnedOrPermanent
    ? '#00f5d4'
    : '#f5b841';
  const accentSoft = land?.isFrozen || land?.frozen
    ? 'rgba(125,211,252,0.16)'
    : isOwnedOrPermanent
    ? 'rgba(0,245,212,0.14)'
    : 'rgba(245,184,65,0.15)';

  // Normalize footprint to 1.0 max span, then project with low-angle isometric perspective
  const maxSpan = Math.max(widthM, depthM, 4);
  const nw = (widthM / maxSpan) * 1.15;
  const nd = (depthM / maxSpan) * 1.15;
  const nh = Math.min(0.68, Math.max(0.28, (heightM / maxSpan) * 0.9));

  const W = 560;
  const H = 315;
  const originX = W * 0.5;
  const originY = H * 0.72;
  const sx = 178;
  const sy = 56; // Low-angle flattening for dramatic isometric horizon
  const sz = 165;

  const proj = (x, y, z) => {
    const px = originX + (x - z) * sx;
    const py = originY + (x + z) * sy - y * sz;
    return [Number(px.toFixed(1)), Number(py.toFixed(1))];
  };

  const hw = nw / 2;
  const hd = nd / 2;
  const b0 = proj(-hw, 0, -hd);
  const b1 = proj(hw, 0, -hd);
  const b2 = proj(hw, 0, hd);
  const b3 = proj(-hw, 0, hd);
  const t0 = proj(-hw, nh, -hd);
  const t1 = proj(hw, nh, -hd);
  const t2 = proj(hw, nh, hd);
  const t3 = proj(-hw, nh, hd);

  const pts = (arr) => arr.map((p) => `${p[0]},${p[1]}`).join(' ');

  // Floor grid lines
  const gridLines = [];
  const steps = 6;
  for (let i = 1; i < steps; i += 1) {
    const u = -hw + (nw * i) / steps;
    const gA = proj(u, 0, -hd);
    const gB = proj(u, 0, hd);
    gridLines.push(
      `<line x1="${gA[0]}" y1="${gA[1]}" x2="${gB[0]}" y2="${gB[1]}" stroke="${accent}" stroke-opacity="0.18" stroke-width="1"/>`
    );
    const v = -hd + (nd * i) / steps;
    const gC = proj(-hw, 0, v);
    const gD = proj(hw, 0, v);
    gridLines.push(
      `<line x1="${gC[0]}" y1="${gC[1]}" x2="${gD[0]}" y2="${gD[1]}" stroke="${accent}" stroke-opacity="0.18" stroke-width="1"/>`
    );
  }

  // Sculptures sorted back-to-front by (nx + nz)
  const palette = ['#00f5d4', '#ff3e7f', '#00bbf9', '#ffd166', '#9b5de5', '#4ade80'];
  const items = visible.map((sc, idx) => {
    const pos = computeLocalPlacement(sc, idx, visible.length, widthM, depthM);
    const nx = (pos.dx / maxSpan) * 1.15;
    const nz = (pos.dz / maxSpan) * 1.15;
    const ny = Math.min(nh * 0.35, (pos.dy / maxSpan) * 0.9);
    let col = palette[idx % palette.length];
    if (Array.isArray(sc.voxels) && sc.voxels.length > 0 && sc.voxels[0]?.color) {
      col = String(sc.voxels[0].color);
    }
    const isModel = sc.modelType === 'custom-3d';
    const boxW = Math.min(0.16, Math.max(0.065, 0.085 * Math.sqrt(pos.scale)));
    const boxH = Math.min(nh * 0.72, Math.max(0.12, (isModel ? 0.24 : 0.2) * Math.sqrt(pos.scale)));
    return { nx, ny, nz, boxW, boxH, col, isModel, depth: nx + nz };
  });
  items.sort((a, b) => a.depth - b.depth);

  const scSvg = items
    .map((it) => {
      const r = it.boxW * 0.5;
      const pTop = [
        proj(it.nx - r, it.ny + it.boxH, it.nz - r),
        proj(it.nx + r, it.ny + it.boxH, it.nz - r),
        proj(it.nx + r, it.ny + it.boxH, it.nz + r),
        proj(it.nx - r, it.ny + it.boxH, it.nz + r)
      ];
      const pLeft = [
        proj(it.nx - r, it.ny + it.boxH, it.nz + r),
        proj(it.nx + r, it.ny + it.boxH, it.nz + r),
        proj(it.nx + r, it.ny, it.nz + r),
        proj(it.nx - r, it.ny, it.nz + r)
      ];
      const pRight = [
        proj(it.nx + r, it.ny + it.boxH, it.nz - r),
        proj(it.nx + r, it.ny + it.boxH, it.nz + r),
        proj(it.nx + r, it.ny, it.nz + r),
        proj(it.nx + r, it.ny, it.nz - r)
      ];
      const base = proj(it.nx, 0, it.nz);
      return `<g>
        <ellipse cx="${base[0]}" cy="${base[1]}" rx="${(r * 130).toFixed(1)}" ry="${(r * 45).toFixed(1)}" fill="${it.col}" fill-opacity="0.28"/>
        <polygon points="${pts(pLeft)}" fill="${it.col}" fill-opacity="0.72" stroke="#060a14" stroke-opacity="0.45" stroke-width="0.9"/>
        <polygon points="${pts(pRight)}" fill="${it.col}" fill-opacity="0.52" stroke="#060a14" stroke-opacity="0.45" stroke-width="0.9"/>
        <polygon points="${pts(pTop)}" fill="${it.col}" fill-opacity="0.96" stroke="#ffffff" stroke-opacity="0.45" stroke-width="0.8"/>
      </g>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stop-color="#070d1d"/>
        <stop offset="55%" stop-color="#0c1730"/>
        <stop offset="100%" stop-color="#060a14"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="62%" r="54%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#060a14" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <polygon points="${pts([b0, b1, b2, b3])}" fill="${accentSoft}" stroke="${accent}" stroke-opacity="0.65" stroke-width="1.6"/>
    ${gridLines.join('')}
    <line x1="${b0[0]}" y1="${b0[1]}" x2="${t0[0]}" y2="${t0[1]}" stroke="${accent}" stroke-opacity="0.28" stroke-width="1.1"/>
    <line x1="${b1[0]}" y1="${b1[1]}" x2="${t1[0]}" y2="${t1[1]}" stroke="${accent}" stroke-opacity="0.34" stroke-width="1.1"/>
    <line x1="${b3[0]}" y1="${b3[1]}" x2="${t3[0]}" y2="${t3[1]}" stroke="${accent}" stroke-opacity="0.34" stroke-width="1.1"/>
    ${scSvg}
    <line x1="${b2[0]}" y1="${b2[1]}" x2="${t2[0]}" y2="${t2[1]}" stroke="${accent}" stroke-opacity="0.52" stroke-width="1.3"/>
    <polygon points="${pts([t0, t1, t2, t3])}" fill="none" stroke="${accent}" stroke-opacity="0.48" stroke-width="1.2" stroke-dasharray="6 4"/>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getSharedLandContext(width, height) {
  if (webglUnavailable || typeof document === 'undefined') return null;
  if (!sharedLandCtx) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true
      });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#070d1d');
      scene.fog = new THREE.FogExp2('#070d1d', 0.008);

      const pmrem = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      const envRT = pmrem.fromScene(roomEnv, 0.04);
      roomEnv.dispose();
      pmrem.dispose();
      scene.environment = envRT.texture;

      scene.add(new THREE.HemisphereLight(0xdff6ff, 0x182238, 1.0));
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
      keyLight.position.set(14, 18, 12);
      scene.add(keyLight);
      const cyanRim = new THREE.DirectionalLight(0x00f5d4, 0.65);
      cyanRim.position.set(-14, 9, -10);
      scene.add(cyanRim);
      const pinkRim = new THREE.DirectionalLight(0xff3e7f, 0.38);
      pinkRim.position.set(10, 6, -14);
      scene.add(pinkRim);

      const camera = new THREE.PerspectiveCamera(38, width / height, 0.05, 1000);
      const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() || 4;
      sharedLandCtx = { renderer, scene, camera, maxAnisotropy, width, height };
    } catch {
      webglUnavailable = true;
      return null;
    }
  }

  if (sharedLandCtx.width !== width || sharedLandCtx.height !== height) {
    sharedLandCtx.renderer.setSize(width, height, false);
    sharedLandCtx.camera.aspect = width / height;
    sharedLandCtx.camera.updateProjectionMatrix();
    sharedLandCtx.width = width;
    sharedLandCtx.height = height;
  }
  return sharedLandCtx;
}

async function renderOneLandPreview(land, sculpturesOverride, { width, height }) {
  const ctx = getSharedLandContext(width, height);
  if (!ctx) return buildLandLowAngleSvgDataUrl(land, sculpturesOverride);

  const { widthM, depthM, heightM } = resolveLandMetrics(land);
  const visible = getVisibleSculptures(land, sculpturesOverride).slice(0, MAX_3D_SCULPTURES);

  const root = new THREE.Group();
  try {
    const isFrozen = Boolean(land?.isFrozen || land?.frozen);
    const isPermanent =
      land?.stewardStatus === 'permanent' ||
      Boolean(land?.hadHumanInteraction) ||
      Boolean(land?.landDeed);
    const accentHex = isFrozen ? 0x7dd3fc : isPermanent ? 0x00f5d4 : 0xf5b841;

    // Translucent land floor pad
    const floorGeo = new THREE.PlaneGeometry(widthM, depthM);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0b162d,
      emissive: accentHex,
      emissiveIntensity: 0.09,
      roughness: 0.85,
      metalness: 0.1
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    root.add(floorMesh);

    // Ground grid inside the parcel
    const gridSize = Math.max(widthM, depthM);
    const gridDivs = Math.max(6, Math.min(18, Math.round(gridSize / 2)));
    const grid = new THREE.GridHelper(gridSize, gridDivs, accentHex, 0x1c3154);
    grid.scale.set(widthM / gridSize, 1, depthM / gridSize);
    grid.position.y = 0.015;
    root.add(grid);

    // Subtle glowing prism wireframe bounds
    const boxGeo = new THREE.BoxGeometry(widthM, heightM, depthM);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    const edgesMat = new THREE.LineBasicMaterial({
      color: accentHex,
      transparent: true,
      opacity: 0.52
    });
    const prismLines = new THREE.LineSegments(edgesGeo, edgesMat);
    prismLines.position.y = heightM / 2;
    root.add(prismLines);

    // Load and position up to 12 sculptures inside the land
    const palette = [0x00f5d4, 0xff3e7f, 0x00bbf9, 0xffd166, 0x9b5de5, 0x4ade80];
    for (let i = 0; i < visible.length; i += 1) {
      const sc = visible[i];
      const pos = computeLocalPlacement(sc, i, visible.length, widthM, depthM);
      let obj = null;
      const isCustom3d = Boolean(
        (sc.modelType === 'custom-3d' || sc.customModel?.format) && sc.customModel?.format
      );
      const hasVoxels = Array.isArray(sc.voxels) && sc.voxels.length > 0;

      try {
        if (isCustom3d) {
          const loaded = await Promise.race([
            loadCustomModelObject(sc, resolveApiUrl, {
              maxAnisotropy: ctx.maxAnisotropy,
              applyCustomScale: false
            }),
            new Promise((resolve) => setTimeout(() => resolve(null), 3500))
          ]);
          if (loaded?.object3d) {
            enforceCrispTexturesAndShading(loaded.object3d, ctx.maxAnisotropy);
            obj = loaded.object3d;
          }
        } else if (hasVoxels) {
          obj = buildVoxelGroup(sc.voxels, { simplifyLod: true });
        }
      } catch {
        obj = null;
      }

      if (!obj) {
        // Stylised glowing pedestal sculpture beacon when full model wasn't loaded
        const col = palette[i % palette.length];
        const fallbackGroup = new THREE.Group();
        const pillarH = Math.max(1.2, Math.min(heightM * 0.45, 2.2 * Math.sqrt(pos.scale)));
        const pillarW = Math.max(0.7, Math.min(widthM * 0.16, 1.15 * Math.sqrt(pos.scale)));
        const geo = new THREE.BoxGeometry(pillarW, pillarH, pillarW);
        const mat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.25,
          roughness: 0.35,
          metalness: 0.2
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = pillarH / 2;
        fallbackGroup.add(mesh);
        obj = fallbackGroup;
      }

      // Normalize pivot so object rests cleanly on its floor offset
      const rawBox = new THREE.Box3().setFromObject(obj);
      if (!rawBox.isEmpty()) {
        const rawCenter = new THREE.Vector3();
        const rawSize = new THREE.Vector3();
        rawBox.getCenter(rawCenter);
        rawBox.getSize(rawSize);
        const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z, 0.2);
        const maxAllowed = Math.min(widthM, depthM) * 0.42;
        const effectiveScale =
          maxDim * pos.scale > maxAllowed
            ? Math.max(0.2, maxAllowed / maxDim)
            : pos.scale;
        const holder = new THREE.Group();
        obj.position.set(-rawCenter.x, -rawBox.min.y, -rawCenter.z);
        holder.add(obj);
        holder.scale.setScalar(effectiveScale);
        holder.rotation.set(
          (pos.pitch * Math.PI) / 180,
          (pos.yaw * Math.PI) / 180,
          (pos.roll * Math.PI) / 180
        );
        holder.position.set(pos.dx, pos.dy, pos.dz);
        root.add(holder);
      } else {
        root.add(obj);
      }
    }

    ctx.scene.add(root);

    // Frame with a dramatic LOW-ANGLE ISOMETRIC camera (~21° pitch, 38° yaw) fitting the land + all artworks
    const sceneBox = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    sceneBox.getCenter(center);
    sceneBox.getSize(size);
    // Keep vertical target slightly low so horizon & sculptures tower cinematically
    const targetY = Math.min(center.y * 0.72, heightM * 0.38);
    const target = new THREE.Vector3(center.x, Math.max(0.4, targetY), center.z);

    const radius = Math.max(3.5, Math.hypot(size.x, size.z, size.y * 0.75) * 0.54);
    const fovRad = (ctx.camera.fov * Math.PI) / 180;
    const aspect = width / height;
    const vDist = radius / Math.sin(fovRad / 2);
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
    const hDist = radius / Math.sin(hFov / 2);
    const dist = Math.max(vDist, hDist) * 0.96;

    // Low-angle isometric direction (elevation ~21 deg, azimuth ~38 deg)
    const elevRad = (21 * Math.PI) / 180;
    const azimRad = (38 * Math.PI) / 180;
    const camDir = new THREE.Vector3(
      Math.cos(elevRad) * Math.sin(azimRad),
      Math.sin(elevRad),
      Math.cos(elevRad) * Math.cos(azimRad)
    ).normalize();

    ctx.camera.position.copy(target).addScaledVector(camDir, dist);
    ctx.camera.near = Math.max(0.05, dist * 0.01);
    ctx.camera.far = Math.max(250, dist * 12);
    ctx.camera.lookAt(target);
    ctx.camera.updateProjectionMatrix();

    ctx.renderer.render(ctx.scene, ctx.camera);
    const dataUrl = ctx.renderer.domElement.toDataURL('image/png');
    return dataUrl && dataUrl.startsWith('data:image/')
      ? dataUrl
      : buildLandLowAngleSvgDataUrl(land, sculpturesOverride);
  } catch {
    return buildLandLowAngleSvgDataUrl(land, sculpturesOverride);
  } finally {
    ctx.scene.remove(root);
    disposeObject3D(root);
  }
}

/**
 * Renders (and caches) a low-angle isometric 3D preview shot of a Virtual Land framing its
 * boundary prism and sculptures. Uses one queued shared offscreen WebGL context so scrolling
 * many land cards never exhausts GPU contexts.
 */
export function renderLandIsometricPreview(
  land,
  sculpturesOverride = null,
  { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, force = false } = {}
) {
  if (!land) return Promise.resolve('');
  const key = getLandPreviewSignature(land, sculpturesOverride, { width, height });
  if (!key) return Promise.resolve('');

  if (!force) {
    const cached = previewCache.get(key);
    if (cached) return Promise.resolve(cached);
    if (inflightByKey.has(key)) return inflightByKey.get(key);
  }

  const promise = renderChain
    .then(() => renderOneLandPreview(land, sculpturesOverride, { width, height }))
    .then((dataUrl) => {
      if (dataUrl) setCacheEntry(key, dataUrl);
      return dataUrl;
    })
    .catch(() => buildLandLowAngleSvgDataUrl(land, sculpturesOverride))
    .finally(() => {
      inflightByKey.delete(key);
    });

  renderChain = promise.then(
    () => {},
    () => {}
  );
  inflightByKey.set(key, promise);
  return promise;
}
