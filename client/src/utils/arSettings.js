import { useCallback, useEffect, useState } from 'react';

export const AR_SETTINGS_STORAGE_KEY = 'sprayland_ar_settings_v1';
export const AR_SETTINGS_CHANGED_EVENT = 'sprayland:ar-settings-changed';

export const DEFAULT_AR_SETTINGS = Object.freeze({
  /** Use 6-DoF ARCore / WebXR tracking for tighter calibration & world lock when supported. */
  useWebXr6Dof: true,
  /** Show the 6-DoF ARCore startup prompt by default before standard calibration on page load. */
  autoPreCalibrationPrompt: true
});

function normalizeArSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    useWebXr6Dof:
      typeof src.useWebXr6Dof === 'boolean' ? src.useWebXr6Dof : DEFAULT_AR_SETTINGS.useWebXr6Dof,
    autoPreCalibrationPrompt:
      typeof src.autoPreCalibrationPrompt === 'boolean'
        ? src.autoPreCalibrationPrompt
        : DEFAULT_AR_SETTINGS.autoPreCalibrationPrompt
  };
}

export function loadArSettings() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_AR_SETTINGS };
    }
    const raw = window.localStorage.getItem(AR_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AR_SETTINGS };
    return normalizeArSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AR_SETTINGS };
  }
}

export function saveArSettings(patch = {}) {
  const next = normalizeArSettings({
    ...loadArSettings(),
    ...(patch && typeof patch === 'object' ? patch : {})
  });
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(AR_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(AR_SETTINGS_CHANGED_EVENT, { detail: next }));
    } catch {
      // ignore event dispatch errors
    }
  }
  return next;
}

export function resetArSettings() {
  return saveArSettings(DEFAULT_AR_SETTINGS);
}

/**
 * Determines whether the pre-calibration 6-DoF ARCore message should appear
 * by default BEFORE standard sweep calibration when the user lands on the page.
 */
export function shouldShowWebXrPreCalibrationPrompt({
  webxrSupported = false,
  webxrActive = false,
  arSettings = DEFAULT_AR_SETTINGS,
  dismissed = false,
  calibrationReady = false,
  isWelcomeOpen = false
} = {}) {
  const cfg = normalizeArSettings(arSettings);
  if (!webxrSupported) return false;
  if (!cfg.useWebXr6Dof || !cfg.autoPreCalibrationPrompt) return false;
  if (webxrActive) return false;
  if (dismissed) return false;
  if (calibrationReady) return false;
  if (isWelcomeOpen) return false;
  return true;
}

/**
 * React hook subscribed to AR tracking & calibration settings across all modals and views.
 */
export function useArSettings() {
  const [settings, setSettings] = useState(() => loadArSettings());

  useEffect(() => {
    const sync = (ev) => {
      if (ev?.detail) {
        setSettings(normalizeArSettings(ev.detail));
      } else {
        setSettings(loadArSettings());
      }
    };
    const onStorage = (ev) => {
      if (!ev || ev.key === AR_SETTINGS_STORAGE_KEY) {
        setSettings(loadArSettings());
      }
    };
    window.addEventListener(AR_SETTINGS_CHANGED_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(AR_SETTINGS_CHANGED_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateSettings = useCallback((patch) => {
    const next = saveArSettings(patch);
    setSettings(next);
    return next;
  }, []);

  return {
    settings,
    updateSettings
  };
}
