import React, { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../utils/clipboard.js';
import { abbreviateEthAddress } from '../utils/ethAddress.js';
import XeroIcon from './XeroIcon.jsx';

/**
 * Always renders an Ethereum (`0x...`) address or hash in abbreviated form
 * (`0x66E6…0Fe5`) with a crisp one-tap copy icon right beside it.
 */
export default function EthAddressBadge({
  address,
  href = '',
  className = '',
  style = undefined,
  prefixChars = 6,
  suffixChars = 4,
  testId = 'eth-address-badge',
  copyTestId = 'eth-address-copy-btn',
  onCopied = null
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const full = String(address || '').trim();
  if (!full) return null;
  const short = abbreviateEthAddress(full, { prefixChars, suffixChars });

  const handleCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(full);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    }
    onCopied?.(ok, full);
  };

  return (
    <span
      className={`eth-address-badge mono ${className}`.trim()}
      style={style}
      data-testid={testId}
      data-full-address={full}
      title={full}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="eth-address-link"
          onClick={(e) => e.stopPropagation()}
        >
          {short}
        </a>
      ) : (
        <span className="eth-address-text">{short}</span>
      )}
      <button
        type="button"
        className={`eth-address-copy-btn${copied ? ' is-copied' : ''}`}
        data-testid={copyTestId}
        aria-label={copied ? 'Address copied' : `Copy ${short}`}
        title={copied ? 'Copied!' : `Copy full address (${full})`}
        onClick={handleCopy}
      >
        {copied ? '✓' : <XeroIcon emoji="📋" size={12} />}
      </button>
    </span>
  );
}
