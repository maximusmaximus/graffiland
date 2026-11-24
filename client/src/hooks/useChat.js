import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_SIGHT_CLIENT_DISTANCE_M,
  haversineMeters
} from '../../../shared/chatPolicy.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { api } from '../utils/api.js';
import {
  decryptPinnedIpfsBatch,
  getOrCreateDeviceIdentity,
  loadLocalRoomKey,
  signParcelPresenceProof,
  signSightProof,
  wrapRoomKeyForRecipient
} from '../utils/chatCrypto.js';
import { isWebAuthnSupported, requestPasskeyAssertion } from '../utils/passkeyClient.js';

/**
 * Manages background E2EE ECDH key-wrap auto-granting, AR Pinned IPFS message unlocking
 * (including server-verified ORB descriptors and inline Passkey enrollment/retry),
 * and launching camera-locked sculpture chat.
 */
export function useChat({
  user,
  mode,
  arTargetedSculpture,
  locationRef,
  cameraReadyRef,
  polRef,
  videoRef,
  orbPackCacheRef,
  orbTrackerRef,
  latestOrbProofRef,
  handleEnrollPasskey,
  setArSelectHint,
  showTemporaryHint
}) {
  const [chatSelection, setChatSelection] = useState(null);
  const [arPinPreview, setArPinPreview] = useState(null);
  const [pinUnlockNonce, setPinUnlockNonce] = useState(0);
  const arPinCacheRef = useRef(new Map());

  // Background ECDH key-wrap loop for sculptures whose K_room is held locally on this phone
  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    async function processPending() {
      try {
        const res = await api.listPendingChatGrants();
        const grants = res.grants || [];
        if (!grants.length || !active) return;
        const identity = await getOrCreateDeviceIdentity(user.id);
        for (const reqGrant of grants) {
          if (!active) break;
          if (reqGrant.sightDistanceM > 75 || reqGrant.sightScore < 45) continue;
          const roomKeyB64 = loadLocalRoomKey(user.id, reqGrant.sculptureId, reqGrant.keyEpoch);
          if (!roomKeyB64) continue;
          const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
            roomKeyB64,
            sculptureId: reqGrant.sculptureId,
            keyEpoch: reqGrant.keyEpoch,
            recipientEcdhPubJwk: reqGrant.requesterEcdhPubJwk,
            recipientPubFp: reqGrant.requesterPubFp,
            grantorIdentity: identity
          });
          await api.submitSculptureChatGrant(reqGrant.sculptureId, {
            targetGrantId: reqGrant.id,
            wrappedKeyJson,
            grantorEcdhPubJwk: identity.ecdhPublicJwk,
            grantorSignPubJwk: identity.signPublicJwk,
            grantSig
          });
        }
      } catch {
        // non-blocking background auto-grant
      }
    }
    const initTimer = setTimeout(processPending, 1800);
    const intervalId = setInterval(processPending, 15000);
    return () => {
      active = false;
      clearTimeout(initTimer);
      clearInterval(intervalId);
    };
  }, [user?.id]);

  // Automatic IRL AR unlock of Pinned IPFS Message batches when aiming at a parcel sculpture
  useEffect(() => {
    const sc = arTargetedSculpture?.sculpture;
    if (mode !== 'preview' || !sc?.id) {
      setArPinPreview(null);
      return undefined;
    }
    const summary = sc.pinSummary;
    const seq = Number(summary?.batchSeq || 0);
    const cacheKey = `${sc.id}:${seq}`;
    const cached = arPinCacheRef.current.get(cacheKey);
    if (cached) {
      setArPinPreview(cached);
      return undefined;
    }
    if (!summary?.hasPins) {
      setArPinPreview({
        sculptureId: sc.id,
        status: 'none',
        pins: [],
        batchSeq: 0,
        meta: summary || null,
        error: '',
        needsPasskey: false
      });
      return undefined;
    }
    if (!user?.id) {
      setArPinPreview({
        sculptureId: sc.id,
        status: 'locked',
        pins: [],
        batchSeq: seq,
        meta: summary,
        error: `Sign in & visit parcel ${sc.parcelId} in person to decrypt Pinned IPFS Messages.`,
        needsPasskey: false
      });
      return undefined;
    }

    let cancelled = false;
    setArPinPreview({
      sculptureId: sc.id,
      status: 'loading',
      pins: [],
      batchSeq: seq,
      meta: summary,
      error: '',
      needsPasskey: false
    });

    (async () => {
      try {
        const idObj = await getOrCreateDeviceIdentity(user.id);
        const ownerWallets = [user?.walletAddress, user?.customPayoutAddress]
          .filter(Boolean)
          .map((a) => a.toLowerCase());
        const ownerAddr = String(sc.recipientAddress || sc.ownerAddress || '').toLowerCase();
        if (ownerAddr && ownerWallets.includes(ownerAddr)) {
          const sealRes = await api.getOwnerPinSeal(sc.id);
          if (sealRes.encryptedBatch && !cancelled) {
            const dec = await decryptPinnedIpfsBatch({
              encryptedBatch: sealRes.encryptedBatch,
              parcelSealKeyB64: sealRes.parcelSealKeyB64,
              sculptureId: sc.id,
              parcelId: sc.parcelId,
              geohash: sc.geohash
            });
            const nextState = {
              sculptureId: sc.id,
              status: 'unlocked',
              pins: dec.pins || [],
              batchSeq: dec.batchSeq || seq,
              meta: sealRes.meta || summary,
              error: '',
              needsPasskey: false
            };
            arPinCacheRef.current.set(cacheKey, nextState);
            setArPinPreview(nextState);
          }
          return;
        }

        const loc = locationRef.current;
        const polSnap = polRef.current?.getSnapshot ? polRef.current.getSnapshot() : {};
        if (!cameraReadyRef.current || !loc) {
          throw new Error(`Point live AR camera on site inside ${sc.parcelId} to decrypt.`);
        }

        const unsignedSight = {
          selectionMethod: 'ar-camera-raycast',
          rayHit: true,
          inFrustum: true,
          cameraReady: true,
          cameraFrames: Math.max(3, polSnap.cameraFrames || 0),
          opticalFlowCorrelation: polSnap.opticalFlowCorrelation ?? 0.65,
          visualDHash: polSnap.visualDHash || '',
          lat: loc.lat,
          lng: loc.lng,
          altitude: loc.altitude ?? null,
          rayHitDistanceM: arTargetedSculpture?.distanceM ?? null,
          selectedAt: new Date().toISOString()
        };
        const freshSight = await signSightProof(idObj, {
          sculptureId: sc.id,
          parcelId: sc.parcelId,
          sightProof: unsignedSight
        });
        const ch = await api.issueParcelPinChallenge(sc.id, {
          deviceProfile: { isMobile: true }
        });
        let orbProof = latestOrbProofRef.current;
        const cachedPack = orbPackCacheRef.current.get(sc.parcelId);
        if (cachedPack && videoRef.current?.readyState >= 2) {
          const freshOrb = await orbTrackerRef.current?.matchLiveFrame(videoRef.current, cachedPack);
          if (freshOrb?.descriptorDigest) {
            orbProof = {
              descriptorDigest: freshOrb.descriptorDigest,
              inlierCount: freshOrb.inlierCount,
              reprojectionErrorPx: freshOrb.reprojectionErrorPx,
              poseCorrectionYawRad: freshOrb.poseCorrectionYawRad || 0,
              matchedDescriptors: Array.isArray(freshOrb.matchedDescriptors)
                ? freshOrb.matchedDescriptors
                : []
            };
          }
        }
        let webauthnAssertion = null;
        if (ch.webauthnRequired) {
          webauthnAssertion = await requestPasskeyAssertion(
            ch.challengeNonce,
            ch.allowedCredentialIds || []
          );
        }
        const signed = await signParcelPresenceProof(idObj, {
          sculptureId: sc.id,
          parcelId: sc.parcelId,
          geohash: sc.geohash,
          challengeId: ch.challengeId,
          challengeNonce: ch.challengeNonce,
          sightProof: freshSight,
          polSnapshot: polSnap
        });
        const unlocked = await api.unlockPinnedIpfsBatch(sc.id, {
          ...signed,
          ...(orbProof ? { orbProof } : {}),
          ...(webauthnAssertion ? { webauthnAssertion } : {}),
          deviceProfile: { isMobile: true }
        });
        if (!cancelled && unlocked.encryptedBatch && unlocked.parcelSealKeyB64) {
          const dec = await decryptPinnedIpfsBatch({
            encryptedBatch: unlocked.encryptedBatch,
            parcelSealKeyB64: unlocked.parcelSealKeyB64,
            sculptureId: sc.id,
            parcelId: sc.parcelId,
            geohash: sc.geohash
          });
          const nextState = {
            sculptureId: sc.id,
            status: 'unlocked',
            pins: dec.pins || [],
            batchSeq: dec.batchSeq || seq,
            meta: unlocked.meta || summary,
            error: '',
            needsPasskey: false
          };
          arPinCacheRef.current.set(cacheKey, nextState);
          setArPinPreview(nextState);
        }
      } catch (err) {
        if (!cancelled) {
          const msg =
            err.message ||
            `Visit parcel ${sc.parcelId} in person to decrypt Pinned IPFS Messages.`;
          const needsPasskey = /passkey/i.test(msg) && isWebAuthnSupported();
          setArPinPreview({
            sculptureId: sc.id,
            status: 'locked',
            pins: [],
            batchSeq: seq,
            meta: summary,
            error: msg,
            needsPasskey
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    arTargetedSculpture?.distanceM,
    arTargetedSculpture?.sculpture,
    cameraReadyRef,
    latestOrbProofRef,
    locationRef,
    mode,
    orbPackCacheRef,
    orbTrackerRef,
    pinUnlockNonce,
    polRef,
    user,
    videoRef
  ]);

  const enrollPasskeyAndRetryPinUnlock = useCallback(async () => {
    try {
      const ok = await handleEnrollPasskey?.();
      if (ok) {
        arPinCacheRef.current.clear();
        setPinUnlockNonce((n) => n + 1);
        showTemporaryHint('🛡️ Passkey enrolled — re-checking parcel unlock...');
      }
    } catch (err) {
      showTemporaryHint(err.message || 'Passkey enrollment cancelled.');
    }
  }, [handleEnrollPasskey, showTemporaryHint]);

  const openCameraSelectedChat = useCallback(
    (sc, rayHitDistanceM = null, pinPreviewData = null) => {
      if (!sc) return;
      const loc = locationRef.current;
      if (!cameraReadyRef.current) {
        showTemporaryHint('Live mobile camera stream must be active to enter land chat.');
        return;
      }
      if (!loc) {
        showTemporaryHint('Waiting for GPS fix before unlocking land chat.');
        return;
      }
      const targetLat = Number(sc.lat ?? sc.centerLat);
      const targetLng = Number(sc.lng ?? sc.centerLng);
      const landLabel = resolveLandDisplayName(
        {
          customName: sc.parcelName || sc.customName || '',
          firstSculptureTitle: sc.title || ''
        },
        { defaultName: sc.title || 'this land' }
      );
      if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
        const distM = haversineMeters(loc.lat, loc.lng, targetLat, targetLng);
        if (distM > CHAT_SIGHT_CLIENT_DISTANCE_M) {
          showTemporaryHint(
            `"${landLabel}" is ${Math.round(distM)}m away — walk within ${CHAT_SIGHT_CLIENT_DISTANCE_M}m in person to unlock Land Chat.`
          );
          return;
        }
      }
      const polSnap = polRef.current.getSnapshot();
      if ((polSnap.cameraFrames || 0) < 2) {
        showTemporaryHint('Hold live camera steady for a moment to verify Proof of Sight.');
        return;
      }
      setArSelectHint('');
      setChatSelection({
        sculpture: sc,
        pinData:
          pinPreviewData?.sculptureId === sc.id
            ? {
                unlocked: pinPreviewData.status === 'unlocked',
                pins: pinPreviewData.pins || [],
                batchSeq: pinPreviewData.batchSeq || 0,
                meta: pinPreviewData.meta || sc.pinSummary || null,
                error: pinPreviewData.error || ''
              }
            : null,
        sightProof: {
          selectionMethod: 'ar-camera-raycast',
          rayHit: true,
          inFrustum: true,
          cameraReady: true,
          cameraFrames: polSnap.cameraFrames,
          opticalFlowCorrelation: polSnap.opticalFlowCorrelation,
          visualDHash: polSnap.visualDHash,
          lat: loc.lat,
          lng: loc.lng,
          altitude: loc.altitude ?? null,
          rayHitDistanceM: Number.isFinite(rayHitDistanceM) ? Math.round(rayHitDistanceM * 100) / 100 : null,
          selectedAt: new Date().toISOString()
        }
      });
    },
    [cameraReadyRef, locationRef, polRef, setArSelectHint, showTemporaryHint]
  );

  return {
    chatSelection,
    setChatSelection,
    arPinPreview,
    arPinCacheRef,
    enrollPasskeyAndRetryPinUnlock,
    openCameraSelectedChat
  };
}
