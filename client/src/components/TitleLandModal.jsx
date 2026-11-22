import React, { useEffect, useState } from 'react';
import {
  resolveLandDisplayName,
  slugifyLandTitle
} from '../../../shared/landVolume.mjs';
import { EmojiInput, EmojiTextarea } from './EmojiField.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function TitleLandModal({
  mode = 'draft', // 'draft' | 'owned'
  parcel,
  busy = false,
  onSave,
  onSaveAndMint = null,
  onClose
}) {
  const [title, setTitle] = useState(parcel?.customName || '');
  const [description, setDescription] = useState(
    parcel?.description || parcel?.curationNote || ''
  );
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    setTitle(parcel?.customName || '');
    setDescription(parcel?.description || parcel?.curationNote || '');
    setErrorMsg('');
  }, [parcel]);

  if (!parcel) return null;

  const currentLandName = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
  const previewSlug = slugifyLandTitle(title) || slugifyLandTitle(currentLandName) || 'land';

  async function handleSubmit(e, shouldMint = false) {
    e?.preventDefault?.();
    setErrorMsg('');
    const cleanTitle = title.trim().slice(0, 48);
    const cleanDesc = description.trim().slice(0, 240);
    try {
      if (shouldMint && onSaveAndMint) {
        await onSaveAndMint({ customName: cleanTitle, description: cleanDesc });
      } else {
        await onSave?.({ customName: cleanTitle, description: cleanDesc });
      }
      onClose?.();
    } catch (err) {
      setErrorMsg(err?.message || 'Could not save land title.');
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card title-land-modal-card"
        style={{ maxWidth: 480 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Title land ${currentLandName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <XeroIcon emoji="🏷️" size={20} />
            <span>{mode === 'draft' ? 'Title Your Land Plot' : `Rename "${currentLandName}"`}</span>
          </h2>
          <button
            type="button"
            className="btn"
            aria-label="Close title land popup"
            onClick={onClose}
          >
            <XeroIcon emoji="✕" size={14} />
          </button>
        </div>

        <form
          onSubmit={(e) => handleSubmit(e, false)}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <label className="land-name-field">
            <span>Land Title / Name</span>
            <EmojiInput
              type="text"
              autoFocus
              aria-label="Land Title"
              maxLength={48}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Civic Neon Plaza (type : for emojis)"
            />
          </label>

          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
            Share link slug: <span style={{ color: 'var(--accent)' }}>/{previewSlug}</span>
          </div>

          <label className="land-name-field">
            <span>Land Description (shown to visitors &amp; agents)</span>
            <EmojiTextarea
              className="textarea"
              aria-label="Land Description"
              rows={3}
              maxLength={240}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what belongs on this land (type : for emojis)..."
            />
          </label>

          {errorMsg && (
            <div className="status-banner status-banner-error" role="alert">
              {errorMsg}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn ${mode === 'owned' ? 'btn-primary' : 'btn-outline'}`}
              disabled={busy}
            >
              {busy ? 'Saving…' : mode === 'draft' ? 'Save Title' : 'Save Name & Description'}
            </button>
            {mode === 'draft' && onSaveAndMint && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || parcel.valid === false || parcel.hasOverlap}
                onClick={() => handleSubmit(null, true)}
              >
                {busy ? 'Minting…' : 'Save & Mint Land'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
