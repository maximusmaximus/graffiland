import React, { useEffect, useState } from 'react';
import DesktopHub from './components/DesktopHub.jsx';
import MobileStudio from './components/MobileStudio.jsx';
import XeroIcon from './components/XeroIcon.jsx';
import { api, getStoredToken, setStoredToken } from './utils/api.js';
import { isMobileDevice } from './utils/device.js';

export default function App() {
  const [config, setConfig] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(() => isMobileDevice());

  useEffect(() => {
    const onResize = () => setIsMobile(isMobileDevice());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      try {
        const cfg = await api.getConfig();
        if (!active) return;
        setConfig(cfg);

        if (getStoredToken()) {
          try {
            const me = await api.me();
            if (active) setUser(me.user);
          } catch {
            setStoredToken('');
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    boot();
    return () => {
      active = false;
    };
  }, []);

  function handleLogout() {
    setStoredToken('');
    setUser(null);
  }

  if (loading) {
    return (
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          background: '#07090f',
          color: '#f3f6ff'
        }}
      >
        <XeroIcon emoji="🧊" size={28} />
        <span className="mono">Loading GRAFFILAND...</span>
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileStudio
        config={config}
        user={user}
        onUserUpdate={setUser}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <DesktopHub
      config={config}
      user={user}
      onUserUpdate={setUser}
      onLogout={handleLogout}
    />
  );
}
