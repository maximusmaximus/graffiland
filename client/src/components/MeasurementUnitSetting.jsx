import React, { useEffect, useRef, useState } from 'react';
import { useMeasurementUnits } from '../utils/measurementUnits.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import XeroIcon from './XeroIcon.jsx';

const UNIT_OPTIONS = [
  { id: 'auto', label: 'Auto (Location)', shortLabel: 'Auto' },
  { id: 'imperial', label: 'US (ft, mi)', shortLabel: 'ft / mi' },
  { id: 'metric', label: 'Metric (m, km)', shortLabel: 'm / km' }
];

/**
 * Reusable measurement unit preference control displayed inside user settings
 * (Profile, Notification Settings, and Account & Settings).
 */
export default function MeasurementUnitSetting({
  location = null,
  compact = false
}) {
  const { preference, unitSystem, detectedSystem, detectedSource, setPreference } =
    useMeasurementUnits(location);
  const [savedNotice, setSavedNotice] = useState('');
  const savedTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleSelectUnit = (opt) => {
    setPreference(opt.id);
    const msg = `Measurement units saved: ${opt.label}`;
    setSavedNotice(`Saved (${opt.shortLabel})`);
    notifySettingsSaved(msg);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      setSavedNotice('');
      savedTimerRef.current = null;
    }, 3000);
  };

  const detectedSummary =
    detectedSystem === 'imperial'
      ? detectedSource === 'gps'
        ? 'feet & miles (US location)'
        : 'feet & miles (locale)'
      : detectedSource === 'gps'
      ? 'meters & km (location)'
      : 'meters & km (locale)';

  return (
    <div
      className={`unit-setting-card ${compact ? 'is-compact' : ''}`}
      data-testid="measurement-unit-setting"
      data-unit-preference={preference}
      data-unit-system={unitSystem}
    >
      <div className="unit-setting-head">
        <div className="unit-setting-title-wrap">
          <strong className="unit-setting-title">
            <XeroIcon emoji="📏" size={13} /> Measurement Units
          </strong>
          <span className="unit-setting-hint" data-testid="measurement-unit-hint">
            {preference === 'auto'
              ? `Auto → ${detectedSummary}`
              : preference === 'imperial'
              ? 'Always showing feet, miles & sq ft'
              : 'Always showing meters, km & m²'}
          </span>
        </div>
        {savedNotice && (
          <span
            className="unit-setting-saved-badge"
            data-testid="unit-setting-saved"
            role="status"
          >
            ✓ {savedNotice}
          </span>
        )}
      </div>
      <div
        className="unit-setting-segmented"
        role="radiogroup"
        aria-label="Measurement units"
      >
        {UNIT_OPTIONS.map((opt) => {
          const active = preference === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`unit-pref-btn-${opt.id}`}
              className={`btn btn-xs unit-setting-btn ${active ? 'btn-primary' : ''}`}
              onClick={() => handleSelectUnit(opt)}
            >
              {compact ? opt.shortLabel : opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
