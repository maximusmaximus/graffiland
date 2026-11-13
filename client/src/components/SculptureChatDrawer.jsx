import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import {
  computeRoomPossessionProof,
  decryptChatMessage,
  encryptChatMessage,
  generateRoomKeyB64,
  getOrCreateDeviceIdentity,
  loadLocalRoomKey,
  saveLocalRoomKey,
  signSightProof,
  unwrapRoomKeyFromGrant,
  unwrapRoomKeyWithClue,
  wrapRoomKeyForRecipient,
  wrapRoomKeyWithClue
} from '../utils/chatCrypto.js';
import XeroIcon from './XeroIcon.jsx';

export default function SculptureChatDrawer({
  sculpture,
  user,
  location,
  polTracker,
  cameraReady,
  initialSightProof,
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

  const syncBoard = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const idObj = await getOrCreateDeviceIdentity(user.id);
      setIdentity(idObj);
      const freshSight = await buildFreshSightProof(idObj);
      const res = await api.enterSculptureChat(sculpture.id, {
        requesterPubFp: idObj.pubFingerprint,
        sightProof: freshSight,
        deviceProfile: { isMobile: true }
      });
      setEntered(res);
      setErrorMsg('');

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
  }, [autoWrapPendingGrants, buildFreshSightProof, sculpture.id, user]);

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
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <span className="badge teal">
                <XeroIcon emoji="🔐" size={12} /> Server-Blind E2EE
              </span>
              <span className="badge">
                <XeroIcon emoji="👁️" size={12} /> {distLabel}
              </span>
            </div>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close chat">
            <XeroIcon emoji="❌" size={15} />
          </button>
        </div>

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
                  <input
                    className="input"
                    value={msgInput}
                    maxLength={500}
                    onChange={(e) => setMsgInput(e.target.value)}
                    placeholder="Send E2EE note for visitors in camera view..."
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
                        <input
                          className="input"
                          maxLength={140}
                          value={newCluePrompt}
                          onChange={(e) => setNewCluePrompt(e.target.value)}
                          placeholder="Question visible at this location (e.g. Color of bridge sign?)"
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
