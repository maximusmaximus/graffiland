import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import { api } from '../utils/api';
import { isPendingSculptureAction } from '../utils/pendingApprovalPreview.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import MeasurementUnitSetting from './MeasurementUnitSetting.jsx';
import XeroIcon from './XeroIcon.jsx';

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
    hint: `Next steps when your ${LAND_VOLUME_LIMITS.starterFreeHumanClaims} starter Desktop land slots are full.`
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

const NOTIF_CONTEXT_KEY = Symbol.for('sprayland.NotificationContext.v1');
const NotificationContext =
  (typeof globalThis !== 'undefined' && globalThis[NOTIF_CONTEXT_KEY]) ||
  (() => {
    const ctx = createContext(null);
    if (typeof globalThis !== 'undefined') globalThis[NOTIF_CONTEXT_KEY] = ctx;
    return ctx;
  })();

export function useNotificationCenter() {
  return useContext(NotificationContext);
}

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

function computePortalAnchorStyle(anchorEl, isMobile) {
  if (isMobile || typeof window === 'undefined' || !anchorEl?.getBoundingClientRect) {
    return null;
  }
  try {
    const rect = anchorEl.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const popW = Math.min(410, vw - 24);
    const top = Math.max(10, Math.min(rect.bottom + 8, Math.max(10, vh - 320)));
    const desiredRight = Math.max(12, vw - rect.right);
    const maxRight = Math.max(12, vw - popW - 12);
    const right = Math.min(desiredRight, maxRight);
    return {
      top: `${Math.round(top)}px`,
      right: `${Math.round(right)}px`
    };
  } catch {
    return null;
  }
}

function useNotificationEngine({
  user = null,
  variant = 'desktop',
  refreshSignal = 0,
  pendingApprovals = null,
  pendingApprovalsLoaded = true,
  onRequestPendingRefresh = null,
  onApprovalResolved = null,
  onAction = null,
  onOpenSettingsExternal = null,
  usePortal = true
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('inbox');
  const [rawNotifications, setRawNotifications] = useState([]);
  const [serverUnreadCount, setServerUnreadCount] = useState(0);
  const [fetchedPending, setFetchedPending] = useState([]);
  const [fetchedPendingLoaded, setFetchedPendingLoaded] = useState(false);
  const [resolvedRequestIds, setResolvedRequestIds] = useState(() => new Set());
  const [viewedWhileOpenIds, setViewedWhileOpenIds] = useState(() => new Set());
  const [approvalBusyId, setApprovalBusyId] = useState('');
  const [approvalErrors, setApprovalErrors] = useState({});
  const [approvalNotice, setApprovalNotice] = useState(null);
  const [preferences, setPreferences] = useState(DEFAULT_PREFS);
  const [mintStatus, setMintStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [savingPrefKey, setSavingPrefKey] = useState('');
  const [browserPerm, setBrowserPerm] = useState(getBrowserNotificationPermission);
  const [pushFeedback, setPushFeedback] = useState('');
  const [settingsSavedNotice, setSettingsSavedNotice] = useState('');
  const [anchorStyle, setAnchorStyle] = useState(null);
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
  const popoverRef = useRef(null);
  const seenIdsRef = useRef(new Set());
  const viewedWhileOpenIdsRef = useRef(new Set());
  const requestedPendingSyncIdsRef = useRef(new Set());
  const openRef = useRef(false);
  const initializedRef = useRef(false);
  const pendingApprovalsRef = useRef(pendingApprovals);
  pendingApprovalsRef.current = pendingApprovals;
  const onRequestPendingRefreshRef = useRef(onRequestPendingRefresh);
  onRequestPendingRefreshRef.current = onRequestPendingRefresh;

  const isMobile = variant === 'mobile';
  const hasPendingSync = Array.isArray(pendingApprovals)
    ? pendingApprovalsLoaded !== false
    : fetchedPendingLoaded;

  const livePendingList = useMemo(() => {
    const source = Array.isArray(pendingApprovals) ? pendingApprovals : fetchedPending;
    return (source || []).filter(
      (r) => r && r.id && r.status === 'pending' && !resolvedRequestIds.has(r.id)
    );
  }, [pendingApprovals, fetchedPending, resolvedRequestIds]);

  const pendingById = useMemo(() => {
    const map = new Map();
    for (const req of livePendingList) {
      map.set(req.id, req);
    }
    return map;
  }, [livePendingList]);

  // Reactively derive history & inbox lists so async pendingApprovals updates NEVER drop alerts
  const allNotifications = useMemo(
    () =>
      rawNotifications.filter((n) => {
        if (n.actionType === 'open_land_approval' && n.meta?.requestId) {
          if (resolvedRequestIds.has(n.meta.requestId)) return false;
          if (pendingById.has(n.meta.requestId)) return true;
          // While parent pending list is still loading, preserve unread approval alerts (no 0 flicker)
          return !hasPendingSync && !n.read;
        }
        return true;
      }),
    [rawNotifications, resolvedRequestIds, pendingById, hasPendingSync]
  );

  const notifications = useMemo(
    () =>
      allNotifications.filter((n) => {
        if (n.actionType === 'open_land_approval' && n.meta?.requestId) {
          if (resolvedRequestIds.has(n.meta.requestId)) return false;
          if (pendingById.has(n.meta.requestId)) return true;
          return !hasPendingSync && !n.read;
        }
        return !n.read || (open && viewedWhileOpenIds.has(n.id));
      }),
    [allNotifications, resolvedRequestIds, pendingById, hasPendingSync, open, viewedWhileOpenIds]
  );

  const closePopover = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setApprovalNotice(null);
    if (viewedWhileOpenIdsRef.current.size > 0) {
      const dismissedIds = new Set(viewedWhileOpenIdsRef.current);
      viewedWhileOpenIdsRef.current.clear();
      setViewedWhileOpenIds(new Set());
      setRawNotifications((prev) =>
        prev.map((n) => (dismissedIds.has(n.id) ? { ...n, read: true } : n))
      );
      setServerUnreadCount((c) => Math.max(0, c - dismissedIds.size));
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
        setRawNotifications([]);
        setServerUnreadCount(0);
        setFetchedPending([]);
        setFetchedPendingLoaded(false);
        setResolvedRequestIds(new Set());
        setViewedWhileOpenIds(new Set());
        setMintStatus(null);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const shouldFetchPending =
          !Array.isArray(pendingApprovalsRef.current) &&
          typeof api.listPendingSignatures === 'function';
        const [res, sigRes] = await Promise.all([
          api.getNotifications(40),
          shouldFetchPending
            ? api.listPendingSignatures().catch(() => null)
            : Promise.resolve(null)
        ]);
        const list = Array.isArray(res?.notifications) ? res.notifications : [];
        const prefs = res?.preferences ? { ...DEFAULT_PREFS, ...res.preferences } : DEFAULT_PREFS;
        if (sigRes && Array.isArray(sigRes.requests)) {
          const freshPending = sigRes.requests.filter((r) => r && r.id && r.status === 'pending');
          setFetchedPending(freshPending);
          setFetchedPendingLoaded(true);
          const freshIds = new Set(freshPending.map((r) => r.id));
          setResolvedRequestIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set();
            for (const id of prev) {
              if (freshIds.has(id)) next.add(id);
            }
            return next;
          });
        }
        const computedPageUnread = list.filter((n) => n && !n.read).length;
        const reportedUnread = Number.isFinite(Number(res?.unreadCount))
          ? Number(res.unreadCount)
          : computedPageUnread;
        setRawNotifications(list);
        setServerUnreadCount(Math.max(0, reportedUnread));
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

  // If /api/notifications discovers a brand-new unread approval before parent's next poll, request immediate sync
  useEffect(() => {
    if (!user || !hasPendingSync || typeof onRequestPendingRefreshRef.current !== 'function') {
      return;
    }
    const missingReqIds = [];
    for (const n of rawNotifications) {
      if (n.actionType !== 'open_land_approval' || n.read) continue;
      const reqId = String(n.meta?.requestId || '').trim();
      if (!reqId) continue;
      if (pendingById.has(reqId) || resolvedRequestIds.has(reqId)) continue;
      if (requestedPendingSyncIdsRef.current.has(reqId)) continue;
      requestedPendingSyncIdsRef.current.add(reqId);
      missingReqIds.push(reqId);
    }
    if (missingReqIds.length > 0) {
      onRequestPendingRefreshRef.current();
    }
  }, [user, hasPendingSync, rawNotifications, pendingById, resolvedRequestIds]);

  const userId = user?.id || '';
  const loadNotificationsRef = useRef(loadNotifications);
  loadNotificationsRef.current = loadNotifications;
  useEffect(() => {
    seenIdsRef.current = new Set();
    viewedWhileOpenIdsRef.current = new Set();
    requestedPendingSyncIdsRef.current = new Set();
    openRef.current = false;
    initializedRef.current = false;
    setViewedWhileOpenIds(new Set());
    if (!userId) {
      setOpen(false);
      setRawNotifications([]);
      setServerUnreadCount(0);
      setFetchedPending([]);
      setFetchedPendingLoaded(false);
      setMintStatus(null);
      return;
    }
    loadNotificationsRef.current({ silent: false });
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadNotificationsRef.current({ silent: true });
    }, 15000);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        loadNotificationsRef.current({ silent: true });
      }
    };
    const onFocus = () => {
      loadNotificationsRef.current({ silent: true });
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
      window.removeEventListener('focus', onFocus);
    };
  }, [userId]);

  useEffect(() => {
    if (user && refreshSignal > 0) {
      loadNotificationsRef.current({ silent: true });
    }
  }, [user, refreshSignal]);

  // Automatically mark displayed non-approval inbox notifications as seen/read when the user opens Inbox
  // (Pending approvals stay actionable & keep their bell badge count until approved or rejected!)
  useEffect(() => {
    if (!open || activeTab !== 'inbox' || !user) return;
    const newlyViewedIds = notifications
      .filter((n) => {
        if (viewedWhileOpenIdsRef.current.has(n.id)) return false;
        const pendingReqId = n.actionType === 'open_land_approval' ? n.meta?.requestId : '';
        if (pendingReqId && pendingById.has(pendingReqId)) return false;
        return !n.read;
      })
      .map((n) => n.id);
    if (newlyViewedIds.length === 0) return;
    for (const id of newlyViewedIds) {
      viewedWhileOpenIdsRef.current.add(id);
    }
    setViewedWhileOpenIds(new Set(viewedWhileOpenIdsRef.current));
    api.markNotificationsRead({ ids: newlyViewedIds }).catch(() => {});
  }, [open, activeTab, notifications, pendingById, user]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (popoverRef.current && popoverRef.current.contains(e.target)) return;
      if (containerRef.current && containerRef.current.contains(e.target)) return;
      if (e.target?.closest?.('[data-notif-trigger="1"]')) return;
      closePopover();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
      }
    };
    document.addEventListener('pointerdown', onDocDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, closePopover]);

  const openNotifications = useCallback(
    (preferredTab = '', anchorEl = null) => {
      if (preferredTab) setActiveTab(preferredTab);
      if (usePortal) {
        setAnchorStyle(computePortalAnchorStyle(anchorEl, isMobile));
      }
      openRef.current = true;
      setOpen(true);
      setBrowserPerm(getBrowserNotificationPermission());
      loadNotifications({ silent: true });
      if (onOpenSettingsExternal) onOpenSettingsExternal();
    },
    [usePortal, isMobile, loadNotifications, onOpenSettingsExternal]
  );

  const toggleNotifications = useCallback(
    (preferredTab = '', anchorEl = null) => {
      if (openRef.current && (!preferredTab || preferredTab === activeTab)) {
        closePopover();
        return;
      }
      openNotifications(preferredTab, anchorEl);
    },
    [activeTab, closePopover, openNotifications]
  );

  const handleNotificationAction = async (item, overrideAction = null) => {
    const effective = overrideAction ? { ...item, ...overrideAction } : item;
    const pendingReqId = item?.actionType === 'open_land_approval' ? item?.meta?.requestId : '';
    const isStillPendingApproval = Boolean(pendingReqId && pendingById.has(pendingReqId));
    if (item?.id && !item.isSyntheticPending && !isStillPendingApproval) {
      viewedWhileOpenIdsRef.current.add(item.id);
      setViewedWhileOpenIds(new Set(viewedWhileOpenIdsRef.current));
      api.markNotificationsRead({ ids: [item.id] }).catch(() => {});
    }
    if (onAction) {
      closePopover();
      onAction(effective);
    }
  };

  const handleInlineApprove = async (e, reqObj, item, options = {}) => {
    e.stopPropagation();
    const requestId = reqObj?.id || item?.meta?.requestId || '';
    if (!requestId || approvalBusyId) return;
    const autoFitScale = Boolean(options?.autoFitScale);
    setApprovalBusyId(requestId);
    setApprovalNotice(null);
    setApprovalErrors((prev) => {
      if (!prev[requestId]) return prev;
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
    try {
      let extSig = '';
      if (
        !autoFitScale &&
        reqObj?.canonicalMessage &&
        reqObj?.ownerAddress &&
        user?.walletAddress &&
        user.walletAddress.toLowerCase() !== reqObj.ownerAddress.toLowerCase() &&
        typeof window !== 'undefined' &&
        window.ethereum
      ) {
        extSig = await window.ethereum.request({
          method: 'personal_sign',
          params: [reqObj.canonicalMessage, reqObj.ownerAddress]
        });
      }
      const signPayload = {
        ...(extSig ? { signature: extSig } : {}),
        ...(autoFitScale ? { autoFitScale: true } : {})
      };
      const signRes = await api.mobileSignRequest(requestId, signPayload);
      const targetParcelId = String(
        signRes?.result?.sculpture?.parcelId ||
          signRes?.result?.parcel?.parcelId ||
          signRes?.request?.parcelId ||
          reqObj?.parcelId ||
          item?.parcelId ||
          ''
      ).trim();
      const targetSculptureId = String(
        signRes?.result?.sculpture?.id || reqObj?.sculptureId || item?.sculptureId || ''
      ).trim();
      const targetLandTitle = String(
        signRes?.request?.landDisplayName ||
          reqObj?.landDisplayName ||
          reqObj?.parcelName ||
          item?.meta?.landTitle ||
          ''
      ).trim();
      const executedNotif = signRes?.notification?.id ? signRes.notification : null;

      setResolvedRequestIds((prev) => new Set([...prev, requestId]));
      setFetchedPending((prev) => prev.filter((r) => r.id !== requestId));
      setRawNotifications((prev) => {
        const filtered = prev.filter(
          (n) =>
            n.id !== item?.id &&
            n.meta?.requestId !== requestId &&
            (!executedNotif || n.id !== executedNotif.id)
        );
        return executedNotif ? [executedNotif, ...filtered] : filtered;
      });
      if (item?.id && !item.isSyntheticPending) {
        api.markNotificationsRead({ ids: [item.id] }).catch(() => {});
      }
      const title =
        reqObj?.summaryTitle ||
        String(item?.title || 'Land Transaction').replace(/^✍️\s*Approval needed:\s*/i, '');
      const quotedTitle = title.includes('"') ? title : `"${title}"`;
      const fitSuffix = signRes?.autoFittedScale ? ` (auto-fitted to ${signRes.autoFittedScale}×)` : '';
      const msg = `Approved & minted ${quotedTitle}${fitSuffix}!`;
      setApprovalNotice({
        text: msg,
        parcelId: targetParcelId,
        landTitle: targetLandTitle,
        sculptureId: targetSculptureId,
        isApproved: true
      });
      const goLandItem = targetParcelId
        ? {
            id: executedNotif?.id || '',
            isSyntheticPending: !executedNotif?.id,
            parcelId: targetParcelId,
            sculptureId: targetSculptureId,
            actionType: 'open_land',
            actionLabel: 'Go to Land',
            meta: {
              parcelId: targetParcelId,
              parcelUrl: `?parcel=${encodeURIComponent(targetParcelId)}`,
              sculptureId: targetSculptureId,
              landTitle: targetLandTitle
            }
          }
        : null;
      notifySettingsSaved(
        msg,
        goLandItem && onAction
          ? {
              actionLabel: '📍 Go to Land →',
              onAction: () => {
                closePopover();
                onAction(goLandItem);
              }
            }
          : undefined
      );
      onApprovalResolved?.({
        type: 'approved',
        requestId,
        parcelId: targetParcelId,
        result: signRes
      });
    } catch (err) {
      const errMsg = err?.message || 'Could not approve transaction.';
      const maxSafe = Number(err?.data?.maxSafeScale ?? err?.data?.suggestedScale ?? 0);
      setApprovalErrors((prev) => ({
        ...prev,
        [requestId]: {
          message: errMsg,
          code: String(err?.data?.code || ''),
          maxSafeScale: Number.isFinite(maxSafe) && maxSafe > 0 ? maxSafe : null
        }
      }));
      notifySettingsSaved(`⚠️ ${errMsg}`, { tone: 'error', durationMs: 6500 });
    } finally {
      setApprovalBusyId('');
    }
  };

  const handleInlineReject = async (e, reqObj, item) => {
    e.stopPropagation();
    const requestId = reqObj?.id || item?.meta?.requestId || '';
    if (!requestId || approvalBusyId) return;
    setApprovalBusyId(requestId);
    setApprovalNotice(null);
    setApprovalErrors((prev) => {
      if (!prev[requestId]) return prev;
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
    try {
      await api.rejectSignatureRequest(requestId);
      setResolvedRequestIds((prev) => new Set([...prev, requestId]));
      setFetchedPending((prev) => prev.filter((r) => r.id !== requestId));
      setRawNotifications((prev) =>
        prev.filter((n) => n.id !== item?.id && n.meta?.requestId !== requestId)
      );
      if (item?.id && !item.isSyntheticPending) {
        api.markNotificationsRead({ ids: [item.id] }).catch(() => {});
      }
      const title =
        reqObj?.summaryTitle ||
        String(item?.title || 'Land Transaction').replace(/^✍️\s*Approval needed:\s*/i, '');
      const msg = `Rejected "${title}".`;
      setApprovalNotice({
        text: msg,
        parcelId: '',
        landTitle: '',
        sculptureId: '',
        isApproved: false
      });
      notifySettingsSaved(msg);
      onApprovalResolved?.({
        type: 'rejected',
        requestId,
        parcelId: reqObj?.parcelId || item?.parcelId || ''
      });
    } catch (err) {
      const errMsg = err?.message || 'Could not reject transaction.';
      setApprovalErrors((prev) => ({
        ...prev,
        [requestId]: { message: errMsg, code: '', maxSafeScale: null }
      }));
    } finally {
      setApprovalBusyId('');
    }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    const target = rawNotifications.find((n) => n.id === id);
    setRawNotifications((prev) => prev.filter((n) => n.id !== id));
    if (target && !target.read) setServerUnreadCount((c) => Math.max(0, c - 1));
    api.deleteNotification(id).catch(() => {});
  };

  const handleClearAllHistory = async (e) => {
    e?.stopPropagation?.();
    if (clearingAll || allNotifications.length === 0) return;
    setClearingAll(true);
    try {
      if (typeof api.clearNotifications === 'function') {
        await api.clearNotifications('all');
      }
      setRawNotifications([]);
      setServerUnreadCount(0);
      viewedWhileOpenIdsRef.current.clear();
      setViewedWhileOpenIds(new Set());
      notifySettingsSaved('Cleared notification history.');
    } catch {
      notifySettingsSaved('Could not clear notification history.', { tone: 'error' });
    } finally {
      setClearingAll(false);
    }
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
        'SPRAY.LAND Notifications Active',
        'You will be alerted when sculptures land on your parcels or new mint slots unlock.',
        'graffiland-push-enabled'
      );
    } catch {
      setPushFeedback('Could not save browser notification setting.');
    } finally {
      setSavingPrefKey('');
    }
  };

  // Combine persisted notifications with any live pending approvals whose notification was already read/dismissed
  const existingReqIdsInNotifs = new Set(
    notifications
      .filter((n) => n.actionType === 'open_land_approval' && n.meta?.requestId)
      .map((n) => n.meta.requestId)
  );
  const syntheticPendingNotifs = livePendingList
    .filter((req) => !existingReqIdsInNotifs.has(req.id))
    .map((req) => {
      const hasPreview = isPendingSculptureAction(req.action);
      const landTitle = req.landDisplayName || req.parcelName || 'your land';
      return {
        id: `pending-notif:${req.id}`,
        isSyntheticPending: true,
        read: false,
        category: 'land_activity',
        severity: 'action',
        title: `✍️ Approval needed: ${req.summaryTitle || 'Land Transaction'}`,
        message: hasPreview
          ? `${req.agentName || 'Your paired agent'} requested "${req.summaryTitle || req.action}" on "${landTitle}". Preview on the map or approve right here.`
          : `${req.agentName || 'Your paired agent'} requested "${req.summaryTitle || req.action}" on "${landTitle}".`,
        parcelId: req.parcelId || '',
        sculptureId: req.sculptureId || '',
        actionType: 'open_land_approval',
        actionLabel: hasPreview ? 'Preview on Land' : 'Review on Land',
        createdAt: req.createdAt,
        meta: {
          requestId: req.id,
          action: req.action,
          agentName: req.agentName || '',
          landTitle,
          hasSculpturePreview: hasPreview
        }
      };
    });

  const displayNotifications = [...syntheticPendingNotifs, ...notifications].filter((item) => {
    const reqId = item.actionType === 'open_land_approval' ? item.meta?.requestId : '';
    return !(reqId && resolvedRequestIds.has(reqId));
  });

  const historyDisplayNotifications = allNotifications.filter((item) => {
    const reqId = item.actionType === 'open_land_approval' ? item.meta?.requestId : '';
    return !(reqId && resolvedRequestIds.has(reqId));
  });

  const unreadRegularCount = useMemo(() => {
    const visibleUnreadRegular = notifications.filter((n) => {
      if (n.read || viewedWhileOpenIds.has(n.id)) return false;
      const pendingReqId = n.actionType === 'open_land_approval' ? n.meta?.requestId : '';
      if (pendingReqId && pendingById.has(pendingReqId)) return false; // counted via livePendingList
      return true;
    }).length;
    if (open && activeTab === 'inbox') return 0;
    const rawUnreadInPage = rawNotifications.filter((n) => !n.read).length;
    const extraBeyondPage =
      viewedWhileOpenIds.size === 0 ? Math.max(0, serverUnreadCount - rawUnreadInPage) : 0;
    return visibleUnreadRegular + extraBeyondPage;
  }, [
    notifications,
    viewedWhileOpenIds,
    pendingById,
    open,
    activeTab,
    rawNotifications,
    serverUnreadCount
  ]);

  // Bell badge ALWAYS reflects every unread notification + every unresolved pending approval
  const badgeCount = unreadRegularCount + livePendingList.length;

  const renderNotificationList = (items) => (
    <div className="notif-list">
      {items.map((item) => {
        const artHref =
          item.meta?.sculptureUrl ||
          (item.sculptureId ? `?sculpture=${encodeURIComponent(item.sculptureId)}` : '');
        const parcelHref =
          item.meta?.parcelUrl ||
          (item.parcelId ? `?parcel=${encodeURIComponent(item.parcelId)}` : '');
        const isApprovalLink = item.actionType === 'open_land_approval';
        const requestId = isApprovalLink ? String(item.meta?.requestId || '') : '';
        const liveReq = requestId ? pendingById.get(requestId) || null : null;
        const effectiveReq =
          liveReq ||
          (requestId
            ? {
                id: requestId,
                parcelId: item.parcelId || '',
                action: item.meta?.action || '',
                summaryTitle: String(item.title || '').replace(/^✍️\s*Approval needed:\s*/i, '')
              }
            : null);
        const hasSculpturePreview = Boolean(
          isApprovalLink &&
            (item.meta?.hasSculpturePreview ||
              isPendingSculptureAction(effectiveReq?.action || ''))
        );
        const isBusyApproval = Boolean(requestId && approvalBusyId === requestId);
        const itemApprovalErr = requestId ? approvalErrors?.[requestId] || null : null;
        const canAutoFit =
          itemApprovalErr?.code === 'exceeds_land_bounds' &&
          Number(itemApprovalErr?.maxSafeScale) >= 0.001;
        const isRepairAlert = Boolean(item.meta?.needsRepair);
        const isLandLink =
          !isApprovalLink && item.actionType === 'open_land' && Boolean(parcelHref);
        const isArtLink =
          !isApprovalLink &&
          !isLandLink &&
          Boolean(artHref) &&
          (item.actionType === 'open_sculpture' || Boolean(item.sculptureId));
        return (
          <div
            key={item.id}
            className={`notif-item severity-${item.severity || 'info'} ${
              item.read ? 'is-read' : 'is-unread'
            }`}
            data-request-id={requestId || undefined}
            onClick={() =>
              hasSculpturePreview && effectiveReq
                ? handleNotificationAction(item, {
                    actionType: 'preview_pending_sculpture',
                    pendingRequest: liveReq || effectiveReq
                  })
                : handleNotificationAction(item)
            }
          >
            <div className="notif-item-icon" aria-hidden="true">
              {isApprovalLink
                ? '✍️'
                : isRepairAlert
                ? '🔗'
                : item.meta?.approvedAndMinted
                ? '✨'
                : item.meta?.landMinted
                ? '🗺️'
                : iconForCategory(item.category)}
            </div>
            <div className="notif-item-content">
              <div className="notif-item-top">
                <strong className="notif-item-title">
                  {hasSculpturePreview && (
                    <span
                      className="map-preview-pill"
                      style={{ marginRight: 5, verticalAlign: 'middle' }}
                    >
                      Preview
                    </span>
                  )}
                  {item.title}
                </strong>
                <span className="notif-item-time">{formatRelativeTime(item.createdAt)}</span>
              </div>
              <p className="notif-item-msg">{item.message}</p>
              {itemApprovalErr?.message && (
                <div
                  className="approval-inline-error"
                  data-testid="notif-approval-error"
                  role="alert"
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginBottom: 6 }}
                >
                  <div className="approval-inline-error-msg">⚠️ {itemApprovalErr.message}</div>
                  {canAutoFit && effectiveReq && (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      data-testid="notif-autofit-approve-btn"
                      disabled={Boolean(approvalBusyId)}
                      onClick={(e) =>
                        handleInlineApprove(e, effectiveReq, item, {
                          autoFitScale: true
                        })
                      }
                    >
                      {isBusyApproval
                        ? 'Fitting…'
                        : `📐 Auto-Fit (${itemApprovalErr.maxSafeScale}×) & Approve`}
                    </button>
                  )}
                </div>
              )}
              {(item.actionLabel || isLandLink || isArtLink || Boolean(effectiveReq)) && (
                <div className="notif-item-actions">
                  {isApprovalLink && effectiveReq ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-xs btn-primary notif-inline-approve-btn"
                        data-testid="notif-inline-approve-btn"
                        disabled={Boolean(approvalBusyId)}
                        onClick={(e) => handleInlineApprove(e, effectiveReq, item)}
                      >
                        {isBusyApproval ? 'Approving…' : '✅ Approve'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-danger notif-inline-reject-btn"
                        data-testid="notif-inline-reject-btn"
                        disabled={Boolean(approvalBusyId)}
                        onClick={(e) => handleInlineReject(e, effectiveReq, item)}
                      >
                        {isBusyApproval ? '…' : '✕ Reject'}
                      </button>
                      {hasSculpturePreview && (
                        <button
                          type="button"
                          className="btn-xs notif-action-btn"
                          data-testid="notif-preview-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNotificationAction(item, {
                              actionType: 'preview_pending_sculpture',
                              pendingRequest: liveReq || effectiveReq
                            });
                          }}
                        >
                          👁️ Preview
                        </button>
                      )}
                      <button
                        type="button"
                        className="notif-secondary-link notif-secondary-btn"
                        data-testid="notif-approve-land-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNotificationAction(item);
                        }}
                      >
                        Open Land →
                      </button>
                    </>
                  ) : isLandLink ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-xs btn-primary notif-action-btn notif-go-land-btn"
                        data-testid="notif-go-to-land-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNotificationAction(item, { actionType: 'open_land' });
                        }}
                      >
                        📍 {item.actionLabel || 'Go to Land'} →
                      </button>
                      {artHref && (
                        <a
                          href={artHref}
                          className="notif-secondary-link"
                          data-testid="notif-art-link"
                          onClick={(e) => {
                            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                              e.preventDefault();
                              e.stopPropagation();
                              handleNotificationAction(item, {
                                actionType: 'open_sculpture'
                              });
                            }
                          }}
                        >
                          View Art
                        </a>
                      )}
                    </>
                  ) : isArtLink ? (
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
                  {!isApprovalLink && !isLandLink && parcelHref && (
                    <a
                      href={parcelHref}
                      className="notif-secondary-link notif-land-pill-link"
                      data-testid="notif-land-link"
                      onClick={(e) => {
                        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleNotificationAction(item, { actionType: 'open_land' });
                        }
                      }}
                    >
                      📍 Go to Land
                    </a>
                  )}
                </div>
              )}
            </div>
            {!item.isSyntheticPending && (
              <button
                type="button"
                className="notif-dismiss-btn"
                aria-label="Dismiss notification"
                title="Dismiss"
                onClick={(e) => handleDelete(e, item.id)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  const popoverNode =
    open && user ? (
      <div
        ref={popoverRef}
        className={`notif-popover glass-card ${isMobile ? 'notif-popover-mobile' : ''} ${
          usePortal ? 'notif-popover-portal' : ''
        }`}
        style={usePortal && anchorStyle ? anchorStyle : undefined}
        role="dialog"
        aria-label="Notifications"
        data-testid="notif-popover"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="notif-header">
          <div className="notif-header-title">
            <strong>🔔 Notifications</strong>
            {badgeCount > 0 && (
              <span className="notif-pill-unread">
                {badgeCount} {unreadRegularCount > 0 ? 'new' : 'pending'}
              </span>
            )}
          </div>
          <div className="notif-header-actions">
            <div className="notif-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'inbox'}
                data-testid="notif-tab-inbox"
                className={`notif-tab ${activeTab === 'inbox' ? 'active' : ''}`}
                onClick={() => setActiveTab('inbox')}
              >
                Inbox
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'history'}
                data-testid="notif-tab-history"
                className={`notif-tab ${activeTab === 'history' ? 'active' : ''}`}
                onClick={() => setActiveTab('history')}
              >
                History
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'settings'}
                data-testid="notif-tab-settings"
                className={`notif-tab ${activeTab === 'settings' ? 'active' : ''}`}
                onClick={() => setActiveTab('settings')}
              >
                <XeroIcon emoji="⚙️" size={16} /> Settings
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

        {activeTab === 'inbox' ? (
          <div className="notif-inbox-body">
            <div className="notif-inbox-toolbar">
              <span className="notif-toolbar-meta">
                {loading
                  ? 'Refreshing...'
                  : displayNotifications.length > 0
                  ? `${displayNotifications.length} alert${displayNotifications.length === 1 ? '' : 's'}`
                  : 'No unread alerts'}
              </span>
              <div className="notif-toolbar-btns">
                <button
                  type="button"
                  className="notif-link-btn"
                  data-testid="notif-refresh-btn"
                  disabled={loading}
                  onClick={() => loadNotifications({ silent: false })}
                  title="Refresh notifications"
                >
                  🔄 Refresh
                </button>
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

            {approvalNotice?.text && (
              <div
                className="settings-inline-saved notif-settings-saved-pill notif-approval-status-bar"
                data-testid="notif-approval-status"
                role="status"
                style={{ margin: '0 12px 8px' }}
              >
                <span className="notif-approval-status-text">✅ {approvalNotice.text}</span>
                {approvalNotice.isApproved && approvalNotice.parcelId && (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary notif-approved-go-land-btn"
                    data-testid="notif-approved-go-to-land-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNotificationAction(
                        {
                          id: '',
                          isSyntheticPending: true,
                          parcelId: approvalNotice.parcelId,
                          sculptureId: approvalNotice.sculptureId || '',
                          actionType: 'open_land',
                          actionLabel: 'Go to Land',
                          meta: {
                            parcelId: approvalNotice.parcelId,
                            parcelUrl: `?parcel=${encodeURIComponent(approvalNotice.parcelId)}`,
                            sculptureId: approvalNotice.sculptureId || '',
                            landTitle: approvalNotice.landTitle || ''
                          }
                        },
                        { actionType: 'open_land' }
                      );
                    }}
                  >
                    📍 Go to Land →
                  </button>
                )}
              </div>
            )}

            {displayNotifications.length === 0 ? (
              <div className="notif-empty">
                <div className="notif-empty-icon">✨</div>
                <strong>You’re all caught up!</strong>
                <p>
                  You’ll see alerts with direct links here whenever new art is minted on a land you
                  own or contributed to, or when mint slots change.
                </p>
                {historyDisplayNotifications.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-xs"
                    data-testid="notif-open-history-from-empty"
                    style={{ marginTop: 10 }}
                    onClick={() => setActiveTab('history')}
                  >
                    📜 View recent history ({historyDisplayNotifications.length})
                  </button>
                )}
              </div>
            ) : (
              renderNotificationList(displayNotifications)
            )}
          </div>
        ) : activeTab === 'history' ? (
          <div className="notif-inbox-body" data-testid="notif-history-body">
            <div className="notif-inbox-toolbar">
              <span className="notif-toolbar-meta">
                {loading
                  ? 'Refreshing...'
                  : historyDisplayNotifications.length > 0
                  ? `${historyDisplayNotifications.length} saved alert${
                      historyDisplayNotifications.length === 1 ? '' : 's'
                    }`
                  : 'No notification history'}
              </span>
              <div className="notif-toolbar-btns">
                <button
                  type="button"
                  className="notif-link-btn"
                  disabled={loading}
                  onClick={() => loadNotifications({ silent: false })}
                >
                  🔄 Refresh
                </button>
                {historyDisplayNotifications.length > 0 && (
                  <button
                    type="button"
                    className="notif-link-btn notif-clear-btn"
                    data-testid="notif-clear-all-btn"
                    disabled={clearingAll}
                    onClick={handleClearAllHistory}
                  >
                    {clearingAll ? 'Clearing…' : '🗑️ Clear All'}
                  </button>
                )}
              </div>
            </div>
            {historyDisplayNotifications.length === 0 ? (
              <div className="notif-empty">
                <div className="notif-empty-icon">📜</div>
                <strong>No past notifications</strong>
                <p>Recent alerts you’ve read stay listed here so you can reopen lands or clear them anytime.</p>
              </div>
            ) : (
              renderNotificationList(historyDisplayNotifications)
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
                  preferences.browser_push_enabled && browserPerm === 'granted' ? 'btn-primary' : ''
                }`}
                disabled={savingPrefKey === 'browser_push_enabled' || browserPerm === 'unsupported'}
                onClick={handleToggleBrowserPush}
              >
                {preferences.browser_push_enabled && browserPerm === 'granted' ? 'On ✓' : 'Turn On'}
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
    ) : null;

  const portalElement =
    usePortal && open && user && typeof document !== 'undefined' && document.body
      ? createPortal(
          <>
            <div
              className="notif-portal-backdrop"
              data-testid="notif-portal-backdrop"
              onClick={(e) => {
                e.stopPropagation();
                closePopover();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            />
            {popoverNode}
          </>,
          document.body
        )
      : null;

  const contextValue = useMemo(
    () => ({
      available: true,
      user,
      variant,
      open,
      activeTab,
      badgeCount,
      unreadCount: unreadRegularCount,
      pendingCount: livePendingList.length,
      historyCount: historyDisplayNotifications.length,
      mintStatus,
      openNotifications,
      closeNotifications: closePopover,
      toggleNotifications,
      refreshNotifications: () => loadNotifications({ silent: false })
    }),
    [
      user,
      variant,
      open,
      activeTab,
      badgeCount,
      unreadRegularCount,
      livePendingList.length,
      historyDisplayNotifications.length,
      mintStatus,
      openNotifications,
      closePopover,
      toggleNotifications,
      loadNotifications
    ]
  );

  return {
    containerRef,
    contextValue,
    badgeCount,
    open,
    toggleNotifications,
    popoverNode,
    portalElement
  };
}

export function NotificationProvider({
  user = null,
  variant = 'desktop',
  refreshSignal = 0,
  pendingApprovals = null,
  pendingApprovalsLoaded = true,
  onRequestPendingRefresh = null,
  onApprovalResolved = null,
  onAction = null,
  onOpenSettingsExternal = null,
  children
}) {
  const engine = useNotificationEngine({
    user,
    variant,
    refreshSignal,
    pendingApprovals,
    pendingApprovalsLoaded,
    onRequestPendingRefresh,
    onApprovalResolved,
    onAction,
    onOpenSettingsExternal,
    usePortal: true
  });

  return (
    <NotificationContext.Provider value={engine.contextValue}>
      {children}
      {engine.portalElement}
    </NotificationContext.Provider>
  );
}

export function GlobalNotificationBell({
  compact = false,
  variantOverride = '',
  className = '',
  testId = ''
}) {
  const ctx = useContext(NotificationContext);
  if (!ctx?.available || !ctx.user) return null;
  const isMobile = (variantOverride || ctx.variant) === 'mobile';
  const badgeCount = ctx.badgeCount || 0;
  return (
    <button
      type="button"
      data-notif-trigger="1"
      data-testid={testId || undefined}
      className={`notif-bell-btn ${
        compact
          ? 'notif-bell-compact'
          : isMobile
          ? 'hud-pill notif-bell-mobile'
          : 'btn-ghost'
      } ${badgeCount > 0 ? 'has-unread' : ''} ${ctx.open ? 'is-open' : ''} ${className}`.trim()}
      aria-label={`Notifications${badgeCount > 0 ? ` (${badgeCount} unread)` : ''}`}
      aria-expanded={ctx.open}
      aria-haspopup="dialog"
      title="Notifications & alert settings"
      onClick={(e) => {
        e.stopPropagation();
        ctx.toggleNotifications('', e.currentTarget);
      }}
    >
      <span aria-hidden="true">🔔</span>
      {badgeCount > 0 && (
        <span className="notif-count-badge" data-testid="notif-unread-badge">
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </button>
  );
}

function StandaloneNotificationCenter(props) {
  const { user = null, variant = 'desktop' } = props;
  const isMobile = variant === 'mobile';
  const engine = useNotificationEngine({
    ...props,
    usePortal: false
  });

  if (!user) return null;

  return (
    <div
      ref={engine.containerRef}
      className={`notif-center ${isMobile ? 'notif-center-mobile' : 'notif-center-desktop'}`}
    >
      <button
        type="button"
        data-notif-trigger="1"
        className={`notif-bell-btn ${isMobile ? 'hud-pill notif-bell-mobile' : 'btn-ghost'} ${
          engine.badgeCount > 0 ? 'has-unread' : ''
        } ${engine.open ? 'is-open' : ''}`}
        aria-label={`Notifications${engine.badgeCount > 0 ? ` (${engine.badgeCount} unread)` : ''}`}
        aria-expanded={engine.open}
        aria-haspopup="dialog"
        title="Notifications & alert settings"
        onClick={(e) => engine.toggleNotifications('', e.currentTarget)}
      >
        <span aria-hidden="true">🔔</span>
        {engine.badgeCount > 0 && (
          <span className="notif-count-badge" data-testid="notif-unread-badge">
            {engine.badgeCount > 99 ? '99+' : engine.badgeCount}
          </span>
        )}
      </button>
      {engine.popoverNode}
    </div>
  );
}

export default function NotificationCenter(props) {
  const ctx = useContext(NotificationContext);
  if (ctx?.available) {
    if (!ctx.user) return null;
    const isMobile = (props.variant || ctx.variant) === 'mobile';
    return (
      <div className={`notif-center ${isMobile ? 'notif-center-mobile' : 'notif-center-desktop'}`}>
        <GlobalNotificationBell variantOverride={props.variant} />
      </div>
    );
  }
  return <StandaloneNotificationCenter {...props} />;
}
