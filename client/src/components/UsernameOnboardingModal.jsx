import React, { useEffect, useState } from 'react';
import {
  BIO_MAX_LEN,
  buildPublicProfileUrl,
  normalizeUsername,
  suggestUsernameFromName,
  validateBio,
  validateUsername
} from '../../../shared/profileRules.mjs';
import { api } from '../utils/api.js';
import { EmojiTextarea } from './EmojiField.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function UsernameOnboardingModal({
  user,
  onComplete,
  onLogout,
  checkUsernameFn = null,
  saveProfileFn = null
}) {
  const [usernameInput, setUsernameInput] = useState(
    () => user?.username || suggestUsernameFromName(user?.name || '', user?.email || '')
  );
  const [bioInput, setBioInput] = useState(() => user?.bio || '');
  const [availability, setAvailability] = useState({
    state: 'idle', // 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error'
    username: '',
    message: ''
  });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const normalized = normalizeUsername(usernameInput);
  const localValidation = validateUsername(usernameInput);
  const bioValidation = validateBio(bioInput);

  useEffect(() => {
    setSubmitError('');
    if (!localValidation.ok) {
      setAvailability({
        state: 'invalid',
        username: localValidation.username,
        message: localValidation.error
      });
      return undefined;
    }

    let cancelled = false;
    setAvailability({
      state: 'checking',
      username: localValidation.username,
      message: 'Checking availability...'
    });

    const checker = checkUsernameFn || ((u) => api.checkUsername(u));
    const timer = setTimeout(async () => {
      try {
        const res = await checker(localValidation.username);
        if (cancelled) return;
        setAvailability({
          state: res?.available ? 'available' : 'taken',
          username: res?.username || localValidation.username,
          message:
            res?.reason ||
            (res?.available
              ? `@${localValidation.username} is available!`
              : `@${localValidation.username} is already taken.`)
        });
      } catch (err) {
        if (cancelled) return;
        setAvailability({
          state: 'error',
          username: localValidation.username,
          message: err?.message || 'Could not verify availability right now.'
        });
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [usernameInput, localValidation.ok, localValidation.username, localValidation.error, checkUsernameFn]);

  const previewUrl = normalized
    ? buildPublicProfileUrl({
        origin: typeof window !== 'undefined' ? window.location.origin : '',
        pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
        username: normalized
      })
    : '';

  const canSubmit =
    !saving &&
    localValidation.ok &&
    bioValidation.ok &&
    availability.state === 'available' &&
    availability.username === localValidation.username;

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');
    if (!localValidation.ok) {
      setSubmitError(localValidation.error);
      return;
    }
    if (!bioValidation.ok) {
      setSubmitError(bioValidation.error);
      return;
    }
    setSaving(true);
    try {
      const saver = saveProfileFn || ((payload) => api.updateProfile(payload));
      const res = await saver({
        username: localValidation.username,
        bio: bioValidation.bio
      });
      if (res?.user) {
        onComplete?.(res.user);
      }
    } catch (err) {
      const msg = err?.message || 'Could not save username.';
      setSubmitError(msg);
      if (/taken/i.test(msg)) {
        setAvailability({
          state: 'taken',
          username: localValidation.username,
          message: msg
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop username-onboarding-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Choose your SPRAY.LAND username"
      data-testid="username-onboarding-modal"
    >
      <div className="modal-card username-onboarding-card">
        <div className="modal-header" style={{ marginBottom: 8 }}>
          <h2 className="modal-title">
            <XeroIcon emoji="✨" size={22} />
            Claim Your Unique Username
          </h2>
          <span className="badge teal" style={{ fontSize: 10.5 }}>
            Required
          </span>
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Choose a unique handle for your public SPRAY.LAND profile. No one else can claim your
          username, and you can change it anytime in your profile settings.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="field-label" htmlFor="onboarding-username-input">
              <span>Username (3–24 chars: letters, numbers, _ or -)</span>
            </label>
            <div className="profile-username-input-wrap">
              <span className="profile-username-at" aria-hidden="true">
                @
              </span>
              <input
                id="onboarding-username-input"
                aria-label="Choose username"
                className="input profile-username-input"
                type="text"
                autoComplete="username"
                autoFocus
                maxLength={24}
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value.replace(/\s+/g, ''))}
                placeholder="your_handle"
                required
              />
            </div>

            <div
              className={`profile-availability-status is-${availability.state}`}
              data-testid="onboarding-username-status"
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

            {previewUrl && localValidation.ok && (
              <div className="profile-link-preview mono">
                Public profile: <span>{previewUrl}</span>
              </div>
            )}
          </div>

          <div>
            <div className="field-label">
              <label htmlFor="onboarding-bio-input">Bio (optional)</label>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                {bioInput.length}/{BIO_MAX_LEN}
              </span>
            </div>
            <EmojiTextarea
              id="onboarding-bio-input"
              aria-label="Profile bio"
              className="textarea"
              rows={3}
              maxLength={BIO_MAX_LEN}
              value={bioInput}
              onChange={(e) => setBioInput(e.target.value)}
              placeholder="Tell others what you build on SPRAY.LAND... (type : for emojis)"
            />
          </div>

          {submitError && (
            <div className="profile-error-banner" role="alert">
              <XeroIcon emoji="⚠️" size={14} /> {submitError}
            </div>
          )}

          <div className="username-onboarding-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSubmit}
              data-testid="onboarding-save-username-btn"
              style={{ flex: 1, justifyContent: 'center' }}
            >
              <XeroIcon emoji="🚀" size={15} />
              {saving ? 'Saving username...' : `Save @${normalized || 'username'} & Continue`}
            </button>
            {onLogout && (
              <button
                type="button"
                className="btn"
                onClick={onLogout}
                disabled={saving}
                title="Sign out of this account"
              >
                Sign Out
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
