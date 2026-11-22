import React, { useCallback, useEffect, useRef, useState } from 'react';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { api } from '../utils/api.js';
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
import XeroIcon from './XeroIcon.jsx';

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

  const reqSentRef = useRef(false);
  const autoInitRef = useRef(false);
  const pinAttemptedRef = useRef(false);
  const lastUnlockedSeqRef = useRef(Number(initialPinData?.batchSeq || 0));
  const sightRef = useRef(initialSightProof);
  const listEndRef = useRef(null);

  const buildFreshSightProof = useCallback(
    async (idObj) => {
      const snap = polTracker?.getSnapshot ? polTracker.getSnapshot() : {};
      const base = {
        ...(sightRef.current || {}),
        selectionMethod: 'ar-camera-raycast',
        rayHit: true,
        inFrustum: true,
        cameraReady: Boolean(cameraReady),
        cameraFrames: Math.max(snap.cameraFrames || 0, sightRef.current?.cameraFrames || 2),
        opticalFlowCorrelation: snap.opticalFlowCorrelation ?? sightRef.current?.opticalFlowCorrelation ?? 0.65,
        visualDHash: snap.visualDHash || sightRef.current?.visualDHash || '',
        lat: location?.lat ?? sightRef.current?.lat,
        lng: location?.lng ?? sightRef.current?.lng,
        altitude: location?.altitude ?? sightRef.current?.altitude ?? null,
        selectedAt: new Date().toISOString()
      };
      if (!idObj) return base;
      return signSightProof(idObj, {
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        sightProof: base
      });
    },
    [cameraReady, location, polTracker, sculpture.id, sculpture.parcelId]
  );

  const autoWrapPendingGrants = useCallback(
    async (activeKeyB64, activeIdentity) => {
      if (!activeKeyB64 || !activeIdentity) return;
      try {
        const res = await api.listSculpturePendingGrants(sculpture.id);
        const list = res.grants || [];
        setPendingGrants(list);
        for (const reqGrant of list) {
          if (reqGrant.sightDistanceM <= 75 && reqGrant.sightScore >= 45) {
            const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
              roomKeyB64: activeKeyB64,
              sculptureId: sculpture.id,
              keyEpoch: reqGrant.keyEpoch,
              recipientEcdhPubJwk: reqGrant.requesterEcdhPubJwk,
              recipientPubFp: reqGrant.requesterPubFp,
              grantorIdentity: activeIdentity
            });
            await api.submitSculptureChatGrant(sculpture.id, {
              targetGrantId: reqGrant.id,
              wrappedKeyJson,
              grantorEcdhPubJwk: activeIdentity.ecdhPublicJwk,
              grantorSignPubJwk: activeIdentity.signPublicJwk,
              grantSig
            });
          }
        }
        if (list.length > 0) {
          const refreshed = await api.listSculpturePendingGrants(sculpture.id);
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

      if (res?.isLandHolder) {
        if (lastUnlockedSeqRef.current === serverSeq && serverSeq > 0 && pinUnlockStatus === 'unlocked') {
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

      if (lastUnlockedSeqRef.current === serverSeq && pinUnlockStatus === 'unlocked') {
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
        const snap = polTracker?.getSnapshot ? polTracker.getSnapshot() : {};
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
    [pinUnlockStatus, polTracker, sculpture.geohash, sculpture.id, sculpture.parcelId]
  );

  const syncBoard = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const idObj = await getOrCreateDeviceIdentity(user.id);
      setIdentity(idObj);
      const freshSight = await buildFreshSightProof(idObj);
      let res = await api.enterSculptureChat(sculpture.id, {
        requesterPubFp: idObj.pubFingerprint,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });

      // Automatically join/initialize the sculpture's chatbox on selection so the selector is immediately part of it
      if (!res.initialized && !autoInitRef.current) {
        autoInitRef.current = true;
        try {
          const keyB64 = generateRoomKeyB64();
          const epoch = 1;
          saveLocalRoomKey(user.id, sculpture.id, epoch, keyB64);
          const { roomKeyCommit } = await computeRoomPossessionProof(keyB64, sculpture.id, epoch);
          const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
            roomKeyB64: keyB64,
            sculptureId: sculpture.id,
            keyEpoch: epoch,
            recipientEcdhPubJwk: idObj.ecdhPublicJwk,
            recipientPubFp: idObj.pubFingerprint,
            grantorIdentity: idObj
          });
          await api.initSculptureChat(sculpture.id, {
            ownerEcdhPubJwk: idObj.ecdhPublicJwk,
            ownerSignPubJwk: idObj.signPublicJwk,
            ownerPubFp: idObj.pubFingerprint,
            selfGrantEnvelope: wrappedKeyJson,
            selfGrantSig: grantSig,
            roomKeyCommit,
            sightProof: freshSight,
            deviceProfile: { isMobile: true }
          });
          res = await api.enterSculptureChat(sculpture.id, {
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

      setEntered(res);
      setErrorMsg('');

      await syncPinnedBatch(res, idObj, freshSight);

      if (!res.initialized || !res.board) {
        setRoomKeyB64('');
        setMessages([]);
        return;
      }

      const epoch = res.board.keyEpoch;
      let activeKey = loadLocalRoomKey(user.id, sculpture.id, epoch);

      if (!activeKey && res.myGrant?.status === 'granted' && res.myGrant?.wrappedKeyJson) {
        try {
          activeKey = await unwrapRoomKeyFromGrant({
            wrappedKeyJson: res.myGrant.wrappedKeyJson,
            grantSig: res.myGrant.grantSig,
            grantorSignPubJwk: res.myGrant.grantorSignPubJwk,
            sculptureId: sculpture.id,
            keyEpoch: epoch,
            identity: idObj
          });
          saveLocalRoomKey(user.id, sculpture.id, epoch, activeKey);
        } catch (err) {
          setErrorMsg(err.message || 'Could not unwrap granted chat key.');
        }
      }

      // If locked and no pending/granted request submitted yet, submit an ECDH grant request automatically
      if (!activeKey && !res.myGrant && !reqSentRef.current) {
        reqSentRef.current = true;
        await api
          .requestSculptureChatGrant(sculpture.id, {
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
              sculptureId: sculpture.id
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
          await autoWrapPendingGrants(activeKey, idObj);
        } else {
          setPendingGrants([]);
        }
      } else {
        setMessages([]);
      }
    } catch (err) {
      setErrorMsg(err.message || 'Unable to verify AR camera sight for chat');
    } finally {
      setLoading(false);
    }
  }, [autoWrapPendingGrants, buildFreshSightProof, sculpture.id, syncPinnedBatch, user]);

  useEffect(() => {
    syncBoard();
    const timer = setInterval(syncBoard, 2800);
    return () => clearInterval(timer);
  }, [syncBoard]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleInitializeBoard() {
    if (!user || !identity) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const keyB64 = generateRoomKeyB64();
      const epoch = 1;
      saveLocalRoomKey(user.id, sculpture.id, epoch, keyB64);
      const { roomKeyCommit } = await computeRoomPossessionProof(keyB64, sculpture.id, epoch);
      const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
        roomKeyB64: keyB64,
        sculptureId: sculpture.id,
        keyEpoch: epoch,
        recipientEcdhPubJwk: identity.ecdhPublicJwk,
        recipientPubFp: identity.pubFingerprint,
        grantorIdentity: identity
      });
      const freshSight = await buildFreshSightProof(identity);
      await api.initSculptureChat(sculpture.id, {
        ownerEcdhPubJwk: identity.ecdhPublicJwk,
        ownerSignPubJwk: identity.signPublicJwk,
        ownerPubFp: identity.pubFingerprint,
        selfGrantEnvelope: wrappedKeyJson,
        selfGrantSig: grantSig,
        roomKeyCommit,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });
      await syncBoard();
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
      const epoch = entered.board.keyEpoch;
      const unlocked = await unwrapRoomKeyWithClue({
        clueWrappedJson: entered.board.clueWrappedJson,
        sculptureId: sculpture.id,
        keyEpoch: epoch,
        clueAnswer: clueInput
      });
      saveLocalRoomKey(user.id, sculpture.id, epoch, unlocked);

      // Prove knowledge of K_room via blinded HMAC commitment so viewer joins peer group cleanly
      const { roomProofToken } = await computeRoomPossessionProof(unlocked, sculpture.id, epoch);
      const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
        roomKeyB64: unlocked,
        sculptureId: sculpture.id,
        keyEpoch: epoch,
        recipientEcdhPubJwk: identity.ecdhPublicJwk,
        recipientPubFp: identity.pubFingerprint,
        grantorIdentity: identity
      });
      const freshSight = await buildFreshSightProof(identity);
      await api.claimClueChatGrant(sculpture.id, {
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
      await syncBoard();
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
      const epoch = entered?.board?.keyEpoch || 1;
      const freshSight = await buildFreshSightProof(identity);
      const payload = await encryptChatMessage({
        roomKeyB64,
        sculptureId: sculpture.id,
        keyEpoch: epoch,
        senderSub: user.id,
        identity,
        text: msgInput,
        authorName: user.name || 'Artist',
        sightDistM: entered?.sight?.distanceMeters ?? null,
        altM: location?.altitude != null ? Math.round(location.altitude) : null
      });
      await api.postSculptureChatMessage(sculpture.id, {
        ...payload,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });
      setMsgInput('');
      await syncBoard();
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
      const epoch = entered.board.keyEpoch;
      let clueWrappedJson = '';
      if (newCluePrompt.trim()) {
        clueWrappedJson = await wrapRoomKeyWithClue({
          roomKeyB64,
          sculptureId: sculpture.id,
          keyEpoch: epoch,
          clueAnswer: newClueAnswer
        });
      }
      await api.updateSculptureChatClue(sculpture.id, {
        cluePrompt: newCluePrompt.trim(),
        clueWrappedJson,
        deviceProfile: { isMobile: true }
      });
      setClueEditOpen(false);
      setNewClueAnswer('');
      await syncBoard();
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
        authorName: user?.name || 'Land Holder',
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
      ? `${entered.sight.distanceMeters}m away`
      : sculpture.distanceMeters != null
        ? `${sculpture.distanceMeters}m away`
        : 'In Camera View';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title" style={{ fontSize: 16 }}>
              <XeroIcon emoji="💬" size={20} /> {sculpture.title}
            </h3>
            {sculpture.description && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.35 }}>
                {sculpture.description}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <span className="badge teal">
                <XeroIcon emoji="🔐" size={12} /> Server-Blind E2EE
              </span>
              <span className="badge">
                <XeroIcon emoji="👁️" size={12} /> {distLabel}
              </span>
              <span className="badge gold">
                <XeroIcon emoji="📍" size={12} />{' '}
                {resolveLandDisplayName(
                  {
                    customName: sculpture.parcelName || sculpture.landDisplayName || '',
                    firstSculptureTitle: sculpture.title || '',
                    placeName: sculpture.placeName || ''
                  },
                  { defaultName: 'Virtual Land' }
                )}
              </span>
            </div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close chat">
            <XeroIcon emoji="❌" size={15} />
          </button>
        </div>

        {(pinMeta?.hasPins || entered?.isLandHolder || pinUnlockStatus === 'locked' || pinnedItems.length > 0) && (
          <div className="pin-batch-box" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--accent-gold)' }}>
                <XeroIcon emoji="📌" size={14} /> Land Holder Pinned IPFS Batch
              </span>
              {pinMeta?.ipfsCid && (
                <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                  ipfs://{pinMeta.ipfsCid.slice(0, 12)}... · v{pinMeta.batchSeq}
                </span>
              )}
            </div>

            {pinUnlockError && (
              <div style={{ fontSize: 11, color: 'var(--accent-gold)', marginBottom: 6 }}>
                <XeroIcon emoji="🔒" size={12} /> {pinUnlockError}
                {pinUnlockStatus === 'locked' && (
                  <button
                    type="button"
                    className="btn"
                    style={{ marginLeft: 8, padding: '2px 7px', fontSize: 10 }}
                    onClick={() => {
                      pinAttemptedRef.current = false;
                      syncBoard();
                    }}
                  >
                    Retry Parcel Unlock
                  </button>
                )}
              </div>
            )}

            {pinnedItems.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pinnedItems.map((pin) => (
                  <div
                    key={pin.id}
                    className="card"
                    style={{ padding: '7px 9px', borderColor: 'rgba(255, 209, 102, 0.35)' }}
                  >
                    {editingPinId === pin.id ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <EmojiInput
                          className="input"
                          wrapperStyle={{ flex: 1, minWidth: 0 }}
                          value={editingPinText}
                          maxLength={500}
                          onChange={(e) => setEditingPinText(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          disabled={pinBusy}
                          onClick={() => handleSavePinEdit(pin.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          onClick={() => setEditingPinId('')}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{pin.text}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 10, color: 'var(--muted)' }}>
                          <span>
                            {pin.authorName} · Encrypted on IPFS for{' '}
                            {resolveLandDisplayName(
                              {
                                customName: sculpture.parcelName || sculpture.landDisplayName || '',
                                firstSculptureTitle: sculpture.title || '',
                                placeName: sculpture.placeName || ''
                              },
                              { defaultName: 'this land' }
                            )}
                          </span>
                          {entered?.isLandHolder && (
                            <span style={{ display: 'flex', gap: 4 }}>
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '2px 6px', fontSize: 10 }}
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
                                className="btn btn-danger"
                                style={{ padding: '2px 6px', fontSize: 10 }}
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
                ))}
              </div>
            ) : entered?.isLandHolder ? (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                No pinned messages yet. Add an encrypted note below that only real-life visitors on this parcel can decrypt.
              </div>
            ) : null}

            {entered?.isLandHolder && (
              <form onSubmit={handleAddPin} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <EmojiInput
                  className="input"
                  wrapperStyle={{ flex: 1, minWidth: 0 }}
                  value={pinInput}
                  maxLength={500}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="Pin encrypted IPFS message (type : for emojis)..."
                  required
                />
                <button className="btn btn-primary" type="submit" disabled={pinBusy} style={{ fontSize: 11 }}>
                  <XeroIcon emoji="📌" size={13} /> {pinBusy ? '...' : 'Pin'}
                </button>
              </form>
            )}
          </div>
        )}

        {!user ? (
          <div className="card" style={{ textAlign: 'center', padding: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              Sign in with Google to generate your device&apos;s E2EE identity key and enter this
              location&apos;s encrypted sculpture chat board.
            </p>
            <button className="btn btn-primary" onClick={onRequestLogin}>
              <XeroIcon emoji="🔑" size={16} /> Google Sign-In
            </button>
          </div>
        ) : loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            <XeroIcon emoji="⏳" size={18} /> Verifying AR camera sight &amp; decrypting board...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {errorMsg && (
              <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 12 }}>
                {errorMsg}
              </div>
            )}

            {entered && !entered.initialized ? (
              <div className="card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                  <XeroIcon emoji="🔐" size={16} /> Initialize Encrypted Location Board
                </div>
                <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>
                  No chat board key has been created for this sculpture yet. Initializing generates
                  a 256-bit client-side AES-GCM key exclusively on your device.
                </p>
                <button className="btn btn-primary" onClick={handleInitializeBoard}>
                  <XeroIcon emoji="🔑" size={15} /> Create E2EE Board (Epoch 1)
                </button>
              </div>
            ) : !roomKeyB64 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="card" style={{ padding: 12, fontSize: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <XeroIcon emoji="🔒" size={16} /> Board Key Required to Decrypt ({entered?.messages?.length || 0} past posts)
                  </div>
                  <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.45 }}>
                    Past messages are end-to-end encrypted in AES-256-GCM. Neither the map,
                    desktop browsers, nor our server can decrypt them.
                  </p>
                  {identity && (
                    <div className="mono" style={{ fontSize: 10, color: 'var(--accent)', marginTop: 8 }}>
                      Device Key FP: {identity.pubFingerprint} · Status: Waiting for ECDH wrap
                    </div>
                  )}
                </div>

                {entered?.board?.hasClue && (
                  <form onSubmit={handleUnlockClue} className="card" style={{ padding: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <XeroIcon emoji="🧩" size={15} /> Unlock Instantly with On-Site Clue
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--gold)', marginBottom: 8 }}>
                      &ldquo;{entered.board.cluePrompt}&rdquo;
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="input"
                        value={clueInput}
                        onChange={(e) => setClueInput(e.target.value)}
                        placeholder="Answer visible at this physical spot"
                        required
                      />
                      <button className="btn btn-primary" type="submit" disabled={clueBusy}>
                        <XeroIcon emoji="🔑" size={14} /> {clueBusy ? '...' : 'Unlock'}
                      </button>
                    </div>
                    {clueError && (
                      <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 6 }}>{clueError}</div>
                    )}
                  </form>
                )}

                <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
                  Your camera sight request is queued automatically for the creator or nearby keyholders.
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    maxHeight: 270,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    paddingRight: 2
                  }}
                >
                  {messages.length === 0 ? (
                    <div className="card" style={{ padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
                      <XeroIcon emoji="💬" size={18} />
                      <div style={{ marginTop: 6 }}>
                        Location board unlocked! Leave the first encrypted note for future visitors standing here.
                      </div>
                    </div>
                  ) : (
                    messages.map((m) => (
                      <div key={m.id} className="card" style={{ padding: '8px 10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, marginBottom: 4 }}>
                          <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <XeroIcon emoji="🛡️" size={12} /> {m.authorName}
                          </span>
                          <span className="mono" style={{ color: 'var(--muted)', fontSize: 10 }}>
                            {m.sightDistM != null ? `${m.sightDistM}m` : ''}
                            {m.altM != null ? ` · ${m.altM}m alt` : ''}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.4 }}>{m.text}</div>
                      </div>
                    ))
                  )}
                  <div ref={listEndRef} />
                </div>

                <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: 6 }}>
                  <EmojiInput
                    className="input"
                    wrapperStyle={{ flex: 1, minWidth: 0 }}
                    value={msgInput}
                    maxLength={500}
                    onChange={(e) => setMsgInput(e.target.value)}
                    placeholder="Send E2EE note (type : for emojis)..."
                    required
                  />
                  <button className="btn btn-primary" type="submit" disabled={sending}>
                    <XeroIcon emoji="📤" size={15} /> {sending ? '...' : 'Send'}
                  </button>
                </form>

                {pendingGrants.length > 0 && (
                  <div className="badge gold" style={{ alignSelf: 'flex-start' }}>
                    <XeroIcon emoji="⏳" size={13} /> Auto-wrapping {pendingGrants.length} verified viewer(s)...
                  </div>
                )}

                {entered?.board?.creatorSub === user.id && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 11, padding: '5px 9px' }}
                      onClick={() => {
                        setNewCluePrompt(entered.board.cluePrompt || '');
                        setClueEditOpen((o) => !o);
                      }}
                    >
                      <XeroIcon emoji="🧩" size={13} />{' '}
                      {entered.board.hasClue ? 'Update On-Site Visual Clue' : 'Add Optional On-Site Clue'}
                    </button>
                    {clueEditOpen && (
                      <form onSubmit={handleSaveClue} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
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
                        <button className="btn btn-primary" type="submit" disabled={savingClue}>
                          {savingClue ? 'Saving...' : newCluePrompt.trim() ? 'Save Clue Envelope' : 'Disable Clue'}
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
