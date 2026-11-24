import * as THREE from 'three';

export const DEFAULT_BOUNDARY_NEAR_ALPHA = 1.0;
export const DEFAULT_BOUNDARY_FAR_ALPHA = 0.32; // ~68% fade at farthest corner (unmistakable even on light map tiles)
export const MIN_FAR_BOUNDARY_FADE_FRACTION = 0.25;

/**
 * Parses common hex (#rgb, #rrggbb) or rgb()/rgba() CSS colors into { r, g, b, a }.
 */
export function parseCssColorRgba(color) {
  const raw = String(color || '').trim();
  const rgbaMatch = raw.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
  );
  if (rgbaMatch) {
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(rgbaMatch[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(rgbaMatch[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(rgbaMatch[3])))),
      a: rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, Number(rgbaMatch[4]))) : 1
    };
  }

  let hex = raw.replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1
    };
  }
  return { r: 0, g: 245, b: 212, a: 1 };
}

/**
 * Scales a CSS color's alpha channel by `alphaFactor` (0..1) and returns an rgba() string.
 */
export function colorWithAlpha(color, alphaFactor = 1) {
  const { r, g, b, a } = parseCssColorRgba(color);
  const outA = Math.max(0, Math.min(1, a * Number(alphaFactor)));
  return `rgba(${r}, ${g}, ${b}, ${outA.toFixed(3)})`;
}

/**
 * Computes normalized camera-depth fade alphas for a projected 4-corner 3D prism.
 * Corners closest to the user get `nearAlpha` (clear), while corners on the opposite
 * side of the figure away from the user fade by at least 25% (default 58%, down to `farAlpha`).
 *
 * Uses each vertical column's horizontal ground-plane camera depth (`bottom[i].depth` or `-bottom[i].y`)
 * so tall figures never invert near-vs-far face clarity.
 */
export function computePrismCornerFadeAlphas(
  bottom,
  top,
  {
    nearAlpha = DEFAULT_BOUNDARY_NEAR_ALPHA,
    farAlpha = DEFAULT_BOUNDARY_FAR_ALPHA,
    minFadeFraction = MIN_FAR_BOUNDARY_FADE_FRACTION
  } = {}
) {
  if (!Array.isArray(bottom) || bottom.length < 4 || !Array.isArray(top) || top.length < 4) {
    return { columnAlphas: [1, 1, 1, 1], columnDepthT: [0, 0, 0, 0], edges: [] };
  }

  const clampedNear = Math.max(0.1, Math.min(1, Number(nearAlpha)));
  const maxAllowedFar = clampedNear * (1 - Math.max(MIN_FAR_BOUNDARY_FADE_FRACTION, Number(minFadeFraction) || 0.25));
  const clampedFar = Math.max(0.08, Math.min(maxAllowedFar, Number(farAlpha)));

  // Extract monotonic camera depth per corner column (larger = farther away from user/camera)
  const hasExplicitDepth = bottom.every((p) => Number.isFinite(Number(p?.depth)) && Number(p.depth) !== 0);
  const rawDepths = bottom.slice(0, 4).map((p) =>
    hasExplicitDepth ? Number(p.depth) : -Number(p?.y || 0)
  );
  const minD = Math.min(...rawDepths);
  const maxD = Math.max(...rawDepths);
  const span = maxD - minD;

  // Flat top-down (zero pitch -> negligible depth span) keeps uniform clarity
  const columnDepthT =
    span > 1e-6 ? rawDepths.map((d) => Math.max(0, Math.min(1, (d - minD) / span))) : [0, 0, 0, 0];

  const columnAlphas = columnDepthT.map((t) => {
    const eased = Math.pow(t, 0.92);
    return Number((clampedNear - (clampedNear - clampedFar) * eased).toFixed(4));
  });

  // Build all 12 edges (4 bottom, 4 top, 4 vertical) and sort strictly back-to-front
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const next = (i + 1) % 4;
    edges.push({
      kind: 'bottom',
      a: bottom[i],
      b: bottom[next],
      alphaA: columnAlphas[i],
      alphaB: columnAlphas[next],
      depthT: (columnDepthT[i] + columnDepthT[next]) * 0.5,
      avgAlpha: (columnAlphas[i] + columnAlphas[next]) * 0.5
    });
    edges.push({
      kind: 'top',
      a: top[i],
      b: top[next],
      alphaA: columnAlphas[i],
      alphaB: columnAlphas[next],
      depthT: (columnDepthT[i] + columnDepthT[next]) * 0.5,
      avgAlpha: (columnAlphas[i] + columnAlphas[next]) * 0.5
    });
    edges.push({
      kind: 'vertical',
      a: bottom[i],
      b: top[i],
      alphaA: columnAlphas[i],
      alphaB: columnAlphas[i],
      depthT: columnDepthT[i],
      avgAlpha: columnAlphas[i]
    });
  }

  // Painter's order: draw farthest (highest depthT) first so crisp front edges draw cleanly on top
  edges.sort((e1, e2) => e2.depthT - e1.depthT);

  return { columnAlphas, columnDepthT, edges };
}

function makeEdgeStroke(ctx, a, b, baseColor, alphaA, alphaB) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (Math.abs(alphaA - alphaB) > 0.03 && len > 1 && typeof ctx.createLinearGradient === 'function') {
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, colorWithAlpha(baseColor, alphaA));
    grad.addColorStop(1, colorWithAlpha(baseColor, alphaB));
    return grad;
  }
  return colorWithAlpha(baseColor, (alphaA + alphaB) * 0.5);
}

/**
 * Draws a 3D prism wireframe on Canvas2D with smooth camera-depth fading so the boundary
 * lines closest to the user are crisp and lines on the opposite side of the figure are
 * faded by at least 25% (default 58% at the farthest corner).
 */
export function drawDepthFadedPrismEdges(
  ctx,
  geom,
  {
    outerColor,
    innerColor,
    lineWidth = 2.1,
    glowBlur = 12,
    dashed = false,
    darkHalo = true,
    nearAlpha = DEFAULT_BOUNDARY_NEAR_ALPHA,
    farAlpha = DEFAULT_BOUNDARY_FAR_ALPHA,
    includeBottomEdges = true
  }
) {
  if (!ctx || !geom?.bottom || !geom?.top) return null;
  const fade = computePrismCornerFadeAlphas(geom.bottom, geom.top, { nearAlpha, farAlpha });
  const edges = includeBottomEdges
    ? fade.edges
    : fade.edges.filter((edge) => edge.kind !== 'bottom');

  const drawPass = ({
    color,
    width,
    blur,
    alphaScale = 1,
    alphaExponent = 1,
    scaleWidthByDepth = false
  }) => {
    ctx.save();
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const edge of edges) {
      const aA = Math.pow(edge.alphaA, alphaExponent) * alphaScale;
      const aB = Math.pow(edge.alphaB, alphaExponent) * alphaScale;
      const avg = Math.pow(edge.avgAlpha, alphaExponent);
      const depthWeight = 0.72 + 0.28 * edge.avgAlpha;
      ctx.strokeStyle = makeEdgeStroke(ctx, edge.a, edge.b, color, aA, aB);
      ctx.lineWidth = scaleWidthByDepth ? Math.max(0.8, width * depthWeight) : width;
      ctx.shadowColor = blur > 0 ? colorWithAlpha(outerColor, avg) : 'transparent';
      ctx.shadowBlur = blur > 0 ? blur * avg : 0;
      ctx.beginPath();
      ctx.moveTo(edge.a.x, edge.a.y);
      ctx.lineTo(edge.b.x, edge.b.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (darkHalo && !dashed) {
    drawPass({
      color: 'rgba(4, 10, 20, 0.72)',
      width: lineWidth + 2.8,
      blur: 2,
      alphaScale: 1,
      alphaExponent: 2.1,
      scaleWidthByDepth: true
    });
  }
  drawPass({
    color: outerColor,
    width: lineWidth + 1.1,
    blur: glowBlur,
    alphaScale: 1,
    alphaExponent: 1.15,
    scaleWidthByDepth: true
  });
  drawPass({
    color: innerColor,
    width: Math.max(1, lineWidth - 0.5),
    blur: 0,
    alphaScale: 0.94,
    alphaExponent: 1.25,
    scaleWidthByDepth: true
  });

  return fade;
}

/* ================= THREE.JS DEPTH-FADED 3D BOUNDARY WIREFRAMES ================= */

const DEPTH_FADE_VERT_SHADER = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DEPTH_FADE_FRAG_SHADER = `
uniform vec3 uColor;
uniform float uOpacityScale;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, clamp(vAlpha * uOpacityScale, 0.0, 1.0));
}
`;

/**
 * Pure math helper computing per-column camera-depth fade alphas for 4 world-space
 * horizontal corners (bottom[0..3]) relative to `cameraPos`.
 * Uses horizontal XZ projection along the camera-to-center viewing axis so tall figures
 * fade strictly front-to-back across the figure away from the user.
 */
export function computeThreeCornersDepthAlphas(
  worldBottomCorners,
  cameraPos,
  {
    nearOpacity = 0.98,
    farOpacity = 0.4,
    minFadeFraction = MIN_FAR_BOUNDARY_FADE_FRACTION
  } = {}
) {
  if (!Array.isArray(worldBottomCorners) || worldBottomCorners.length < 4 || !cameraPos) {
    return [nearOpacity, nearOpacity, nearOpacity, nearOpacity];
  }

  const clampedNear = Math.max(0.1, Math.min(1, Number(nearOpacity)));
  const maxAllowedFar =
    clampedNear * (1 - Math.max(MIN_FAR_BOUNDARY_FADE_FRACTION, Number(minFadeFraction) || 0.25));
  const clampedFar = Math.max(0.08, Math.min(maxAllowedFar, Number(farOpacity)));

  let cx = 0;
  let cz = 0;
  for (let i = 0; i < 4; i++) {
    cx += Number(worldBottomCorners[i].x || 0);
    cz += Number(worldBottomCorners[i].z || 0);
  }
  cx *= 0.25;
  cz *= 0.25;

  // Direction from camera horizontally toward the figure center (increasing along this vector = farther away!)
  let fx = cx - Number(cameraPos.x || 0);
  let fz = cz - Number(cameraPos.z || 0);
  const fLen = Math.hypot(fx, fz);

  let rawDepths;
  if (fLen > 0.05) {
    fx /= fLen;
    fz /= fLen;
    rawDepths = worldBottomCorners.slice(0, 4).map((pt) => {
      const dx = Number(pt.x || 0) - cx;
      const dz = Number(pt.z || 0) - cz;
      return dx * fx + dz * fz;
    });
  } else {
    // User standing dead-center inside the prism: fall back to Euclidean XZ distance from camera
    rawDepths = worldBottomCorners.slice(0, 4).map((pt) =>
      Math.hypot(Number(pt.x || 0) - Number(cameraPos.x || 0), Number(pt.z || 0) - Number(cameraPos.z || 0))
    );
  }

  const minD = Math.min(...rawDepths);
  const maxD = Math.max(...rawDepths);
  const span = maxD - minD;
  if (span <= 1e-5) {
    return [clampedNear, clampedNear, clampedNear, clampedNear];
  }

  return rawDepths.map((d) => {
    const t = Math.max(0, Math.min(1, (d - minD) / span));
    const eased = Math.pow(t, 0.92);
    return Number((clampedNear - (clampedNear - clampedFar) * eased).toFixed(4));
  });
}

// 12 edges of a 4-column prism: each pair is [columnA, isTopA, columnB, isTopB]
const PRISM_EDGE_PAIRS = [
  // 4 bottom perimeter edges
  [0, 0, 1, 0],
  [1, 0, 2, 0],
  [2, 0, 3, 0],
  [3, 0, 0, 0],
  // 4 top perimeter edges
  [0, 1, 1, 1],
  [1, 1, 2, 1],
  [2, 1, 3, 1],
  [3, 1, 0, 1],
  // 4 vertical corner pillars
  [0, 0, 0, 1],
  [1, 0, 1, 1],
  [2, 0, 2, 1],
  [3, 0, 3, 1]
];

/**
 * Builds a Three.js `LineSegments` boundary prism with per-vertex `aAlpha` shader support
 * so near boundary lines stay crisp and far boundary lines smoothly fade away from the camera.
 */
export function createDepthFadedThreePrismWireframe(
  bottomCorners,
  topCorners,
  colorHex = 0x00f5d4,
  { nearOpacity = 0.98, farOpacity = 0.4, opacityScale = 1 } = {}
) {
  const positions = new Float32Array(PRISM_EDGE_PAIRS.length * 2 * 3);
  const alphas = new Float32Array(PRISM_EDGE_PAIRS.length * 2);

  let pIdx = 0;
  let aIdx = 0;
  for (const [colA, topA, colB, topB] of PRISM_EDGE_PAIRS) {
    const ptA = topA ? topCorners[colA] : bottomCorners[colA];
    const ptB = topB ? topCorners[colB] : bottomCorners[colB];
    positions[pIdx++] = ptA.x;
    positions[pIdx++] = ptA.y;
    positions[pIdx++] = ptA.z;
    positions[pIdx++] = ptB.x;
    positions[pIdx++] = ptB.y;
    positions[pIdx++] = ptB.z;
    alphas[aIdx++] = nearOpacity;
    alphas[aIdx++] = nearOpacity;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uOpacityScale: { value: opacityScale }
    },
    vertexShader: DEPTH_FADE_VERT_SHADER,
    fragmentShader: DEPTH_FADE_FRAG_SHADER,
    transparent: true,
    depthWrite: false
  });

  const line = new THREE.LineSegments(geo, mat);
  line.userData.depthFadePrism = {
    localBottom: bottomCorners.slice(0, 4).map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    nearOpacity,
    farOpacity
  };
  return line;
}

/**
 * Convenience builder for a centered width × height × depth Three.js box boundary
 * with base at y = 0 and top at y = height.
 */
export function createDepthFadedThreeBoxWireframe(
  width,
  height,
  depth,
  colorHex = 0x00f5d4,
  options = {}
) {
  const hw = Number(width) * 0.5;
  const hd = Number(depth) * 0.5;
  const h = Number(height);
  const bottom = [
    new THREE.Vector3(-hw, 0, -hd),
    new THREE.Vector3(hw, 0, -hd),
    new THREE.Vector3(hw, 0, hd),
    new THREE.Vector3(-hw, 0, hd)
  ];
  const top = [
    new THREE.Vector3(-hw, h, -hd),
    new THREE.Vector3(hw, h, -hd),
    new THREE.Vector3(hw, h, hd),
    new THREE.Vector3(-hw, h, hd)
  ];
  return createDepthFadedThreePrismWireframe(bottom, top, colorHex, options);
}

const _tmpWorldCorner = new THREE.Vector3();
const _tmpWorldCorners = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3()
];

/**
 * Updates per-vertex `aAlpha` on a depth-faded Three.js wireframe (or recursively across a group)
 * relative to the active camera's world position. Zero per-frame heap allocations!
 */
export function updateThreeWireframeDepthFade(rootObj, cameraWorldPos) {
  if (!rootObj || !cameraWorldPos) return;
  rootObj.traverse((obj) => {
    const cfg = obj?.userData?.depthFadePrism;
    if (!cfg || !obj.geometry?.attributes?.aAlpha) return;
    obj.updateMatrixWorld(false);
    const matW = obj.matrixWorld;
    for (let i = 0; i < 4; i++) {
      _tmpWorldCorner.copy(cfg.localBottom[i]).applyMatrix4(matW);
      _tmpWorldCorners[i].copy(_tmpWorldCorner);
    }
    const colAlphas = computeThreeCornersDepthAlphas(_tmpWorldCorners, cameraWorldPos, {
      nearOpacity: cfg.nearOpacity,
      farOpacity: cfg.farOpacity
    });
    const attr = obj.geometry.attributes.aAlpha;
    const arr = attr.array;
    let idx = 0;
    for (const [colA, , colB] of PRISM_EDGE_PAIRS) {
      arr[idx++] = colAlphas[colA];
      arr[idx++] = colAlphas[colB];
    }
    attr.needsUpdate = true;
  });
}
