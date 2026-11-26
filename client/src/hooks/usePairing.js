import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE } from '../utils/api.js';
import { getWsUrl } from '../utils/device.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import { recordUserAction } from '../utils/userHistory.js';

/**
 * Manages desktop WebSocket live-mirror pairing, robust MCP agent pairing lifecycle,
 * real-time mobile signature notifications, and delegated publish polling.
 */
export function usePairing({
  user,
  voxels,
  voxelsRef,
  rawOrientationRef,
  yawOffsetRef,
  showTemporaryHint,
  onOpenLogin,
  onDesktopCommand,
  onDelegatedPublishExecuted,
  onSignatureExecuted = null,
  onConnectionStateChange = null,
  onNavigateToLand = null
}) {
  const wsRef = useRef(null);
  const onDesktopCommandRef = useRef(onDesktopCommand);
  const onDelegatedPublishRef = useRef(onDelegatedPublishExecuted);
  const onSignatureExecutedRef = useRef(onSignatureExecuted);
  const showHintRef = useRef(showTemporaryHint);
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  const onNavigateToLandRef = useRef(onNavigateToLand);
  const activePairCodeRef = useRef('');
  const hadDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const pairPingTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    onDesktopCommandRef.current = onDesktopCommand;
    onDelegatedPublishRef.current = onDelegatedPublishExecuted;
    onSignatureExecutedRef.current = onSignatureExecuted;
    showHintRef.current = showTemporaryHint;
    onConnectionStateChangeRef.current = onConnectionStateChange;
    onNavigateToLandRef.current = onNavigateToLand;
  }, [
    onDesktopCommand,
    onDelegatedPublishExecuted,
    onSignatureExecuted,
    showTemporaryHint,
    onConnectionStateChange,
    onNavigateToLand
  ]);

  const [pairOpen, setPairOpen] = useState(false);
  const [pairCodeInput, setPairCodeInput] = useState(() => {
    if (typeof window === 'undefined') return '';
    const p = new URLSearchParams(window.location.search).get('pair') || '';
    return p.toUpperCase();
  });
  const [pairedCode, setPairedCode] = useState('');
  const [pairError, setPairError] = useState('');

  const [mcpPairingsState, setMcpPairingsState] = useState({
    mcpActive: false,
    activePairing: null,
    latestPairing: null,
    needsRepair: false,
    expiringSoon: false,
    repairReason: '',
    pairings: []
  });
  const [mcpPairBusy, setMcpPairBusy] = useState(false);
  const [mcpPairNotice, setMcpPairNotice] = useState('');
  const [repairNotice, setRepairNotice] = useState(null);
  const notifiedRepairKeysRef = useRef(new Set());
  const [pendingSignatures, setPendingSignatures] = useState([]);
  const [signatureHistory, setSignatureHistory] = useState([]);
  const [pendingSigBusyId, setPendingSigBusyId] = useState('');
  const [pendingSigErrors, setPendingSigErrors] = useState({});
  const [agentPublishPrompt, setAgentPublishPrompt] = useState(null);

  useEffect(() => {
    if (wsRef.current?.readyState === 1 && pairedCode) {
      wsRef.current.send(JSON.stringify({ type: 'voxels_sync', voxels }));
    }
  }, [voxels, pairedCode]);

  const refreshMcpPairings = useCallback(async () => {
    if (!user?.id) {
      setMcpPairingsState({
        mcpActive: false,
        activePairing: null,
        latestPairing: null,
        needsRepair: false,
        expiringSoon: false,
        repairReason: '',
        pairings: []
      });
      return null;
    }
    try {
      const res = await api.listMcpPairings();
      setMcpPairingsState(res);
      if (res?.needsRepair || res?.expiringSoon) {
        const code = res.latestPairing?.code || res.activePairing?.code || '';
        const reason = res.needsRepair ? res.repairReason || 'expired' : 'expiring_soon';
        const dedupeKey = `mcp:${reason}:${code}`;
        const msg =
          reason === 'expiring_soon'
            ? `Your AI agent pairing (${code || 'MCP'}) expires soon — re-pair to stay connected.`
            : `Your AI agent pairing (${code || 'MCP'}) ${
                reason === 'disconnected' ? 'was disconnected' : 'expired'
              } — tap Pair to re-pair.`;
        setRepairNotice((prev) =>
          prev && prev.kind === 'desktop' ? prev : { kind: 'mcp', reason, code, message: msg }
        );
        if (!notifiedRepairKeysRef.current.has(dedupeKey)) {
          notifiedRepairKeysRef.current.add(dedupeKey);
          notifySettingsSaved(`🔗 Re-pair needed: ${msg}`, { tone: 'warning', durationMs: 6000 });
          showHintRef.current?.(`🔗 ${msg}`);
        }
      } else if (res?.mcpActive) {
        setRepairNotice((prev) => (prev?.kind === 'mcp' ? null : prev));
      }
      return res;
    } catch {
      return null;
    }
  }, [user?.id]);

  const refreshPendingSignatures = useCallback(async () => {
    if (!user?.id) {
      setPendingSignatures([]);
      setSignatureHistory([]);
      return [];
    }
    try {
      const res = await api.listPendingSignatures({ includeHistory: true });
      const list = res.requests || [];
      setPendingSignatures(list);
      if (Array.isArray(res.history)) {
        setSignatureHistory(res.history);
      }
      return list;
    } catch {
      return [];
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setMcpPairingsState({ mcpActive: false, activePairing: null, pairings: [] });
      setPendingSignatures([]);
      setSignatureHistory([]);
      return undefined;
    }
    refreshMcpPairings();
    refreshPendingSignatures();
    const timer = setInterval(() => {
      refreshMcpPairings();
      refreshPendingSignatures();
    }, 4500);
    return () => clearInterval(timer);
  }, [user?.id, refreshMcpPairings, refreshPendingSignatures]);

  useEffect(() => {
    const activeCode = mcpPairingsState.activePairing?.code;
    if (!user?.id || !activeCode) return undefined;

    let closed = false;
    let ws = null;
    let retryTimer = null;
    let pingTimer = null;

    const openMcpSocket = () => {
      if (closed) return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      try {
        const nextWs = new WebSocket(getWsUrl());
        ws = nextWs;
        nextWs.onopen = () => {
          if (closed || ws !== nextWs) return;
          nextWs.send(JSON.stringify({ type: 'subscribe_mcp', pairingCode: activeCode }));
          clearInterval(pingTimer);
          pingTimer = setInterval(() => {
            if (!closed && ws === nextWs && nextWs.readyState === 1) {
              try {
                nextWs.send(JSON.stringify({ type: 'ping' }));
              } catch {
                // ignore
              }
            }
          }, 20000);
        };
        nextWs.onmessage = (ev) => {
          if (closed || ws !== nextWs) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'pong') return;
            if (msg.type === 'signature_request') {
              refreshPendingSignatures();
              showHintRef.current?.(
                `🔔 Agent requests signature for ${msg.request?.parcelId || 'your land'}`
              );
            }
          } catch {
            // ignore malformed frames
          }
        };
        nextWs.onclose = () => {
          if (closed || ws !== nextWs) return;
          clearInterval(pingTimer);
          pingTimer = null;
          ws = null;
          if (
            typeof navigator !== 'undefined' &&
            navigator.onLine === false
          ) {
            return;
          }
          clearTimeout(retryTimer);
          retryTimer = setTimeout(openMcpSocket, 3500);
        };
      } catch {
        // fallback to polling
      }
    };

    const onReconnectEvent = () => {
      if (closed) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      openMcpSocket();
    };

    openMcpSocket();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onReconnectEvent);
      window.addEventListener('pageshow', onReconnectEvent);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onReconnectEvent);
    }
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onReconnectEvent);
        window.removeEventListener('pageshow', onReconnectEvent);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onReconnectEvent);
      }
      try {
        if (ws) {
          ws.onclose = null;
          ws.onmessage = null;
          ws.close();
        }
      } catch {
        // ignore
      }
    };
  }, [user?.id, mcpPairingsState.activePairing?.code, refreshPendingSignatures]);

  useEffect(() => {
    const reqId = agentPublishPrompt?.requestId;
    if (!reqId) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await api.getSignatureRequest(reqId, agentPublishPrompt.pairingCode);
        const reqObj = res?.request;
        if (!cancelled && reqObj?.status === 'executed' && reqObj?.result?.sculpture) {
          setAgentPublishPrompt(null);
          refreshPendingSignatures();
          onDelegatedPublishRef.current?.(reqObj.result);
        }
      } catch {
        // keep polling
      }
    };
    const timer = setInterval(poll, 2200);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentPublishPrompt?.requestId, agentPublishPrompt?.pairingCode, refreshPendingSignatures]);

  const connectPairCode = useCallback(
    (codeToJoin, { isReconnect = false } = {}) => {
      const clean = String(codeToJoin || '').trim().toUpperCase();
      if (!clean) return;
      setPairError('');
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      clearInterval(pairPingTimerRef.current);
      pairPingTimerRef.current = null;
      activePairCodeRef.current = clean;

      const prevWs = wsRef.current;
      if (prevWs) {
        prevWs.onopen = null;
        prevWs.onmessage = null;
        prevWs.onclose = null;
        prevWs.onerror = null;
        try {
          prevWs.close();
        } catch {
          // ignore
        }
      }

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws || unmountedRef.current) return;
        ws.send(JSON.stringify({ type: 'join_pair', code: clean }));
        clearInterval(pairPingTimerRef.current);
        pairPingTimerRef.current = setInterval(() => {
          if (wsRef.current === ws && !unmountedRef.current && ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ type: 'ping' }));
            } catch {
              // ignore
            }
          }
        }, 20000);
      };

      ws.onmessage = (ev) => {
        if (wsRef.current !== ws || unmountedRef.current) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'pong' || msg.type === 'desktop_reconnecting') return;
          if (msg.type === 'pair_connected') {
            reconnectAttemptRef.current = 0;
            const status = isReconnect || hadDisconnectRef.current ? 'reconnected' : 'connected';
            hadDisconnectRef.current = false;
            activePairCodeRef.current = msg.code || clean;
            setPairedCode(msg.code);
            setPairOpen(false);
            setRepairNotice((prev) => (prev?.kind === 'desktop' ? null : prev));
            ws.send(JSON.stringify({ type: 'voxels_sync', voxels: voxelsRef.current }));
            onConnectionStateChangeRef.current?.({
              kind: 'desktop',
              status,
              code: msg.code || clean
            });
          } else if (msg.type === 'pair_error') {
            activePairCodeRef.current = '';
            setPairError(msg.error);
            const errMsg = msg.error || 'Desktop pairing code expired or invalid — please re-pair.';
            setRepairNotice({
              kind: 'desktop',
              reason: 'pair_error',
              code: clean,
              message: `${errMsg} Scan a fresh QR code on Desktop to re-pair.`
            });
            notifySettingsSaved(`🔗 Re-pair needed: ${errMsg}`, { tone: 'warning', durationMs: 6000 });
            showHintRef.current?.(`🔗 ${errMsg}`);
          } else if (msg.type === 'pair_ended') {
            activePairCodeRef.current = '';
            hadDisconnectRef.current = true;
            setPairedCode('');
            const endedMsg = 'Desktop pairing ended — scan QR or enter a new code to re-pair.';
            setRepairNotice({
              kind: 'desktop',
              reason: 'pair_ended',
              code: clean,
              message: endedMsg
            });
            notifySettingsSaved(`🔗 ${endedMsg}`, { tone: 'warning', durationMs: 6000 });
            showHintRef.current?.(`🔗 ${endedMsg}`);
            onConnectionStateChangeRef.current?.({
              kind: 'desktop',
              status: 'ended',
              code: clean
            });
          } else if (msg.type === 'desktop_command') {
            if (msg.action === 'recenter' && rawOrientationRef.current) {
              yawOffsetRef.current = rawOrientationRef.current.alpha;
            } else {
              onDesktopCommandRef.current?.(msg);
            }
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws || unmountedRef.current) return;
        clearInterval(pairPingTimerRef.current);
        pairPingTimerRef.current = null;
        wsRef.current = null;
        setPairedCode('');
        hadDisconnectRef.current = true;
        onConnectionStateChangeRef.current?.({
          kind: 'desktop',
          status: 'disconnected',
          code: clean,
          unexpected: Boolean(activePairCodeRef.current === clean)
        });
        if (activePairCodeRef.current === clean) {
          const delays = [1500, 3000, 5000, 10000, 15000, 20000];
          const delay = delays[reconnectAttemptRef.current];
          if (
            delay != null &&
            (typeof navigator === 'undefined' || navigator.onLine !== false) &&
            (typeof document === 'undefined' || document.visibilityState !== 'hidden')
          ) {
            reconnectAttemptRef.current += 1;
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = setTimeout(() => {
              if (!unmountedRef.current && activePairCodeRef.current === clean) {
                connectPairCode(clean, { isReconnect: true });
              }
            }, delay);
          } else if (delay == null) {
            const lostMsg = 'Desktop live pairing lost — scan QR or enter a new code to re-pair.';
            setRepairNotice({
              kind: 'desktop',
              reason: 'reconnect_failed',
              code: clean,
              message: lostMsg
            });
            notifySettingsSaved(`🔗 ${lostMsg}`, { tone: 'warning', durationMs: 6000 });
            showHintRef.current?.(`🔗 ${lostMsg}`);
          }
        }
      };
    },
    [rawOrientationRef, voxelsRef, yawOffsetRef]
  );

  useEffect(() => {
    unmountedRef.current = false;
    const urlPair = typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('pair') || '').toUpperCase()
      : '';
    if (urlPair && urlPair.length === 6) {
      connectPairCode(urlPair);
    }

    const tryAutoReconnect = () => {
      if (unmountedRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const code = activePairCodeRef.current;
      if (!code) return;
      const state = wsRef.current?.readyState;
      if (state === 0 || state === 1) return;
      reconnectAttemptRef.current = 0;
      connectPairCode(code, { isReconnect: true });
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', tryAutoReconnect);
      window.addEventListener('pageshow', tryAutoReconnect);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', tryAutoReconnect);
    }

    return () => {
      unmountedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      clearInterval(pairPingTimerRef.current);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', tryAutoReconnect);
        window.removeEventListener('pageshow', tryAutoReconnect);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', tryAutoReconnect);
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, [connectPairCode]);

  const handleCreateMcpPairing = useCallback(async () => {
    if (!user) {
      onOpenLogin?.();
      return;
    }
    setMcpPairBusy(true);
    setMcpPairNotice('');
    try {
      const res = await api.createMcpPairing({ apiOrigin: API_BASE || window.location.origin });
      await refreshMcpPairings();
      const copied = res.ownerPrompt ? await copyToClipboard(res.ownerPrompt) : false;
      setRepairNotice((prev) => (prev?.kind === 'mcp' ? null : prev));
      setMcpPairNotice(
        `Generated ${res.pairing?.code}${copied ? ' & copied full Owner MCP Prompt!' : ''}`
      );
      const status = hadDisconnectRef.current ? 'reconnected' : 'connected';
      hadDisconnectRef.current = false;
      onConnectionStateChangeRef.current?.({
        kind: 'mcp',
        status,
        code: res.pairing?.code || ''
      });
    } catch (err) {
      setMcpPairNotice(err.message || 'Failed to generate pairing code');
    } finally {
      setMcpPairBusy(false);
    }
  }, [user, onOpenLogin, refreshMcpPairings]);

  const handleDisconnectMcpPairing = useCallback(
    async (code) => {
      setMcpPairBusy(true);
      setMcpPairNotice('');
      try {
        await api.disconnectMcpPairing(code);
        await refreshMcpPairings();
        hadDisconnectRef.current = true;
        setMcpPairNotice('Disconnected MCP pairing — MCP service is now inactive.');
        onConnectionStateChangeRef.current?.({
          kind: 'mcp',
          status: 'disconnected',
          code: code || '',
          manual: true
        });
      } catch (err) {
        setMcpPairNotice(err.message || 'Disconnect failed');
      } finally {
        setMcpPairBusy(false);
      }
    },
    [refreshMcpPairings]
  );

  const disconnectDesktopPair = useCallback(() => {
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    clearInterval(pairPingTimerRef.current);
    pairPingTimerRef.current = null;
    const prevCode = activePairCodeRef.current;
    activePairCodeRef.current = '';
    hadDisconnectRef.current = true;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    setPairedCode('');
    setPairError('');
    onConnectionStateChangeRef.current?.({
      kind: 'desktop',
      status: 'disconnected',
      code: prevCode,
      manual: true
    });
  }, []);

  const handleMobileSignPending = useCallback(
    async (reqItem, options = {}) => {
      if (!reqItem?.id) return;
      const autoFitScale = Boolean(options?.autoFitScale);
      const overrideScale = options?.overrideScale ?? null;
      setPendingSigBusyId(reqItem.id);
      setPendingSigErrors((prev) => {
        if (!prev[reqItem.id]) return prev;
        const next = { ...prev };
        delete next[reqItem.id];
        return next;
      });
      try {
        let extSig = '';
        if (
          !autoFitScale &&
          !overrideScale &&
          user?.walletAddress &&
          reqItem.ownerAddress &&
          user.walletAddress.toLowerCase() !== reqItem.ownerAddress.toLowerCase() &&
          typeof window !== 'undefined' &&
          window.ethereum
        ) {
          extSig = await window.ethereum.request({
            method: 'personal_sign',
            params: [reqItem.canonicalMessage, reqItem.ownerAddress]
          });
        }
        const payload = {
          ...(extSig ? { signature: extSig } : {}),
          ...(autoFitScale ? { autoFitScale: true } : {}),
          ...(overrideScale ? { overrideScale } : {})
        };
        const res = await api.mobileSignRequest(reqItem.id, payload);
        await refreshPendingSignatures();
        onSignatureExecutedRef.current?.(res, reqItem);
        const label =
          reqItem.summaryTitle ||
          String(reqItem.action || 'land action').replace(/_/g, ' ');
        const targetParcelId = String(
          res?.result?.sculpture?.parcelId ||
            res?.result?.parcel?.parcelId ||
            res?.request?.parcelId ||
            reqItem.parcelId ||
            ''
        ).trim();
        const landLabel =
          reqItem.landDisplayName || reqItem.parcelName || targetParcelId || 'your land';
        const fitSuffix = res?.autoFittedScale ? ` (auto-fitted to ${res.autoFittedScale}×)` : '';
        const msg = `Approved & minted ${label}${fitSuffix} on ${landLabel}!`;
        if (user?.id) {
          recordUserAction(user.id, {
            type: 'approve_land_tx',
            icon: '✅',
            title: `Approved ${label}${fitSuffix}`,
            detail: landLabel,
            parcelId: targetParcelId,
            sculptureId: res?.result?.sculpture?.id || reqItem.sculptureId || '',
            linkLabel: 'Land'
          });
        }
        notifySettingsSaved(msg, {
          tone: 'success',
          durationMs: 6000,
          ...(targetParcelId && onNavigateToLandRef.current
            ? {
                actionLabel: '📍 Go to Land →',
                onAction: () => onNavigateToLandRef.current?.(targetParcelId)
              }
            : {})
        });
        showHintRef.current?.(msg);
        return res;
      } catch (err) {
        const errMsg = err?.message || 'Could not sign request';
        const maxSafe = Number(err?.data?.maxSafeScale ?? err?.data?.suggestedScale ?? 0);
        setPendingSigErrors((prev) => ({
          ...prev,
          [reqItem.id]: {
            message: errMsg,
            code: String(err?.data?.code || ''),
            maxSafeScale: Number.isFinite(maxSafe) && maxSafe > 0 ? maxSafe : null
          }
        }));
        notifySettingsSaved(`⚠️ ${errMsg}`, { tone: 'error', durationMs: 6500 });
        showHintRef.current?.(errMsg);
      } finally {
        setPendingSigBusyId('');
      }
    },
    [user?.id, user?.walletAddress, refreshPendingSignatures]
  );

  const handleMobileRejectPending = useCallback(
    async (reqId) => {
      setPendingSigBusyId(reqId);
      setPendingSigErrors((prev) => {
        if (!prev[reqId]) return prev;
        const next = { ...prev };
        delete next[reqId];
        return next;
      });
      try {
        await api.rejectSignatureRequest(reqId);
        await refreshPendingSignatures();
        notifySettingsSaved('Signature request rejected.');
        showHintRef.current?.('Signature request rejected.');
      } catch (err) {
        const errMsg = err?.message || 'Could not reject request';
        setPendingSigErrors((prev) => ({
          ...prev,
          [reqId]: { message: errMsg, code: String(err?.data?.code || ''), maxSafeScale: null }
        }));
        notifySettingsSaved(`⚠️ ${errMsg}`, { tone: 'error', durationMs: 5500 });
        showHintRef.current?.(errMsg);
      } finally {
        setPendingSigBusyId('');
      }
    },
    [refreshPendingSignatures]
  );

  return {
    wsRef,
    pairOpen,
    setPairOpen,
    pairCodeInput,
    setPairCodeInput,
    pairedCode,
    pairError,
    connectPairCode,
    disconnectDesktopPair,
    mcpPairingsState,
    mcpPairBusy,
    mcpPairNotice,
    setMcpPairNotice,
    repairNotice,
    dismissRepairNotice: () => setRepairNotice(null),
    refreshMcpPairings,
    handleCreateMcpPairing,
    handleDisconnectMcpPairing,
    pendingSignatures,
    signatureHistory,
    pendingSigBusyId,
    pendingSigErrors,
    refreshPendingSignatures,
    handleMobileSignPending,
    handleMobileRejectPending,
    agentPublishPrompt,
    setAgentPublishPrompt
  };
}
