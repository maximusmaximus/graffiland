import { api } from './api.js';

function b64UrlToUint8(b64url) {
  let b64 = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bufferToB64Url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isWebAuthnSupported() {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.PublicKeyCredential) &&
    Boolean(navigator.credentials?.create) &&
    Boolean(navigator.credentials?.get)
  );
}

export async function registerHardwarePasskey(deviceLabel = 'Mobile Device Passkey') {
  if (!isWebAuthnSupported()) {
    throw new Error('Hardware Passkeys (WebAuthn) are not supported on this browser.');
  }
  const options = await api.getPasskeyRegistrationOptions();
  const publicKey = {
    ...options,
    challenge: b64UrlToUint8(options.challenge),
    user: {
      ...options.user,
      id: b64UrlToUint8(options.user.id)
    }
  };
  const cred = /** @type {PublicKeyCredential | null} */ (
    await navigator.credentials.create({ publicKey })
  );
  if (!cred || !cred.response) {
    throw new Error('Passkey registration was cancelled.');
  }
  const attResp = /** @type {AuthenticatorAttestationResponse & { getPublicKey?: () => ArrayBuffer | null }} */ (
    cred.response
  );
  const spkiBuf =
    typeof attResp.getPublicKey === 'function' ? attResp.getPublicKey() : null;
  if (!spkiBuf) {
    throw new Error(
      'Browser did not expose SPKI ECDSA P-256 public key (update iOS/Android/Chrome).'
    );
  }
  return api.verifyPasskeyRegistration({
    credentialId: cred.id || bufferToB64Url(cred.rawId),
    publicKeySpkiB64: bufferToB64Url(spkiBuf),
    clientDataJSON: bufferToB64Url(attResp.clientDataJSON),
    deviceLabel
  });
}

export async function requestPasskeyAssertion(challengeB64Url, allowedCredentialIds = []) {
  if (!isWebAuthnSupported()) {
    throw new Error('Hardware Passkeys (WebAuthn) are required on this parcel.');
  }
  /** @type {PublicKeyCredentialDescriptor[]} */
  const allowCredentials = Array.isArray(allowedCredentialIds)
    ? allowedCredentialIds
        .filter(Boolean)
        .map((id) => ({ type: /** @type {const} */ ('public-key'), id: b64UrlToUint8(id) }))
    : [];
  const assertion = /** @type {PublicKeyCredential | null} */ (
    await navigator.credentials.get({
      publicKey: {
        challenge: b64UrlToUint8(challengeB64Url),
        ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
        userVerification: 'preferred',
        timeout: 45000
      }
    })
  );
  if (!assertion || !assertion.response) {
    throw new Error('Passkey biometric verification was cancelled.');
  }
  const assertResp = /** @type {AuthenticatorAssertionResponse} */ (assertion.response);
  return {
    credentialId: assertion.id || bufferToB64Url(assertion.rawId),
    clientDataJSON: bufferToB64Url(assertResp.clientDataJSON),
    authenticatorData: bufferToB64Url(assertResp.authenticatorData),
    signature: bufferToB64Url(assertResp.signature)
  };
}
