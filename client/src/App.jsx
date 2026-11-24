import React, { Suspense, lazy, useEffect, useState } from 'react';
import { parseParcelParamFromLocation } from '../../shared/landVolume.mjs';
import { parseProfileParamFromLocation } from '../../shared/profileRules.mjs';
import DirectLinkIntroOverlay from './components/DirectLinkIntroOverlay.jsx';
import FirstVisitWelcomeOverlay from './components/FirstVisitWelcomeOverlay.jsx';
import GoogleLoginGate from './components/GoogleLoginGate.jsx';
import SettingsSavedToast from './components/SettingsSavedToast.jsx';
import UsernameOnboardingModal from './components/UsernameOnboardingModal.jsx';
import XeroIcon from './components/XeroIcon.jsx';
import { api, getStoredToken, setStoredToken } from './utils/api.js';
import {
  DIRECT_LINK_INTRO_SEEN_KEY,
  loadBoolPreference,
  saveBoolPreference,
  TUTORIAL_SEEN_KEY,
  WELCOME_OVERLAY_SEEN_KEY
} from './utils/clipboard.js';
import { isMobileDevice } from './utils/device.js';

const DesktopHub = lazy(() => import('./components/DesktopHub.jsx'));
const MobileStudio = lazy(() => import('./components/MobileStudio.jsx'));

function isDirectLinkLocation() {
  try {
    const sp = new URLSearchParams(window.location.search);
    const parsedParcel = parseParcelParamFromLocation(
      window.location.search,
      window.location.pathname
    );
    const parsedProfile = parseProfileParamFromLocation(window.location.search);
    return Boolean(
      sp.has('sculpture') || parsedParcel.parcelId || parsedParcel.slug || parsedProfile
    );
  } catch {
    return false;
  }
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(() => isMobileDevice());
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    if (isDirectLinkLocation()) {
      return false;
    }
    return !loadBoolPreference(WELCOME_OVERLAY_SEEN_KEY, false);
  });
  const [directIntroOpen, setDirectIntroOpen] = useState(
    () => isDirectLinkLocation() && !loadBoolPreference(DIRECT_LINK_INTRO_SEEN_KEY, false)
  );
  const [directLoginOpen, setDirectLoginOpen] = useState(false);
  const [desktopAction, setDesktopAction] = useState(null);
  const [skipTutorialSignal, setSkipTutorialSignal] = useState(0);

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
            if (active) {
              setUser(me.user);
              if (me.user) setDirectIntroOpen(false);
            }
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

  const lazyFallback = (
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
      <span className="mono">Loading Workspace...</span>
    </div>
  );

  function dismissWelcome(dontShowAgain = true) {
    if (dontShowAgain) {
      saveBoolPreference(WELCOME_OVERLAY_SEEN_KEY, true);
    }
    setWelcomeOpen(false);
  }

  function dismissDirectIntro() {
    saveBoolPreference(DIRECT_LINK_INTRO_SEEN_KEY, true);
    setDirectIntroOpen(false);
    setSkipTutorialSignal((n) => n + 1);
  }

  const onboardingModal =
    user && user.needsUsernameOnboarding ? (
      <UsernameOnboardingModal
        user={user}
        onComplete={(updatedUser) => setUser(updatedUser)}
        onLogout={handleLogout}
      />
    ) : null;

  const showDirectIntro = directIntroOpen && !user && !welcomeOpen && !onboardingModal;

  const welcomeOverlay = welcomeOpen ? (
    <FirstVisitWelcomeOverlay
      isMobile={isMobile}
      onExplore={dismissWelcome}
      onConnectAgent={(dontShow) => {
        dismissWelcome(dontShow);
        setDesktopAction({ type: 'agent', ts: Date.now() });
      }}
      onOpenGuide={(dontShow) => {
        dismissWelcome(dontShow);
        setDesktopAction({ type: 'info', ts: Date.now() });
      }}
      onSkipToCamera={(dontShow) => {
        dismissWelcome(dontShow);
        saveBoolPreference(TUTORIAL_SEEN_KEY, true);
        setSkipTutorialSignal((n) => n + 1);
      }}
    />
  ) : null;

  const directLinkIntroOverlay = showDirectIntro ? (
    <DirectLinkIntroOverlay
      onClose={dismissDirectIntro}
      onSignIn={() => {
        dismissDirectIntro();
        setDirectLoginOpen(true);
      }}
    />
  ) : null;

  const directLoginModal =
    directLoginOpen && !user ? (
      <GoogleLoginGate
        config={config}
        backdropClassName="direct-link-login-backdrop"
        onSuccess={(loggedInUser) => {
          setUser(loggedInUser);
          setDirectLoginOpen(false);
        }}
        onClose={() => setDirectLoginOpen(false)}
      />
    ) : null;

  if (isMobile) {
    return (
      <>
        <Suspense fallback={lazyFallback}>
          <MobileStudio
            config={config}
            user={user}
            onUserUpdate={setUser}
            onLogout={handleLogout}
            isWelcomeOpen={
              welcomeOpen || showDirectIntro || directLoginOpen || Boolean(onboardingModal)
            }
            skipTutorialSignal={skipTutorialSignal}
          />
        </Suspense>
        {welcomeOverlay}
        {directLinkIntroOverlay}
        {directLoginModal}
        {onboardingModal}
        <SettingsSavedToast />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={lazyFallback}>
        <DesktopHub
          config={config}
          user={user}
          onUserUpdate={setUser}
          onLogout={handleLogout}
          welcomeRequest={desktopAction}
          onOpenWelcome={() => setWelcomeOpen(true)}
        />
      </Suspense>
      {welcomeOverlay}
      {directLinkIntroOverlay}
      {directLoginModal}
      {onboardingModal}
      <SettingsSavedToast />
    </>
  );
}
