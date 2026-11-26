import React, { useEffect, useRef, useState } from 'react';
import { api, setStoredToken } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import BrandLogo from './BrandLogo.jsx';
import XeroIcon from './XeroIcon.jsx';

export const DIRECT_LINK_INTRO_COPY =
  'Copy this land and hand it to your AI agent to add 3D models to it. Sign in with Google to make your own land for free.';

function GoogleMarkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.08 3.56-5.15 3.56-8.65z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.9l-3.87-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.72-4.95H1.28v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.28a12 12 0 0 0 0 10.8l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.94 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.6l4 3.1c.95-2.84 3.6-4.95 6.72-4.95z"
      />
    </svg>
  );
}

export default function DirectLinkIntroOverlay({
  config = null,
  onClose,
  onSignIn = null,
  onAuthSuccess = null
}) {
  const startedInsideCardRef = useRef(false);
  const gsiHostRef = useRef(null);
  const [gsiReady, setGsiReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!config?.googleClientId || typeof onAuthSuccess !== 'function' || !gsiHostRef.current) {
      return undefined;
    }
    let cancelled = false;
    function renderGsiButton() {
      if (cancelled || !window.google?.accounts?.id || !gsiHostRef.current) return;
      try {
        window.google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: async (response) => {
            setAuthBusy(true);
            setAuthError('');
            try {
              const data = await api.loginWithGoogle({ credential: response.credential });
              setStoredToken(data.token);
              onAuthSuccess(data.user);
            } catch (err) {
              setAuthError(err?.message || 'Google sign-in failed.');
            } finally {
              setAuthBusy(false);
            }
          }
        });
        gsiHostRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(gsiHostRef.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          width: 320
        });
        setGsiReady(true);
      } catch {
        setGsiReady(false);
      }
    }

    if (window.google?.accounts?.id) {
      renderGsiButton();
    } else {
      const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
      if (existing) {
        existing.addEventListener('load', renderGsiButton, { once: true });
      } else {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = renderGsiButton;
        document.head.appendChild(script);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [config?.googleClientId, onAuthSuccess]);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget && !startedInsideCardRef.current) {
      onClose?.();
    }
    startedInsideCardRef.current = false;
  }

  async function handleCopyLand() {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    if (!url) return;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2200);
    }
  }

  return (
    <div
      className="direct-link-intro-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="direct-link-intro-title"
      data-testid="direct-link-intro-backdrop"
      onPointerDown={(e) => {
        startedInsideCardRef.current = e.target !== e.currentTarget;
      }}
      onClick={handleBackdropClick}
    >
      <div
        className="direct-link-intro-card"
        data-testid="direct-link-intro-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="direct-link-intro-header">
          <h2
            id="direct-link-intro-title"
            className="direct-link-intro-title"
            aria-label="SPRAY.LAND"
          >
            <BrandLogo variant="lockup" height={30} />
          </h2>
          <button
            type="button"
            className="direct-link-intro-close-box"
            aria-label="Close intro"
            title="Close"
            data-testid="direct-link-intro-close-btn"
            onClick={() => onClose?.()}
          >
            ✕
          </button>
        </div>

        <p className="direct-link-intro-copy" data-testid="direct-link-intro-text">
          {DIRECT_LINK_INTRO_COPY}
        </p>

        {authError && (
          <div className="direct-link-intro-error" role="alert">
            ⚠️ {authError}
          </div>
        )}

        <div className="direct-link-intro-actions">
          <button
            type="button"
            className={`btn direct-link-intro-copy-btn ${copied ? 'is-copied' : ''}`}
            data-testid="direct-link-intro-copy-btn"
            onClick={handleCopyLand}
          >
            <XeroIcon emoji="📋" size={16} />
            <span>{copied ? 'Copied Land Link!' : 'Copy Land for Your Agent'}</span>
          </button>

          {config?.googleClientId && typeof onAuthSuccess === 'function' && (
            <div
              ref={gsiHostRef}
              className="direct-link-intro-gsi-host"
              style={{ display: gsiReady ? 'flex' : 'none' }}
            />
          )}

          {!gsiReady && typeof onSignIn === 'function' && (
            <button
              type="button"
              className="direct-link-intro-google-btn"
              data-testid="direct-link-intro-signin-btn"
              disabled={authBusy}
              onClick={() => onSignIn()}
            >
              <GoogleMarkIcon />
              <span>{authBusy ? 'Signing in…' : 'Sign in with Google'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
