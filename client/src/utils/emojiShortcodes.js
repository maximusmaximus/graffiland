import xeroemoji from 'xeroemoji';

// Popular Slack/Discord/GitHub shortcodes prioritized before broad xeroemoji full-text search
export const COMMON_EMOJI_SHORTCODES = [
  ['fire', '🔥', 'fire'],
  ['art', '🎨', 'artist palette'],
  ['sparkles', '✨', 'sparkles'],
  ['sparkle', '✨', 'sparkles'],
  ['rocket', '🚀', 'rocket'],
  ['heart', '❤️', 'red heart'],
  ['love', '😍', 'smiling face with heart-eyes'],
  ['smile', '😄', 'grinning face with smiling eyes'],
  ['joy', '😂', 'face with tears of joy'],
  ['cool', '😎', 'smiling face with sunglasses'],
  ['thinking', '🤔', 'thinking face'],
  ['eyes', '👀', 'eyes'],
  ['wave', '👋', 'waving hand'],
  ['clap', '👏', 'clapping hands'],
  ['thumbsup', '👍', 'thumbs up'],
  ['+1', '👍', 'thumbs up'],
  ['muscle', '💪', 'flexed biceps'],
  ['tada', '🎉', 'party popper'],
  ['party', '🥳', 'partying face'],
  ['100', '💯', 'hundred points'],
  ['star', '⭐', 'star'],
  ['glow', '🌟', 'glowing star'],
  ['zap', '⚡', 'high voltage'],
  ['rainbow', '🌈', 'rainbow'],
  ['sun', '☀️', 'sun'],
  ['sunset', '🌇', 'cityscape at dusk'],
  ['moon', '🌙', 'crescent moon'],
  ['cloud', '☁️', 'cloud'],
  ['snow', '❄️', 'snowflake'],
  ['snowflake', '❄️', 'snowflake'],
  ['freeze', '❄️', 'snowflake'],
  ['crown', '👑', 'crown'],
  ['gem', '💎', 'gem stone'],
  ['trophy', '🏆', 'trophy'],
  ['medal', '🏅', 'sports medal'],
  ['cube', '🧊', 'ice cube'],
  ['brick', '🧱', 'brick'],
  ['pin', '📍', 'round pushpin'],
  ['map', '🗺️', 'world map'],
  ['compass', '🧭', 'compass'],
  ['robot', '🤖', 'robot'],
  ['bot', '🤖', 'robot'],
  ['alien', '👽', 'alien'],
  ['ghost', '👻', 'ghost'],
  ['dragon', '🐉', 'dragon'],
  ['unicorn', '🦄', 'unicorn'],
  ['phoenix', '🔥', 'fire'],
  ['cat', '🐱', 'cat face'],
  ['dog', '🐶', 'dog face'],
  ['butterfly', '🦋', 'butterfly'],
  ['tree', '🌳', 'deciduous tree'],
  ['flower', '🌸', 'cherry blossom'],
  ['rose', '🌹', 'rose'],
  ['earth', '🌍', 'globe showing Europe-Africa'],
  ['globe', '🌐', 'globe with meridians'],
  ['city', '🏙️', 'cityscape'],
  ['bridge', '🌉', 'bridge at night'],
  ['house', '🏠', 'house'],
  ['park', '🏞️', 'national park'],
  ['music', '🎵', 'musical note'],
  ['paint', '🖌️', 'paintbrush'],
  ['spray', '🎨', 'artist palette'],
  ['camera', '📷', 'camera'],
  ['phone', '📱', 'mobile phone'],
  ['lock', '🔒', 'locked'],
  ['unlock', '🔓', 'unlocked'],
  ['key', '🔑', 'key'],
  ['link', '🔗', 'link'],
  ['check', '✅', 'check mark button'],
  ['x', '❌', 'cross mark'],
  ['warning', '⚠️', 'warning'],
  ['info', 'ℹ️', 'information'],
  ['coffee', '☕', 'hot beverage'],
  ['pizza', '🍕', 'pizza'],
  ['money', '💰', 'money bag'],
  ['coin', '🪙', 'coin'],
  ['flag', '🚩', 'triangular flag'],
  ['gift', '🎁', 'wrapped gift'],
  ['bulb', '💡', 'light bulb'],
  ['magic', '🪄', 'magic wand']
];

const EXACT_ALIAS_MAP = new Map(
  COMMON_EMOJI_SHORTCODES.map(([code, emoji, name]) => [code.toLowerCase(), { shortcode: code, emoji, name }])
);

export function toEmojiShortcode(name = '') {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/**
 * Searches matching emojis for a partial `:query` shortcode using curated aliases + xeroemoji.
 */
export function searchEmojiShortcodes(rawQuery = '', limit = 8) {
  const q = String(rawQuery || '').trim().toLowerCase();
  if (!q) return [];
  const spaceQ = q.replace(/_/g, ' ');
  const results = [];
  const seenEmoji = new Set();

  const pushItem = ({ shortcode, emoji, name, svgUrl }) => {
    if (!emoji || seenEmoji.has(emoji) || results.length >= limit) return;
    seenEmoji.add(emoji);
    const meta = svgUrl ? null : xeroemoji.get(emoji);
    results.push({
      shortcode: shortcode || toEmojiShortcode(name),
      emoji,
      name: name || shortcode,
      svgUrl: svgUrl || meta?.svgUrl || ''
    });
  };

  // 1) Exact alias match first
  if (EXACT_ALIAS_MAP.has(q)) {
    pushItem(EXACT_ALIAS_MAP.get(q));
  }

  // 2) Prefix matches in common aliases
  for (const [code, emoji, name] of COMMON_EMOJI_SHORTCODES) {
    if (results.length >= limit) break;
    if (code.startsWith(q) || name.toLowerCase().startsWith(spaceQ)) {
      pushItem({ shortcode: code, emoji, name });
    }
  }

  // 3) Substring matches in common aliases
  for (const [code, emoji, name] of COMMON_EMOJI_SHORTCODES) {
    if (results.length >= limit) break;
    if (code.includes(q) || name.toLowerCase().includes(spaceQ)) {
      pushItem({ shortcode: code, emoji, name });
    }
  }

  // 4) Full Unicode search via bundled xeroemoji library (excluding skin-tone variants for cleaner variety)
  if (results.length < limit && typeof xeroemoji.search === 'function') {
    const hits = xeroemoji.search(spaceQ) || [];
    for (const hit of hits) {
      if (results.length >= limit) break;
      if (!hit?.emoji || hit.skinTone) continue;
      pushItem({
        shortcode: toEmojiShortcode(hit.name || q),
        emoji: hit.emoji,
        name: hit.name || q,
        svgUrl: hit.svgUrl || ''
      });
    }
  }

  return results;
}

/**
 * Finds an exact emoji for a completed `:shortcode:` token (e.g. `:fire:` -> `🔥`).
 */
export function resolveExactEmojiShortcode(rawCode = '') {
  const code = String(rawCode || '').trim().toLowerCase();
  if (!code || code.length < 2) return null;
  if (EXACT_ALIAS_MAP.has(code)) {
    return EXACT_ALIAS_MAP.get(code).emoji;
  }
  const spaceName = code.replace(/_/g, ' ');
  if (typeof xeroemoji.search === 'function') {
    const hits = xeroemoji.search(spaceName) || [];
    const exact = hits.find(
      (h) =>
        !h.skinTone &&
        (String(h.name || '').toLowerCase() === spaceName || toEmojiShortcode(h.name) === code)
    );
    if (exact?.emoji) return exact.emoji;
  }
  return null;
}

/**
 * Detects an active `:query` shortcode being typed immediately before caretPos.
 * Avoids matching URLs (`https://`, `ipfs://`) or timestamps (`12:30`).
 */
export function detectActiveEmojiToken(text = '', caretPos = null) {
  const str = String(text || '');
  const end = caretPos === null || caretPos === undefined ? str.length : Math.min(str.length, Math.max(0, Number(caretPos)));
  const before = str.slice(0, end);
  const match = before.match(/(?:^|[\s([{"'.,!?-]):([a-z][a-z0-9_+-]{0,27}|\+1|100)$/i);
  if (!match) return null;
  const query = match[1];
  const colonIdx = before.length - query.length - 1;
  return {
    start: colonIdx,
    end,
    query
  };
}

/**
 * Converts a completed `:shortcode:` immediately before caretPos into its Unicode emoji.
 */
export function replaceCompletedEmojiShortcodes(text = '', caretPos = null) {
  const str = String(text || '');
  const end = caretPos === null || caretPos === undefined ? str.length : Math.min(str.length, Math.max(0, Number(caretPos)));
  const before = str.slice(0, end);
  const match = before.match(/(?:^|[\s([{"'.,!?-]):([a-z][a-z0-9_+-]{1,27}|\+1|100):$/i);
  if (!match) return null;
  const code = match[1];
  const emoji = resolveExactEmojiShortcode(code);
  if (!emoji) return null;
  const colonStart = before.length - code.length - 2;
  const nextVal = `${str.slice(0, colonStart)}${emoji}${str.slice(end)}`;
  return {
    value: nextVal,
    caret: colonStart + emoji.length,
    emoji,
    shortcode: code
  };
}

/**
 * Replaces an active `:query` token with the chosen emoji while respecting optional maxLength.
 */
export function insertEmojiAtToken(text = '', token, emoji = '', maxLength = undefined) {
  if (!token || !emoji) return { value: String(text || ''), caret: String(text || '').length };
  const str = String(text || '');
  const rawNext = `${str.slice(0, token.start)}${emoji}${str.slice(token.end)}`;
  if (Number.isFinite(Number(maxLength)) && rawNext.length > Number(maxLength)) {
    const allowedPrefix = str.slice(0, token.start);
    const remaining = Math.max(0, Number(maxLength) - allowedPrefix.length - emoji.length);
    const trimmedSuffix = str.slice(token.end, token.end + remaining);
    return {
      value: `${allowedPrefix}${emoji}${trimmedSuffix}`,
      caret: allowedPrefix.length + emoji.length
    };
  }
  return {
    value: rawNext,
    caret: token.start + emoji.length
  };
}
