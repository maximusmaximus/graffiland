import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { CONFIG } from '../config.mjs';

function getEncryptionKey() {
  return crypto.createHash('sha256').update(CONFIG.walletEncryptionKey).digest();
}

export function createEncryptedWallet() {
  const wallet = ethers.Wallet.createRandom();
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(wallet.privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    address: wallet.address,
    encryptedWalletJson: JSON.stringify({
      v: 1,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex')
    })
  };
}

export function decryptPrivateKey(encryptedWalletJson) {
  const payload = JSON.parse(encryptedWalletJson);
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

export function resolveRecipientAddress(userRow) {
  if (userRow?.custom_payout_address && ethers.isAddress(userRow.custom_payout_address)) {
    return ethers.getAddress(userRow.custom_payout_address);
  }
  return ethers.getAddress(userRow.wallet_address);
}
