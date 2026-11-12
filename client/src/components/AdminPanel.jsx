import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import XeroIcon from './XeroIcon.jsx';

export default function AdminPanel({ user, config, onModerationChange, onSelectSculpture }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reasonDrafts, setReasonDrafts] = useState({});

  const loadAll = useCallback(async () => {
    if (!user?.isAdmin) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.adminListSculptures();
      setItems(res.sculptures || []);
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
          <button className="btn" onClick={loadAll}>
            <XeroIcon emoji="🔄" size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'rgba(255,77,109,0.5)', color: '#ffb3c1' }}>
          <XeroIcon emoji="⚠️" size={15} /> {error}
        </div>
      )}

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
                      {item.parcelId} · {item.lat}, {item.lng}
                    </div>
                  </td>
                  <td>
                    <div>{item.creatorName}</div>
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
