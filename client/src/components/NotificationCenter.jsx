import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import MeasurementUnitSetting from './MeasurementUnitSetting.jsx';

const CATEGORY_META = [
  {
    key: 'sculpture_on_land',
    icon: '🎨',
    label: 'New art on your lands & contributions',
    hint: 'Direct links whenever new art is minted on a land you own or contributed to.'
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
    label: 'Land expiry & archive alerts',
    hint: 'Alerts 3 hours before a land expires (72h agent limit or 28-day inactivity) and when archived.'
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
  const [settingsSavedNotice, setSettingsSavedNotice] = useState('');
  const settingsNoticeTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (settingsNoticeTimerRef.current) clearTimeout(settingsNoticeTimerRef.current);
    };
  }, []);

  const flashSettingsSaved = useCallback((msg, tone = 'success') => {
    setSettingsSavedNotice(msg);
    notifySettingsSaved(msg, { tone });
    if (settingsNoticeTimerRef.current) clearTimeout(settingsNoticeTimerRef.current);
    settingsNoticeTimerRef.current = setTimeout(() => {
      setSettingsSavedNotice('');
      settingsNoticeTimerRef.current = null;
    }, 3200);
  }, []);

  const containerRef = useRef(null);
  const seenIdsRef = useRef(new Set());
  const viewedWhileOpenIdsRef = useRef(new Set());
  const openRef = useRef(false);
  const initializedRef = useRef(false);

  const closePopover = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    if (viewedWhileOpenIdsRef.current.size > 0) {
      const dismissedIds = new Set(viewedWhileOpenIdsRef.current);
      viewedWhileOpenIdsRef.current.clear();
      setNotifications((prev) => prev.filter((n) => !dismissedIds.has(n.id)));
      setUnreadCount(0);
    }
  }, []);

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
        // Seen/read notifications are automatically dismissed and stay hidden; keep items seen
        // during the current open session visible until the user closes or acts on them.
        const visibleList = list.filter(
          (n) => !n.read || (openRef.current && viewedWhileOpenIdsRef.current.has(n.id))
        );
        const unseenCount = visibleList.filter(
          (n) => !n.read && !viewedWhileOpenIdsRef.current.has(n.id)
        ).length;
        setNotifications(visibleList);
        setUnreadCount(openRef.current ? 0 : unseenCount);
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
    viewedWhileOpenIdsRef.current = new Set();
    openRef.current = false;
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

  // Automatically mark displayed notifications as seen/read the moment the user views the inbox
  useEffect(() => {
    if (!open || activeTab !== 'inbox' || !user) return;
    const newlyViewedIds = notifications
      .filter((n) => !viewedWhileOpenIdsRef.current.has(n.id))
      .map((n) => n.id);
    if (newlyViewedIds.length === 0) return;
    for (const id of newlyViewedIds) {
      viewedWhileOpenIdsRef.current.add(id);
    }
    setUnreadCount(0);
    api.markNotificationsRead({ ids: newlyViewedIds }).catch(() => {});
  }, [open, activeTab, notifications, user]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        closePopover();
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closePopover();
    };
    document.addEventListener('pointerdown', onDocDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closePopover]);

  if (!user) return null;

  const handleToggleOpen = () => {
    if (open) {
      closePopover();
      return;
    }
    openRef.current = true;
    setOpen(true);
    setBrowserPerm(getBrowserNotificationPermission());
    loadNotifications({ silent: true });
    if (onOpenSettingsExternal) onOpenSettingsExternal();
  };

  const handleNotificationAction = async (item, overrideAction = null) => {
    const effective = overrideAction ? { ...item, ...overrideAction } : item;
    if (item?.id) {
      viewedWhileOpenIdsRef.current.add(item.id);
      api.markNotificationsRead({ ids: [item.id] }).catch(() => {});
    }
    if (onAction) {
      closePopover();
      onAction(effective);
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
      const cat = CATEGORY_META.find((c) => c.key === key);
      const label = cat ? cat.label : key === 'browser_push_enabled' ? 'Browser alerts' : 'Notification setting';
      flashSettingsSaved(`Saved: ${label} ${nextVal ? 'enabled' : 'disabled'}.`);
    } catch {
      setPreferences((prev) => ({ ...prev, [key]: !nextVal }));
      flashSettingsSaved('Could not save notification preference.', 'error');
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
      flashSettingsSaved('Saved: Browser notifications enabled.');
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
                onClick={closePopover}
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
                      Tap Mint Land to see the simple ways to mint (Mobile AR instant permanent land
                      or Desktop 3D plot).
                    </span>
                  </>
                ) : (
                  <>
                    <strong>
                      ⏳ {mintStatus.usedSlots}/{mintStatus.maxSlots} starter Desktop lands full
                    </strong>
                    <span>
                      Tap Mint Land to see how to mint right now in Mobile AR or unlock more slots.
                    </span>
                  </>
                )}
              </div>
              {onAction && (
                <button
                  type="button"
                  className="btn-xs notif-mint-banner-btn"
                  data-testid="notif-mint-land-btn"
                  onClick={() => {
                    closePopover();
                    onAction({
                      actionType: 'open_mint',
                      category: mintStatus.canMintDesktop
                        ? 'mint_slots_unlocked'
                        : 'mint_limit_reached'
                    });
                  }}
                >
                  🏗️ Mint Land
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
                    : notifications.length > 0
                    ? `${notifications.length} alert${notifications.length === 1 ? '' : 's'} · auto-dismisses once seen`
                    : 'No unread alerts'}
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
                </div>
              </div>

              {notifications.length === 0 ? (
                <div className="notif-empty">
                  <div className="notif-empty-icon">✨</div>
                  <strong>You’re all caught up!</strong>
                  <p>
                    You’ll see alerts with direct links here whenever new art is minted on a land
                    you own or contributed to, or when mint slots change.
                  </p>
                </div>
              ) : (
                <div className="notif-list">
                  {notifications.map((item) => {
                    const artHref =
                      item.meta?.sculptureUrl ||
                      (item.sculptureId ? `?sculpture=${encodeURIComponent(item.sculptureId)}` : '');
                    const parcelHref =
                      item.meta?.parcelUrl ||
                      (item.parcelId ? `?parcel=${encodeURIComponent(item.parcelId)}` : '');
                    const isApprovalLink = item.actionType === 'open_land_approval';
                    const isRepairAlert = Boolean(item.meta?.needsRepair);
                    const isArtLink =
                      !isApprovalLink &&
                      Boolean(artHref) &&
                      (item.actionType === 'open_sculpture' || Boolean(item.sculptureId));
                    return (
                      <div
                        key={item.id}
                        className={`notif-item severity-${item.severity || 'info'} ${
                          item.read ? 'is-read' : 'is-unread'
                        }`}
                        onClick={() => handleNotificationAction(item)}
                      >
                        <div className="notif-item-icon" aria-hidden="true">
                          {isApprovalLink
                            ? '✍️'
                            : isRepairAlert
                            ? '🔗'
                            : iconForCategory(item.category)}
                        </div>
                        <div className="notif-item-content">
                          <div className="notif-item-top">
                            <strong className="notif-item-title">{item.title}</strong>
                            <span className="notif-item-time">
                              {formatRelativeTime(item.createdAt)}
                            </span>
                          </div>
                          <p className="notif-item-msg">{item.message}</p>
                          {(item.actionLabel || isArtLink) && (
                            <div className="notif-item-actions">
                              {isArtLink ? (
                                <a
                                  href={artHref}
                                  className="btn-xs notif-action-btn notif-action-link"
                                  data-testid="notif-art-link"
                                  onClick={(e) => {
                                    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleNotificationAction(item, { actionType: 'open_sculpture' });
                                    }
                                  }}
                                >
                                  {item.actionLabel || 'View Art'} →
                                </a>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-xs notif-action-btn"
                                  data-testid={
                                    isApprovalLink
                                      ? 'notif-approve-land-btn'
                                      : isRepairAlert
                                      ? 'notif-repair-btn'
                                      : undefined
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleNotificationAction(item);
                                  }}
                                >
                                  {item.actionLabel} →
                                </button>
                              )}
                              {isArtLink && parcelHref && (
                                <a
                                  href={parcelHref}
                                  className="notif-secondary-link"
                                  data-testid="notif-land-link"
                                  onClick={(e) => {
                                    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleNotificationAction(item, { actionType: 'open_land' });
                                    }
                                  }}
                                >
                                  Open Land
                                </a>
                              )}
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
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="notif-settings-body">
              {settingsSavedNotice && (
                <div
                  className="settings-inline-saved notif-settings-saved-pill"
                  data-testid="notif-settings-saved"
                  role="status"
                >
                  ✅ {settingsSavedNotice}
                </div>
              )}
              <MeasurementUnitSetting compact />
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
