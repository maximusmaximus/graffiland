import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import {
  clearLocalDraft,
  saveLocalDraft
} from '../utils/clipboard.js';

/**
 * Manages local auto-saved drafts, cloud account drafts, and AI Agent Sculpture Code sessions.
 */
export function useDrafts({
  initialDraft,
  user,
  location,
  locationRef,
  voxels,
  voxelsRef,
  setVoxels,
  title,
  setTitle,
  description,
  setDescription,
  cluePrompt,
  setCluePrompt,
  setClueAnswer,
  color,
  material,
  reachMeters,
  surfaceAnchor,
  setSurfaceAnchor,
  surfaceAnchorRef,
  modeRef,
  setMode,
  commitTransformAndExit,
  stopBrushPainting,
  resetArtTransformState,
  captureSculptureSnapshot,
  setSensorBanner,
  showTemporaryHint,
  drawActivity = null,
  markDrawActivity = null
}) {
  const [activeDraftId, setActiveDraftId] = useState(initialDraft.activeDraftId || '');
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [cloudDrafts, setCloudDrafts] = useState([]);
  const [draftsBusy, setDraftsBusy] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftStatusText, setDraftStatusText] = useState(() =>
    Array.isArray(initialDraft.voxels) && initialDraft.voxels.length > 0
      ? `Restored ${initialDraft.voxels.length} blocks`
      : ''
  );

  const [agentOpen, setAgentOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentCopied, setAgentCopied] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [agentSession, setAgentSession] = useState(null);

  const draftSnapshotRef = useRef(null);
  const lastCloudSyncSigRef = useRef('');
  const activeDraftIdRef = useRef(activeDraftId);
  const lastAppliedAgentTsRef = useRef('');

  useEffect(() => {
    activeDraftIdRef.current = activeDraftId;
  }, [activeDraftId]);

  const refreshCloudDrafts = useCallback(async () => {
    if (!user?.id) return [];
    try {
      const res = await api.listDrafts();
      const items = res.drafts || [];
      setCloudDrafts(items);
      return items;
    } catch {
      return [];
    }
  }, [user?.id]);

  const persistCloudDraft = useCallback(
    async ({ source = 'auto', forceNew = false, previewDataUrl = '' } = {}) => {
      if (!user?.id) return null;
      const currentVoxels = voxelsRef.current || [];
      const currentTitle = title.trim();
      const currentDesc = description.trim();
      if (currentVoxels.length === 0 && !currentTitle && !currentDesc) return null;

      const payload = {
        ...(!forceNew && activeDraftIdRef.current ? { id: activeDraftIdRef.current } : {}),
        title: currentTitle,
        description: currentDesc,
        voxels: currentVoxels,
        location: locationRef.current,
        surfaceAnchor: surfaceAnchorRef.current,
        previewDataUrl,
        source
      };
      const res = await api.saveDraft(payload);
      if (res?.draft?.id) {
        setActiveDraftId(res.draft.id);
        activeDraftIdRef.current = res.draft.id;
        setDraftStatusText(
          `Saved to cloud (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        );
        setCloudDrafts((prev) => [res.draft, ...prev.filter((d) => d.id !== res.draft.id)]);
      }
      return res?.draft || null;
    },
    [description, locationRef, surfaceAnchorRef, title, user?.id, voxelsRef]
  );

  useEffect(() => {
    const hasContent =
      voxels.length > 0 ||
      Boolean(title.trim()) ||
      Boolean(description.trim()) ||
      Boolean(surfaceAnchor);

    if (!hasContent) {
      draftSnapshotRef.current = null;
      clearLocalDraft();
      setDraftStatusText(user?.id ? 'Cloud drafts ready' : '');
      return undefined;
    }

    const snap = {
      activeDraftId,
      title,
      description,
      cluePrompt,
      color,
      material,
      reachMeters,
      surfaceAnchor,
      voxels,
      lastDrawAt: drawActivity?.lastDrawAt ?? null,
      drawLocation: drawActivity?.drawLocation ?? null,
      updatedAt: new Date().toISOString()
    };
    draftSnapshotRef.current = snap;

    const timer = setTimeout(() => {
      saveLocalDraft(snap);
      if (!user?.id) {
        setDraftStatusText(`Auto-saved on device (${voxels.length} blocks)`);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [
    activeDraftId,
    cluePrompt,
    color,
    description,
    drawActivity?.drawLocation,
    drawActivity?.lastDrawAt,
    material,
    reachMeters,
    surfaceAnchor,
    title,
    user?.id,
    voxels
  ]);

  useEffect(() => {
    const flushLocal = () => {
      if (draftSnapshotRef.current) {
        saveLocalDraft(draftSnapshotRef.current);
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') flushLocal();
    };
    window.addEventListener('beforeunload', flushLocal);
    window.addEventListener('pagehide', flushLocal);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('beforeunload', flushLocal);
      window.removeEventListener('pagehide', flushLocal);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setCloudDrafts([]);
      lastCloudSyncSigRef.current = '';
      return undefined;
    }

    let cancelled = false;
    refreshCloudDrafts();

    const queryDraftId = new URLSearchParams(window.location.search).get('draft');
    if (queryDraftId && !activeDraftIdRef.current) {
      api
        .getDraft(queryDraftId)
        .then((res) => {
          if (cancelled || !res?.draft) return;
          const d = res.draft;
          setActiveDraftId(d.id);
          activeDraftIdRef.current = d.id;
          setVoxels(Array.isArray(d.voxels) ? d.voxels : []);
          setTitle(d.title || '');
          setDescription(d.description || '');
          setSurfaceAnchor(d.surfaceAnchor || null);
          markDrawActivity?.({ forceState: true });
          setDraftStatusText(`Loaded cloud draft (${d.voxelCount} blocks)`);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [markDrawActivity, refreshCloudDrafts, setDescription, setSurfaceAnchor, setTitle, setVoxels, user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    const hasContent =
      voxels.length > 0 || Boolean(title.trim()) || Boolean(description.trim());
    if (!hasContent) return undefined;

    let hash = 0;
    for (let i = 0; i < voxels.length; i += 1) {
      const v = voxels[i];
      hash =
        (hash * 31 +
          Math.round(v.x * 1000) +
          Math.round(v.y * 1000) * 7 +
          Math.round(v.z * 1000) * 13 +
          Math.round((v.scale ?? 1) * 100)) |
        0;
    }
    const anchorSig = surfaceAnchor
      ? `${surfaceAnchor.x}:${surfaceAnchor.y}:${surfaceAnchor.z}:${surfaceAnchor.locked}`
      : '';
    const sig = `${user.id}|${activeDraftId}|${title}|${description}|${voxels.length}|${hash}|${anchorSig}`;
    if (lastCloudSyncSigRef.current === sig) return undefined;

    const timer = setTimeout(() => {
      persistCloudDraft({ source: 'auto' })
        .then((saved) => {
          if (saved) lastCloudSyncSigRef.current = sig;
        })
        .catch(() => {});
    }, 2000);

    return () => clearTimeout(timer);
  }, [activeDraftId, description, persistCloudDraft, surfaceAnchor, title, user?.id, voxels]);

  const applyAgentSessionDraft = useCallback(
    (sess) => {
      if (!sess || !Array.isArray(sess.draftVoxels) || sess.draftVoxels.length === 0) return;
      if (sess.updatedAt && lastAppliedAgentTsRef.current === sess.updatedAt) return;
      lastAppliedAgentTsRef.current = sess.updatedAt || String(Date.now());
      setVoxels(sess.draftVoxels);
      markDrawActivity?.({ forceState: true });
      if (sess.draftTitle) {
        setTitle((prev) => (prev.trim() ? prev : sess.draftTitle));
      }
      if (sess.draftDescription) {
        setDescription((prev) => (prev.trim() ? prev : sess.draftDescription));
      }
      setSensorBanner(
        `Agent staged ${sess.draftVoxels.length} voxels (${sess.agentName || 'AI Agent'}) — inspect in AR & publish on your phone.`
      );
    },
    [markDrawActivity, setDescription, setSensorBanner, setTitle, setVoxels]
  );

  const openAgentHandoff = useCallback(async () => {
    setAgentOpen(true);
    setAgentError('');
    setAgentCopied(false);

    let activeLoc = locationRef.current || location;
    if (!activeLoc && navigator.geolocation?.getCurrentPosition) {
      activeLoc = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              altitude: pos.coords.altitude,
              accuracy: pos.coords.accuracy,
              heading: pos.coords.heading
            }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 4500 }
        );
      });
    }

    if (!activeLoc) {
      setAgentError(
        'Enable GPS location permission to lock an instant session code onto your exact physical spot.'
      );
      return;
    }

    setAgentBusy(true);
    try {
      const created = await api.createAgentSession({ location: activeLoc });
      setAgentSession(created);
      lastAppliedAgentTsRef.current = '';
    } catch (err) {
      setAgentError(err.message);
    } finally {
      setAgentBusy(false);
    }
  }, [location, locationRef]);

  const refreshAgentDraft = useCallback(async () => {
    if (!agentSession?.code) return;
    setAgentError('');
    try {
      const res = await api.getAgentSession(agentSession.code);
      if (res?.session) {
        setAgentSession((prev) => ({
          ...(prev || {}),
          ...res.session,
          spec: res.spec || prev?.spec
        }));
        if (res.session.status === 'ready' && res.session.draftVoxels?.length) {
          applyAgentSessionDraft(res.session);
        }
      }
    } catch (err) {
      setAgentError(err.message);
    }
  }, [agentSession?.code, applyAgentSessionDraft]);

  useEffect(() => {
    const code = agentSession?.code;
    if (!code) return undefined;
    const poll = async () => {
      try {
        const res = await api.getAgentSession(code);
        if (res?.session) {
          setAgentSession((prev) => ({
            ...(prev || {}),
            ...res.session,
            spec: res.spec || prev?.spec
          }));
          if (res.session.status === 'ready' && res.session.draftVoxels?.length) {
            applyAgentSessionDraft(res.session);
          }
        }
      } catch {
        // retry on next tick
      }
    };
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
  }, [agentSession?.code, applyAgentSessionDraft]);

  const openDraftsSheet = useCallback(async () => {
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw');
    }
    setDraftError('');
    setDraftsOpen(true);
    if (user?.id) {
      setDraftsBusy(true);
      try {
        await refreshCloudDrafts();
      } finally {
        setDraftsBusy(false);
      }
    }
  }, [commitTransformAndExit, modeRef, refreshCloudDrafts, user?.id]);

  const handleManualSaveDraft = useCallback(
    async ({ forceNew = false, closePublish = false } = {}) => {
      setDraftError('');
      const currentVoxels = voxelsRef.current || [];
      if (currentVoxels.length === 0 && !title.trim() && !description.trim()) {
        setDraftError('Draw at least 1 block or add a title before saving a draft.');
        return;
      }

      if (!user?.id) {
        saveLocalDraft({
          activeDraftId,
          title,
          description,
          cluePrompt,
          color,
          material,
          reachMeters,
          surfaceAnchor,
          voxels: currentVoxels,
          lastDrawAt: drawActivity?.lastDrawAt ?? null,
          drawLocation: drawActivity?.drawLocation ?? null,
          updatedAt: new Date().toISOString()
        });
        setDraftStatusText(`Saved on device (${currentVoxels.length} blocks)`);
        showTemporaryHint('Draft saved on device (sign in to sync to cloud)');
        if (closePublish) setMode('draw');
        return;
      }

      setDraftsBusy(true);
      try {
        const previewDataUrl = captureSculptureSnapshot();
        await persistCloudDraft({ source: 'manual', forceNew, previewDataUrl });
        showTemporaryHint(forceNew ? 'Saved as new cloud draft!' : 'Draft saved to your account!');
        if (closePublish) setMode('draw');
      } catch (err) {
        setDraftError(err.message || 'Failed to save draft');
      } finally {
        setDraftsBusy(false);
      }
    },
    [
      activeDraftId,
      captureSculptureSnapshot,
      cluePrompt,
      color,
      description,
      drawActivity?.drawLocation,
      drawActivity?.lastDrawAt,
      material,
      persistCloudDraft,
      reachMeters,
      setMode,
      showTemporaryHint,
      surfaceAnchor,
      title,
      user?.id,
      voxelsRef
    ]
  );

  const handleLoadDraft = useCallback(
    async (draft) => {
      if (!draft) return;
      setDraftError('');
      let full = draft;
      if (!Array.isArray(draft.voxels) && user?.id) {
        setDraftsBusy(true);
        try {
          const res = await api.getDraft(draft.id);
          if (res?.draft) full = res.draft;
        } catch (err) {
          setDraftError(err.message || 'Failed to load draft');
          setDraftsBusy(false);
          return;
        } finally {
          setDraftsBusy(false);
        }
      }
      stopBrushPainting();
      resetArtTransformState();
      setActiveDraftId(full.id || '');
      activeDraftIdRef.current = full.id || '';
      setVoxels(Array.isArray(full.voxels) ? full.voxels : []);
      setTitle(full.title || '');
      setDescription(full.description || '');
      setCluePrompt('');
      setClueAnswer('');
      setSurfaceAnchor(full.surfaceAnchor || null);
      markDrawActivity?.({ forceState: true });
      setMode('draw');
      modeRef.current = 'draw';
      setDraftsOpen(false);
      setDraftStatusText(`Loaded (${(full.voxels || []).length} blocks)`);
      showTemporaryHint(`Resumed draft: ${full.title || 'Untitled'}`);
    },
    [
      markDrawActivity,
      modeRef,
      resetArtTransformState,
      setClueAnswer,
      setCluePrompt,
      setDescription,
      setMode,
      setSurfaceAnchor,
      setTitle,
      setVoxels,
      showTemporaryHint,
      stopBrushPainting,
      user?.id
    ]
  );

  const handleDeleteCloudDraft = useCallback(async (draftId) => {
    if (!draftId) return;
    setDraftError('');
    setDraftsBusy(true);
    try {
      await api.deleteDraft(draftId);
      setCloudDrafts((prev) => prev.filter((d) => d.id !== draftId));
      if (activeDraftIdRef.current === draftId) {
        setActiveDraftId('');
        activeDraftIdRef.current = '';
      }
    } catch (err) {
      setDraftError(err.message || 'Failed to delete draft');
    } finally {
      setDraftsBusy(false);
    }
  }, []);

  const handleStartNewDraft = useCallback(() => {
    stopBrushPainting();
    resetArtTransformState();
    clearLocalDraft();
    setActiveDraftId('');
    activeDraftIdRef.current = '';
    lastCloudSyncSigRef.current = '';
    setVoxels([]);
    setTitle('');
    setDescription('');
    setCluePrompt('');
    setClueAnswer('');
    setSurfaceAnchor(null);
    setDraftStatusText('');
    setDraftsOpen(false);
    setMode('draw');
    modeRef.current = 'draw';
    showTemporaryHint('Started fresh blank draft');
  }, [
    modeRef,
    resetArtTransformState,
    setClueAnswer,
    setCluePrompt,
    setDescription,
    setMode,
    setSurfaceAnchor,
    setTitle,
    setVoxels,
    showTemporaryHint,
    stopBrushPainting
  ]);

  const discardActiveCanvasDraft = useCallback(() => {
    draftSnapshotRef.current = null;
    clearLocalDraft();
    setActiveDraftId('');
    activeDraftIdRef.current = '';
    lastCloudSyncSigRef.current = '';
    setDraftStatusText('');
  }, []);

  const markDraftPublished = useCallback((publishedDraftId) => {
    clearLocalDraft();
    setActiveDraftId('');
    activeDraftIdRef.current = '';
    lastCloudSyncSigRef.current = '';
    if (publishedDraftId) {
      setCloudDrafts((prev) => prev.filter((d) => d.id !== publishedDraftId));
    }
    setDraftStatusText('');
  }, []);

  return {
    activeDraftId,
    activeDraftIdRef,
    draftsOpen,
    setDraftsOpen,
    cloudDrafts,
    draftsBusy,
    draftError,
    draftStatusText,
    openDraftsSheet,
    refreshCloudDrafts,
    handleManualSaveDraft,
    handleLoadDraft,
    handleDeleteCloudDraft,
    handleStartNewDraft,
    discardActiveCanvasDraft,
    markDraftPublished,
    agentOpen,
    setAgentOpen,
    agentBusy,
    agentCopied,
    setAgentCopied,
    agentError,
    agentSession,
    openAgentHandoff,
    refreshAgentDraft,
    applyAgentSessionDraft
  };
}
