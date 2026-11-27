import React, { useCallback, useEffect, useState } from 'react';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { api } from '../utils/api.js';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function AdminPanel({ user, config, onModerationChange, onSelectSculpture }) {
  const [items, setItems] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reasonDrafts, setReasonDrafts] = useState({});

  const loadAll = useCallback(async () => {
    if (!user?.isAdmin) return;
    setLoading(true);
    setError('');
    try {
      const [res, metricsRes] = await Promise.all([
        api.adminListSculptures(),
        api.getAdminMetrics().catch(() => null)
      ]);
      setItems(res.sculptures || []);
      if (metricsRes) setMetrics(metricsRes);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [user?.isAdmin]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function toggleHidden(item) {
    try {
      const nextHidden = !item.hidden;
      const reason = reasonDrafts[item.id] || 'Hidden by administrator';
      await api.adminSetVisibility(item.id, nextHidden, reason);
      await loadAll();
      onModerationChange?.();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!user?.isAdmin) {
    return (
      <div className="card" style={{ maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
        <XeroIcon emoji="🛡️" size={34} />
        <h3>Administrator Access Required</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          Sign in with an authorized Google Admin email (configured in{' '}
          <span className="mono">ADMIN_EMAILS</span>) to hide/unhide sculptures and audit Proof of Location.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <XeroIcon emoji="🛡️" size={22} />
          <strong>Moderation &amp; Chain Operations</strong>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge teal">
            Chain: {config?.chain?.network?.name} ({config?.chain?.network?.chainId})
          </span>
          <span className="badge pink">
            Resale Royalty: {config?.chain?.resaleFeePercent || 5}% ({config?.chain?.resaleFeeBps || 500} bps)
          </span>
          <span className="badge">IPFS: {config?.ipfsProvider}</span>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'rgba(255,77,109,0.5)', color: '#ffb3c1' }}>
          <XeroIcon emoji="⚠️" size={15} /> {error}
        </div>
      )}

      {metrics && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>
              <XeroIcon emoji="📡" size={14} /> Operational Telemetry &amp; Quota Health
            </strong>
            <span className={`badge ${metrics.status === 'degraded' || metrics.recentAlerts?.length ? 'gold' : 'teal'}`}>
              {metrics.status === 'degraded'
                ? 'Degraded'
                : metrics.recentAlerts?.length
                ? `${metrics.recentAlerts.length} Alert(s)`
                : 'Healthy'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8, fontSize: 12 }}>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>Relayer Ops Today</div>
              <div className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                {metrics.relayerTodayOps || 0}
              </div>
            </div>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>Pinata Errors (24h)</div>
              <div
                className="mono"
                style={{
                  fontWeight: 700,
                  color: (metrics.counts?.pinFailures24h || 0) > 0 ? '#ffb3c1' : 'var(--accent)'
                }}
              >
                {metrics.counts?.pinFailures24h || 0}
              </div>
            </div>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>Rate Limit Trips (24h)</div>
              <div className="mono" style={{ fontWeight: 700 }}>
                {metrics.counts?.rateLimitTrips24h || 0}
              </div>
            </div>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>Sculptures / Revs / ORB</div>
              <div className="mono" style={{ fontWeight: 700 }}>
                {metrics.counts?.sculptures || 0} / {metrics.counts?.revisions || 0} / {metrics.counts?.landmarks || 0}
              </div>
            </div>
          </div>
          {metrics.recentAlerts?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--accent-gold)' }}>
              {metrics.recentAlerts.slice(0, 5).map((a) => (
                <div key={a.id}>
                  <XeroIcon emoji="⚠️" size={12} /> [{a.category}] {a.detail || a.status}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ fontSize: 12, color: 'var(--muted)' }}>
        <strong style={{ color: 'var(--text)' }}>
          <XeroIcon emoji="📜" size={13} /> Takedown &amp; Virtual Land Dispute Policy:
        </strong>{' '}
        Physical-property safety complaints, DMCA/IP takedown notices, or severe policy violations can be hidden immediately with an explicit audit reason below. All on-chain ERC-721 provenance and IPFS revisions remain transparent while public map/AR feeds suppress hidden items.
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20, color: 'var(--muted)' }}>Loading moderation queue...</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--muted)' }}>No sculptures submitted yet.</div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Title &amp; Parcel</th>
                <th>Creator</th>
                <th>PoL Score</th>
                <th>Token / IPFS</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      onClick={() => onSelectSculpture(item)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: 'var(--accent)',
                        fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      {item.title}
                    </button>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {resolveLandDisplayName(
                        {
                          customName: item.parcelName || item.landDisplayName || '',
                          firstSculptureTitle: item.title || '',
                          placeName: item.placeName || ''
                        },
                        { defaultName: 'Virtual Land' }
                      )}{' '}
                      · {item.lat}, {item.lng}
                    </div>
                  </td>
                  <td>
                    <div>
                      <UserHandleBadge
                        user={{
                          id: item.creatorSub,
                          username: item.creatorUsername,
                          creatorName: item.creatorName,
                          avatarImage: item.creatorAvatar
                        }}
                        fallback="Creator"
                        size="xs"
                      />
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {item.creatorEmail}
                    </div>
                  </td>
                  <td className="mono">{item.polScore}/100</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    #{item.chain?.tokenId} · {item.ipfs?.metadataCid?.slice(0, 14)}...
                  </td>
                  <td>
                    {item.hidden ? (
                      <span className="badge pink">
                        <XeroIcon emoji="🔒" size={12} /> Hidden
                      </span>
                    ) : (
                      <span className="badge teal">
                        <XeroIcon emoji="🔓" size={12} /> Public
                      </span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {!item.hidden && (
                        <input
                          className="input"
                          style={{ width: 140, padding: '6px 8px', fontSize: 11 }}
                          placeholder="Hide reason..."
                          value={reasonDrafts[item.id] || ''}
                          onChange={(e) =>
                            setReasonDrafts((p) => ({ ...p, [item.id]: e.target.value }))
                          }
                        />
                      )}
                      <button
                        className={`btn ${item.hidden ? 'btn-primary' : 'btn-danger'}`}
                        onClick={() => toggleHidden(item)}
                      >
                        <XeroIcon emoji={item.hidden ? '👁️' : '❌'} size={14} />
                        {item.hidden ? 'Unhide' : 'Hide'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
