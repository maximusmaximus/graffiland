export interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly BASE_URL: string;
}

export interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export interface DbAdapter {
  get<T = Record<string, any>>(sql: string, params?: any[]): Promise<T | null | undefined>;
  all<T = Record<string, any>>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<{ changes?: number; meta?: { changes?: number } } | any>;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
  wallet_address: string;
  custom_payout_address?: string;
  is_admin?: number | boolean;
  encrypted_wallet_json?: string;
  created_at?: string;
}

export interface AnchorOffset {
  dx: number;
  dy: number;
  dz: number;
  yaw: number;
}

export interface OrbKeyframeFeature {
  u: number;
  v: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  response: number;
  descB64: string;
}

export interface OrbProof {
  descriptorDigest: string;
  inlierCount: number;
  reprojectionErrorPx: number;
  matchedDescriptors?: Array<{
    keyframeIndex?: number;
    featureIndex?: number;
    liveDescB64: string;
    u: number;
    v: number;
  }>;
}

export interface PasskeyAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAfterSec: number;
}

export interface OperationalHealthReport {
  status: string;
  timestamp: string;
  chain: Record<string, any>;
  ipfsProvider: string;
  relayerTodayOps: number;
  counts: {
    sculptures: number;
    revisions: number;
    landmarks: number;
    passkeys: number;
    rateLimitTrips24h: number;
    pinFailures24h: number;
  };
  recentAlerts: Array<{
    id: string;
    category: string;
    status: string;
    detail: string;
    createdAt: string;
  }>;
}
