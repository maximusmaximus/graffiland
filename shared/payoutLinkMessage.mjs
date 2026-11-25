import { ethers } from 'ethers';

export const PAYOUT_LINK_MAX_AGE_MS = 10 * 60 * 1000;
const PAYOUT_LINK_MAX_SKEW_MS = 2 * 60 * 1000;

export class PayoutLinkError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Canonical EIP-191 message a user signs with an external wallet to prove they control the
 * address they want to use as their mint recipient. Binding the SPRAY.LAND user id stops one
 * account from replaying another account's signature.
 */
export function buildPayoutLinkMessage({ userId, address, issuedAt }) {
  return [
    'GRAFFILAND Payout Address Verification',
    'Sign to prove you control this wallet and use it as your mint recipient.',
    `Account: ${userId}`,
    `Address: ${ethers.getAddress(address)}`,
    `Issued At: ${issuedAt}`
  ].join('\n');
}

/**
 * Verifies that `signature` over the canonical message was produced by `address` recently.
 * Throws PayoutLinkError on any failure.
 */
export function verifyPayoutLinkSignature({
  userId,
  address,
  issuedAt,
  signature,
  now = Date.now()
}) {
  if (!userId) throw new PayoutLinkError('Authenticated account required.', 401);
  if (!address || !ethers.isAddress(address)) {
    throw new PayoutLinkError('Invalid EVM wallet address.');
  }
  const issuedMs = Date.parse(String(issuedAt || ''));
  if (!Number.isFinite(issuedMs)) {
    throw new PayoutLinkError('issuedAt (ISO timestamp) is required to verify a payout address.');
  }
  if (issuedMs > now + PAYOUT_LINK_MAX_SKEW_MS || now - issuedMs > PAYOUT_LINK_MAX_AGE_MS) {
    throw new PayoutLinkError('Payout address signature expired. Sign again to continue.');
  }
  const sig = String(signature || '').trim();
  if (!sig) {
    throw new PayoutLinkError(
      'A wallet signature is required to prove you control this payout address.',
      401
    );
  }
  const message = buildPayoutLinkMessage({ userId, address, issuedAt });
  let recovered = '';
  try {
    recovered = ethers.verifyMessage(message, sig);
  } catch {
    throw new PayoutLinkError('Invalid wallet signature format.', 401);
  }
  if (recovered.toLowerCase() !== ethers.getAddress(address).toLowerCase()) {
    throw new PayoutLinkError('Signature was not produced by the payout address.', 401);
  }
  return { address: ethers.getAddress(address), message };
}
