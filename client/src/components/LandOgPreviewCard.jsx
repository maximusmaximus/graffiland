import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  computeLandOgContentSig,
  normalizeLandOgImageMode
} from '../../../shared/landOgImage.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { api } from '../utils/api.js';
import {
  buildLandOgShareUrl,
  buildLandShareToXUrl,
  copyToClipboard
} from '../utils/clipboard.js';
import {
  buildLandLowAngleSvgDataUrl,
  renderLandIsometricPreview
} from '../utils/landPreviewRenderer.js';
import {
  buildLandOgImageUrl,
  composeCenteredLogoOgPng,
  readImageFileAsDataUrl,
  RECOMMENDED_OG_DIMENSIONS
} from '../utils/ogShareComposer.js';
import BrandLogo from './BrandLogo.jsx';
import XeroIcon from './XeroIcon.jsx';

/**
 * Renders the ACTUAL Open Graph / Social Share Preview card (1200×630, 1.91:1) for a Virtual Land
 * with the SPRAY.LAND logotype centered in the middle.
 * - For all viewers: shows exactly what X.com, Facebook, Discord & iMessage render when shared.
 * - For the Land Holder: automatically refreshes stale 3D low-angle snapshots, lets them upload
 *   their own custom image (with suggested 1200×630 px dimensions), or toggle the preview OFF
 *   so shares fall back cleanly to the SPRAY.LAND logo.
 */
export default function LandOgPreviewCard({
  parcel,
  sculptures = [],
  isLandOwner = false,
  compact = false,
  onOgSettingsUpdated = null,
  onStatusMessage = null
}) {
  const parcelId = parcel?.parcelId || '';
  const visibleSculptures = useMemo(
    () => (Array.isArray(sculptures) ? sculptures.filter((s) => s && !s.hidden) : []),
    [sculptures]
  );

  const serverMode = normalizeLandOgImageMode(
    parcel?.ogImageMode ?? parcel?.settings?.ogImageMode ?? 'auto'
  );
  const serverCustomUrl = String(
    parcel?.ogCustomImageUrl ?? parcel?.settings?.ogCustomImageUrl ?? ''
  ).trim();
  const serverAutoUrl = String(
    parcel?.ogPreviewImageUrl ?? parcel?.settings?.ogPreviewImageUrl ?? ''
  ).trim();
  const serverAutoSig = String(
    parcel?.ogPreviewSig ?? parcel?.settings?.ogPreviewSig ?? ''
  ).trim();

  const [ogMode, setOgMode] = useState(serverMode);
  const [customUrl, setCustomUrl] = useState(serverCustomUrl);
  const [autoSnapshotUrl, setAutoSnapshotUrl] = useState(serverAutoUrl);
  const [autoSnapshotSig, setAutoSnapshotSig] = useState(serverAutoSig);
  const [localComposedUrl, setLocalComposedUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef(null);
  const autoSyncedKeyRef = useRef('');

  useEffect(() => {
    setOgMode(serverMode);
    setCustomUrl(serverCustomUrl);
    setAutoSnapshotUrl(serverAutoUrl);
    setAutoSnapshotSig(serverAutoSig);
  }, [parcelId, serverMode, serverCustomUrl, serverAutoUrl, serverAutoSig]);

  const effectiveParcel = useMemo(
    () => ({
      ...parcel,
      ogImageMode: ogMode,
      ogCustomImageUrl: customUrl,
      ogPreviewImageUrl: autoSnapshotUrl,
      ogPreviewSig: autoSnapshotSig
    }),
    [parcel, ogMode, customUrl, autoSnapshotUrl, autoSnapshotSig]
  );

  const landDisplayName = useMemo(
    () => resolveLandDisplayName(effectiveParcel || {}, { defaultName: 'Virtual Land' }),
    [effectiveParcel]
  );

  const liveContentSig = useMemo(
    () => computeLandOgContentSig({ parcel: effectiveParcel, sculptures: visibleSculptures }),
    [effectiveParcel, visibleSculptures]
  );

  const serverOgImageUrl = useMemo(
    () => buildLandOgImageUrl(effectiveParcel, visibleSculptures),
    [effectiveParcel, visibleSculptures]
  );

  const fallbackSvg = useMemo(
    () => (ogMode === 'auto' ? buildLandLowAngleSvgDataUrl(effectiveParcel, visibleSculptures) : ''),
    [effectiveParcel, visibleSculptures, ogMode]
  );

  const isAutoFresh = Boolean(autoSnapshotUrl && autoSnapshotSig && autoSnapshotSig === liveContentSig);

  // Render live 1200x630 centered-logo preview locally & auto-sync fresh 3D snapshot for Land Holder
  useEffect(() => {
    if (!parcelId) return undefined;
    let cancelled = false;

    async function syncPreview() {
      if (ogMode === 'logo') {
        const composed = await composeCenteredLogoOgPng({ mode: 'logo' });
        if (!cancelled) setLocalComposedUrl(composed || '');
        return;
      }

      if (ogMode === 'custom') {
        setLocalComposedUrl('');
        return;
      }

      // ogMode === 'auto': use stored fresh snapshot if already matching liveContentSig
      if (isAutoFresh) {
        setLocalComposedUrl('');
        return;
      }

      const rawLowAngle = await renderLandIsometricPreview(effectiveParcel, visibleSculptures, {
        width: RECOMMENDED_OG_DIMENSIONS.width,
        height: RECOMMENDED_OG_DIMENSIONS.height
      });
      if (cancelled) return;

      const composed = await composeCenteredLogoOgPng({
        backgroundDataUrl: rawLowAngle,
        mode: 'auto',
        width: RECOMMENDED_OG_DIMENSIONS.width,
        height: RECOMMENDED_OG_DIMENSIONS.height
      });
      if (cancelled) return;
      if (composed) setLocalComposedUrl(composed);

      // Automatically persist fresh snapshot when Land Holder opens Land Details so X/Facebook stay up-to-date
      const syncKey = `${parcelId}:${liveContentSig}`;
      if (isLandOwner && composed && autoSyncedKeyRef.current !== syncKey) {
        autoSyncedKeyRef.current = syncKey;
        try {
          const res = await api.updateLandOgSettings(parcelId, {
            autoPreviewDataUrl: composed,
            contentSig: liveContentSig
          });
          if (!cancelled && res?.settings) {
            setAutoSnapshotUrl(res.settings.ogPreviewImageUrl || composed);
            setAutoSnapshotSig(res.settings.ogPreviewSig || liveContentSig);
            onOgSettingsUpdated?.(res.settings);
          }
        } catch {
          // Non-fatal: server dynamically renders fresh low-angle PNG as fallback
        }
      }
    }

    syncPreview();
    return () => {
      cancelled = true;
    };
  }, [
    parcelId,
    ogMode,
    isAutoFresh,
    liveContentSig,
    isLandOwner,
    effectiveParcel,
    visibleSculptures,
    onOgSettingsUpdated
  ]);

  async function handleTogglePreviewEnabled(enabled) {
    if (!isLandOwner || !parcelId || busy) return;
    const nextMode = enabled ? (customUrl ? 'custom' : 'auto') : 'logo';
    setBusy('toggle');
    setErrorMsg('');
    try {
      const res = await api.updateLandOgSettings(parcelId, {
        previewEnabled: enabled,
        ogImageMode: nextMode
      });
      const updated = res?.settings;
      if (updated) {
        setOgMode(normalizeLandOgImageMode(updated.ogImageMode));
        setCustomUrl(updated.ogCustomImageUrl || '');
        setAutoSnapshotUrl(updated.ogPreviewImageUrl || '');
        setAutoSnapshotSig(updated.ogPreviewSig || '');
        onOgSettingsUpdated?.(updated);
      } else {
        setOgMode(nextMode);
      }
      onStatusMessage?.(
        enabled
          ? 'Share preview enabled for X, Facebook & social links.'
          : 'Custom/3D share preview turned off — sharing now uses the SPRAY.LAND logo.'
      );
    } catch (err) {
      setErrorMsg(err?.message || 'Could not update share preview setting');
    } finally {
      setBusy('');
    }
  }

  async function handleCustomFileChange(e) {
    const file = e.target?.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !isLandOwner || !parcelId) return;

    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type || '')) {
      setErrorMsg('Please select a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setErrorMsg('Image is too large (max 8 MB). Recommended: 1200 × 630 px.');
      return;
    }

    setBusy('upload');
    setErrorMsg('');
    try {
      const rawDataUrl = await readImageFileAsDataUrl(file);
      // Composite centered SPRAY.LAND logotype onto 1200x630 PNG (falls back to rawDataUrl in headless JSDOM)
      const composited = await composeCenteredLogoOgPng({
        backgroundDataUrl: rawDataUrl,
        mode: 'custom',
        width: RECOMMENDED_OG_DIMENSIONS.width,
        height: RECOMMENDED_OG_DIMENSIONS.height
      });
      const payloadDataUrl = composited || rawDataUrl;

      const res = await api.updateLandOgSettings(parcelId, {
        customImageDataUrl: payloadDataUrl,
        ogImageMode: 'custom'
      });
      const updated = res?.settings;
      if (updated) {
        setOgMode(normalizeLandOgImageMode(updated.ogImageMode));
        setCustomUrl(updated.ogCustomImageUrl || payloadDataUrl);
        onOgSettingsUpdated?.(updated);
      } else {
        setOgMode('custom');
        setCustomUrl(payloadDataUrl);
      }
      onStatusMessage?.('Uploaded custom 1200×630 share image with centered SPRAY.LAND logotype!');
    } catch (err) {
      setErrorMsg(err?.message || 'Could not upload custom share image');
    } finally {
      setBusy('');
    }
  }

  async function handleResetToAuto3D() {
    if (!isLandOwner || !parcelId || busy) return;
    setBusy('reset');
    setErrorMsg('');
    try {
      const res = await api.updateLandOgSettings(parcelId, {
        clearCustomImage: true,
        ogImageMode: 'auto'
      });
      const updated = res?.settings;
      if (updated) {
        setOgMode(normalizeLandOgImageMode(updated.ogImageMode));
        setCustomUrl('');
        onOgSettingsUpdated?.(updated);
      } else {
        setOgMode('auto');
        setCustomUrl('');
      }
      autoSyncedKeyRef.current = '';
      onStatusMessage?.('Switched back to live low-angle 3D land preview.');
    } catch (err) {
      setErrorMsg(err?.message || 'Could not reset share preview');
    } finally {
      setBusy('');
    }
  }

  async function handleRefreshAutoSnapshot() {
    if (!isLandOwner || !parcelId || busy) return;
    setBusy('refresh');
    setErrorMsg('');
    try {
      const rawLowAngle = await renderLandIsometricPreview(effectiveParcel, visibleSculptures, {
        width: RECOMMENDED_OG_DIMENSIONS.width,
        height: RECOMMENDED_OG_DIMENSIONS.height,
        force: true
      });
      const composed = await composeCenteredLogoOgPng({
        backgroundDataUrl: rawLowAngle,
        mode: 'auto',
        width: RECOMMENDED_OG_DIMENSIONS.width,
        height: RECOMMENDED_OG_DIMENSIONS.height
      });
      if (composed) {
        setLocalComposedUrl(composed);
        const res = await api.updateLandOgSettings(parcelId, {
          autoPreviewDataUrl: composed,
          contentSig: liveContentSig,
          ogImageMode: 'auto'
        });
        if (res?.settings) {
          setAutoSnapshotUrl(res.settings.ogPreviewImageUrl || composed);
          setAutoSnapshotSig(res.settings.ogPreviewSig || liveContentSig);
          onOgSettingsUpdated?.(res.settings);
        }
      }
      onStatusMessage?.('Refreshed 1200×630 OG share snapshot for X & Facebook!');
    } catch (err) {
      setErrorMsg(err?.message || 'Could not refresh 3D snapshot');
    } finally {
      setBusy('');
    }
  }

  async function handleCopyOgLink() {
    const shareUrl = buildLandOgShareUrl({
      parcelId,
      customName: parcel?.customName || landDisplayName,
      landName: landDisplayName
    });
    const ok = await copyToClipboard(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
    onStatusMessage?.(ok ? `Copied social OG share link for "${landDisplayName}"!` : shareUrl);
  }

  // Decide exact preview image to render in the 1200x630 card frame
  let displaySrc = '';
  let alreadyHasCenteredLogo = false;
  if (ogMode === 'logo') {
    displaySrc = localComposedUrl || '';
    alreadyHasCenteredLogo = Boolean(localComposedUrl);
  } else if (ogMode === 'custom' && customUrl) {
    displaySrc = customUrl;
    alreadyHasCenteredLogo = true;
  } else if (localComposedUrl) {
    displaySrc = localComposedUrl;
    alreadyHasCenteredLogo = true;
  } else if (isAutoFresh && autoSnapshotUrl) {
    displaySrc = autoSnapshotUrl;
    alreadyHasCenteredLogo = true;
  } else if (fallbackSvg) {
    displaySrc = fallbackSvg;
    alreadyHasCenteredLogo = false;
  } else {
    displaySrc = serverOgImageUrl;
    alreadyHasCenteredLogo = true;
  }

  const modeBadgeLabel =
    ogMode === 'logo'
      ? 'SPRAY.LAND Logo'
      : ogMode === 'custom'
      ? 'Custom Image'
      : 'Live 3D Isometric';

  return (
    <div
      className={`land-og-preview-card ${compact ? 'is-compact' : ''}`}
      data-testid="land-og-preview-card"
      data-og-mode={ogMode}
      data-og-sig={liveContentSig}
    >
      <div className="land-og-preview-header">
        <div className="land-og-preview-heading">
          <XeroIcon emoji="🖼️" size={14} />
          <strong>Social Share Preview (X / Facebook)</strong>
          <span className="badge teal" style={{ fontSize: 9.5 }} data-testid="land-og-mode-badge">
            {modeBadgeLabel}
          </span>
        </div>
        <div className="land-og-preview-share-actions">
          <button
            type="button"
            className={`btn btn-xs ${copied ? 'is-copy-confirmed' : ''}`}
            data-testid="land-og-copy-share-btn"
            onClick={handleCopyOgLink}
            title="Copy social share link with dynamic OG preview"
          >
            {copied ? '✓ Copied' : '📋 Share Link'}
          </button>
          <a
            href={buildLandShareToXUrl({
              parcelId,
              customName: parcel?.customName || landDisplayName,
              landName: landDisplayName
            })}
            target="_blank"
            rel="noreferrer"
            className="btn btn-xs plot-share-x-btn"
            data-testid="land-og-share-x-btn"
            title={`Share ${landDisplayName} on X with live OG card`}
          >
            𝕏 Post
          </a>
        </div>
      </div>

      {/* Exact 1200x630 (1.91:1) Preview Frame as rendered on X.com & Facebook */}
      <div className="land-og-preview-frame" data-testid="land-og-preview-frame">
        {displaySrc ? (
          <img
            src={displaySrc}
            alt={`Open Graph share preview for ${landDisplayName}`}
            className="land-og-preview-img"
            data-testid="land-og-preview-img"
          />
        ) : (
          <div className="land-og-logo-backdrop" data-testid="land-og-logo-fallback" />
        )}
        {!alreadyHasCenteredLogo && (
          <div
            className="land-og-centered-logo-overlay"
            data-testid="land-og-centered-logo-overlay"
            aria-hidden="true"
          >
            <BrandLogo variant="lockup" height={ogMode === 'logo' ? 40 : 32} decorative />
          </div>
        )}
        <span className="land-og-dims-pill mono">1200 × 630 · OG</span>
      </div>

      <div className="land-og-card-meta-strip">
        <span className="mono land-og-domain">spray.land</span>
        <span className="land-og-card-title">{landDisplayName} — View &amp; Build in 3D</span>
        <span className="land-og-card-sub">
          {visibleSculptures.length}{' '}
          {visibleSculptures.length === 1 ? '3D artwork' : '3D artworks'} · Freshly synced for X &amp; Facebook
        </span>
      </div>

      {/* Land Holder Customization Controls */}
      {isLandOwner && (
        <div className="land-og-owner-controls" data-testid="land-og-owner-controls">
          <label className="land-og-toggle-row">
            <input
              type="checkbox"
              data-testid="land-og-preview-toggle"
              checked={ogMode !== 'logo'}
              disabled={Boolean(busy)}
              onChange={(e) => handleTogglePreviewEnabled(e.target.checked)}
            />
            <span>
              <strong>Show Land Preview Image</strong>
              <small>
                When off, shared links display only the SPRAY.LAND logo by default.
              </small>
            </span>
          </label>

          <div className="land-og-upload-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              data-testid="land-og-custom-upload"
              aria-label="Upload custom land share image"
              onChange={handleCustomFileChange}
            />
            <button
              type="button"
              className="btn btn-xs"
              data-testid="land-og-upload-btn"
              disabled={Boolean(busy)}
              onClick={() => fileInputRef.current?.click()}
            >
              <XeroIcon emoji="📤" size={12} />{' '}
              {busy === 'upload'
                ? 'Uploading…'
                : customUrl
                ? 'Replace Custom Image'
                : 'Upload Custom Image'}
            </button>

            {ogMode === 'custom' && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                data-testid="land-og-reset-auto-btn"
                disabled={Boolean(busy)}
                onClick={handleResetToAuto3D}
              >
                {busy === 'reset' ? 'Resetting…' : 'Use Auto 3D Preview'}
              </button>
            )}

            {ogMode === 'auto' && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                data-testid="land-og-refresh-btn"
                disabled={Boolean(busy)}
                onClick={handleRefreshAutoSnapshot}
                title="Re-capture a fresh low-angle 3D isometric preview now"
              >
                {busy === 'refresh' ? 'Capturing…' : '↻ Refresh 3D'}
              </button>
            )}

            <span className="land-og-suggested-dims mono" data-testid="land-og-suggested-dims">
              Suggested: {RECOMMENDED_OG_DIMENSIONS.width} × {RECOMMENDED_OG_DIMENSIONS.height} px (
              {RECOMMENDED_OG_DIMENSIONS.ratioLabel})
            </span>
          </div>

          {errorMsg && (
            <div className="land-og-error" role="alert" data-testid="land-og-error">
              ⚠️ {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
