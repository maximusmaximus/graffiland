import React, { useEffect, useRef, useState } from 'react';
import { api, setStoredToken } from '../utils/api.js';
import XeroIcon from './XeroIcon.jsx';

export default function GoogleLoginGate({ config, onSuccess, onClose, inline = false }) {
  const gsiRef = useRef(null);
  const [devEmail, setDevEmail] = useState('artist@graffiland.local');
  const [devName, setDevName] = useState('Street Voxel Artist');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!config?.googleClientId || !gsiRef.current) return;

    let cancelled = false;
    function renderGsi() {
      if (cancelled || !window.google?.accounts?.id || !gsiRef.current) return;
      window.google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async (response) => {
          setLoading(true);
          setError('');
          try {
            const data = await api.loginWithGoogle({ credential: response.credential });
            setStoredToken(data.token);
            onSuccess(data.user);
          } catch (err) {
            setError(err.message);
          } finally {
            setLoading(false);
          }
        }
      });
      gsiRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(gsiRef.current, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with'
      });
    }

    if (window.google?.accounts?.id) {
      renderGsi();
    } else {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = renderGsi;
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
  }, [config?.googleClientId, onSuccess]);

  async function handleDevGoogleLogin(emailOverride, nameOverride) {
    setLoading(true);
    setError('');
    try {
      const data = await api.loginWithGoogle({
        devProfile: {
          email: emailOverride || devEmail,
          name: nameOverride || devName
        }
      });
      setStoredToken(data.token);
      onSuccess(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const card = (
    <div className="modal-card" style={{ maxWidth: 440 }}>
      <div className="modal-header">
        <h2 className="modal-title">
          <XeroIcon emoji="🔐" size={24} />
          Sign in with Google
        </h2>
        {onClose && (
          <button className="btn" onClick={onClose} aria-label="Close">
            <XeroIcon emoji="❌" size={16} />
          </button>
        )}
      </div>

      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
        GRAFFILAND uses Google Sign-In exclusively. When you publish a 3D sculpture, gas is
        sponsored for you and the Robinhood Chain NFT is minted directly to your account wallet.
      </p>

      {error && (
        <div
          style={{
            background: 'rgba(255,77,109,0.14)',
            border: '1px solid rgba(255,77,109,0.45)',
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: 13,
            color: '#ffb3c1',
            marginBottom: 12
          }}
        >
          <XeroIcon emoji="⚠️" size={16} /> {error}
        </div>
      )}

      {config?.googleClientId ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div ref={gsiRef} />
          {loading && <div className="mono" style={{ fontSize: 12 }}>Verifying Google account...</div>}
        </div>
      ) : config?.allowDevGoogleAuth ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="badge gold" style={{ alignSelf: 'flex-start' }}>
            <XeroIcon emoji="⚙️" size={14} /> Local Google Dev Fallback (set GOOGLE_CLIENT_ID in .env for OAuth)
          </div>
          <div>
            <div className="field-label">
              <span>Google Email</span>
            </div>
            <input
              className="input"
              type="email"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              placeholder="you@gmail.com"
            />
          </div>
          <div>
            <div className="field-label">
              <span>Display Name</span>
            </div>
            <input
              className="input"
              type="text"
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="Your artist name"
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={loading}
            onClick={() => handleDevGoogleLogin()}
          >
            <XeroIcon emoji="🌐" size={18} />
            {loading ? 'Signing in...' : 'Continue with Google'}
          </button>
          <button
            className="btn"
            disabled={loading}
            onClick={() => handleDevGoogleLogin('admin@graffiland.local', 'GRAFFILAND Admin')}
          >
            <XeroIcon emoji="🛡️" size={16} />
            Quick Sign-In as Admin (Dev)
          </button>
        </div>
      ) : (
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>
          Google OAuth Client ID is not configured on the server.
        </p>
      )}
    </div>
  );

  if (inline) return card;

  return <div className="modal-backdrop">{card}</div>;
}
