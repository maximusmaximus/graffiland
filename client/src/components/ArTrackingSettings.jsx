import React, { useEffect, useRef, useState } from 'react';
import { useArSettings } from '../utils/arSettings.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import { isWebXrArSupported } from '../utils/webxrArSession.js';
import XeroIcon from './XeroIcon.jsx';

/**
 * User-configurable AR calibration & 6-DoF ARCore settings displayed inside
 * Profile ⚙️ Settings (and Account Settings). Lets users toggle 6-DoF ARCore
 * tracking and the pre-calibration 6-DoF prompt ON or OFF cleanly.
 */
export default function ArTrackingSettings({
  webxrSupported = null,
  webxrActive = false,
  onEnableWebxr = null,
  onDisableWebxr = null,
  compact = false
}) {
  const { settings, updateSettings } = useArSettings();
  const [detectedSupport, setDetectedSupport] = useState(
    typeof webxrSupported === 'boolean' ? webxrSupported : false
  );
  const [savedNotice, setSavedNotice] = useState('');
  const [xrBusy, setXrBusy] = useState(false);
  const savedTimerRef = useRef(null);

  useEffect(() => {
    if (typeof webxrSupported === 'boolean') {
      setDetectedSupport(webxrSupported);
      return undefined;
    }
    let cancelled = false;
    isWebXrArSupported().then((ok) => {
      if (!cancelled) setDetectedSupport(Boolean(ok));
    });
    return () => {
      cancelled = true;
    };
  }, [webxrSupported]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const flashSaved = (shortLabel, toastMsg) => {
    setSavedNotice(shortLabel);
    notifySettingsSaved(toastMsg);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      setSavedNotice('');
      savedTimerRef.current = null;
    }, 3000);
  };

  const handleToggleWebXr = async () => {
    const nextVal = !settings.useWebXr6Dof;
    updateSettings({ useWebXr6Dof: nextVal });
    flashSaved(
      nextVal ? '6-DoF ON' : '6-DoF OFF',
      nextVal
        ? '6-DoF ARCore calibration enabled.'
        : '6-DoF ARCore disabled — using standard sensor calibration.'
    );
    if (nextVal && detectedSupport && !webxrActive && typeof onEnableWebxr === 'function') {
      setXrBusy(true);
      try {
        await onEnableWebxr({ fromSettings: true });
      } catch {
        // Preference stays saved even if browser declines session start inside modal
      } finally {
        setXrBusy(false);
      }
    } else if (!nextVal && webxrActive && typeof onDisableWebxr === 'function') {
      setXrBusy(true);
      try {
        await onDisableWebxr();
      } catch {
        // ignore stop failure
      } finally {
        setXrBusy(false);
      }
    }
  };

  const handleTogglePreCalPrompt = () => {
    const nextVal = !settings.autoPreCalibrationPrompt;
    updateSettings({ autoPreCalibrationPrompt: nextVal });
    flashSaved(
      nextVal ? 'Prompt ON' : 'Prompt OFF',
      nextVal
        ? '6-DoF ARCore pre-calibration prompt turned ON.'
        : '6-DoF ARCore pre-calibration prompt turned OFF.'
    );
  };

  const supportLabel = webxrActive
    ? '6-DoF ARCore Active'
    : detectedSupport
    ? 'Supported on this device'
    : 'Not available on this browser';

  return (
    <div
      className={`unit-setting-card ar-settings-card ${compact ? 'is-compact' : ''}`}
      data-testid="ar-tracking-settings"
      data-webxr-enabled={settings.useWebXr6Dof ? 'true' : 'false'}
      data-webxr-prompt={settings.autoPreCalibrationPrompt ? 'true' : 'false'}
      data-webxr-supported={detectedSupport ? 'true' : 'false'}
    >
      <div className="unit-setting-head">
        <div className="unit-setting-title-wrap">
          <strong className="unit-setting-title">
            <XeroIcon emoji="✨" size={13} /> AR Calibration &amp; 6-DoF ARCore
          </strong>
          <span className="unit-setting-hint" data-testid="ar-settings-device-status">
            {supportLabel}
          </span>
        </div>
        {savedNotice && (
          <span
            className="unit-setting-saved-badge"
            data-testid="ar-settings-saved"
            role="status"
          >
            ✓ {savedNotice}
          </span>
        )}
      </div>

      <div className="ar-settings-toggle-list">
        <div className="ar-settings-toggle-row">
          <div className="ar-settings-toggle-copy">
            <strong>6-DoF ARCore Tracking</strong>
            <span>
              Use hardware 6-DoF ARCore when supported for faster, tighter calibration &amp; world
              lock.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.useWebXr6Dof}
            aria-label="Toggle 6-DoF ARCore Tracking"
            data-testid="setting-toggle-webxr-6dof"
            disabled={xrBusy}
            className={`btn btn-xs ar-setting-switch-btn ${
              settings.useWebXr6Dof ? 'btn-primary is-on' : ''
            }`}
            onClick={handleToggleWebXr}
          >
            {xrBusy ? '…' : settings.useWebXr6Dof ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="ar-settings-toggle-row">
          <div className="ar-settings-toggle-copy">
            <strong>Pre-Calibration 6-DoF Prompt</strong>
            <span>
              Show the 6-DoF ARCore prompt first before regular calibration on supported devices.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.autoPreCalibrationPrompt && settings.useWebXr6Dof}
            aria-label="Toggle Pre-Calibration 6-DoF Prompt"
            data-testid="setting-toggle-webxr-prompt"
            disabled={!settings.useWebXr6Dof}
            className={`btn btn-xs ar-setting-switch-btn ${
              settings.useWebXr6Dof && settings.autoPreCalibrationPrompt
                ? 'btn-primary is-on'
                : ''
            }`}
            onClick={handleTogglePreCalPrompt}
          >
            {settings.useWebXr6Dof && settings.autoPreCalibrationPrompt ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
    </div>
  );
}
