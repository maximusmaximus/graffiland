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
  onDelegatedPublishExecuted
}) {
  const wsRef = useRef(null);
  const onDesktopCommandRef = useRef(onDesktopCommand);
  const onDelegatedPublishRef = useRef(onDelegatedPublishExecuted);
  const showHintRef = useRef(showTemporaryHint);

  useEffect(() => {
    onDesktopCommandRef.current = onDesktopCommand;
    onDelegatedPublishRef.current = onDelegatedPublishExecuted;
    showHintRef.current = showTemporaryHint;
  }, [onDesktopCommand, onDelegatedPublishExecuted, showTemporaryHint]);

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

    let ws;
    try {
      ws = new WebSocket(getWsUrl());
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe_mcp', pairingCode: activeCode }));
      };
      ws.onmessage = (ev) => {
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
    } catch {
      // fallback to polling
    }
    return () => {
      try {
        ws?.close();
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
    (codeToJoin) => {
      const clean = String(codeToJoin || '').trim().toUpperCase();
      if (!clean) return;
      setPairError('');
      if (wsRef.current) wsRef.current.close();

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join_pair', code: clean }));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'pair_connected') {
            setPairedCode(msg.code);
            setPairOpen(false);
            ws.send(JSON.stringify({ type: 'voxels_sync', voxels: voxelsRef.current }));
          } else if (msg.type === 'pair_error') {
            setPairError(msg.error);
          } else if (msg.type === 'pair_ended') {
            setPairedCode('');
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
        setPairedCode('');
      };
    },
    [rawOrientationRef, voxelsRef, yawOffsetRef]
  );

  useEffect(() => {
    const urlPair = typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('pair') || '').toUpperCase()
      : '';
    if (urlPair && urlPair.length === 6) {
      connectPairCode(urlPair);
    }
    return () => wsRef.current?.close();
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
        setMcpPairNotice('Disconnected MCP pairing — MCP service is now inactive.');
      } catch (err) {
        setMcpPairNotice(err.message || 'Disconnect failed');
      } finally {
        setMcpPairBusy(false);
      }
    },
    [refreshMcpPairings]
  );

  const disconnectDesktopPair = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    setPairedCode('');
    setPairError('');
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
