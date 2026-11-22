import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';

const CATEGORY_META = [
  {
    key: 'sculpture_on_land',
    icon: '🎨',
    label: 'Sculptures on your lands',
    hint: 'When anyone builds or publishes a sculpture on your Virtual Land.'
  },
  {
    key: 'mint_slots_unlocked',
    icon: '🎉',
    label: 'Minting unlocked & new slots',
    hint: 'Know right away when you can mint more Desktop lands or awaken a parcel.'
  },
  {
    key: 'mint_limit_reached',
    icon: '📱',
    label: 'Free mint cap & Mobile IRL tips',
    hint: 'Next steps when your 3 starter Desktop land slots are full.'
  },
  {
    key: 'land_expiring',
    icon: '⏳',
    label: 'Land lease expirations',
    hint: 'Reminders before a dormant land lease expires.'
  },
  {
    key: 'land_activity',
    icon: '💎',
    label: 'Sales, royalties & land activity',
    hint: 'Marketplace purchases, royalties, and quest updates on your lands.'
  }
];

const DEFAULT_PREFS = {
  sculpture_on_land: true,
  mint_slots_unlocked: true,
  mint_limit_reached: true,
  land_expiring: true,
  land_activity: true,
  browser_push_enabled: false
};

function formatRelativeTime(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 45) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function getBrowserNotificationPermission() {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return 'unsupported';
  }
  return window.Notification.permission || 'default';
}

function iconForCategory(category) {
  const found = CATEGORY_META.find((c) => c.key === category);
  return found ? found.icon : '🔔';
}

export default function NotificationCenter({
  user = null,
  variant = 'desktop',
  refreshSignal = 0,
  onAction = null,
  onOpenSettingsExternal = null
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('inbox');
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [preferences, setPreferences] = useState(DEFAULT_PREFS);
  const [mintStatus, setMintStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingPrefKey, setSavingPrefKey] = useState('');
  const [browserPerm, setBrowserPerm] = useState(getBrowserNotificationPermission);
  const [pushFeedback, setPushFeedback] = useState('');

  const containerRef = useRef(null);
  const seenIdsRef = useRef(new Set());
  const initializedRef = useRef(false);

  const fireBrowserNotification = useCallback((title, body, tag = '') => {
    try {
      if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
      if (window.Notification.permission !== 'granted') return;
      new window.Notification(title, {
        body,
        tag: tag || undefined,
        silent: false
      });
    } catch {
      // Ignore browser notification errors in restricted/mobile webviews
    }
  }, []);

  const loadNotifications = useCallback(
    async ({ silent = false } = {}) => {
      if (!user) {
        setNotifications([]);
        setUnreadCount(0);
        setMintStatus(null);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const res = await api.getNotifications(40);
        const list = Array.isArray(res?.notifications) ? res.notifications : [];
        const prefs = res?.preferences ? { ...DEFAULT_PREFS, ...res.preferences } : DEFAULT_PREFS;
        setNotifications(list);
        setUnreadCount(Number(res?.unreadCount || 0));
        setPreferences(prefs);
        if (res?.mintStatus) setMintStatus(res.mintStatus);

        if (initializedRef.current && prefs.browser_push_enabled) {
          const freshUnread = list.filter((n) => !n.read && !seenIdsRef.current.has(n.id));
          for (const item of freshUnread.slice(0, 3)) {
            fireBrowserNotification(item.title, item.message, item.id);
          }
        }
        for (const item of list) {
          seenIdsRef.current.add(item.id);
        }
        initializedRef.current = true;
      } catch {
        // Non-fatal background fetch failure
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [user, fireBrowserNotification]
  );

  const userId = user?.id || '';
  useEffect(() => {
    seenIdsRef.current = new Set();
    initializedRef.current = false;
    if (!userId) {
      setOpen(false);
      setNotifications([]);
      setUnreadCount(0);
      setMintStatus(null);
      return;
    }
    loadNotifications({ silent: false });
    const timer = window.setInterval(() => {
      loadNotifications({ silent: true });
    }, 30000);
    return () => window.clearInterval(timer);
  }, [userId, loadNotifications]);

  useEffect(() => {
    if (user && refreshSignal > 0) {
      loadNotifications({ silent: true });
    }
  }, [user, refreshSignal, loadNotifications]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  const handleToggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setBrowserPerm(getBrowserNotificationPermission());
      loadNotifications({ silent: true });
      if (onOpenSettingsExternal) onOpenSettingsExternal();
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markNotificationsRead({ markAll: true });
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true, readAt: n.readAt || new Date().toISOString() })));
      setUnreadCount(0);
    } catch {
      // ignore
    }
  };

  const handleNotificationAction = async (item) => {
    if (!item.read) {
      api.markNotificationsRead({ ids: [item.id] }).catch(() => {});
      setNotifications((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, read: true, readAt: new Date().toISOString() } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (onAction) {
      setOpen(false);
      onAction(item);
    }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    const target = notifications.find((n) => n.id === id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    if (target && !target.read) setUnreadCount((c) => Math.max(0, c - 1));
    api.deleteNotification(id).catch(() => {});
  };

  const handleTogglePref = async (key) => {
    const nextVal = !preferences[key];
    setSavingPrefKey(key);
    setPreferences((prev) => ({ ...prev, [key]: nextVal }));
    try {
      const res = await api.updateNotificationPreferences({ [key]: nextVal });
      if (res?.preferences) setPreferences({ ...DEFAULT_PREFS, ...res.preferences });
    } catch {
      setPreferences((prev) => ({ ...prev, [key]: !nextVal }));
    } finally {
      setSavingPrefKey('');
    }
  };

  const handleToggleBrowserPush = async () => {
    setPushFeedback('');
    const currentPerm = getBrowserNotificationPermission();
    setBrowserPerm(currentPerm);

    if (currentPerm === 'unsupported') {
      setPushFeedback('Browser notifications are not supported on this device/browser.');
      return;
    }

    if (preferences.browser_push_enabled) {
      await handleTogglePref('browser_push_enabled');
      setPushFeedback('Browser notifications paused.');
      return;
    }

    if (currentPerm === 'denied') {
      setPushFeedback('Blocked in browser settings — allow notifications for this site to turn them on.');
      return;
    }

    let grantedPerm = currentPerm;
    if (currentPerm !== 'granted' && typeof window.Notification?.requestPermission === 'function') {
      try {
        grantedPerm = await window.Notification.requestPermission();
        setBrowserPerm(grantedPerm);
      } catch {
        grantedPerm = 'denied';
      }
    }

    if (grantedPerm !== 'granted') {
      setPushFeedback('Permission was not granted — you will still get in-app alerts here.');
      return;
    }

    setSavingPrefKey('browser_push_enabled');
    try {
      const res = await api.updateNotificationPreferences({ browser_push_enabled: true });
      if (res?.preferences) setPreferences({ ...DEFAULT_PREFS, ...res.preferences });
      else setPreferences((prev) => ({ ...prev, browser_push_enabled: true }));
      setPushFeedback('Browser notifications enabled!');
      fireBrowserNotification(
        'GRAFFILAND Notifications Active',
        'You will be alerted when sculptures land on your parcels or new mint slots unlock.',
        'graffiland-push-enabled'
      );
    } catch {
      setPushFeedback('Could not save browser notification setting.');
    } finally {
      setSavingPrefKey('');
    }
  };

  const isMobile = variant === 'mobile';

  return (
    <div
      ref={containerRef}
      className={`notif-center ${isMobile ? 'notif-center-mobile' : 'notif-center-desktop'}`}
    >
      <button
        type="button"
        className={`notif-bell-btn ${isMobile ? 'hud-pill notif-bell-mobile' : 'btn-ghost'} ${
          unreadCount > 0 ? 'has-unread' : ''
        }`}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
        title="Notifications & alert settings"
        onClick={handleToggleOpen}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span className="notif-count-badge" data-testid="notif-unread-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`notif-popover glass-card ${isMobile ? 'notif-popover-mobile' : ''}`}
          role="dialog"
          aria-label="Notifications"
        >
          <div className="notif-header">
            <div className="notif-header-title">
              <strong>🔔 Notifications</strong>
              {unreadCount > 0 && <span className="notif-pill-unread">{unreadCount} new</span>}
            </div>
            <div className="notif-header-actions">
              <div className="notif-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'inbox'}
                  className={`notif-tab ${activeTab === 'inbox' ? 'active' : ''}`}
                  onClick={() => setActiveTab('inbox')}
                >
                  Inbox
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'settings'}
                  className={`notif-tab ${activeTab === 'settings' ? 'active' : ''}`}
                  onClick={() => setActiveTab('settings')}
                >
                  ⚙️ Settings
                </button>
              </div>
              <button
                type="button"
                className="notif-close-btn"
                aria-label="Close notifications"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
          </div>

          {mintStatus && (
            <div
              className={`notif-mint-banner ${
                mintStatus.canMintDesktop ? 'mint-open' : 'mint-full'
              }`}
            >
              <div className="notif-mint-banner-text">
                {mintStatus.canMintDesktop ? (
                  <>
                    <strong>
                      ✅ Mint Ready · {mintStatus.remainingSlots}/{mintStatus.maxSlots} free Desktop
                      slots open
                    </strong>
                    <span>
                      Draw and mint a new 3D Virtual Land anytime — or sculpt IRL on mobile!
                    </span>
                  </>
                ) : (
                  <>
                    <strong>
                      ⏳ {mintStatus.usedSlots}/{mintStatus.maxSlots} starter Desktop lands full
                    </strong>
                    <span>
                      Build a sculpture on one of your unbuilt lands to unlock another Desktop slot,
                      or sculpt in person with Mobile AR now.
                    </span>
                  </>
                )}
              </div>
              {onAction && (
                <button
                  type="button"
                  className="btn-xs notif-mint-banner-btn"
                  onClick={() => {
                    setOpen(false);
                    onAction({
                      actionType: mintStatus.canMintDesktop ? 'open_mint' : 'open_pair_mobile',
                      category: mintStatus.canMintDesktop
                        ? 'mint_slots_unlocked'
                        : 'mint_limit_reached'
                    });
                  }}
                >
                  {mintStatus.canMintDesktop ? '🏗️ Mint Land' : '📱 Pair Mobile'}
                </button>
              )}
            </div>
          )}

          {activeTab === 'inbox' ? (
            <div className="notif-inbox-body">
              <div className="notif-inbox-toolbar">
                <span className="notif-toolbar-meta">
                  {loading
                    ? 'Refreshing...'
                    : `${notifications.length} alert${notifications.length === 1 ? '' : 's'}`}
                </span>
                <div className="notif-toolbar-btns">
                  {!preferences.browser_push_enabled && browserPerm !== 'unsupported' && (
                    <button
                      type="button"
                      className="notif-link-btn"
                      onClick={() => setActiveTab('settings')}
                    >
                      🔔 Enable Browser Alerts
                    </button>
                  )}
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      className="notif-link-btn"
                      onClick={handleMarkAllRead}
                    >
                      Mark all read
                    </button>
                  )}
                </div>
              </div>

              {notifications.length === 0 ? (
                <div className="notif-empty">
                  <div className="notif-empty-icon">✨</div>
                  <strong>You’re all caught up!</strong>
                  <p>
                    You’ll see alerts here when someone builds a sculpture on your land, when a
                    sale happens, or whenever you unlock new minting capacity.
                  </p>
                </div>
              ) : (
                <div className="notif-list">
                  {notifications.map((item) => (
                    <div
                      key={item.id}
                      className={`notif-item severity-${item.severity || 'info'} ${
                        item.read ? 'is-read' : 'is-unread'
                      }`}
                      onClick={() => handleNotificationAction(item)}
                    >
                      <div className="notif-item-icon" aria-hidden="true">
                        {iconForCategory(item.category)}
                      </div>
                      <div className="notif-item-content">
                        <div className="notif-item-top">
                          <strong className="notif-item-title">{item.title}</strong>
                          <span className="notif-item-time">
                            {formatRelativeTime(item.createdAt)}
                          </span>
                        </div>
                        <p className="notif-item-msg">{item.message}</p>
                        {item.actionLabel && (
                          <div className="notif-item-actions">
                            <button
                              type="button"
                              className="btn-xs notif-action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleNotificationAction(item);
                              }}
                            >
                              {item.actionLabel} →
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="notif-dismiss-btn"
                        aria-label="Dismiss notification"
                        title="Dismiss"
                        onClick={(e) => handleDelete(e, item.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="notif-settings-body">
              <div className="notif-push-card">
                <div className="notif-push-info">
                  <strong>🔔 Browser Notifications</strong>
                  <span>
                    {browserPerm === 'unsupported'
                      ? 'Not supported in this browser.'
                      : browserPerm === 'denied'
                      ? 'Blocked in browser permissions — enable in site settings.'
                      : preferences.browser_push_enabled && browserPerm === 'granted'
                      ? 'Active — desktop/mobile browser popups will alert you in real time.'
                      : 'Get instant browser popups for land sculptures and unlocked mint slots.'}
                  </span>
                </div>
                <button
                  type="button"
                  className={`btn-xs ${
                    preferences.browser_push_enabled && browserPerm === 'granted'
                      ? 'btn-primary'
                      : ''
                  }`}
                  disabled={savingPrefKey === 'browser_push_enabled' || browserPerm === 'unsupported'}
                  onClick={handleToggleBrowserPush}
                >
                  {preferences.browser_push_enabled && browserPerm === 'granted'
                    ? 'On ✓'
                    : 'Turn On'}
                </button>
              </div>
              {pushFeedback && <div className="notif-push-feedback">{pushFeedback}</div>}

              <div className="notif-pref-list">
                {CATEGORY_META.map((cat) => {
                  const enabled = Boolean(preferences[cat.key]);
                  return (
                    <label key={cat.key} className="notif-pref-row">
                      <div className="notif-pref-copy">
                        <strong>
                          {cat.icon} {cat.label}
                        </strong>
                        <span>{cat.hint}</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={savingPrefKey === cat.key}
                        onChange={() => handleTogglePref(cat.key)}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
