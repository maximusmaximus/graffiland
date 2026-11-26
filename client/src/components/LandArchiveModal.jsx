import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import BrandLogo from './BrandLogo.jsx';
import { GlobalNotificationBell } from './NotificationCenter.jsx';
import XeroIcon from './XeroIcon.jsx';

const REASON_FILTERS = [
  { key: 'all', label: 'All Archived' },
  { key: 'agent_72h_no_human_interaction', label: '72h Agent Reclaimed' },
  { key: 'inactivity_28d_no_human_interaction', label: '28-Day Inactivity' }
];

function formatDateTime(iso) {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function buildArchiveShareUrl(archiveId = '') {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('archive', archiveId || '1');
  return url.toString();
}

export default function LandArchiveModal({
  initialArchiveId = '',
  onJumpToLocation = null,
  onClose
}) {
  const [archives, setArchives] = useState([]);
  const [counts, setCounts] = useState({ total: 0, agent72h: 0, inactivity28d: 0 });
  const [reasonFilter, setReasonFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(initialArchiveId || '');
  const [copiedId, setCopiedId] = useState('');

  const loadArchives = useCallback(
    async (nextReason = reasonFilter, nextQuery = searchQuery) => {
      setLoading(true);
      setError('');
      try {
        const res = await api.getLandArchives({
          reason: nextReason,
          q: nextQuery,
          limit: 60
        });
        const list = Array.isArray(res?.archives) ? res.archives : [];
        setArchives(list);
        if (res?.counts) {
          setCounts({
            total: Number(res.counts.total || 0),
            agent72h: Number(res.counts.agent72h || 0),
            inactivity28d: Number(res.counts.inactivity28d || 0)
          });
        }
        if (initialArchiveId && list.some((a) => a.id === initialArchiveId)) {
          setExpandedId(initialArchiveId);
        }
      } catch (err) {
        setError(err?.message || 'Could not load Land Archive.');
      } finally {
        setLoading(false);
      }
    },
    [initialArchiveId, reasonFilter, searchQuery]
  );

  useEffect(() => {
    loadArchives(reasonFilter, searchQuery);
  }, [reasonFilter, loadArchives, searchQuery]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleCopyLink(id = '') {
    const ok = await copyToClipboard(buildArchiveShareUrl(id));
    if (ok) {
      setCopiedId(id || 'root');
      setTimeout(() => setCopiedId(''), 1800);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="land-archive-modal">
      <div
        className="modal-card"
        style={{ maxWidth: 740, width: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" style={{ gap: 10 }}>
            <BrandLogo variant="lockup" height={28} />
            <span className="badge teal">Archive</span>
          </h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <GlobalNotificationBell compact testId="archive-modal-notif-bell-btn" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => handleCopyLink('')}
              title="Copy link to Land Archive"
            >
              <XeroIcon emoji="🔗" size={13} /> {copiedId === 'root' ? 'Copied!' : 'Share Archive'}
            </button>
            <button className="btn" onClick={onClose} aria-label="Close land archive">
              <XeroIcon emoji="✕" size={16} />
            </button>
          </div>
        </div>

        <div
          className="card"
          style={{
            padding: '10px 12px',
            marginBottom: 12,
            fontSize: 12.5,
            lineHeight: 1.5,
            borderColor: 'rgba(255, 209, 102, 0.28)'
          }}
        >
          <strong>Why lands enter the Archive:</strong> Agent-created lands are archived and
          destroyed if no verified human interacts with them <strong>in person within 72 hours</strong>{' '}
          (even if the agent added 3D models). Any land without an in-person human interaction for{' '}
          <strong>28 consecutive days</strong> is also archived and destroyed so coordinates reopen
          to active builders. Consumed free mint slots without human visitors do not reopen.
        </div>

        {/* Summary pills + search */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {REASON_FILTERS.map((f) => {
              const count =
                f.key === 'all'
                  ? counts.total
                  : f.key === 'agent_72h_no_human_interaction'
                  ? counts.agent72h
                  : counts.inactivity28d;
              return (
                <button
                  key={f.key}
                  type="button"
                  className={`btn btn-sm ${reasonFilter === f.key ? 'btn-primary' : ''}`}
                  onClick={() => setReasonFilter(f.key)}
                >
                  {f.label} ({count})
                </button>
              );
            })}
          </div>
          <input
            type="search"
            className="input"
            style={{ maxWidth: 220, padding: '6px 10px', fontSize: 12.5 }}
            placeholder="Search name, GLAND-..., creator"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search archived lands"
          />
        </div>

        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
              Loading archived lands…
            </div>
          ) : error ? (
            <div className="card" style={{ color: '#ff6b8b', padding: 16 }}>
              {error}
            </div>
          ) : archives.length === 0 ? (
            <div
              className="card"
              style={{ textAlign: 'center', color: 'var(--muted)', padding: 28, lineHeight: 1.55 }}
              data-testid="land-archive-empty"
            >
              <div style={{ fontSize: 28, marginBottom: 6 }}>🗄️</div>
              <strong>No archived lands match this filter yet.</strong>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>
                Whenever an unvisited 72-hour agent land or a 28-day inactive land is reclaimed,
                its full snapshot and 3D artwork records appear permanently here.
              </div>
            </div>
          ) : (
            archives.map((item) => {
              const isExpanded = expandedId === item.id;
              const is72h = item.archiveReason === 'agent_72h_no_human_interaction';
              const vol = item.volume || {};
              const dimsText =
                Number(vol.widthMeters) > 0 && Number(vol.depthMeters) > 0
                  ? `${Math.round(vol.widthMeters)}m × ${Math.round(vol.depthMeters)}m × ${Math.round(vol.heightMeters || 18)}m`
                  : '14m × 14m × 18m';
              const sculptures = Array.isArray(item.sculpturesSnapshot)
                ? item.sculpturesSnapshot
                : [];

              return (
                <div
                  key={item.id}
                  className="card"
                  style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
                  data-testid="land-archive-item"
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 10,
                      flexWrap: 'wrap'
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <strong style={{ fontSize: 14 }}>{item.landName}</strong>
                        <span className="badge" style={{ fontSize: 11 }}>
                          {item.stewardType === 'agent' ? '🤖 AI Agent' : '👤 Human'}
                        </span>
                        <span
                          className={`badge ${is72h ? 'danger' : 'gold'}`}
                          style={{ fontSize: 11 }}
                        >
                          {is72h ? '⏳ 72h No Human Visit' : '🗓️ 28d Inactive'}
                        </span>
                        {item.freeSlotForfeited && (
                          <span className="badge" style={{ fontSize: 11, color: '#fca5a5' }}>
                            Slot not reopened
                          </span>
                        )}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}
                      >
                        {item.parcelId} · {dimsText} · {item.centerLat.toFixed(5)},{' '}
                        {item.centerLng.toFixed(5)}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {typeof onJumpToLocation === 'function' && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            onJumpToLocation(item.centerLat, item.centerLng, item.landName);
                            onClose?.();
                          }}
                          title="Fly map to these reclaimed coordinates"
                        >
                          <XeroIcon emoji="📍" size={12} /> View Spot
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleCopyLink(item.id)}
                      >
                        {copiedId === item.id ? 'Copied' : 'Link'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => setExpandedId(isExpanded ? '' : item.id)}
                      >
                        {isExpanded ? 'Hide Details' : `Details (${item.sculptureCount} art)`}
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    <strong>Creator:</strong> {item.stewardName} ·{' '}
                    <strong>Archived:</strong> {formatDateTime(item.archivedAt)} ·{' '}
                    <strong>Last Human Visit:</strong>{' '}
                    {item.lastHumanInteractionAt
                      ? formatDateTime(item.lastHumanInteractionAt)
                      : 'None (0 in-person visits)'}
                  </div>

                  {isExpanded && (
                    <div
                      style={{
                        borderTop: '1px solid var(--border)',
                        paddingTop: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        fontSize: 12.5
                      }}
                    >
                      <div>
                        <strong>Archive Reason:</strong> {item.archiveReasonLabel}
                      </div>
                      {item.description && (
                        <div style={{ color: 'var(--muted)' }}>
                          <strong>Original Note:</strong> {item.description}
                        </div>
                      )}
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        Claimed: {formatDateTime(item.claimedAt)} · Expired:{' '}
                        {formatDateTime(item.expiredAt)} · Archive ID: {item.id}
                      </div>

                      <div>
                        <strong>Archived 3D Models &amp; Sculptures ({sculptures.length}):</strong>
                        {sculptures.length === 0 ? (
                          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                            No active sculptures were placed on this land prior to archiving.
                          </div>
                        ) : (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              marginTop: 6
                            }}
                          >
                            {sculptures.map((sc) => (
                              <div
                                key={sc.id}
                                style={{
                                  padding: '7px 10px',
                                  borderRadius: 8,
                                  background: 'rgba(15, 23, 42, 0.55)',
                                  border: '1px solid rgba(148, 163, 184, 0.2)'
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    flexWrap: 'wrap'
                                  }}
                                >
                                  <strong>{sc.title}</strong>
                                  <span className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                                    {sc.modelType === 'custom-3d'
                                      ? `${String(sc.modelFormat || '3D').toUpperCase()} 3D Model`
                                      : `${sc.voxelCount || 0} voxels`}{' '}
                                    · {sc.layerRole === 'steward_stage' ? 'Agent Stage' : 'Artwork'}
                                  </span>
                                </div>
                                {sc.description && (
                                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                                    {sc.description}
                                  </div>
                                )}
                                {(sc.ipfsGatewayUrl || sc.ipfsModelCid) && (
                                  <div style={{ marginTop: 4, fontSize: 11.5 }}>
                                    {sc.ipfsGatewayUrl && (
                                      <a
                                        href={sc.ipfsGatewayUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        style={{ color: 'var(--accent)', marginRight: 10 }}
                                      >
                                        IPFS Snapshot ↗
                                      </a>
                                    )}
                                    {sc.ipfsModelCid && (
                                      <span className="mono" style={{ color: 'var(--muted)' }}>
                                        CID: {String(sc.ipfsModelCid).slice(0, 18)}…
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
