import React, { Suspense, lazy, useEffect, useState } from 'react';
import { parseParcelParamFromLocation } from '../../shared/landVolume.mjs';
import { parseProfileParamFromLocation } from '../../shared/profileRules.mjs';
import DirectLinkIntroOverlay from './components/DirectLinkIntroOverlay.jsx';
import FirstVisitWelcomeOverlay from './components/FirstVisitWelcomeOverlay.jsx';
import GoogleLoginGate from './components/GoogleLoginGate.jsx';
import LaunchSplashOverlay from './components/LaunchSplashOverlay.jsx';
import MobilePortraitLockOverlay from './components/MobilePortraitLockOverlay.jsx';
import SettingsSavedToast from './components/SettingsSavedToast.jsx';
import UsernameOnboardingModal from './components/UsernameOnboardingModal.jsx';
import { api, getStoredToken, setStoredToken } from './utils/api.js';
import {
  DIRECT_LINK_INTRO_SEEN_KEY,
  loadBoolPreference,
  saveBoolPreference,
  TUTORIAL_SEEN_KEY,
  WELCOME_OVERLAY_SEEN_KEY
} from './utils/clipboard.js';
import { isMobileDevice } from './utils/device.js';
import {
  installMobileViewportLock,
  isMobileLandscapeOrientation
} from './utils/mobilePortraitLock.js';

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
  const [isLandscapeLocked, setIsLandscapeLocked] = useState(() =>
    isMobileDevice() ? isMobileLandscapeOrientation() : false
  );
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
    const syncViewportState = () => {
      const mobile = isMobileDevice();
      setIsMobile(mobile);
      setIsLandscapeLocked(mobile ? isMobileLandscapeOrientation() : false);
    };
    syncViewportState();
    window.addEventListener('resize', syncViewportState);
    window.addEventListener('orientationchange', syncViewportState);
    const screenOrient = window.screen?.orientation;
    screenOrient?.addEventListener?.('change', syncViewportState);
    return () => {
      window.removeEventListener('resize', syncViewportState);
      window.removeEventListener('orientationchange', syncViewportState);
      screenOrient?.removeEventListener?.('change', syncViewportState);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) return undefined;
    return installMobileViewportLock();
  }, [isMobile]);

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

  const lazyFallback = (
    <div
      style={{
        height: '100dvh',
        background: '#060a14'
      }}
    />
  );

  function dismissWelcome(dontShowAgain = true) {
    if (dontShowAgain) {
      saveBoolPreference(WELCOME_OVERLAY_SEEN_KEY, true);
    }
    if (isMobile) {
      saveBoolPreference(TUTORIAL_SEEN_KEY, true);
      setSkipTutorialSignal((n) => n + 1);
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
    />
  ) : null;

  const directLinkIntroOverlay = showDirectIntro ? (
    <DirectLinkIntroOverlay
      config={config}
      onClose={dismissDirectIntro}
      onAuthSuccess={(loggedInUser) => {
        setUser(loggedInUser);
        dismissDirectIntro();
      }}
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

  return (
    <>
      {loading ? (
        <div
          style={{
            height: '100dvh',
            background: '#060a14'
          }}
        />
      ) : isMobile ? (
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
      ) : (
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
      )}
      {!loading && welcomeOverlay}
      {!loading && directLinkIntroOverlay}
      {!loading && directLoginModal}
      {!loading && onboardingModal}
      {isMobile && isLandscapeLocked && <MobilePortraitLockOverlay />}
      <LaunchSplashOverlay appReady={!loading} />
      <SettingsSavedToast />
    </>
  );
}
