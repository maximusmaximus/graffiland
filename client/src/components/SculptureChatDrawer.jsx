import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatLandChatAccessModeLabel } from '../../../shared/chatPolicy.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import {
  resolveAuthorHandleForStorage,
  resolveSafeUserAvatar
} from '../../../shared/userDisplay.mjs';
import { api } from '../utils/api.js';
import { exitDomFullscreenSafely } from '../utils/cameraRecovery.js';
import { useVisualViewportLayout } from '../hooks/useVisualViewportLayout.js';
import {
  computeRoomPossessionProof,
  decryptChatMessage,
  decryptPinnedIpfsBatch,
  encryptChatMessage,
  encryptPinnedIpfsBatch,
  generateRoomKeyB64,
  getOrCreateDeviceIdentity,
  loadLocalRoomKey,
  saveLocalRoomKey,
  signParcelPresenceProof,
  signSightProof,
  unwrapRoomKeyFromGrant,
  unwrapRoomKeyWithClue,
  wrapRoomKeyForRecipient,
  wrapRoomKeyWithClue
} from '../utils/chatCrypto.js';
import { EmojiInput } from './EmojiField.jsx';
import { GlobalNotificationBell } from './NotificationCenter.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

function formatShortChatTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function SculptureChatDrawer({
  sculpture,
  user,
  location,
  polTracker,
  cameraReady,
  initialSightProof,
  initialPinData,
  onRequestLogin,
  onClose
}) {
  const [loading, setLoading] = useState(true);
  const [entered, setEntered] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [roomKeyB64, setRoomKeyB64] = useState('');
  const [messages, setMessages] = useState([]);
  const [pendingGrants, setPendingGrants] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');

  const [pinMeta, setPinMeta] = useState(initialPinData?.meta || sculpture.pinSummary || null);
  const [pinnedItems, setPinnedItems] = useState(initialPinData?.pins || []);
  const [pinUnlockStatus, setPinUnlockStatus] = useState(
    initialPinData?.unlocked ? 'unlocked' : initialPinData?.error ? 'locked' : 'idle'
  );
  const [pinUnlockError, setPinUnlockError] = useState(initialPinData?.error || '');
  const [pinInput, setPinInput] = useState('');
  const [editingPinId, setEditingPinId] = useState('');
  const [editingPinText, setEditingPinText] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const [clueInput, setClueInput] = useState('');
  const [clueBusy, setClueBusy] = useState(false);
  const [clueError, setClueError] = useState('');

  const [msgInput, setMsgInput] = useState('');
  const [sending, setSending] = useState(false);

  const [clueEditOpen, setClueEditOpen] = useState(false);
  const [newCluePrompt, setNewCluePrompt] = useState('');
  const [newClueAnswer, setNewClueAnswer] = useState('');
  const [savingClue, setSavingClue] = useState(false);
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'pins' | 'access'
  const viewport = useVisualViewportLayout(true);

  const reqSentRef = useRef(false);
  const autoInitRef = useRef(false);
  const pinAttemptedRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const lastUnlockedSeqRef = useRef(Number(initialPinData?.batchSeq || 0));
  const sightRef = useRef(initialSightProof);
  const locationRef = useRef(location);
  const cameraReadyRef = useRef(cameraReady);
  const polTrackerRef = useRef(polTracker);
  const pinUnlockStatusRef = useRef(pinUnlockStatus);
  const boardIdRef = useRef(sculpture.id);
  const listEndRef = useRef(null);
  const feedRef = useRef(null);

  locationRef.current = location;
  cameraReadyRef.current = cameraReady;
  polTrackerRef.current = polTracker;
  pinUnlockStatusRef.current = pinUnlockStatus;
  if (initialSightProof && !sightRef.current) {
    sightRef.current = initialSightProof;
  }

  useEffect(() => {
    mountedRef.current = true;
    exitDomFullscreenSafely();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scrollFeedToBottom = useCallback((smooth = false) => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
    if (typeof listEndRef.current?.scrollIntoView === 'function') {
      listEndRef.current.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
    }
  }, []);

  useEffect(() => {
    boardIdRef.current = sculpture.id;
    sightRef.current = initialSightProof;
    reqSentRef.current = false;
    autoInitRef.current = false;
    pinAttemptedRef.current = false;
  }, [initialSightProof, sculpture.id]);

  const activeBoardId = entered?.board?.sculptureId || entered?.boardId || sculpture.id;

  const buildFreshSightProof = useCallback(
    async (idObj) => {
      const tracker = polTrackerRef.current;
      const snap = tracker?.getSnapshot ? tracker.getSnapshot() : {};
      const liveLoc = locationRef.current;
      const initSight = sightRef.current || {};
      const resolvedCamReady = Boolean(cameraReadyRef.current || initSight.cameraReady);
      const base = {
        ...initSight,
        selectionMethod: 'ar-camera-raycast',
        rayHit: true,
        inFrustum: true,
        cameraReady: resolvedCamReady,
        cameraFrames: Math.max(
          resolvedCamReady ? 2 : 0,
          Number(snap.cameraFrames || 0),
          Number(initSight.cameraFrames || 0)
        ),
        opticalFlowCorrelation:
          snap.opticalFlowCorrelation ?? initSight.opticalFlowCorrelation ?? 0.65,
        visualDHash: snap.visualDHash || initSight.visualDHash || '',
        lat: liveLoc?.lat ?? initSight.lat,
        lng: liveLoc?.lng ?? initSight.lng,
        altitude: liveLoc?.altitude ?? initSight.altitude ?? null,
        selectedAt: new Date().toISOString()
      };
      if (!idObj) return base;
      return signSightProof(idObj, {
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        sightProof: base
      });
    },
    [sculpture.id, sculpture.parcelId]
  );

  const autoWrapPendingGrants = useCallback(
    async (activeKeyB64, activeIdentity, targetBoardId = null) => {
      const roomId = targetBoardId || boardIdRef.current || sculpture.id;
      if (!activeKeyB64 || !activeIdentity || !roomId) return;
      try {
        const res = await api.listSculpturePendingGrants(roomId);
        const list = res.grants || [];
        setPendingGrants(list);
        for (const reqGrant of list) {
          if (reqGrant.sightDistanceM <= 75 && reqGrant.sightScore >= 45) {
            const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
              roomKeyB64: activeKeyB64,
              sculptureId: roomId,
              keyEpoch: reqGrant.keyEpoch,
              recipientEcdhPubJwk: reqGrant.requesterEcdhPubJwk,
              recipientPubFp: reqGrant.requesterPubFp,
              grantorIdentity: activeIdentity
            });
            await api.submitSculptureChatGrant(roomId, {
              targetGrantId: reqGrant.id,
              wrappedKeyJson,
              grantorEcdhPubJwk: activeIdentity.ecdhPublicJwk,
              grantorSignPubJwk: activeIdentity.signPublicJwk,
              grantSig
            });
          }
        }
        if (list.length > 0) {
          const refreshed = await api.listSculpturePendingGrants(roomId);
          setPendingGrants(refreshed.grants || []);
        }
      } catch {
        // non-fatal background check
      }
    },
    [sculpture.id]
  );

  const syncPinnedBatch = useCallback(
    async (res, idObj, freshSight) => {
      const nextMeta = res?.pinMeta || null;
      if (nextMeta) setPinMeta(nextMeta);
      const serverSeq = Number(nextMeta?.batchSeq || 0);

      if (sculpture.isParcelChat) {
        setPinnedItems([]);
        setPinUnlockStatus('no-pins');
        setPinUnlockError('');
        return;
      }

      if (res?.isLandHolder) {
        if (
          lastUnlockedSeqRef.current === serverSeq &&
          serverSeq > 0 &&
          pinUnlockStatusRef.current === 'unlocked'
        ) {
          return;
        }
        try {
          const sealRes = await api.getOwnerPinSeal(sculpture.id);
          if (sealRes.meta) setPinMeta(sealRes.meta);
          if (sealRes.encryptedBatch) {
            const dec = await decryptPinnedIpfsBatch({
              encryptedBatch: sealRes.encryptedBatch,
              parcelSealKeyB64: sealRes.parcelSealKeyB64,
              sculptureId: sculpture.id,
              parcelId: sculpture.parcelId,
              geohash: sculpture.geohash
            });
            setPinnedItems(dec.pins || []);
            lastUnlockedSeqRef.current = Number(dec.batchSeq || serverSeq);
          } else {
            setPinnedItems([]);
            lastUnlockedSeqRef.current = serverSeq;
          }
          setPinUnlockStatus('unlocked');
          setPinUnlockError('');
        } catch (err) {
          setPinUnlockError(err.message || 'Could not load owner IPFS pins');
        }
        return;
      }

      if (!nextMeta?.hasPins) {
        setPinnedItems([]);
        setPinUnlockStatus('no-pins');
        setPinUnlockError('');
        return;
      }

      if (lastUnlockedSeqRef.current === serverSeq && pinUnlockStatusRef.current === 'unlocked') {
        return;
      }
      if (pinAttemptedRef.current && serverSeq <= lastUnlockedSeqRef.current) {
        return;
      }

      pinAttemptedRef.current = true;
      try {
        const ch = await api.issueParcelPinChallenge(sculpture.id, {
          deviceProfile: { isMobile: true }
        });
        const tracker = polTrackerRef.current;
        const snap = tracker?.getSnapshot ? tracker.getSnapshot() : {};
        const signed = await signParcelPresenceProof(idObj, {
          sculptureId: sculpture.id,
          parcelId: sculpture.parcelId,
          geohash: sculpture.geohash,
          challengeId: ch.challengeId,
          challengeNonce: ch.challengeNonce,
          sightProof: freshSight,
          polSnapshot: snap
        });
        const unlocked = await api.unlockPinnedIpfsBatch(sculpture.id, {
          ...signed,
          deviceProfile: { isMobile: true }
        });
        if (unlocked.meta) setPinMeta(unlocked.meta);
        if (unlocked.encryptedBatch && unlocked.parcelSealKeyB64) {
          const dec = await decryptPinnedIpfsBatch({
            encryptedBatch: unlocked.encryptedBatch,
            parcelSealKeyB64: unlocked.parcelSealKeyB64,
            sculptureId: sculpture.id,
            parcelId: sculpture.parcelId,
            geohash: sculpture.geohash
          });
          setPinnedItems(dec.pins || []);
          lastUnlockedSeqRef.current = Number(dec.batchSeq || serverSeq);
          setPinUnlockStatus('unlocked');
          setPinUnlockError('');
        } else {
          setPinnedItems([]);
          setPinUnlockStatus('no-pins');
        }
      } catch (err) {
        setPinUnlockStatus('locked');
        setPinUnlockError(
          err.message ||
            'Stand physically inside this parcel with live AR camera and GPS to decrypt pinned IPFS messages.'
        );
      }
    },
    [sculpture.geohash, sculpture.id, sculpture.isParcelChat, sculpture.parcelId]
  );

  const syncBoard = useCallback(async ({ force = false } = {}) => {
    if (!user) {
      setLoading(false);
      return;
    }
    if (syncInFlightRef.current && !force) return;
    syncInFlightRef.current = true;
    try {
      const idObj = await getOrCreateDeviceIdentity(user.id);
      setIdentity(idObj);
      const freshSight = await buildFreshSightProof(idObj);
      let res = await api.enterSculptureChat(sculpture.id, {
        requesterPubFp: idObj.pubFingerprint,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });

      // Automatically join/initialize the land's shared chatbox on selection so the selector is immediately part of it
      const resolvedInitId = res.board?.sculptureId || res.boardId || sculpture.id;
      if (!res.initialized && !autoInitRef.current) {
        autoInitRef.current = true;
        try {
          const keyB64 = generateRoomKeyB64();
          const epoch = 1;
          saveLocalRoomKey(user.id, resolvedInitId, epoch, keyB64);
          const { roomKeyCommit } = await computeRoomPossessionProof(keyB64, resolvedInitId, epoch);
          const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
            roomKeyB64: keyB64,
            sculptureId: resolvedInitId,
            keyEpoch: epoch,
            recipientEcdhPubJwk: idObj.ecdhPublicJwk,
            recipientPubFp: idObj.pubFingerprint,
            grantorIdentity: idObj
          });
          await api.initSculptureChat(resolvedInitId, {
            ownerEcdhPubJwk: idObj.ecdhPublicJwk,
            ownerSignPubJwk: idObj.signPublicJwk,
            ownerPubFp: idObj.pubFingerprint,
            selfGrantEnvelope: wrappedKeyJson,
            selfGrantSig: grantSig,
            roomKeyCommit,
            sightProof: freshSight,
            deviceProfile: { isMobile: true }
          });
          res = await api.enterSculptureChat(resolvedInitId, {
            requesterPubFp: idObj.pubFingerprint,
            sightProof: freshSight,
            deviceProfile: { isMobile: true }
          });
        } catch {
          // Another user may have initialized concurrently; re-enter cleanly
          res = await api.enterSculptureChat(sculpture.id, {
            requesterPubFp: idObj.pubFingerprint,
            sightProof: freshSight,
            deviceProfile: { isMobile: true }
          });
        }
      }

      const canonicalBoardId = res.board?.sculptureId || res.boardId || sculpture.id;
      boardIdRef.current = canonicalBoardId;
      setEntered(res);
      setErrorMsg('');

      await syncPinnedBatch(res, idObj, freshSight);

      if (!res.initialized || !res.board) {
        setRoomKeyB64('');
        setMessages([]);
        return;
      }

      const epoch = res.board.keyEpoch;
      let activeKey = loadLocalRoomKey(user.id, canonicalBoardId, epoch);

      if (!activeKey && res.myGrant?.status === 'granted' && res.myGrant?.wrappedKeyJson) {
        try {
          activeKey = await unwrapRoomKeyFromGrant({
            wrappedKeyJson: res.myGrant.wrappedKeyJson,
            grantSig: res.myGrant.grantSig,
            grantorSignPubJwk: res.myGrant.grantorSignPubJwk,
            sculptureId: canonicalBoardId,
            keyEpoch: epoch,
            identity: idObj
          });
          saveLocalRoomKey(user.id, canonicalBoardId, epoch, activeKey);
        } catch (err) {
          setErrorMsg(err.message || 'Could not unwrap granted chat key.');
        }
      }

      // If locked and no pending/granted request submitted yet, submit an ECDH grant request automatically
      if (!activeKey && !res.myGrant && !reqSentRef.current) {
        reqSentRef.current = true;
        await api
          .requestSculptureChatGrant(canonicalBoardId, {
            requesterEcdhPubJwk: idObj.ecdhPublicJwk,
            requesterSignPubJwk: idObj.signPublicJwk,
            requesterPubFp: idObj.pubFingerprint,
            sightProof: freshSight,
            deviceProfile: { isMobile: true }
          })
          .catch(() => {});
      }

      setRoomKeyB64(activeKey);

      if (activeKey) {
        const decList = [];
        for (const rawMsg of res.messages || []) {
          try {
            const plain = await decryptChatMessage({
              msg: rawMsg,
              roomKeyB64: activeKey,
              sculptureId: canonicalBoardId
            });
            decList.push(plain);
          } catch {
            decList.push({
              id: rawMsg.id,
              senderSub: rawMsg.senderSub,
              senderPubFp: rawMsg.senderPubFp,
              authorName: 'Unverified / Previous Epoch',
              text: '[Encrypted message failed signature or key check]',
              verifiedSig: false,
              createdAt: rawMsg.createdAt
            });
          }
        }
        setMessages(decList);
        if (res.pendingRequestsCount > 0) {
          await autoWrapPendingGrants(activeKey, idObj, canonicalBoardId);
        } else {
          setPendingGrants([]);
        }
      } else {
        setMessages([]);
      }
    } catch (err) {
      if (mountedRef.current) {
        setErrorMsg(err.message || 'Unable to verify AR camera sight for chat');
      }
    } finally {
      syncInFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [autoWrapPendingGrants, buildFreshSightProof, sculpture.id, syncPinnedBatch, user]);

  useEffect(() => {
    syncBoard();
    const timer = setInterval(syncBoard, 2800);
    return () => clearInterval(timer);
  }, [syncBoard]);

  useEffect(() => {
    scrollFeedToBottom(true);
  }, [messages.length, scrollFeedToBottom]);

  // Keep latest messages & composer smoothly visible whenever the virtual keyboard opens or resizes
  useEffect(() => {
    if (activeTab !== 'chat') return;
    scrollFeedToBottom(false);
  }, [activeTab, scrollFeedToBottom, viewport.height, viewport.keyboardOpen]);

  // Lock background document scrolling while full-screen chat is open and support Escape to close
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  async function handleInitializeBoard() {
    if (!user || !identity) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const roomId = activeBoardId;
      const keyB64 = generateRoomKeyB64();
      const epoch = 1;
      saveLocalRoomKey(user.id, roomId, epoch, keyB64);
      const { roomKeyCommit } = await computeRoomPossessionProof(keyB64, roomId, epoch);
      const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
        roomKeyB64: keyB64,
        sculptureId: roomId,
        keyEpoch: epoch,
        recipientEcdhPubJwk: identity.ecdhPublicJwk,
        recipientPubFp: identity.pubFingerprint,
        grantorIdentity: identity
      });
      const freshSight = await buildFreshSightProof(identity);
      await api.initSculptureChat(roomId, {
        ownerEcdhPubJwk: identity.ecdhPublicJwk,
        ownerSignPubJwk: identity.signPublicJwk,
        ownerPubFp: identity.pubFingerprint,
        selfGrantEnvelope: wrappedKeyJson,
        selfGrantSig: grantSig,
        roomKeyCommit,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });
      await syncBoard({ force: true });
    } catch (err) {
      setErrorMsg(err.message || 'Could not initialize encrypted board');
      setLoading(false);
    }
  }

  async function handleUnlockClue(e) {
    e.preventDefault();
    if (!entered?.board?.clueWrappedJson || !identity) return;
    setClueBusy(true);
    setClueError('');
    try {
      const roomId = activeBoardId;
      const epoch = entered.board.keyEpoch;
      const unlocked = await unwrapRoomKeyWithClue({
        clueWrappedJson: entered.board.clueWrappedJson,
        sculptureId: roomId,
        keyEpoch: epoch,
        clueAnswer: clueInput
      });
      saveLocalRoomKey(user.id, roomId, epoch, unlocked);

      // Prove knowledge of K_room via blinded HMAC commitment so viewer joins peer group cleanly
      const { roomProofToken } = await computeRoomPossessionProof(unlocked, roomId, epoch);
      const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
        roomKeyB64: unlocked,
        sculptureId: roomId,
        keyEpoch: epoch,
        recipientEcdhPubJwk: identity.ecdhPublicJwk,
        recipientPubFp: identity.pubFingerprint,
        grantorIdentity: identity
      });
      const freshSight = await buildFreshSightProof(identity);
      await api.claimClueChatGrant(roomId, {
        roomProofToken,
        requesterEcdhPubJwk: identity.ecdhPublicJwk,
        requesterSignPubJwk: identity.signPublicJwk,
        requesterPubFp: identity.pubFingerprint,
        selfGrantEnvelope: wrappedKeyJson,
        selfGrantSig: grantSig,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });
      setClueInput('');
      await syncBoard({ force: true });
    } catch {
      setClueError(
        'Incorrect real-world clue answer. Inspect this location carefully or wait for an admitted peer.'
      );
    } finally {
      setClueBusy(false);
    }
  }

  async function handleSendMessage(e) {
    e.preventDefault();
    if (!roomKeyB64 || !identity || !msgInput.trim()) return;
    setSending(true);
    setErrorMsg('');
    try {
      const roomId = activeBoardId;
      const epoch = entered?.board?.keyEpoch || 1;
      const freshSight = await buildFreshSightProof(identity);
      const payload = await encryptChatMessage({
        roomKeyB64,
        sculptureId: roomId,
        keyEpoch: epoch,
        senderSub: user.id,
        identity,
        text: msgInput,
        authorName: resolveAuthorHandleForStorage(user, 'Artist'),
        sightDistM: entered?.sight?.distanceMeters ?? null,
        altM: location?.altitude != null ? Math.round(location.altitude) : null
      });
      await api.postSculptureChatMessage(roomId, {
        ...payload,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });
      setMsgInput('');
      await syncBoard({ force: true });
    } catch (err) {
      setErrorMsg(err.message || 'Failed to send encrypted message');
    } finally {
      setSending(false);
    }
  }

  async function handleSaveClue(e) {
    e.preventDefault();
    if (!roomKeyB64 || !entered?.board) return;
    setSavingClue(true);
    setErrorMsg('');
    try {
      const roomId = activeBoardId;
      const epoch = entered.board.keyEpoch;
      let clueWrappedJson = '';
      if (newCluePrompt.trim()) {
        clueWrappedJson = await wrapRoomKeyWithClue({
          roomKeyB64,
          sculptureId: roomId,
          keyEpoch: epoch,
          clueAnswer: newClueAnswer
        });
      }
      await api.updateSculptureChatClue(roomId, {
        cluePrompt: newCluePrompt.trim(),
        clueWrappedJson,
        deviceProfile: { isMobile: true }
      });
      setClueEditOpen(false);
      setNewClueAnswer('');
      await syncBoard({ force: true });
    } catch (err) {
      setErrorMsg(err.message || 'Failed to update on-site clue');
    } finally {
      setSavingClue(false);
    }
  }

  async function persistPinBatch(nextPins) {
    if (!identity) return;
    setPinBusy(true);
    setPinUnlockError('');
    try {
      const sealRes = await api.getOwnerPinSeal(sculpture.id);
      const encryptedBatch = await encryptPinnedIpfsBatch({
        pins: nextPins,
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        geohash: sculpture.geohash,
        batchSeq: sealRes.nextBatchSeq,
        parcelSealKeyB64: sealRes.parcelSealKeyB64,
        identity
      });
      const saved = await api.saveEncryptedPinBatch(sculpture.id, { encryptedBatch });
      if (saved.meta) setPinMeta(saved.meta);
      const dec = await decryptPinnedIpfsBatch({
        encryptedBatch,
        parcelSealKeyB64: sealRes.parcelSealKeyB64,
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        geohash: sculpture.geohash
      });
      setPinnedItems(dec.pins || []);
      lastUnlockedSeqRef.current = Number(saved.meta?.batchSeq || sealRes.nextBatchSeq);
      setPinUnlockStatus('unlocked');
    } catch (err) {
      setPinUnlockError(err.message || 'Failed to save encrypted IPFS pin batch');
    } finally {
      setPinBusy(false);
    }
  }

  async function handleAddPin(e) {
    e.preventDefault();
    const text = pinInput.trim();
    if (!text) return;
    const nowIso = new Date().toISOString();
    const next = [
      ...pinnedItems,
      {
        id: crypto.randomUUID(),
        text,
        authorName: resolveAuthorHandleForStorage(user, 'Land Holder'),
        authorUsername: user?.username || '',
        authorAvatar: resolveSafeUserAvatar(user?.avatarImage || ''),
        authorAddress: user?.customPayoutAddress || user?.walletAddress || '',
        pinnedAt: nowIso,
        updatedAt: nowIso
      }
    ];
    await persistPinBatch(next);
    setPinInput('');
  }

  async function handleSavePinEdit(pinId) {
    const clean = editingPinText.trim();
    if (!clean) return;
    const next = pinnedItems.map((p) =>
      p.id === pinId ? { ...p, text: clean, updatedAt: new Date().toISOString() } : p
    );
    await persistPinBatch(next);
    setEditingPinId('');
    setEditingPinText('');
  }

  async function handleDeletePin(pinId) {
    const next = pinnedItems.filter((p) => p.id !== pinId);
    await persistPinBatch(next);
  }

  const distLabel =
    entered?.sight?.distanceMeters != null
      ? `${entered.sight.distanceMeters}m`
      : sculpture.distanceMeters != null
        ? `${sculpture.distanceMeters}m`
        : 'In View';
  const landDisplayName = resolveLandDisplayName(
    {
      customName: sculpture.parcelName || sculpture.landDisplayName || '',
      firstSculptureTitle: sculpture.title || '',
      placeName: sculpture.placeName || ''
    },
    { defaultName: 'Virtual Land' }
  );
  const isUnlocked = Boolean(roomKeyB64);
  const hasPinsTab = Boolean(
    pinMeta?.hasPins || entered?.isLandHolder || pinUnlockStatus === 'locked' || pinnedItems.length > 0
  );

  const backdropStyle =
    viewport.height > 0
      ? {
          top: `${viewport.top}px`,
          left: `${viewport.left}px`,
          height: `${viewport.height}px`,
          width: viewport.width > 0 ? `${viewport.width}px` : '100%'
        }
      : undefined;

  return (
    <div
      className={`modal-backdrop chat-board-backdrop ${
        viewport.keyboardOpen ? 'is-keyboard-open' : ''
      } ${viewport.compact ? 'is-compact-viewport' : ''}`}
      data-testid="sculpture-chat-backdrop"
      data-fullscreen="true"
      data-keyboard-open={viewport.keyboardOpen ? 'true' : 'false'}
      style={backdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`Land chat for ${landDisplayName}`}
      onClick={onClose}
    >
      <div
        className="modal-card chat-board-modal"
        data-testid="sculpture-chat-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Clean Compact Land Chat Board Header */}
        <div className="chat-board-header">
          <div className="chat-board-header-info">
            <div className="chat-board-title-row">
              <XeroIcon emoji="💬" size={18} />
              <h3 className="chat-board-title">{landDisplayName}</h3>
            </div>
            <div className="chat-board-meta-row">
              <span className="chat-board-pill is-gold">
                <XeroIcon emoji="📍" size={11} /> Land Chat
              </span>
              {(sculpture.creatorUsername || sculpture.creatorName) && (
                <UserHandleBadge
                  user={{
                    id: sculpture.creatorSub,
                    username: sculpture.creatorUsername,
                    creatorName: sculpture.creatorName,
                    avatarImage: sculpture.creatorAvatar
                  }}
                  fallback="Creator"
                  size="xs"
                />
              )}
              <span className={`chat-board-pill ${isUnlocked ? 'is-teal' : ''}`}>
                <XeroIcon emoji={isUnlocked ? '🔓' : '🔐'} size={10} />{' '}
                {isUnlocked ? 'E2EE Live' : 'Locked'} · {distLabel}
              </span>
            </div>
          </div>
          <div className="modal-header-actions">
            <GlobalNotificationBell compact testId="chat-drawer-notif-bell-btn" />
            <button
              type="button"
              className="btn btn-xs chat-board-close-btn"
              onClick={onClose}
              aria-label="Close chat"
            >
              <XeroIcon emoji="❌" size={13} />
            </button>
          </div>
        </div>

        {/* Clean 3-Tab Navigation Bar */}
        <div className="chat-board-tabs" role="tablist" aria-label="Chat board sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'chat'}
            data-testid="chat-tab-messages"
            className={`chat-board-tab ${activeTab === 'chat' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            <span>💬 Chat</span>
            <span className="chat-board-tab-count">{messages.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'pins'}
            data-testid="chat-tab-pins"
            className={`chat-board-tab ${activeTab === 'pins' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('pins')}
          >
            <span>📌 Pinned</span>
            <span className="chat-board-tab-count">{pinnedItems.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'access'}
            data-testid="chat-tab-access"
            className={`chat-board-tab ${activeTab === 'access' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('access')}
          >
            <span>🔐 Access</span>
            {pendingGrants.length > 0 && (
              <span className="chat-board-tab-count is-alert">{pendingGrants.length}</span>
            )}
          </button>
        </div>

        {errorMsg && (
          <div className="chat-board-error" role="alert">
            <XeroIcon emoji="⚠️" size={13} /> <span>{errorMsg}</span>
          </div>
        )}

        {/* TAB 1: CHAT FEED + STICKY BOTTOM COMPOSER */}
        {activeTab === 'chat' && (
          <div className="chat-board-panel is-chat-panel" role="tabpanel">
            {!user ? (
              <div className="chat-board-empty-card">
                <XeroIcon emoji="🔐" size={24} />
                <p>
                  Sign in to unlock your E2EE identity key and chat with visitors at{' '}
                  <strong>{landDisplayName}</strong>.
                </p>
                <button type="button" className="btn btn-primary" onClick={onRequestLogin}>
                  <XeroIcon emoji="🔑" size={15} /> Sign In to Chat
                </button>
              </div>
            ) : loading ? (
              <div className="chat-board-empty-card" data-testid="chat-loading-card">
                <XeroIcon emoji="⏳" size={22} />
                <p>Loading Land Chat…</p>
              </div>
            ) : !entered && errorMsg ? (
              <div className="chat-board-empty-card" data-testid="chat-error-retry-card">
                <XeroIcon emoji="⚠️" size={24} />
                <strong>Could Not Load Land Chat</strong>
                <p>{errorMsg}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="chat-retry-btn"
                  onClick={() => {
                    setLoading(true);
                    setErrorMsg('');
                    syncBoard({ force: true });
                  }}
                >
                  <XeroIcon emoji="🔄" size={14} /> Try Again
                </button>
              </div>
            ) : entered && !entered.initialized ? (
              <div className="chat-board-empty-card">
                <XeroIcon emoji="🔐" size={24} />
                <strong>Start the Location Chat Board</strong>
                <p>
                  Generates an end-to-end encrypted AES-256-GCM room key strictly on your device.
                </p>
                <button type="button" className="btn btn-primary" onClick={handleInitializeBoard}>
                  <XeroIcon emoji="🔑" size={15} /> Create E2EE Board (Epoch 1)
                </button>
              </div>
            ) : !roomKeyB64 ? (
              <div className="chat-board-locked-wrap">
                <div className="chat-board-empty-card">
                  <XeroIcon emoji="🔒" size={22} />
                  <strong>
                    Encrypted Board ({entered?.messages?.length || 0} past{' '}
                    {(entered?.messages?.length || 0) === 1 ? 'post' : 'posts'})
                  </strong>
                  <p>
                    Messages are end-to-end encrypted. Answer the on-site visual clue or wait for a
                    nearby keyholder to admit your device.
                  </p>
                </div>
                {entered?.board?.hasClue && (
                  <form onSubmit={handleUnlockClue} className="chat-board-clue-card">
                    <div className="chat-board-clue-title">
                      <XeroIcon emoji="🧩" size={14} /> On-Site Clue Unlock
                    </div>
                    <div className="chat-board-clue-prompt">
                      &ldquo;{entered.board.cluePrompt}&rdquo;
                    </div>
                    <div className="chat-board-inline-row">
                      <input
                        className="input"
                        value={clueInput}
                        onChange={(e) => setClueInput(e.target.value)}
                        placeholder="Answer visible here…"
                        required
                      />
                      <button className="btn btn-primary" type="submit" disabled={clueBusy}>
                        <XeroIcon emoji="🔑" size={13} /> {clueBusy ? '…' : 'Unlock'}
                      </button>
                    </div>
                    {clueError && <div className="chat-board-inline-err">{clueError}</div>}
                  </form>
                )}
              </div>
            ) : (
              <>
                {pinnedItems.length > 0 && (
                  <button
                    type="button"
                    className="chat-board-pin-teaser"
                    onClick={() => setActiveTab('pins')}
                  >
                    <span className="chat-board-pin-teaser-label">
                      <XeroIcon emoji="📌" size={12} /> Pinned ({pinnedItems.length}):
                    </span>
                    <span className="chat-board-pin-teaser-text">{pinnedItems[0].text}</span>
                    <span className="chat-board-pin-teaser-link">View ›</span>
                  </button>
                )}

                <div
                  ref={feedRef}
                  className="chat-board-feed"
                  data-testid="chat-board-feed"
                >
                  {messages.length === 0 ? (
                    <div className="chat-board-empty-card is-compact">
                      <XeroIcon emoji="💬" size={20} />
                      <p>
                        Board unlocked! Leave the first encrypted note for future visitors standing
                        at <strong>{landDisplayName}</strong>.
                      </p>
                    </div>
                  ) : (
                    messages.map((m) => {
                      const isMine = Boolean(user?.id && m.senderSub && m.senderSub === user.id);
                      const timeLabel = formatShortChatTime(m.createdAt);
                      return (
                        <div
                          key={m.id}
                          className={`chat-bubble ${isMine ? 'is-mine' : 'is-other'}`}
                        >
                          <div className="chat-bubble-head">
                            <UserHandleBadge
                              user={{
                                id: m.senderSub,
                                username: isMine ? user?.username || '' : '',
                                authorName: m.authorName,
                                avatarImage: isMine ? user?.avatarImage || '' : ''
                              }}
                              fallback="Artist"
                              size="xs"
                            />
                            <span className="chat-bubble-meta mono">
                              {m.verifiedSig !== false && <span title="Verified E2EE signature">🛡️</span>}
                              {m.sightDistM != null ? ` ${m.sightDistM}m` : ''}
                              {timeLabel ? ` · ${timeLabel}` : ''}
                            </span>
                          </div>
                          <div className="chat-bubble-text">{m.text}</div>
                        </div>
                      );
                    })
                  )}
                  <div ref={listEndRef} />
                </div>

                {pendingGrants.length > 0 && (
                  <div className="chat-board-pending-strip">
                    <XeroIcon emoji="⏳" size={12} /> Auto-wrapping key for {pendingGrants.length}{' '}
                    nearby verified visitor{pendingGrants.length === 1 ? '' : 's'}…
                  </div>
                )}

                <form
                  onSubmit={handleSendMessage}
                  className="chat-board-composer"
                  data-testid="chat-composer-form"
                >
                  <EmojiInput
                    className="input chat-composer-input"
                    data-testid="chat-composer-input"
                    wrapperStyle={{ flex: 1, minWidth: 0 }}
                    value={msgInput}
                    maxLength={500}
                    enterKeyHint="send"
                    autoComplete="off"
                    onFocus={() => scrollFeedToBottom(false)}
                    onChange={(e) => setMsgInput(e.target.value)}
                    placeholder="Write an encrypted note… (: for emojis)"
                    required
                  />
                  <button
                    className="btn btn-primary chat-board-send-btn"
                    data-testid="chat-composer-send"
                    type="submit"
                    disabled={sending || !msgInput.trim()}
                  >
                    <XeroIcon emoji="📤" size={14} /> {sending ? '…' : 'Send'}
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* TAB 2: PINNED IPFS NOTES */}
        {activeTab === 'pins' && (
          <div className="chat-board-panel is-pins-panel" role="tabpanel" data-testid="chat-panel-pins">
            <div className="chat-board-section-head">
              <strong>
                <XeroIcon emoji="📌" size={14} /> Parcel-Locked Pinned Notes
              </strong>
              {pinMeta?.ipfsCid && (
                <span className="mono chat-board-cid-chip">
                  ipfs://{pinMeta.ipfsCid.slice(0, 10)}… · v{pinMeta.batchSeq}
                </span>
              )}
            </div>

            {pinUnlockError && (
              <div className="chat-board-clue-card">
                <div style={{ fontSize: 12, color: 'var(--accent-gold)' }}>
                  <XeroIcon emoji="🔒" size={12} /> {pinUnlockError}
                </div>
                {pinUnlockStatus === 'locked' && (
                  <button
                    type="button"
                    className="btn btn-xs"
                    style={{ alignSelf: 'flex-start', marginTop: 6 }}
                    onClick={() => {
                      pinAttemptedRef.current = false;
                      syncBoard({ force: true });
                    }}
                  >
                    Retry Parcel Unlock
                  </button>
                )}
              </div>
            )}

            <div className="chat-board-pins-list">
              {pinnedItems.length > 0 ? (
                pinnedItems.map((pin) => (
                  <div key={pin.id} className="chat-pin-card">
                    {editingPinId === pin.id ? (
                      <div className="chat-board-inline-row">
                        <EmojiInput
                          className="input"
                          wrapperStyle={{ flex: 1, minWidth: 0 }}
                          value={editingPinText}
                          maxLength={500}
                          onChange={(e) => setEditingPinText(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          disabled={pinBusy}
                          onClick={() => handleSavePinEdit(pin.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() => setEditingPinId('')}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="chat-pin-text">{pin.text}</div>
                        <div className="chat-pin-footer">
                          <UserHandleBadge
                            user={{
                              username: pin.authorUsername || '',
                              authorName: pin.authorName,
                              avatarImage: pin.authorAvatar || ''
                            }}
                            fallback="Land Holder"
                            size="xs"
                          />
                          {entered?.isLandHolder && (
                            <span style={{ display: 'inline-flex', gap: 4 }}>
                              <button
                                type="button"
                                className="btn btn-xs"
                                disabled={pinBusy}
                                onClick={() => {
                                  setEditingPinId(pin.id);
                                  setEditingPinText(pin.text);
                                }}
                              >
                                <XeroIcon emoji="✏️" size={10} /> Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs btn-danger"
                                disabled={pinBusy}
                                onClick={() => handleDeletePin(pin.id)}
                              >
                                <XeroIcon emoji="🗑️" size={10} /> Remove
                              </button>
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ))
              ) : (
                <div className="chat-board-empty-card is-compact">
                  <XeroIcon emoji="📌" size={18} />
                  <p>
                    {entered?.isLandHolder
                      ? 'Pin an encrypted note below that only in-person visitors on this land can read.'
                      : hasPinsTab
                      ? 'No unlocked pinned notes available yet.'
                      : 'No pinned notes on this land yet.'}
                  </p>
                </div>
              )}
            </div>

            {entered?.isLandHolder && (
              <form onSubmit={handleAddPin} className="chat-board-composer" data-testid="chat-pin-composer-form">
                <EmojiInput
                  className="input chat-composer-input"
                  wrapperStyle={{ flex: 1, minWidth: 0 }}
                  value={pinInput}
                  maxLength={500}
                  enterKeyHint="send"
                  autoComplete="off"
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="Pin an encrypted IPFS note… (: for emojis)"
                  required
                />
                <button className="btn btn-primary chat-board-send-btn" type="submit" disabled={pinBusy}>
                  <XeroIcon emoji="📌" size={13} /> {pinBusy ? '…' : 'Pin'}
                </button>
              </form>
            )}
          </div>
        )}

        {/* TAB 3: ACCESS, E2EE SECURITY & ON-SITE CLUE */}
        {activeTab === 'access' && (
          <div className="chat-board-panel" role="tabpanel" data-testid="chat-panel-access">
            <div className="chat-access-grid">
              <div className="chat-access-stat">
                <span className="chat-access-label">Encryption</span>
                <strong className="chat-access-val">AES-256-GCM · Epoch {entered?.board?.keyEpoch || 1}</strong>
              </div>
              <div className="chat-access-stat">
                <span className="chat-access-label">Sight Proximity</span>
                <strong className="chat-access-val">{distLabel}</strong>
              </div>
              <div className="chat-access-stat">
                <span className="chat-access-label">Room Key Status</span>
                <strong className="chat-access-val">
                  {isUnlocked ? '🔓 Unlocked on Device' : '🔒 Awaiting Unlock'}
                </strong>
              </div>
              <div className="chat-access-stat" data-testid="chat-access-policy-stat">
                <span className="chat-access-label">Chat Access</span>
                <strong className="chat-access-val">
                  {formatLandChatAccessModeLabel(entered?.chatAccessMode)}
                </strong>
              </div>
              {entered?.chatAllowAgents !== undefined && (
                <div className="chat-access-stat" data-testid="chat-access-agents-stat">
                  <span className="chat-access-label">Paired Agents</span>
                  <strong className="chat-access-val">
                    {entered.chatAllowAgents ? '🤖 Allowed' : '🚫 Humans Only'}
                  </strong>
                </div>
              )}
              {entered?.viewerChatRole && (
                <div className="chat-access-stat" data-testid="chat-access-role-stat">
                  <span className="chat-access-label">Your Access</span>
                  <strong className="chat-access-val">
                    {entered.viewerChatRole === 'land_holder'
                      ? '👑 Land Holder'
                      : entered.viewerChatRole === 'contributor'
                      ? '🎨 Land Contributor'
                      : entered.viewerChatRole === 'whitelisted'
                      ? '✅ Whitelisted'
                      : '📍 On-Site Visitor'}
                  </strong>
                </div>
              )}
              {identity && (
                <div className="chat-access-stat">
                  <span className="chat-access-label">Device Fingerprint</span>
                  <strong className="chat-access-val mono">{identity.pubFingerprint}</strong>
                </div>
              )}
            </div>

            {sculpture.description && (
              <div className="chat-pin-card">
                <span className="chat-access-label">Artwork Description</span>
                <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.4 }}>
                  {sculpture.description}
                </div>
              </div>
            )}

            {entered?.board?.hasClue && !roomKeyB64 && (
              <form onSubmit={handleUnlockClue} className="chat-board-clue-card">
                <div className="chat-board-clue-title">
                  <XeroIcon emoji="🧩" size={14} /> Unlock with On-Site Visual Clue
                </div>
                <div className="chat-board-clue-prompt">&ldquo;{entered.board.cluePrompt}&rdquo;</div>
                <div className="chat-board-inline-row">
                  <input
                    className="input"
                    value={clueInput}
                    onChange={(e) => setClueInput(e.target.value)}
                    placeholder="Answer visible here…"
                    required
                  />
                  <button className="btn btn-primary" type="submit" disabled={clueBusy}>
                    <XeroIcon emoji="🔑" size={13} /> {clueBusy ? '…' : 'Unlock'}
                  </button>
                </div>
                {clueError && <div className="chat-board-inline-err">{clueError}</div>}
              </form>
            )}

            {user &&
              (entered?.board?.creatorSub === user.id || entered?.isLandHolder) &&
              roomKeyB64 && (
              <div className="chat-pin-card">
                <div className="chat-board-section-head" style={{ marginBottom: 6 }}>
                  <strong>
                    <XeroIcon emoji="🧩" size={13} /> On-Site Visual Clue (Optional)
                  </strong>
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => {
                      setNewCluePrompt(entered.board.cluePrompt || '');
                      setClueEditOpen((o) => !o);
                    }}
                  >
                    {clueEditOpen ? 'Close' : entered.board.hasClue ? 'Edit Clue' : '+ Add Clue'}
                  </button>
                </div>
                {!clueEditOpen && (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {entered.board.hasClue
                      ? `Active clue: "${entered.board.cluePrompt}"`
                      : 'Add a real-world question so in-person visitors can unlock this chat without waiting.'}
                  </div>
                )}
                {clueEditOpen && (
                  <form onSubmit={handleSaveClue} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    <EmojiInput
                      className="input"
                      maxLength={140}
                      value={newCluePrompt}
                      onChange={(e) => setNewCluePrompt(e.target.value)}
                      placeholder="Question visible at this location (type : for emojis)"
                    />
                    {newCluePrompt.trim() && (
                      <input
                        className="input"
                        value={newClueAnswer}
                        onChange={(e) => setNewClueAnswer(e.target.value)}
                        placeholder="Exact real-world answer (PBKDF2 hashed locally)"
                        required
                      />
                    )}
                    <button className="btn btn-primary btn-sm" type="submit" disabled={savingClue}>
                      {savingClue ? 'Saving…' : newCluePrompt.trim() ? 'Save Clue Envelope' : 'Disable Clue'}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
