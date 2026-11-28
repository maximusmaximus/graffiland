/**
 * Formats an Ethereum (`0x...`) address or transaction hash into a compact
 * abbreviated representation (e.g. `0x66E6…0Fe5`) so long hex strings never
 * clutter or wrap awkwardly in mobile and desktop views.
 *
 * @param {string | null | undefined} address
 * @param {{ prefixChars?: number, suffixChars?: number }} [options]
 * @returns {string}
 */
export function abbreviateEthAddress(
  address,
  { prefixChars = 6, suffixChars = 4 } = {}
) {
  const clean = String(address || '').trim();
  if (!clean) return '';
  if (clean.length <= prefixChars + suffixChars + 2) {
    return clean;
  }
  return `${clean.slice(0, prefixChars)}…${clean.slice(-suffixChars)}`;
}
