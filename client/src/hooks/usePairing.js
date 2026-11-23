import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE } from '../utils/api.js';
import { getWsUrl } from '../utils/device.js';
import { copyToClipboard } from '../utils/clipboard.js';

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
  onConnectionStateChange = null
}) {
  const wsRef = useRef(null);
  const onDesktopCommandRef = useRef(onDesktopCommand);
  const onDelegatedPublishRef = useRef(onDelegatedPublishExecuted);
  const showHintRef = useRef(showTemporaryHint);
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  const activePairCodeRef = useRef('');
  const hadDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    onDesktopCommandRef.current = onDesktopCommand;
    onDelegatedPublishRef.current = onDelegatedPublishExecuted;
    showHintRef.current = showTemporaryHint;
    onConnectionStateChangeRef.current = onConnectionStateChange;
  }, [onDesktopCommand, onDelegatedPublishExecuted, showTemporaryHint, onConnectionStateChange]);

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
    pairings: []
  });
  const [mcpPairBusy, setMcpPairBusy] = useState(false);
  const [mcpPairNotice, setMcpPairNotice] = useState('');
  const [pendingSignatures, setPendingSignatures] = useState([]);
  const [signatureHistory, setSignatureHistory] = useState([]);
  const [pendingSigBusyId, setPendingSigBusyId] = useState('');
  const [agentPublishPrompt, setAgentPublishPrompt] = useState(null);

  useEffect(() => {
    if (wsRef.current?.readyState === 1 && pairedCode) {
      wsRef.current.send(JSON.stringify({ type: 'voxels_sync', voxels }));
    }
  }, [voxels, pairedCode]);

  const refreshMcpPairings = useCallback(async () => {
    if (!user?.id) {
      setMcpPairingsState({ mcpActive: false, activePairing: null, pairings: [] });
      return null;
    }
    try {
      const res = await api.listMcpPairings();
      setMcpPairingsState(res);
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

    const openMcpSocket = () => {
      if (closed) return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      try {
        const nextWs = new WebSocket(getWsUrl());
        ws = nextWs;
        nextWs.onopen = () => {
          if (closed || ws !== nextWs) return;
          nextWs.send(JSON.stringify({ type: 'subscribe_mcp', pairingCode: activeCode }));
        };
        nextWs.onmessage = (ev) => {
          if (closed || ws !== nextWs) return;
          try {
            const msg = JSON.parse(ev.data);
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
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onReconnectEvent);
    }
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onReconnectEvent);
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
      };

      ws.onmessage = (ev) => {
        if (wsRef.current !== ws || unmountedRef.current) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'pair_connected') {
            reconnectAttemptRef.current = 0;
            const status = isReconnect || hadDisconnectRef.current ? 'reconnected' : 'connected';
            hadDisconnectRef.current = false;
            activePairCodeRef.current = msg.code || clean;
            setPairedCode(msg.code);
            setPairOpen(false);
            ws.send(JSON.stringify({ type: 'voxels_sync', voxels: voxelsRef.current }));
            onConnectionStateChangeRef.current?.({
              kind: 'desktop',
              status,
              code: msg.code || clean
            });
          } else if (msg.type === 'pair_error') {
            activePairCodeRef.current = '';
            setPairError(msg.error);
          } else if (msg.type === 'pair_ended') {
            activePairCodeRef.current = '';
            hadDisconnectRef.current = true;
            setPairedCode('');
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
          const delays = [1500, 3000, 6000, 10000];
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
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', tryAutoReconnect);
    }

    return () => {
      unmountedRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', tryAutoReconnect);
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
    async (reqItem) => {
      if (!reqItem?.id) return;
      setPendingSigBusyId(reqItem.id);
      try {
        let extSig = '';
        if (
          user?.walletAddress &&
          reqItem.ownerAddress &&
          user.walletAddress.toLowerCase() !== reqItem.ownerAddress.toLowerCase() &&
          window.ethereum
        ) {
          extSig = await window.ethereum.request({
            method: 'personal_sign',
            params: [reqItem.canonicalMessage, reqItem.ownerAddress]
          });
        }
        await api.mobileSignRequest(reqItem.id, extSig ? { signature: extSig } : {});
        await refreshPendingSignatures();
        showHintRef.current?.(
          `✅ Signed & executed ${reqItem.action.replace(/_/g, ' ')} on ${reqItem.parcelId}`
        );
      } catch (err) {
        showHintRef.current?.(err.message || 'Could not sign request');
      } finally {
        setPendingSigBusyId('');
      }
    },
    [user?.walletAddress, refreshPendingSignatures]
  );

  const handleMobileRejectPending = useCallback(
    async (reqId) => {
      setPendingSigBusyId(reqId);
      try {
        await api.rejectSignatureRequest(reqId);
        await refreshPendingSignatures();
        showHintRef.current?.('Signature request rejected.');
      } catch (err) {
        showHintRef.current?.(err.message || 'Could not reject request');
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
    refreshMcpPairings,
    handleCreateMcpPairing,
    handleDisconnectMcpPairing,
    pendingSignatures,
    signatureHistory,
    pendingSigBusyId,
    refreshPendingSignatures,
    handleMobileSignPending,
    handleMobileRejectPending,
    agentPublishPrompt,
    setAgentPublishPrompt
  };
}
