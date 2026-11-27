import xeroemoji from 'xeroemoji';
import { buildEmojiGlbFromPngBytes } from './glb.mjs';

export const CATALOG_SOURCES = Object.freeze({
  simready: {
    id: 'simready',
    name: 'SimReady Pile',
    shortName: 'SimReady',
    repo: 'maximusmaximus/simready-pile',
    repoUrl: 'https://github.com/maximusmaximus/simready-pile',
    description: 'Decimated NVIDIA SimReady 3D GLB props & real-world objects',
    indexUrl: 'https://raw.githubusercontent.com/maximusmaximus/simready-pile/main/assets.json',
    glbBaseUrl: 'https://cdn.jsdelivr.net/gh/maximusmaximus/simready-pile@main/glb'
  },
  pixels: {
    id: 'pixels',
    name: 'Pixels Atlas',
    shortName: 'Pixels',
    repo: 'maximusmaximus/pixels',
    repoUrl: 'https://github.com/maximusmaximus/pixels',
    description: '6,194 Pixel Art Atlas 3D GLB models (meshopt + WebP)',
    indexUrl: 'https://raw.githubusercontent.com/maximusmaximus/pixels/main/src/data/atlas-ids.json',
    glbBaseUrl: 'https://huggingface.co/datasets/codepawl/pixel-atlas-glb/resolve/main/objects'
  },
  xeroemoji: {
    id: 'xeroemoji',
    name: 'XeroEmoji Pile',
    shortName: 'XeroEmoji',
    repo: 'maximusmaximus/xeroemoji-pile',
    repoUrl: 'https://github.com/maximusmaximus/xeroemoji-pile',
    description: 'Top 500 ranked 3D extruded Xero Emojis',
    indexUrl: 'https://raw.githubusercontent.com/maximusmaximus/xeroemoji-pile/main/src/data/top500.ts',
    cdnBaseUrl: 'https://cdn.jsdelivr.net/gh/maximusmaximus/xeroemoji@v1.0.2'
  }
});

// Curated fallback items if upstream raw GitHub indexes are temporarily unreachable
const FALLBACK_SIMREADY_IDS = [
  'appliance_toaster_a01',
  'appliance_refrigerator_a01',
  'chair_office_a01',
  'chair_dining_a01',
  'food_produce_banana_m01',
  'food_produce_apple_a01',
  'plant_potted_a01',
  'table_coffee_a01',
  'lamp_desk_a01',
  'cone_traffic_a01',
  'barrel_steel_a01',
  'bin_waste_a01'
];

const FALLBACK_PIXELS_IDS = [
  'acoustic_guitar',
  'arcade_machine',
  'bonsai_tree',
  'cactus',
  'campfire',
  'coffee_cup',
  'crown',
  'crystal_ball',
  'dragon_egg',
  'flamingo',
  'mushroom',
  'pizza_slice',
  'rocket',
  'skateboard',
  'treasure_chest',
  'ufo'
];

const FALLBACK_XEROEMOJI_TOP_IDS = [
  '1f525', '2764', '1f602', '1f60d', '1f680', '1f451', '1f48e', '1f389',
  '2728', '1f308', '1f355', '1f47b', '1f480', '1f4a9', '1f3a8', '1f3b8',
  '1f3c6', '26a1', '1f335', '1f344', '1f436', '1f431', '1f984', '1f47d',
  '1f916', '2615', '1f388', '1f3af', '1f31f', '1f4af'
];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const indexCache = {
  simready: { loadedAt: 0, entries: null, promise: null },
  pixels: { loadedAt: 0, entries: null, promise: null },
  xeroemoji: { loadedAt: 0, entries: null, promise: null }
};

function toTitleCaseWord(word) {
  const w = String(word || '').trim();
  if (!w) return '';
  if (/^[A-Z0-9]{2,4}$/.test(w)) return w; // Keep short acronyms like TV, CT, IV, UFO
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

export function formatSimReadyLabel(rawId) {
  const clean = String(rawId || '').trim();
  if (!clean) return 'SimReady Prop';
  // Split camelCase and strip trailing variant suffix like _a01, _b02, _m01
  const withoutVariant = clean.replace(/_[a-z]\d{2}$/i, '');
  const tokens = withoutVariant
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/)
    .filter(Boolean);
  if (tokens.length === 0) return clean;
  // Deduplicate adjacent identical tokens (e.g. airSystem_air_filter -> Air System Filter)
  const deduped = [];
  for (const tok of tokens) {
    if (deduped.length === 0 || deduped[deduped.length - 1].toLowerCase() !== tok.toLowerCase()) {
      deduped.push(tok);
    }
  }
  const title = deduped.map(toTitleCaseWord).join(' ');
  const variantMatch = clean.match(/_([a-z]\d{2})$/i);
  return variantMatch ? `${title} (${variantMatch[1].toUpperCase()})` : title;
}

export function formatPixelsLabel(rawId) {
  const clean = String(rawId || '').trim();
  if (!clean) return 'Pixel Model';
  return clean
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(toTitleCaseWord)
    .join(' ');
}

function normalizeXeroEmojiKey(rawId) {
  return String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/\.glb$/i, '')
    .replace(/^u\+/, '')
    .replace(/[^0-9a-f-]/g, '');
}

function buildXeroEmojiLookupByFile() {
  const byFile = new Map();
  const mapObj = typeof xeroemoji?.map === 'function' ? xeroemoji.map() : xeroemoji?.map || {};
  for (const [key, entry] of Object.entries(mapObj)) {
    if (!entry) continue;
    let file = '';
    let emoji = '';
    let name = '';
    let group = '';
    let subgroup = '';
    if (Array.isArray(entry)) {
      file = String(entry[0] || key || '').toLowerCase();
      emoji = String(entry[1] || '');
      name = String(entry[2] || file);
      group = String(entry[3] || '');
      subgroup = String(entry[4] || '');
    } else if (typeof entry === 'object') {
      file = String(entry.file || entry.key || key || '').toLowerCase();
      emoji = String(entry.emoji || '');
      name = String(entry.name || file);
      group = String(entry.group || '');
      subgroup = String(entry.subgroup || '');
    }
    if (!file || byFile.has(file)) continue;
    byFile.set(file, {
      file,
      emoji,
      name,
      group,
      subgroup,
      svgUrl: `${CATALOG_SOURCES.xeroemoji.cdnBaseUrl}/svg/${file}.svg`,
      pngUrl: `${CATALOG_SOURCES.xeroemoji.cdnBaseUrl}/png/${file}.png`
    });
  }
  return byFile;
}

let cachedXeroLookup = null;
function getXeroLookup() {
  if (!cachedXeroLookup) cachedXeroLookup = buildXeroEmojiLookupByFile();
  return cachedXeroLookup;
}

function buildSimReadyEntry(rawId) {
  const id = String(rawId || '').trim();
  const title = formatSimReadyLabel(id);
  const tokens = id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  const category = tokens.split(' ')[0] || 'prop';
  return {
    id: `simready:${id}`,
    rawId: id,
    source: 'simready',
    sourceName: CATALOG_SOURCES.simready.name,
    repoUrl: CATALOG_SOURCES.simready.repoUrl,
    title,
    category,
    searchText: `${title.toLowerCase()} ${tokens} simready prop`,
    modelFormat: 'glb',
    modelUrl: `${CATALOG_SOURCES.simready.glbBaseUrl}/${encodeURIComponent(id)}.glb`,
    previewImageUrl: null,
    recommendedScale: 1
  };
}

function buildPixelsEntry(rawId) {
  const id = String(rawId || '').trim();
  const title = formatPixelsLabel(id);
  const tokens = id.replace(/[_-]+/g, ' ').toLowerCase();
  return {
    id: `pixels:${id}`,
    rawId: id,
    source: 'pixels',
    sourceName: CATALOG_SOURCES.pixels.name,
    repoUrl: CATALOG_SOURCES.pixels.repoUrl,
    title,
    category: 'pixel-art',
    searchText: `${title.toLowerCase()} ${tokens} pixel pixels voxel art`,
    modelFormat: 'glb',
    modelUrl: `${CATALOG_SOURCES.pixels.glbBaseUrl}/${encodeURIComponent(id)}/${encodeURIComponent(id)}.glb`,
    previewImageUrl: null,
    recommendedScale: 1
  };
}

function buildXeroEmojiEntry(rawId, rank = 9999, apiOrigin = '') {
  const file = normalizeXeroEmojiKey(rawId);
  const lookup = getXeroLookup();
  const meta = lookup.get(file) || {
    file,
    emoji: '',
    name: file,
    group: 'Emoji',
    subgroup: '',
    svgUrl: `${CATALOG_SOURCES.xeroemoji.cdnBaseUrl}/svg/${file}.svg`,
    pngUrl: `${CATALOG_SOURCES.xeroemoji.cdnBaseUrl}/png/${file}.png`
  };
  const cleanTitle = meta.name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map(toTitleCaseWord)
    .join(' ');
  const base = String(apiOrigin || '').replace(/\/$/, '');
  const modelPath = `/api/catalog/emoji/${encodeURIComponent(file)}.glb`;
  return {
    id: `xeroemoji:${file}`,
    rawId: file,
    source: 'xeroemoji',
    sourceName: CATALOG_SOURCES.xeroemoji.name,
    repoUrl: CATALOG_SOURCES.xeroemoji.repoUrl,
    title: meta.emoji ? `${meta.emoji} ${cleanTitle}` : cleanTitle,
    plainTitle: cleanTitle,
    emoji: meta.emoji || '',
    category: meta.group || 'Emoji',
    rank,
    searchText: `${meta.emoji} ${meta.name} ${meta.group} ${meta.subgroup} ${file} emoji xeroemoji`.toLowerCase(),
    modelFormat: 'glb',
    modelUrl: base ? `${base}${modelPath}` : modelPath,
    previewImageUrl: meta.svgUrl,
    pngUrl: meta.pngUrl,
    recommendedScale: 1
  };
}

async function fetchJsonOrTextWithTimeout(url, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller?.signal,
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadSimReadyEntries(fetchImpl = globalThis.fetch) {
  const slot = indexCache.simready;
  if (slot.entries && Date.now() - slot.loadedAt < CACHE_TTL_MS) return slot.entries;
  if (slot.promise) return slot.promise;

  slot.promise = (async () => {
    try {
      const txt = await fetchJsonOrTextWithTimeout(CATALOG_SOURCES.simready.indexUrl, fetchImpl);
      const ids = JSON.parse(txt);
      if (Array.isArray(ids) && ids.length > 0) {
        slot.entries = ids
          .filter((id) => typeof id === 'string' && id.trim())
          .map(buildSimReadyEntry);
        slot.loadedAt = Date.now();
        return slot.entries;
      }
    } catch {
      // Fall back to curated offline list
    }
    if (!slot.entries) {
      slot.entries = FALLBACK_SIMREADY_IDS.map(buildSimReadyEntry);
      slot.loadedAt = Date.now() - CACHE_TTL_MS + 60_000; // retry upstream in 60s
    }
    return slot.entries;
  })().finally(() => {
    slot.promise = null;
  });

  return slot.promise;
}

async function loadPixelsEntries(fetchImpl = globalThis.fetch) {
  const slot = indexCache.pixels;
  if (slot.entries && Date.now() - slot.loadedAt < CACHE_TTL_MS) return slot.entries;
  if (slot.promise) return slot.promise;

  slot.promise = (async () => {
    try {
      const txt = await fetchJsonOrTextWithTimeout(CATALOG_SOURCES.pixels.indexUrl, fetchImpl);
      const ids = JSON.parse(txt);
      if (Array.isArray(ids) && ids.length > 0) {
        slot.entries = ids
          .filter((id) => typeof id === 'string' && id.trim())
          .map(buildPixelsEntry);
        slot.loadedAt = Date.now();
        return slot.entries;
      }
    } catch {
      // Fall back to curated offline list
    }
    if (!slot.entries) {
      slot.entries = FALLBACK_PIXELS_IDS.map(buildPixelsEntry);
      slot.loadedAt = Date.now() - CACHE_TTL_MS + 60_000;
    }
    return slot.entries;
  })().finally(() => {
    slot.promise = null;
  });

  return slot.promise;
}

async function loadXeroEmojiEntries(fetchImpl = globalThis.fetch) {
  const slot = indexCache.xeroemoji;
  if (slot.entries && Date.now() - slot.loadedAt < CACHE_TTL_MS) return slot.entries;
  if (slot.promise) return slot.promise;

  slot.promise = (async () => {
    let topIds = null;
    try {
      const txt = await fetchJsonOrTextWithTimeout(CATALOG_SOURCES.xeroemoji.indexUrl, fetchImpl);
      const matches = [...txt.matchAll(/"([0-9a-f-]+)"/gi)].map((m) => m[1].toLowerCase());
      if (matches.length >= 50) {
        topIds = matches;
      }
    } catch {
      // Fall back to bundled top ids + xeroemoji package catalog
    }

    const seen = new Set();
    const ordered = [];
    const primaryIds = topIds || FALLBACK_XEROEMOJI_TOP_IDS;
    for (let i = 0; i < primaryIds.length; i += 1) {
      const k = normalizeXeroEmojiKey(primaryIds[i]);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      ordered.push(buildXeroEmojiEntry(k, i));
    }
    // Append remaining non-skin-tone Xero emojis from bundled xeroemoji library so any emoji keyword matches!
    const lookup = getXeroLookup();
    let extraRank = ordered.length;
    for (const [file, meta] of lookup.entries()) {
      if (seen.has(file)) continue;
      if (/(?:1f3fb|1f3fc|1f3fd|1f3fe|1f3ff)/.test(file)) continue; // keep base emojis concise like xeroemoji-pile
      seen.add(file);
      ordered.push(buildXeroEmojiEntry(meta.file, extraRank));
      extraRank += 1;
    }

    slot.entries = ordered;
    slot.loadedAt = topIds ? Date.now() : Date.now() - CACHE_TTL_MS + 60_000;
    return slot.entries;
  })().finally(() => {
    slot.promise = null;
  });

  return slot.promise;
}

export function resetCatalogCacheForTests() {
  for (const key of Object.keys(indexCache)) {
    indexCache[key] = { loadedAt: 0, entries: null, promise: null };
  }
}

function scoreEntry(entry, queryLower, queryTokens) {
  const titleLower = (entry.plainTitle || entry.title || '').toLowerCase();
  const rawLower = (entry.rawId || '').toLowerCase();
  const searchText = entry.searchText || '';

  // Exact emoji character match gets top priority
  if (entry.emoji && entry.emoji === queryLower.trim()) {
    return 1000;
  }

  let score = 0;
  if (titleLower === queryLower || rawLower === queryLower) {
    score += 500;
  } else if (titleLower.startsWith(queryLower) || rawLower.startsWith(queryLower)) {
    score += 320;
  } else if (titleLower.includes(queryLower)) {
    score += 220;
  } else if (searchText.includes(queryLower)) {
    score += 140;
  }

  let matchedTokens = 0;
  for (const tok of queryTokens) {
    if (!tok) continue;
    if (titleLower.includes(tok)) {
      score += 80;
      matchedTokens += 1;
    } else if (searchText.includes(tok)) {
      score += 40;
      matchedTokens += 1;
    }
  }

  if (queryTokens.length > 0 && matchedTokens < queryTokens.length) {
    return 0; // Require all search terms to match
  }

  if (score <= 0) return 0;

  // Prefer shorter, cleaner titles & higher frequency Xero emojis
  score += Math.max(0, 35 - titleLower.length * 0.6);
  if (entry.source === 'xeroemoji' && Number.isFinite(entry.rank)) {
    score += entry.rank < 500 ? Math.max(5, 45 - entry.rank * 0.08) : 0;
  }
  return score;
}

function attachApiOriginToItem(entry, apiOrigin = '') {
  const base = String(apiOrigin || '').replace(/\/$/, '');
  const modelUrl =
    entry.source === 'xeroemoji' && base && entry.modelUrl.startsWith('/')
      ? `${base}${entry.modelUrl}`
      : entry.modelUrl;
  return {
    id: entry.id,
    rawId: entry.rawId,
    source: entry.source,
    sourceName: entry.sourceName,
    repoUrl: entry.repoUrl,
    title: entry.title,
    category: entry.category,
    emoji: entry.emoji || '',
    modelFormat: entry.modelFormat,
    modelUrl,
    previewImageUrl: entry.previewImageUrl || null,
    recommendedScale: entry.recommendedScale || 1
  };
}

function createSeededRng(seedStr) {
  let h = 2166136261 >>> 0;
  const s = String(seedStr || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandomSample(list, count, rng) {
  if (!Array.isArray(list) || list.length === 0 || count <= 0) return [];
  const n = list.length;
  const take = Math.min(n, count);
  const chosenIndices = new Set();
  const out = [];
  // Fast collision-free sampling without cloning huge 6k-element arrays
  let attempts = 0;
  while (out.length < take && attempts < take * 12) {
    attempts += 1;
    const idx = Math.floor(rng() * n);
    if (!chosenIndices.has(idx)) {
      chosenIndices.add(idx);
      out.push(list[idx]);
    }
  }
  if (out.length < take) {
    for (let i = 0; i < n && out.length < take; i += 1) {
      if (!chosenIndices.has(i)) {
        chosenIndices.add(i);
        out.push(list[i]);
      }
    }
  }
  return out;
}

function shuffleArrayInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Searches across maximusmaximus/simready-pile, maximusmaximus/pixels, and
 * maximusmaximus/xeroemoji-pile, returning ranked, preview-ready 3D catalog items.
 */
export async function search3dAssetCatalog({
  query = '',
  source = 'all',
  limit = 12,
  random = false,
  seed = '',
  apiOrigin = '',
  fetchImpl = globalThis.fetch
} = {}) {
  const cleanSource = ['simready', 'pixels', 'xeroemoji'].includes(String(source || '').toLowerCase())
    ? String(source).toLowerCase()
    : 'all';
  const clampedLimit = Math.max(1, Math.min(40, Math.round(Number(limit) || 12)));
  const cleanQuery = String(query || '').trim();
  const queryLower = cleanQuery.toLowerCase();
  const queryTokens = queryLower.split(/[\s,]+/).filter(Boolean);
  const isRandomMode =
    Boolean(random) &&
    String(random).toLowerCase() !== 'false' &&
    String(random) !== '0';

  const wantedSources =
    cleanSource === 'all' ? ['simready', 'pixels', 'xeroemoji'] : [cleanSource];

  const loadedBySource = {};
  await Promise.all(
    wantedSources.map(async (src) => {
      if (src === 'simready') loadedBySource.simready = await loadSimReadyEntries(fetchImpl);
      else if (src === 'pixels') loadedBySource.pixels = await loadPixelsEntries(fetchImpl);
      else if (src === 'xeroemoji') loadedBySource.xeroemoji = await loadXeroEmojiEntries(fetchImpl);
    })
  );

  const totalCatalogCount = Object.values(loadedBySource).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0
  );

  // Empty query + random mode -> return fresh random items balanced across requested sources
  if (!cleanQuery && isRandomMode) {
    const rng = seed ? createSeededRng(String(seed)) : Math.random;
    const perSourceBase = Math.floor(clampedLimit / wantedSources.length);
    let remainder = clampedLimit - perSourceBase * wantedSources.length;
    const shuffledSources = shuffleArrayInPlace([...wantedSources], rng);
    const chosen = [];
    const chosenIds = new Set();

    for (const src of shuffledSources) {
      const want = perSourceBase + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      const sample = pickRandomSample(loadedBySource[src] || [], want, rng);
      for (const item of sample) {
        if (!chosenIds.has(item.id)) {
          chosenIds.add(item.id);
          chosen.push(item);
        }
      }
    }

    if (chosen.length < clampedLimit) {
      const pool = wantedSources
        .flatMap((src) => loadedBySource[src] || [])
        .filter((item) => !chosenIds.has(item.id));
      for (const extra of pickRandomSample(pool, clampedLimit - chosen.length, rng)) {
        chosen.push(extra);
      }
    }

    shuffleArrayInPlace(chosen, rng);

    return {
      query: '',
      source: cleanSource,
      randomized: true,
      totalMatches: totalCatalogCount,
      totalCatalogCount,
      sources: Object.values(CATALOG_SOURCES).map((s) => ({
        id: s.id,
        name: s.name,
        repo: s.repo,
        repoUrl: s.repoUrl,
        count: loadedBySource[s.id]?.length || 0
      })),
      items: chosen.slice(0, clampedLimit).map((e) => attachApiOriginToItem(e, apiOrigin))
    };
  }

  // Empty query -> return balanced featured picks across requested sources
  if (!cleanQuery) {
    const featuredSimready = [
      'food_produce_banana_m01',
      'appliance_toaster_a01',
      'chair_office_a01',
      'plant_potted_a01',
      'cone_traffic_a01',
      'barrel_steel_a01',
      'lamp_desk_a01',
      'table_coffee_a01'
    ];
    const featuredPixels = [
      'acoustic_guitar',
      'arcade_machine',
      'bonsai_tree',
      'cactus',
      'dragon_egg',
      'rocket',
      'skateboard',
      'treasure_chest'
    ];
    const featuredXero = ['1f525', '1f680', '1f451', '1f48e', '1f308', '1f355', '1f47b', '1f3a8'];

    const buckets = [];
    for (const src of wantedSources) {
      const list = loadedBySource[src] || [];
      const picks =
        src === 'simready'
          ? featuredSimready
          : src === 'pixels'
          ? featuredPixels
          : featuredXero;
      const byRaw = new Map(list.map((e) => [e.rawId, e]));
      const picked = [];
      for (const id of picks) {
        if (byRaw.has(id)) picked.push(byRaw.get(id));
      }
      if (picked.length < clampedLimit) {
        for (const item of list) {
          if (picked.length >= clampedLimit) break;
          if (!picked.includes(item)) picked.push(item);
        }
      }
      buckets.push(picked);
    }

    const merged = [];
    let cursor = 0;
    while (merged.length < clampedLimit) {
      let addedAny = false;
      for (const b of buckets) {
        if (cursor < b.length && merged.length < clampedLimit) {
          merged.push(attachApiOriginToItem(b[cursor], apiOrigin));
          addedAny = true;
        }
      }
      if (!addedAny) break;
      cursor += 1;
    }

    return {
      query: '',
      source: cleanSource,
      totalMatches: totalCatalogCount,
      totalCatalogCount,
      sources: Object.values(CATALOG_SOURCES).map((s) => ({
        id: s.id,
        name: s.name,
        repo: s.repo,
        repoUrl: s.repoUrl,
        count: loadedBySource[s.id]?.length || 0
      })),
      items: merged
    };
  }

  // Scored search across requested sources
  const scoredBySource = {};
  let totalMatches = 0;
  for (const src of wantedSources) {
    const list = loadedBySource[src] || [];
    const hits = [];
    for (const entry of list) {
      const sc = scoreEntry(entry, queryLower, queryTokens);
      if (sc > 0) hits.push({ entry, score: sc });
    }
    hits.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
    totalMatches += hits.length;
    scoredBySource[src] = hits;
  }

  // Interleave top hits from each matching source when source === 'all' so the user sees relevant
  // items across SimReady, Pixels, and XeroEmoji without one huge repo drowning out the others
  let chosen = [];
  if (cleanSource === 'all') {
    const queues = wantedSources
      .map((src) => scoredBySource[src] || [])
      .filter((q) => q.length > 0)
      .sort((a, b) => b[0].score - a[0].score);
    const taken = new Set();
    // Round-robin top 2 from each matching source first, then strictly by highest score
    for (let round = 0; round < 2 && chosen.length < clampedLimit; round += 1) {
      for (const q of queues) {
        if (round < q.length && chosen.length < clampedLimit) {
          const hit = q[round];
          if (!taken.has(hit.entry.id)) {
            taken.add(hit.entry.id);
            chosen.push(hit.entry);
          }
        }
      }
    }
    if (chosen.length < clampedLimit) {
      const rest = queues
        .flat()
        .filter((h) => !taken.has(h.entry.id))
        .sort((a, b) => b.score - a.score);
      for (const hit of rest) {
        if (chosen.length >= clampedLimit) break;
        chosen.push(hit.entry);
      }
    }
  } else {
    chosen = (scoredBySource[cleanSource] || []).slice(0, clampedLimit).map((h) => h.entry);
  }

  return {
    query: cleanQuery,
    source: cleanSource,
    totalMatches,
    totalCatalogCount,
    sources: Object.values(CATALOG_SOURCES).map((s) => ({
      id: s.id,
      name: s.name,
      repo: s.repo,
      repoUrl: s.repoUrl,
      count: loadedBySource[s.id]?.length || 0,
      matches: scoredBySource[s.id]?.length || 0
    })),
    items: chosen.map((e) => attachApiOriginToItem(e, apiOrigin))
  };
}

/**
 * Extracts a XeroEmoji ID if a URL or catalogItemId references our dynamic 3D emoji GLB route.
 */
export function extractCatalogEmojiId({ catalogItemId = '', modelUrl = '' } = {}) {
  const cid = String(catalogItemId || '').trim();
  if (/^xeroemoji:/i.test(cid)) {
    const key = normalizeXeroEmojiKey(cid.slice(10));
    if (key && /^[0-9a-f]{2,8}(?:-[0-9a-f]{2,8})*$/i.test(key)) return key;
  }
  const url = String(modelUrl || '').trim();
  const match = url.match(/\/api\/catalog\/emoji\/([0-9a-f-]+)(?:\.glb)?(?:[?#].*)?$/i);
  if (match) {
    const key = normalizeXeroEmojiKey(match[1]);
    if (key && /^[0-9a-f]{2,8}(?:-[0-9a-f]{2,8})*$/i.test(key)) return key;
  }
  return '';
}

/**
 * Resolves a `catalogItemId` (e.g., `simready:appliance_toaster_a01`, `pixels:acoustic_guitar`,
 * `xeroemoji:1f525`) into its canonical modelUrl, title, and metadata.
 */
export function resolveCatalogItemReference({ catalogItemId = '', apiOrigin = '' } = {}) {
  const raw = String(catalogItemId || '').trim();
  if (!raw || !raw.includes(':')) return null;
  const colonIdx = raw.indexOf(':');
  const source = raw.slice(0, colonIdx).toLowerCase();
  const itemId = raw.slice(colonIdx + 1).trim();
  if (!itemId) return null;

  if (source === 'simready') {
    if (!/^[a-zA-Z0-9._-]+$/.test(itemId)) return null;
    return attachApiOriginToItem(buildSimReadyEntry(itemId), apiOrigin);
  }
  if (source === 'pixels') {
    if (!/^[a-zA-Z0-9._-]+$/.test(itemId)) return null;
    return attachApiOriginToItem(buildPixelsEntry(itemId), apiOrigin);
  }
  if (source === 'xeroemoji') {
    const key = normalizeXeroEmojiKey(itemId);
    if (!key || !/^[0-9a-f]{2,8}(?:-[0-9a-f]{2,8})*$/i.test(key)) return null;
    return attachApiOriginToItem(buildXeroEmojiEntry(key, 0, apiOrigin), apiOrigin);
  }
  return null;
}

/**
 * Builds a real glTF 2.0 binary (.glb) for a XeroEmoji ID by fetching its crisp PNG
 * from jsDelivr (maximusmaximus/xeroemoji) and packaging it with buildEmojiGlbFromPngBytes.
 */
export async function buildCatalogEmojiGlb(rawEmojiId, { fetchImpl = globalThis.fetch } = {}) {
  const key = normalizeXeroEmojiKey(rawEmojiId);
  if (!key || !/^[0-9a-f]{2,8}(?:-[0-9a-f]{2,8})*$/i.test(key)) {
    throw new Error('Invalid XeroEmoji ID.');
  }
  const lookup = getXeroLookup();
  const meta = lookup.get(key);
  const file = meta?.file || key;
  const pngUrl = meta?.pngUrl || `${CATALOG_SOURCES.xeroemoji.cdnBaseUrl}/png/${file}.png`;
  const title = meta?.name
    ? meta.name
        .split(/[\s\-_]+/)
        .filter(Boolean)
        .map(toTitleCaseWord)
        .join(' ')
    : `Emoji ${file}`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  let pngBytes;
  try {
    const res = await fetchImpl(pngUrl, { redirect: 'follow', signal: controller?.signal });
    if (!res.ok) {
      throw new Error(`Could not fetch XeroEmoji artwork (${res.status}).`);
    }
    pngBytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    if (timer) clearTimeout(timer);
  }

  const glbBytes = buildEmojiGlbFromPngBytes(pngBytes, {
    emojiId: file,
    title
  });
  return {
    bytes: glbBytes,
    emojiId: file,
    title,
    emoji: meta?.emoji || '',
    pngUrl,
    svgUrl: meta?.svgUrl || `${CATALOG_SOURCES.xeroemoji.cdnBaseUrl}/svg/${file}.svg`
  };
}
