import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function SculptureRevisionsPanel({
  sculptureId,
  currentRev = 1,
  lastErc4906TxHash = '',
  explorerUrl = '',
  canRollback = false,
  onRolledBack
}) {
  const [revisions, setRevisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rollingRev, setRollingRev] = useState(null);
  const [errMsg, setErrMsg] = useState('');

  const loadRevisions = useCallback(async () => {
    if (!sculptureId) return;
    setLoading(true);
    setErrMsg('');
    try {
      const res = await api.getSculptureRevisions(sculptureId);
      setRevisions(res?.revisions || []);
    } catch (err) {
      setErrMsg(err.message || 'Could not load revision history');
    } finally {
      setLoading(false);
    }
  }, [sculptureId]);

  useEffect(() => {
    loadRevisions();
  }, [loadRevisions, currentRev]);

  async function handleRollback(revNum) {
    setRollingRev(revNum);
    setErrMsg('');
    try {
      const res = await api.rollbackSculptureRevision(sculptureId, revNum);
      await loadRevisions();
      onRolledBack?.(res);
    } catch (err) {
      setErrMsg(err.message || `Rollback to v${revNum} failed`);
    } finally {
      setRollingRev(null);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 6,
        padding: '8px 10px',
        borderRadius: 10,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.09)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent)' }}>
          <XeroIcon emoji="📜" size={12} /> Immutable IPFS Revisions (Current: v{currentRev || 1})
        </span>
        {lastErc4906TxHash && (
          <span className="badge teal" style={{ fontSize: 10 }}>
            ERC-4906{' '}
            {explorerUrl ? (
              <a
                href={`${explorerUrl.replace(/\/$/, '')}/tx/${lastErc4906TxHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'inherit', textDecoration: 'underline', marginLeft: 4 }}
              >
                {lastErc4906TxHash.slice(0, 10)}...
              </a>
            ) : (
              lastErc4906TxHash.slice(0, 10)
            )}
          </span>
        )}
      </div>

      {loading ? (
        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
          Loading immutable revisions...
        </div>
      ) : errMsg ? (
        <div className="mono" style={{ fontSize: 11, color: 'var(--danger, #ff5e7e)' }}>
          {errMsg}
        </div>
      ) : revisions.length === 0 ? (
        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
          Initial v{currentRev || 1} anchored on IPFS &amp; Robinhood Chain.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {revisions.slice(0, 8).map((rev) => {
            const isCurrent = Number(rev.revNum) === Number(currentRev || 1);
            return (
              <div
                key={rev.revNum}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  borderRadius: 7,
                  background: isCurrent ? 'rgba(0, 245, 212, 0.08)' : 'rgba(255,255,255,0.02)',
                  border: isCurrent ? '1px solid rgba(0, 245, 212, 0.3)' : '1px solid transparent'
                }}
              >
                <div style={{ minWidth: 0, fontSize: 11 }}>
                  <div>
                    <strong className="mono">v{rev.revNum}</strong>{' '}
                    <span style={{ color: 'var(--text)' }}>{rev.changeSummary || rev.title}</span>{' '}
                    {isCurrent && <span className="badge teal" style={{ fontSize: 9.5 }}>LIVE</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <UserHandleBadge
                      user={{
                        id: rev.editorSub,
                        username: rev.editorUsername,
                        editorName: rev.editorName,
                        editorRole: rev.editorRole,
                        avatarImage: rev.editorAvatar
                      }}
                      fallback="Creator"
                      size="xs"
                    />
                    <span>
                      ({rev.editorRole}) ·{' '}
                      {rev.ipfsMetadataCid ? `${rev.ipfsMetadataCid.slice(0, 12)}...` : 'local'} ·{' '}
                      {rev.modelType === 'custom-3d' ? '3D asset' : `${rev.voxelCount} voxels`}
                    </span>
                  </div>
                </div>
                {canRollback && !isCurrent && (
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 10.5, padding: '3px 8px', flexShrink: 0 }}
                    disabled={rollingRev !== null}
                    onClick={() => handleRollback(rev.revNum)}
                  >
                    {rollingRev === rev.revNum ? 'Rolling back...' : `Rollback v${rev.revNum}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
