// @ts-check
/**
 * Shared D1/SQLite API rate limiting, structured telemetry, and operational health checks.
 * Zero Node-only built-ins so both Node Express and Cloudflare Workers run identically.
 */

/** @typedef {import('./types.d.ts').DbAdapter} DbAdapter */
/** @typedef {import('./types.d.ts').RateLimitResult} RateLimitResult */
/** @typedef {import('./types.d.ts').OperationalHealthReport} OperationalHealthReport */

/**
 * Emits single-line structured JSON logs cleanly.
 * @param {'info'|'warn'|'error'} level
 * @param {string} event
 * @param {Record<string, any>} [meta]
 */
export function logStructured(level, event, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta
  };
  if (level === 'error') {
    console.error(JSON.stringify(payload));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
}

export class RateLimitError extends Error {
  /**
   * @param {string} message
   * @param {number} [retryAfterSec]
   */
  constructor(message, retryAfterSec = 60) {
    super(message);
    this.statusCode = 429;
    this.retryAfterSec = retryAfterSec;
    this.extra = { retryAfterSec };
  }
}

/**
 * Fixed-window sliding-bucket rate limiter backed by SQLite / Cloudflare D1 (`api_rate_limits`).
 * @param {DbAdapter} db
 * @param {{ scope: string, key: string, windowSec?: number, maxRequests?: number }} opts
 * @returns {Promise<RateLimitResult>}
 */
export async function checkRateLimit(
  db,
  { scope, key, windowSec = 60, maxRequests = 60 }
) {
  if (!db || !Number.isFinite(maxRequests) || maxRequests <= 0) {
    return { allowed: true, remaining: maxRequests, limit: maxRequests, resetAfterSec: 0 };
  }
  const cleanKey = `${String(scope || 'api')}:${String(key || 'anon').slice(0, 96)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const bucketStart = nowSec - (nowSec % Math.max(5, windowSec));
  const resetAfterSec = bucketStart + windowSec - nowSec;
  const nowIso = new Date().toISOString();

  await db.run(
    `INSERT INTO api_rate_limits (bucket_key, window_start, req_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(bucket_key, window_start) DO UPDATE SET
       req_count = api_rate_limits.req_count + 1,
       updated_at = excluded.updated_at`,
    [cleanKey, bucketStart, nowIso]
  );

  const row = await db.get(
    'SELECT req_count FROM api_rate_limits WHERE bucket_key = ? AND window_start = ?',
    [cleanKey, bucketStart]
  );
  const count = Number(row?.req_count || 1);

  if (count > maxRequests) {
    await recordOpsEvent(db, {
      category: 'rate_limit',
      status: 'warn',
      actorId: String(key || 'anon'),
      detail: `Rate limit hit on ${scope} (${count}/${maxRequests} in ${windowSec}s)`,
      metricValue: count
    }).catch(() => {});
    throw new RateLimitError(
      `Too many requests on ${scope}. Please retry in ${Math.max(1, resetAfterSec)}s.`,
      Math.max(1, resetAfterSec)
    );
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - count),
    limit: maxRequests,
    resetAfterSec
  };
}

/**
 * Records structured operational events (relayer spend, Pinata failures, rate limit alerts).
 * @param {DbAdapter} db
 * @param {{ category: string, status?: 'ok'|'warn'|'error', actorId?: string, parcelId?: string, detail?: string, metricValue?: number }} opts
 */
export async function recordOpsEvent(
  db,
  { category, status = 'ok', actorId = '', parcelId = '', detail = '', metricValue = 0 }
) {
  if (!db) return;
  const id = `evt_${globalThis.crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO ops_events (id, category, status, actor_id, parcel_id, detail, metric_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(category || 'system').slice(0, 40),
      String(status || 'ok').slice(0, 16),
      String(actorId || '').slice(0, 96),
      String(parcelId || '').slice(0, 48),
      String(detail || '').slice(0, 320),
      Number(metricValue || 0),
      now
    ]
  );
}

/**
 * Computes operational metrics snapshot for admin monitoring and alerts.
 * @param {DbAdapter} db
 * @param {{ chain?: Record<string, any>, ipfsProvider?: string }} [ctx]
 * @returns {Promise<OperationalHealthReport>}
 */
export async function getOperationalHealthReport(db, { chain = {}, ipfsProvider = 'local-cid' } = {}) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [scCount, revCount, lmCount, pkCount, relayerToday, rlTrips, pinFails, alerts] =
    await Promise.all([
      db.get('SELECT COUNT(*) AS c FROM sculptures WHERE hidden = 0'),
      db.get('SELECT COUNT(*) AS c FROM sculpture_revisions'),
      db.get('SELECT COUNT(*) AS c FROM parcel_landmark_anchors'),
      db.get('SELECT COUNT(*) AS c FROM user_passkeys'),
      db.get('SELECT COALESCE(SUM(op_count), 0) AS total FROM relayer_usage WHERE day_key = ?', [
        dayKey
      ]),
      db.get(
        "SELECT COUNT(*) AS c FROM ops_events WHERE category = 'rate_limit' AND created_at >= ?",
        [since24h]
      ),
      db.get(
        "SELECT COUNT(*) AS c FROM ops_events WHERE category = 'pinata' AND status = 'error' AND created_at >= ?",
        [since24h]
      ),
      db.all(
        "SELECT id, category, status, detail, created_at FROM ops_events WHERE status IN ('warn', 'error') ORDER BY created_at DESC LIMIT 15"
      )
    ]);

  return {
    status: Number(pinFails?.c || 0) > 5 ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    chain,
    ipfsProvider,
    relayerTodayOps: Number(relayerToday?.total || 0),
    counts: {
      sculptures: Number(scCount?.c || 0),
      revisions: Number(revCount?.c || 0),
      landmarks: Number(lmCount?.c || 0),
      passkeys: Number(pkCount?.c || 0),
      rateLimitTrips24h: Number(rlTrips?.c || 0),
      pinFailures24h: Number(pinFails?.c || 0)
    },
    recentAlerts: (alerts || []).map((a) => ({
      id: a.id,
      category: a.category,
      status: a.status,
      detail: a.detail,
      createdAt: a.created_at
    }))
  };
}
