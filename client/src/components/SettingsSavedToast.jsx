import React, { useEffect, useRef, useState } from 'react';
import { subscribeSettingsSaved } from '../utils/toastNotice.js';

export default function SettingsSavedToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    const unsub = subscribeSettingsSaved((detail) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setToast(detail);
      timerRef.current = setTimeout(() => {
        setToast((cur) => (cur && cur.id === detail.id ? null : cur));
        timerRef.current = null;
      }, detail.durationMs || 3400);
    });
    return () => {
      unsub();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  if (!toast) return null;

  const icon =
    toast.tone === 'error'
      ? '⚠️'
      : toast.tone === 'warning'
      ? '⏳'
      : toast.tone === 'info'
      ? 'ℹ️'
      : '✅';

  return (
    <div
      className={`settings-saved-toast is-tone-${toast.tone || 'success'}`}
      role="status"
      aria-live="polite"
      data-testid="settings-saved-toast"
    >
      <span className="settings-saved-toast-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-saved-toast-text">{toast.message}</span>
      {toast.actionLabel && typeof toast.onAction === 'function' && (
        <button
          type="button"
          className="btn btn-xs btn-primary settings-saved-toast-action"
          data-testid="settings-toast-action-btn"
          onClick={() => {
            const fn = toast.onAction;
            setToast(null);
            fn();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button
        type="button"
        className="settings-saved-toast-close"
        aria-label="Dismiss notification"
        onClick={() => setToast(null)}
      >
        ×
      </button>
    </div>
  );
}
