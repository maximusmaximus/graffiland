import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildParcelShareUrl } from '../../../shared/landVolume.mjs';
import {
  BIO_MAX_LEN,
  PROFILE_HEADER_PRESETS,
  buildPublicProfileUrl,
  findHeaderPreset,
  formatUserNumber,
  normalizeUsername,
  validateBio,
  validateProfileImage,
  validateUsername
} from '../../../shared/profileRules.mjs';
import { api } from '../utils/api.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import { buildSculptureShareUrl, copyToClipboard } from '../utils/clipboard.js';
import {
  formatLandDimensions,
  formatLandExpiration,
  formatSculptureAssetMeta,
  formatShortDate
} from '../utils/landMapHelpers.js';
import { prepareProfileImageFile } from '../utils/profileImageHelper.js';
import { EmojiTextarea } from './EmojiField.jsx';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

function shortenAddress(addr) {
  const s = String(addr || '').trim();
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function formatMonthYear(iso) {
  if (!iso) return '';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export default function ProfileModal({
  handle = '',
  user = null,
  config = null,
  initialEditing = false,
  onUserUpdate = null,
  onSelectSculpture = null,
  onOpenLand = null,
  onOpenWalletSettings = null,
  onLogout = null,
  onShowHint = null,
  onClose,
  fetchProfileFn = null,
  checkUsernameFn = null,
  saveProfileFn = null
}) {
  const targetHandle = handle || user?.username || user?.id || '';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('lands'); // 'lands' | 'sculptures' | 'actions'
  const [editing, setEditing] = useState(Boolean(initialEditing));

  const [usernameInput, setUsernameInput] = useState('');
  const [bioInput, setBioInput] = useState('');
  const [avatarInput, setAvatarInput] = useState('');
  const [headerInput, setHeaderInput] = useState('');
  const [avatarDirty, setAvatarDirty] = useState(false);
  const [headerDirty, setHeaderDirty] = useState(false);
  const [mediaBusy, setMediaBusy] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [availability, setAvailability] = useState({
    state: 'idle',
    username: '',
    message: ''
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  const avatarFileInputRef = useRef(null);
  const headerFileInputRef = useRef(null);

  const profile = data?.profile || null;
  const stats = data?.stats || {
    landCount: 0,
    sculptureCount: 0,
    activeListingCount: 0,
    questCount: 0,
    actionCount: 0,
    totalBlocks: 0,
    awakenedLands: 0,
    totalXp: 0
  };
  const lands = useMemo(() => data?.lands || [], [data?.lands]);
  const sculptures = useMemo(() => data?.sculptures || [], [data?.sculptures]);
  const listings = useMemo(() => data?.listings || [], [data?.listings]);
  const actions = useMemo(() => data?.actions || [], [data?.actions]);

  const isOwner = Boolean(user?.id && profile?.id && String(user.id) === String(profile.id));
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const loadProfile = useCallback(async () => {
    if (!targetHandle) {
      setLoading(false);
      setLoadError('No profile specified.');
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const curUser = userRef.current;
      const fetcher =
        fetchProfileFn ||
        ((id) =>
          curUser?.id &&
          (id === curUser.id ||
            id.toLowerCase() === String(curUser.username || '').toLowerCase())
            ? api.getMyProfile()
            : api.getPublicProfile(id));
      const res = await fetcher(targetHandle);
      setData(res);
      setUsernameInput(res?.profile?.username || '');
      setBioInput(res?.profile?.bio || '');
      setAvatarInput(res?.profile?.avatarImage || '');
      setHeaderInput(res?.profile?.headerImage || '');
      setAvatarDirty(false);
      setHeaderDirty(false);
      setMediaError('');
      if (
        (res?.lands?.length || 0) === 0 &&
        (res?.sculptures?.length || 0) > 0
      ) {
        setActiveTab('sculptures');
      }
    } catch (err) {
      setLoadError(err?.message || 'Could not load profile.');
    } finally {
      setLoading(false);
    }
  }, [targetHandle, fetchProfileFn]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const localUsernameValidation = validateUsername(usernameInput);
  const localBioValidation = validateBio(bioInput);
  const localAvatarValidation = validateProfileImage(avatarInput, { kind: 'avatar' });
  const localHeaderValidation = validateProfileImage(headerInput, { kind: 'header' });
  const currentUsernameNorm = normalizeUsername(profile?.username || '');

  // Live username uniqueness check while editing
  useEffect(() => {
    if (!editing) return undefined;
    setSaveError('');

    if (!localUsernameValidation.ok) {
      setAvailability({
        state: 'invalid',
        username: localUsernameValidation.username,
        message: localUsernameValidation.error
      });
      return undefined;
    }

    if (
      currentUsernameNorm &&
      localUsernameValidation.username === currentUsernameNorm
    ) {
      setAvailability({
        state: 'available',
        username: localUsernameValidation.username,
        message: 'This is your current username.'
      });
      return undefined;
    }

    let cancelled = false;
    setAvailability({
      state: 'checking',
      username: localUsernameValidation.username,
      message: 'Checking availability...'
    });
    const checker = checkUsernameFn || ((u) => api.checkUsername(u));
    const timer = setTimeout(async () => {
      try {
        const res = await checker(localUsernameValidation.username);
        if (cancelled) return;
        setAvailability({
          state: res?.available ? 'available' : 'taken',
          username: res?.username || localUsernameValidation.username,
          message:
            res?.reason ||
            (res?.available
              ? `@${localUsernameValidation.username} is available!`
              : `@${localUsernameValidation.username} is already taken.`)
        });
      } catch (err) {
        if (cancelled) return;
        setAvailability({
          state: 'error',
          username: localUsernameValidation.username,
          message: err?.message || 'Unable to verify availability.'
        });
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    editing,
    usernameInput,
    currentUsernameNorm,
    localUsernameValidation.ok,
    localUsernameValidation.username,
    localUsernameValidation.error,
    checkUsernameFn
  ]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';

  const publicProfileUrl = useMemo(() => {
    if (!profile?.username) return '';
    return buildPublicProfileUrl({ origin, pathname, username: profile.username });
  }, [origin, pathname, profile?.username]);

  function flashCopy(key, message) {
    setCopiedKey(key);
    onShowHint?.(message);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? '' : prev));
    }, 1800);
  }

  async function handleCopyUrl(key, url, label) {
    if (!url) return;
    const ok = await copyToClipboard(url);
    flashCopy(key, ok ? `Copied ${label}!` : 'Copy unavailable');
  }

  const canSaveEdit =
    !saving &&
    !mediaBusy &&
    localUsernameValidation.ok &&
    localBioValidation.ok &&
    (!avatarDirty || localAvatarValidation.ok) &&
    (!headerDirty || localHeaderValidation.ok) &&
    availability.state === 'available' &&
    availability.username === localUsernameValidation.username;

  async function handleImageUpload(e, kind) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMediaBusy(kind);
    setMediaError('');
    setSaveError('');
    try {
      const dataUrl = await prepareProfileImageFile(file, kind);
      if (kind === 'avatar') {
        setAvatarInput(dataUrl);
        setAvatarDirty(true);
      } else {
        setHeaderInput(dataUrl);
        setHeaderDirty(true);
      }
    } catch (err) {
      setMediaError(err?.message || 'Could not process selected image.');
    } finally {
      setMediaBusy('');
    }
  }

  async function handleSaveProfile(e) {
    e.preventDefault();
    setSaveError('');
    setMediaError('');
    setSaveNotice('');
    if (!localUsernameValidation.ok) {
      setSaveError(localUsernameValidation.error);
      return;
    }
    if (!localBioValidation.ok) {
      setSaveError(localBioValidation.error);
      return;
    }
    if (avatarDirty && !localAvatarValidation.ok) {
      setSaveError(localAvatarValidation.error);
      return;
    }
    if (headerDirty && !localHeaderValidation.ok) {
      setSaveError(localHeaderValidation.error);
      return;
    }
    setSaving(true);
    try {
      const saver = saveProfileFn || ((payload) => api.updateProfile(payload));
      /** @type {any} */
      const payload = {
        username: localUsernameValidation.username,
        bio: localBioValidation.bio
      };
      if (avatarDirty) {
        payload.avatarImage = localAvatarValidation.value;
      }
      if (headerDirty) {
        payload.headerImage = localHeaderValidation.value;
      }
      const res = await saver(payload);
      if (res?.user) {
        onUserUpdate?.(res.user);
      }
      if (res?.profile) {
        setData(res);
        setAvatarInput(res.profile.avatarImage || '');
        setHeaderInput(res.profile.headerImage || '');
      } else {
        await loadProfile();
      }
      setAvatarDirty(false);
      setHeaderDirty(false);
      setEditing(false);
      setSaveNotice('Profile saved!');
      onShowHint?.(`Profile updated (@${localUsernameValidation.username})`);

      // Keep ?u= URL synced if user was viewing their own public URL
      if (typeof window !== 'undefined' && res?.profile?.username) {
        const curUrl = new URL(window.location.href);
        if (curUrl.searchParams.has('u') || curUrl.searchParams.has('profile')) {
          curUrl.searchParams.set('u', res.profile.username);
          curUrl.searchParams.delete('profile');
          window.history.replaceState({}, '', curUrl.toString());
        }
      }
      setTimeout(() => setSaveNotice(''), 2500);
    } catch (err) {
      const msg = err?.message || 'Failed to save profile.';
      setSaveError(msg);
      if (/taken/i.test(msg)) {
        setAvailability({
          state: 'taken',
          username: localUsernameValidation.username,
          message: msg
        });
      }
    } finally {
      setSaving(false);
    }
  }

  function resolveLandUrl(land) {
    return buildParcelShareUrl({
      origin,
      pathname,
      parcelId: land.parcelId,
      customName: land.customName || '',
      compact: true
    });
  }

  function resolveSculptureUrl(sculptureId) {
    return buildSculptureShareUrl(sculptureId) || `${origin}${pathname}?sculpture=${encodeURIComponent(sculptureId)}`;
  }

  function resolveActionUrl(act) {
    if (act.sculptureId) return resolveSculptureUrl(act.sculptureId);
    if (act.parcelId) {
      return buildParcelShareUrl({
        origin,
        pathname,
        parcelId: act.parcelId,
        compact: true
      });
    }
    return act.url || '';
  }

  const displayUsername = editing && localUsernameValidation.username
    ? localUsernameValidation.username
    : profile?.username || '';
  const monogram = String(displayUsername || profile?.displayName || '?')
    .replace(/^@/, '')
    .slice(0, 2)
    .toUpperCase();

  const liveAvatarSrc = editing && avatarDirty
    ? localAvatarValidation.ok
      ? localAvatarValidation.value
      : ''
    : profile?.avatarImage || profile?.picture || '';

  const liveHeaderValue = editing && headerDirty
    ? localHeaderValidation.ok
      ? localHeaderValidation.value
      : ''
    : profile?.headerImage || '';

  const headerPreset = liveHeaderValue.startsWith('preset:') || !liveHeaderValue
    ? findHeaderPreset(liveHeaderValue)
    : null;
  const headerBgImageUrl = !headerPreset && liveHeaderValue ? liveHeaderValue : '';
  const userNumberLabel =
    profile?.userNumberLabel || formatUserNumber(profile?.userNumber || user?.userNumber || 0);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={profile?.username ? `Profile @${profile.username}` : 'Creator Profile'}
      data-testid="profile-modal"
      onClick={onClose}
    >
      <div className="modal-card profile-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ marginBottom: 10 }}>
          <h2 className="modal-title">
            <XeroIcon emoji="👤" size={20} />
            {profile?.username ? `@${profile.username}` : profile?.displayName || 'Profile'}
          </h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {isOwner && !editing && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setUsernameInput(profile?.username || '');
                  setBioInput(profile?.bio || '');
                  setAvatarInput(profile?.avatarImage || '');
                  setHeaderInput(profile?.headerImage || '');
                  setAvatarDirty(false);
                  setHeaderDirty(false);
                  setMediaError('');
                  setSaveError('');
                  setEditing(true);
                }}
                data-testid="profile-edit-btn"
              >
                <XeroIcon emoji="✏️" size={13} /> Edit Profile
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close profile">
              <XeroIcon emoji="❌" size={14} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="card" style={{ padding: 18, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Loading public profile...
          </div>
        ) : loadError || !profile ? (
          <div className="card" style={{ padding: 16, textAlign: 'center', color: '#fda4af', fontSize: 13 }}>
            <XeroIcon emoji="⚠️" size={16} /> {loadError || 'Profile not found.'}
          </div>
        ) : (
          <div className="profile-modal-body">
            {/* Clean Public Profile Banner & Identity Card */}
            <div className="card profile-hero-card">
              <div
                className="profile-public-banner"
                data-testid="public-profile-banner"
                data-header-preset={headerPreset ? headerPreset.id : 'custom'}
                style={headerPreset ? { background: headerPreset.background } : undefined}
              >
                {headerBgImageUrl && (
                  <img
                    className="profile-banner-bg-img"
                    src={headerBgImageUrl}
                    alt=""
                    data-testid="profile-banner-bg-img"
                  />
                )}
                <div className="profile-banner-grid-overlay" aria-hidden="true" />
                <div className="profile-banner-scrim" aria-hidden="true" />

                {/* Top Row: Role Badge + User Number Pill */}
                <div className="profile-banner-top">
                  <span className="profile-banner-role-pill">
                    <XeroIcon emoji={profile.accountType === 'agent' ? '🤖' : '🎨'} size={11} />
                    <span>{profile.accountType === 'agent' ? 'AI Steward' : 'Creator'}</span>
                  </span>

                  <div className="profile-banner-top-right">
                    {userNumberLabel && (
                      <span
                        className="profile-user-number-pill mono"
                        data-testid="profile-user-number"
                        title={`GRAFFILAND Member ${userNumberLabel}`}
                      >
                        USER {userNumberLabel}
                      </span>
                    )}
                    {isOwner && editing && (
                      <button
                        type="button"
                        className="profile-banner-edit-chip"
                        disabled={Boolean(mediaBusy)}
                        onClick={() => headerFileInputRef.current?.click()}
                        title="Upload a custom profile header background"
                      >
                        <XeroIcon emoji="🖼️" size={11} />{' '}
                        {mediaBusy === 'header' ? 'Optimizing…' : 'Header'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Bottom Row: Profile Icon (Bio Image) + Username & Identity */}
                <div className="profile-banner-bottom">
                  <div className="profile-banner-avatar-wrap">
                    <div className="profile-avatar profile-banner-avatar">
                      {liveAvatarSrc ? (
                        <img
                          src={liveAvatarSrc}
                          alt={profile.displayName}
                          data-testid="profile-banner-avatar-img"
                        />
                      ) : (
                        <span>{monogram}</span>
                      )}
                    </div>
                    {isOwner && editing && (
                      <button
                        type="button"
                        className="profile-avatar-edit-dot"
                        aria-label="Upload bio image"
                        title="Change bio image"
                        disabled={Boolean(mediaBusy)}
                        onClick={() => avatarFileInputRef.current?.click()}
                      >
                        <XeroIcon emoji="📷" size={11} />
                      </button>
                    )}
                  </div>

                  <div className="profile-banner-identity">
                    <div className="profile-banner-username-row">
                      {displayUsername ? (
                        <strong className="profile-banner-username" data-testid="profile-handle">
                          @{displayUsername}
                        </strong>
                      ) : (
                        <strong className="profile-banner-username">{profile.displayName}</strong>
                      )}
                    </div>
                    <div className="profile-banner-sub-row">
                      {displayUsername && profile.displayName && (
                        <span className="profile-banner-display-name">{profile.displayName}</span>
                      )}
                      {profile.walletAddress && (
                        <span className="profile-banner-meta-pill mono" title={profile.walletAddress}>
                          {shortenAddress(profile.walletAddress)}
                        </span>
                      )}
                      {profile.joinedAt && (
                        <span className="profile-banner-meta-pill">
                          Joined {formatMonthYear(profile.joinedAt)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="profile-hero-content">
                {/* Bio Display */}
                {!editing && (
                  <div className="profile-bio-block" data-testid="profile-bio">
                    {profile.bio ? (
                      <p className="profile-bio-text">{profile.bio}</p>
                    ) : isOwner ? (
                      <p className="profile-bio-placeholder">
                        No bio yet — tap <strong>Edit Profile</strong> to add your bio, icon, and
                        banner header.
                      </p>
                    ) : (
                      <p className="profile-bio-placeholder">No bio added yet.</p>
                    )}
                  </div>
                )}

                {/* Share Public Profile Bar */}
                <div className="profile-share-bar">
                  {publicProfileUrl && (
                    <>
                      <button
                        type="button"
                        className="btn btn-xs profile-public-link-btn"
                        data-testid="copy-profile-link-btn"
                        onClick={() => handleCopyUrl('profile', publicProfileUrl, 'public profile link')}
                      >
                        <XeroIcon emoji="🔗" size={12} />{' '}
                        {copiedKey === 'profile' ? 'Copied Profile Link!' : 'Copy Public Profile Link'}
                      </button>
                      <a
                        className="btn btn-xs"
                        href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                          `Explore @${profile.username}'s 3D Virtual Lands & AR sculptures on GRAFFILAND!`
                        )}&url=${encodeURIComponent(publicProfileUrl)}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Share profile to X"
                      >
                        𝕏
                      </a>
                    </>
                  )}
                  {isOwner && onOpenWalletSettings && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => {
                        onClose?.();
                        onOpenWalletSettings();
                      }}
                    >
                      <XeroIcon emoji="💳" size={12} /> Wallet
                    </button>
                  )}
                  {isOwner && onLogout && (
                    <button
                      type="button"
                      className="btn btn-xs btn-danger"
                      onClick={() => {
                        onClose?.();
                        onLogout();
                      }}
                    >
                      <XeroIcon emoji="🚪" size={12} /> Sign Out
                    </button>
                  )}
                </div>

                {saveNotice && (
                  <div className="profile-success-banner" role="status">
                    <XeroIcon emoji="✅" size={13} /> {saveNotice}
                  </div>
                )}
              </div>
            </div>

            {/* Owner Edit Form */}
            {isOwner && editing && (
              <form
                className="card profile-edit-card"
                data-testid="profile-edit-form"
                onSubmit={handleSaveProfile}
              >
                <div className="profile-edit-section-head">
                  <strong style={{ fontSize: 13.5 }}>
                    <XeroIcon emoji="✏️" size={14} /> Customize Profile Banner, Bio Image &amp; Bio
                  </strong>
                  <InfoTip title="Profile Banner & Image Tips">
                    Your public banner above updates live as you edit. Upload any PNG, JPEG, or WebP
                    photo (auto-cropped to a crisp 256×256 icon or 960×320 widescreen banner), paste
                    an HTTPS image URL, or pick a curated header background preset.
                  </InfoTip>
                </div>

                {/* Hidden file inputs triggered by banner buttons & form controls */}
                <input
                  ref={avatarFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  data-testid="profile-avatar-file-input"
                  style={{ display: 'none' }}
                  onChange={(e) => handleImageUpload(e, 'avatar')}
                />
                <input
                  ref={headerFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  data-testid="profile-header-file-input"
                  style={{ display: 'none' }}
                  onChange={(e) => handleImageUpload(e, 'header')}
                />

                {/* Bio Image (Profile Icon) Controls */}
                <div className="profile-media-block">
                  <div className="profile-media-head">
                    <span className="field-label" style={{ marginBottom: 0 }}>
                      Bio Image (Profile Icon)
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        disabled={Boolean(mediaBusy)}
                        onClick={() => avatarFileInputRef.current?.click()}
                      >
                        <XeroIcon emoji="📷" size={11} />{' '}
                        {mediaBusy === 'avatar' ? 'Optimizing…' : 'Upload Photo'}
                      </button>
                      {(avatarInput || profile.avatarImage) && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={Boolean(mediaBusy)}
                          onClick={() => {
                            setAvatarInput('');
                            setAvatarDirty(true);
                            setMediaError('');
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    type="url"
                    className="input"
                    aria-label="Bio image URL"
                    placeholder="Or paste an https:// image URL…"
                    value={avatarInput.startsWith('data:') ? '' : avatarInput}
                    onChange={(e) => {
                      setAvatarInput(e.target.value.trim());
                      setAvatarDirty(true);
                      setMediaError('');
                    }}
                  />
                  {avatarInput.startsWith('data:') && (
                    <div className="profile-media-hint mono">
                      ✓ Custom bio image ready ({Math.round(avatarInput.length / 1024)} KB)
                    </div>
                  )}
                  {avatarDirty && !localAvatarValidation.ok && (
                    <div className="profile-media-err">{localAvatarValidation.error}</div>
                  )}
                </div>

                {/* Profile Header (Banner Background) Controls */}
                <div className="profile-media-block">
                  <div className="profile-media-head">
                    <span className="field-label" style={{ marginBottom: 0 }}>
                      Profile Header Background
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        disabled={Boolean(mediaBusy)}
                        onClick={() => headerFileInputRef.current?.click()}
                      >
                        <XeroIcon emoji="🖼️" size={11} />{' '}
                        {mediaBusy === 'header' ? 'Optimizing…' : 'Upload Header'}
                      </button>
                      {headerInput && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={Boolean(mediaBusy)}
                          onClick={() => {
                            setHeaderInput('');
                            setHeaderDirty(true);
                            setMediaError('');
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Curated Background Theme Presets */}
                  <div
                    className="profile-header-presets"
                    role="group"
                    aria-label="Profile header background presets"
                  >
                    {PROFILE_HEADER_PRESETS.map((preset) => {
                      const active =
                        (headerInput || 'preset:cyber-grid').toLowerCase() === preset.token;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`profile-preset-swatch ${active ? 'is-active' : ''}`}
                          style={{ background: preset.background }}
                          aria-pressed={active}
                          aria-label={`Header preset: ${preset.label}`}
                          title={preset.label}
                          onClick={() => {
                            setHeaderInput(preset.token);
                            setHeaderDirty(true);
                            setMediaError('');
                          }}
                        >
                          <span className="profile-preset-label">{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <input
                    type="url"
                    className="input"
                    aria-label="Profile header URL"
                    placeholder="Or paste an https:// banner image URL…"
                    value={
                      headerInput.startsWith('data:') || headerInput.startsWith('preset:')
                        ? ''
                        : headerInput
                    }
                    onChange={(e) => {
                      setHeaderInput(e.target.value.trim());
                      setHeaderDirty(true);
                      setMediaError('');
                    }}
                  />
                  {headerInput.startsWith('data:') && (
                    <div className="profile-media-hint mono">
                      ✓ Custom header photo ready ({Math.round(headerInput.length / 1024)} KB)
                    </div>
                  )}
                  {headerDirty && !localHeaderValidation.ok && (
                    <div className="profile-media-err">{localHeaderValidation.error}</div>
                  )}
                </div>

                {mediaError && (
                  <div className="profile-error-banner" role="alert">
                    <XeroIcon emoji="⚠️" size={14} /> {mediaError}
                  </div>
                )}

                <div>
                  <label className="field-label" htmlFor="profile-edit-username">
                    <span>Username (unique across GRAFFILAND)</span>
                  </label>
                  <div className="profile-username-input-wrap">
                    <span className="profile-username-at" aria-hidden="true">
                      @
                    </span>
                    <input
                      id="profile-edit-username"
                      aria-label="Username"
                      className="input profile-username-input"
                      type="text"
                      maxLength={24}
                      value={usernameInput}
                      onChange={(e) => setUsernameInput(e.target.value.replace(/\s+/g, ''))}
                      placeholder="your_handle"
                      required
                    />
                  </div>
                  <div
                    className={`profile-availability-status is-${availability.state}`}
                    data-testid="profile-username-status"
                    role="status"
                    aria-live="polite"
                  >
                    <XeroIcon
                      emoji={
                        availability.state === 'available'
                          ? '✅'
                          : availability.state === 'checking'
                          ? '⏳'
                          : '⚠️'
                      }
                      size={13}
                    />
                    <span>{availability.message}</span>
                  </div>
                </div>

                <div>
                  <div className="field-label">
                    <label htmlFor="profile-edit-bio">Bio</label>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                      {bioInput.length}/{BIO_MAX_LEN}
                    </span>
                  </div>
                  <EmojiTextarea
                    id="profile-edit-bio"
                    aria-label="Bio"
                    className="textarea"
                    rows={3}
                    maxLength={BIO_MAX_LEN}
                    value={bioInput}
                    onChange={(e) => setBioInput(e.target.value)}
                    placeholder="Share your artistic style, cities you sculpt in, or links... (type : for emojis)"
                  />
                </div>

                {saveError && (
                  <div className="profile-error-banner" role="alert">
                    <XeroIcon emoji="⚠️" size={14} /> {saveError}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={saving}
                    onClick={() => {
                      setAvatarInput(profile?.avatarImage || '');
                      setHeaderInput(profile?.headerImage || '');
                      setAvatarDirty(false);
                      setHeaderDirty(false);
                      setMediaError('');
                      setEditing(false);
                      setSaveError('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={!canSaveEdit}
                    data-testid="profile-save-btn"
                  >
                    <XeroIcon emoji="💾" size={13} /> {saving ? 'Saving...' : 'Save Profile'}
                  </button>
                </div>
              </form>
            )}

            {/* Stats Row */}
            <div className="profile-stats-grid">
              <div className="profile-stat-box">
                <div className="profile-stat-val">{stats.landCount}</div>
                <div className="profile-stat-lbl">Lands</div>
              </div>
              <div className="profile-stat-box">
                <div className="profile-stat-val">{stats.sculptureCount}</div>
                <div className="profile-stat-lbl">Sculptures</div>
              </div>
              <div className="profile-stat-box">
                <div className="profile-stat-val">{Number(stats.totalBlocks || 0).toLocaleString()}</div>
                <div className="profile-stat-lbl">3D Blocks</div>
              </div>
              <div className="profile-stat-box">
                <div className="profile-stat-val">{stats.actionCount}</div>
                <div className="profile-stat-lbl">Actions</div>
              </div>
            </div>

            {/* Public Content Tabs */}
            <div className="profile-tabs" role="tablist" aria-label="Profile content">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'lands'}
                className={`btn btn-xs ${activeTab === 'lands' ? 'btn-primary' : ''}`}
                onClick={() => setActiveTab('lands')}
              >
                <XeroIcon emoji="🗺️" size={12} /> Lands ({lands.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'sculptures'}
                className={`btn btn-xs ${activeTab === 'sculptures' ? 'btn-primary' : ''}`}
                onClick={() => setActiveTab('sculptures')}
              >
                <XeroIcon emoji="🧊" size={12} /> Sculptures ({sculptures.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'actions'}
                className={`btn btn-xs ${activeTab === 'actions' ? 'btn-primary' : ''}`}
                onClick={() => setActiveTab('actions')}
              >
                <XeroIcon emoji="⚡" size={12} /> Actions ({actions.length})
              </button>
            </div>

            {/* Tab 1: Lands with Public Links */}
            {activeTab === 'lands' && (
              <div className="profile-section-list" data-testid="profile-lands-list">
                {lands.length === 0 ? (
                  <div className="profile-empty-box">No Virtual Lands claimed by this account yet.</div>
                ) : (
                  lands.map((land) => {
                    const landUrl = resolveLandUrl(land);
                    const dims = formatLandDimensions(land);
                    const exp = formatLandExpiration(land);
                    return (
                      <div key={land.parcelId} className="profile-item-card" data-testid="profile-land-item">
                        <div className="profile-item-head">
                          <div style={{ minWidth: 0 }}>
                            <div className="profile-item-title">{land.displayName}</div>
                            <div className="profile-item-sub mono">{land.parcelId}</div>
                          </div>
                          <span
                            className={`badge ${
                              exp.state === 'permanent'
                                ? 'teal'
                                : exp.urgent
                                ? 'danger'
                                : 'gold'
                            }`}
                            style={{ fontSize: 10 }}
                          >
                            {exp.badgeText}
                          </span>
                        </div>
                        {land.description && (
                          <div className="profile-item-desc">{land.description}</div>
                        )}
                        <div className="profile-item-chips">
                          {dims && <span className="mobile-sc-chip">📐 {dims}</span>}
                          <span className="mobile-sc-chip">
                            🎨 {land.sculptureCount} sculpture{land.sculptureCount === 1 ? '' : 's'}
                          </span>
                          {land.frozen && <span className="mobile-sc-chip">❄️ Frozen</span>}
                        </div>
                        <div className="profile-item-actions">
                          <a
                            className="btn btn-xs profile-public-link-btn"
                            href={landUrl}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="profile-land-public-link"
                          >
                            <XeroIcon emoji="🔗" size={11} /> Public Land Link
                          </a>
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() => handleCopyUrl(`land-${land.parcelId}`, landUrl, 'land link')}
                          >
                            {copiedKey === `land-${land.parcelId}` ? '✅ Copied' : '📋 Copy'}
                          </button>
                          {land.googleMapsUrl && (
                            <a
                              className="btn btn-xs"
                              href={land.googleMapsUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <XeroIcon emoji="🧭" size={11} /> Maps
                            </a>
                          )}
                          {onOpenLand && (
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              onClick={() => {
                                onClose?.();
                                onOpenLand(land);
                              }}
                            >
                              <XeroIcon emoji="📍" size={11} /> View
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Tab 2: Sculptures with Public Links */}
            {activeTab === 'sculptures' && (
              <div className="profile-section-list" data-testid="profile-sculptures-list">
                {sculptures.length === 0 ? (
                  <div className="profile-empty-box">No published sculptures on this account yet.</div>
                ) : (
                  sculptures.map((sc) => {
                    const scUrl = resolveSculptureUrl(sc.id);
                    const chainLinks = getSculptureChainLinks(sc, config);
                    return (
                      <div key={sc.id} className="profile-item-card" data-testid="profile-sculpture-item">
                        <div className="profile-item-head">
                          <div style={{ minWidth: 0 }}>
                            <div className="profile-item-title">{sc.title}</div>
                            <div className="profile-item-sub mono">
                              {sc.parcelId} · {formatShortDate(sc.createdAt)}
                            </div>
                          </div>
                          <span className="badge" style={{ fontSize: 10 }}>
                            {formatSculptureAssetMeta(sc)}
                          </span>
                        </div>
                        {sc.description && <div className="profile-item-desc">{sc.description}</div>}
                        <div className="profile-item-chips">
                          {Number(sc.polScore || 0) > 0 && (
                            <span className="mobile-sc-chip">🛡️ PoL {Math.round(sc.polScore)}</span>
                          )}
                          {chainLinks.txUrl ? (
                            <a
                              className="mobile-sc-chip is-link"
                              href={chainLinks.txUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              ⛓️ Tx {sc.chain.txHash.slice(0, 8)}...
                            </a>
                          ) : sc.chain?.txHash ? (
                            <span className="mobile-sc-chip">
                              ⛓️ Pre-chain {sc.chain.txHash.slice(0, 8)}...
                            </span>
                          ) : null}
                        </div>
                        <div className="profile-item-actions">
                          <a
                            className="btn btn-xs profile-public-link-btn"
                            href={scUrl}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="profile-sculpture-public-link"
                          >
                            <XeroIcon emoji="🔗" size={11} /> Public Link
                          </a>
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() => handleCopyUrl(`sc-${sc.id}`, scUrl, 'sculpture link')}
                          >
                            {copiedKey === `sc-${sc.id}` ? '✅ Copied' : '📋 Copy'}
                          </button>
                          {onSelectSculpture && (
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              onClick={() => {
                                onClose?.();
                                onSelectSculpture(sc);
                              }}
                            >
                              <XeroIcon emoji="🧊" size={11} /> Review 3D
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Tab 3: Public Activity, Listings & Actions */}
            {activeTab === 'actions' && (
              <div className="profile-section-list" data-testid="profile-actions-list">
                {listings.length > 0 && (
                  <div className="profile-sub-heading">
                    Active Marketplace Listings ({listings.length})
                  </div>
                )}
                {listings.map((lst) => {
                  const lstUrl = resolveSculptureUrl(lst.sculptureId);
                  return (
                    <div key={`lst-${lst.id}`} className="profile-item-card">
                      <div className="profile-item-head">
                        <div className="profile-item-title">🏷️ {lst.sculptureTitle}</div>
                        <span className="badge gold" style={{ fontSize: 10 }}>
                          {lst.priceEth} ETH
                        </span>
                      </div>
                      <div className="profile-item-actions">
                        <a
                          className="btn btn-xs profile-public-link-btn"
                          href={lstUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <XeroIcon emoji="🔗" size={11} /> Public Listing Link
                        </a>
                      </div>
                    </div>
                  );
                })}

                {actions.length === 0 ? (
                  <div className="profile-empty-box">No public account actions recorded yet.</div>
                ) : (
                  actions.map((act) => {
                    const actUrl = resolveActionUrl(act);
                    return (
                      <div key={act.id} className="profile-action-row" data-testid="profile-action-item">
                        <div className="profile-action-icon" aria-hidden="true">
                          <XeroIcon emoji={act.icon || '⚡'} size={15} />
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="profile-action-title">{act.title}</div>
                          <div className="profile-action-meta">
                            {act.detail}
                            {act.createdAt ? ` · ${formatShortDate(act.createdAt)}` : ''}
                          </div>
                        </div>
                        {actUrl && (
                          <a
                            className="btn btn-xs profile-public-link-btn"
                            href={actUrl}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="profile-action-link"
                          >
                            <XeroIcon emoji="🔗" size={11} /> {act.linkLabel || 'Link'}
                          </a>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
