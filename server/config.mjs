import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY, ROBINHOOD_NETWORKS as BASE_NETWORKS } from '../shared/constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

export const ROBINHOOD_NETWORKS = {
  testnet: {
    ...BASE_NETWORKS.testnet,
    rpcUrl: process.env.ROBINHOOD_TESTNET_RPC || BASE_NETWORKS.testnet.rpcUrl
  },
  mainnet: {
    ...BASE_NETWORKS.mainnet,
    rpcUrl: process.env.ROBINHOOD_MAINNET_RPC || BASE_NETWORKS.mainnet.rpcUrl
  }
};

export { POLICY };

const activeNetKey = (process.env.ROBINHOOD_NETWORK || 'testnet').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';

export const CONFIG = {
  port: Number(process.env.PORT || 3001),
  publicUrl: process.env.PUBLIC_URL || 'https://localhost:5173',
  sessionSecret: process.env.SESSION_SECRET || 'graffiland-dev-session-secret-change-me',
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || 'graffiland-dev-wallet-key-change-me',
  googleClientId: process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '',
  allowDevGoogleAuth: process.env.ALLOW_DEV_GOOGLE_AUTH !== 'false',
  adminEmails: (process.env.ADMIN_EMAILS || 'admin@graffiland.local')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  pinataJwt: process.env.PINATA_JWT || '',
  ipfsApiUrl: process.env.IPFS_API_URL || '',
  ipfsGateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs',
  robinhoodNetwork: ROBINHOOD_NETWORKS[activeNetKey],
  robinhoodContractAddress: process.env.ROBINHOOD_CONTRACT_ADDRESS || '',
  robinhoodRelayerPrivateKey: process.env.ROBINHOOD_RELAYER_PRIVATE_KEY || '',
  robinhoodRoyaltyReceiver: process.env.ROBINHOOD_ROYALTY_RECEIVER || '',
  resaleFeeBps: Number(process.env.ROBINHOOD_RESALE_FEE_BPS || 500),
  dbPath: process.env.GRAFFILAND_DB_PATH || path.join(__dirname, 'data', 'graffiland.sqlite'),
  ipfsStorageDir: process.env.GRAFFILAND_IPFS_DIR || path.join(__dirname, 'storage', 'ipfs')
};
