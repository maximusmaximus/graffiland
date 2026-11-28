import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildLandAdd3DItemAgentPrompt } from '../../../shared/landSignatureMessage.mjs';
import {
  buildParcelShareUrl,
  resolveLandDisplayName
} from '../../../shared/landVolume.mjs';
import {
  buildPlacementItemFromSculpture,
  evaluateModelFitInParcel,
  resolveParcelVolumeForPlacement
} from '../../../shared/sculpturePlacement.mjs';
import { api, API_BASE } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { isLandOwnedByUser } from '../utils/landMapHelpers.js';
import { EmojiInput, EmojiTextarea } from './EmojiField.jsx';
import Catalog3DSearchBox from './Catalog3DSearchBox.jsx';
import InfoTip from './InfoTip.jsx';
import { GlobalNotificationBell } from './NotificationCenter.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

const SUPPORTED_ITEM_TYPES = [
  {
    id: 'voxel',
    label: '3D Voxel Sculpture',
    ext: 'VOXEL',
    note: '4x grid (0.05m), up to 4,096 blocks, matte / neon / glass',
    example: 'Agent JSON or Mobile AR'
  },
  {
    id: 'glb',
    label: '.GLB 3D Model',
    ext: 'GLB',
    note: 'Binary glTF 2.0 (Draco & Meshopt supported, <= 4 MB, <= 150k tris)',
    example: 'https://.../sculpture.glb'
  },
  {
    id: 'gltf',
    label: '.GLTF 3D Model',
    ext: 'GLTF',
    note: 'Standard glTF 2.0 JSON scene mesh (<= 4 MB)',
    example: 'https://.../scene.gltf'
  },
  {
    id: 'obj',
    label: '.OBJ 3D Mesh',
    ext: 'OBJ',
    note: 'Wavefront OBJ polygon geometry (<= 4 MB)',
    example: 'https://.../statue.obj'
  },
  {
    id: 'stl',
    label: '.STL 3D Mesh',
    ext: 'STL',
    note: 'ASCII or binary 3D print / sculptural mesh (<= 4 MB)',
    example: 'https://.../monument.stl'
  },
  {
    id: 'ply',
    label: '.PLY 3D Mesh',
    ext: 'PLY',
    note: 'Polygon mesh or color point cloud (<= 4 MB)',
    example: 'https://.../scan.ply'
  }
];

const VOXEL_STYLES = ['custom', 'plinth', 'arch', 'totem', 'pyramid', 'beacon'];

function ModelFormatMiniIllustration({ formatId }) {
  if (formatId === 'voxel') {
    return (
      <svg className="model-format-svg" viewBox="0 0 44 36" aria-hidden="true">
        <polygon points="10,20 22,14 34,20 22,26" fill="#00f5d4" opacity="0.9" />
        <polygon points="10,20 22,26 22,33 10,27" fill="#00bbf9" opacity="0.85" />
        <polygon points="34,20 22,26 22,33 34,27" fill="#0891b2" opacity="0.9" />
        <polygon points="15,11 22,7 29,11 22,15" fill="#ffd166" />
        <polygon points="15,11 22,15 22,21 15,17" fill="#ff3e7f" />
        <polygon points="29,11 22,15 22,21 29,17" fill="#c026d3" />
      </svg>
    );
  }
  if (formatId === 'glb') {
    return (
      <svg className="model-format-svg" viewBox="0 0 44 36" aria-hidden="true">
        <defs>
          <radialGradient id="glbOrb" cx="35%" cy="30%" r="68%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor="#00f5d4" />
            <stop offset="100%" stopColor="#0f3d5e" />
          </radialGradient>
        </defs>
        <ellipse cx="22" cy="31" rx="13" ry="3" fill="rgba(0,245,212,0.22)" />
        <circle cx="22" cy="17" r="12" fill="url(#glbOrb)" stroke="#7efce7" strokeWidth="1.2" />
        <ellipse cx="22" cy="17" rx="12" ry="4.5" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="1" />
      </svg>
    );
  }
  if (formatId === 'gltf') {
    return (
      <svg className="model-format-svg" viewBox="0 0 44 36" aria-hidden="true">
        <polygon points="22,4 36,12 36,26 22,34 8,26 8,12" fill="rgba(0,187,249,0.18)" stroke="#00bbf9" strokeWidth="1.6" />
        <line x1="22" y1="4" x2="22" y2="34" stroke="#00f5d4" strokeWidth="1.2" />
        <line x1="8" y1="12" x2="36" y2="26" stroke="#ffd166" strokeWidth="1.1" opacity="0.8" />
        <line x1="36" y1="12" x2="8" y2="26" stroke="#ff3e7f" strokeWidth="1.1" opacity="0.8" />
        <circle cx="22" cy="19" r="3" fill="#ffffff" />
      </svg>
    );
  }
  if (formatId === 'obj') {
    return (
      <svg className="model-format-svg" viewBox="0 0 44 36" aria-hidden="true">
        <polygon points="22,4 35,28 9,28" fill="rgba(255,62,127,0.2)" stroke="#ff3e7f" strokeWidth="1.6" />
        <line x1="22" y1="4" x2="22" y2="28" stroke="#ffd166" strokeWidth="1.2" />
        <line x1="15.5" y1="16" x2="28.5" y2="16" stroke="#00f5d4" strokeWidth="1.2" />
        <circle cx="22" cy="4" r="2.2" fill="#ffffff" />
        <circle cx="35" cy="28" r="2.2" fill="#ffffff" />
        <circle cx="9" cy="28" r="2.2" fill="#ffffff" />
      </svg>
    );
  }
  if (formatId === 'stl') {
    return (
      <svg className="model-format-svg" viewBox="0 0 44 36" aria-hidden="true">
        <polygon points="22,4 34,15 22,32 10,15" fill="rgba(255,209,102,0.25)" stroke="#ffd166" strokeWidth="1.6" />
        <polygon points="22,4 34,15 22,19" fill="rgba(255,209,102,0.45)" />
        <polygon points="22,4 10,15 22,19" fill="rgba(0,245,212,0.35)" />
        <line x1="22" y1="19" x2="22" y2="32" stroke="#ffd166" strokeWidth="1.2" />
      </svg>
    );
  }
  // PLY point cloud
  return (
    <svg className="model-format-svg" viewBox="0 0 44 36" aria-hidden="true">
      <circle cx="22" cy="8" r="2.4" fill="#00f5d4" />
      <circle cx="14" cy="13" r="2.1" fill="#ffd166" />
      <circle cx="30" cy="13" r="2.1" fill="#ff3e7f" />
      <circle cx="22" cy="17" r="2.6" fill="#ffffff" />
      <circle cx="11" cy="22" r="2" fill="#00bbf9" />
      <circle cx="20" cy="24" r="2.1" fill="#00f5d4" />
      <circle cx="32" cy="22" r="2.1" fill="#ffd166" />
      <circle cx="16" cy="30" r="1.9" fill="#ff3e7f" />
      <circle cx="27" cy="29" r="2" fill="#00bbf9" />
    </svg>
  );
}

function formatByteSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function AddLandItemModal({
  parcel,
  existingSculptures = [],
  user = null,
  mcpState = null,
  onMcpStateChange = null,
  onToggleFreeze = null,
  onToggleSculptureVisibility = null,
  onSculptureUploaded = null,
  onSelectSculpture = null,
  onOpenLandManagement = null,
  onRequestLogin = null,
  onClose
}) {
  const [itemFormat, setItemFormat] = useState('glb');
  const [itemTitle, setItemTitle] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [stylePreset, setStylePreset] = useState('custom');
  const [modelUrl, setModelUrl] = useState('');
  const [modelScale, setModelScale] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [dz, setDz] = useState(0);
  const [yaw, setYaw] = useState(0);

  const [validationState, setValidationState] = useState(null); // { status: 'checking'|'valid'|'invalid', data?, error? }
  const [uploadBusy, setUploadBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [visBusyId, setVisBusyId] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [serverFitHint, setServerFitHint] = useState(null);
  const [pairingOverride, setPairingOverride] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [promptCopyState, setPromptCopyState] = useState(null); // { status: 'copied'|'fallback', verifiedChars, verifiedLines, pairingCode, hasRealPairing }
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const promptTextareaRef = useRef(null);
  const copyResetTimerRef = useRef(null);
  const shareResetTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      if (shareResetTimerRef.current) clearTimeout(shareResetTimerRef.current);
    };
  }, []);

  const apiOrigin =
    API_BASE ||
    (typeof window !== 'undefined'
      ? window.location.origin
      : 'https://graffiland-api.maxinfeld-artshow.workers.dev');

  const activePairingCode =
    pairingOverride ||
    mcpState?.activePairing?.code ||
    mcpState?.pairings?.find((p) => p.status === 'active' || p.status === 'pending')?.code ||
    '<YOUR_GLP_PAIRING_CODE>';

  const ownerAddress =
    user?.activeMintRecipient || user?.walletAddress || '<YOUR_WALLET_ADDRESS>';

  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);
  const requiresApproval = Boolean(parcel?.requireApproval || parcel?.settings?.requireApproval);
  const isLandOwner = useMemo(() => {
    if (!user?.id || !parcel) return true;
    const hasOwnerInfo = Boolean(
      parcel.ownerSub ||
        parcel.stewardSub ||
        parcel.firstClaimantAddress ||
        parcel.ownerAddress
    );
    if (!hasOwnerInfo) return true;
    return isLandOwnedByUser(parcel, user);
  }, [parcel, user]);
  const activeTypeInfo =
    SUPPORTED_ITEM_TYPES.find((t) => t.id === itemFormat) || SUPPORTED_ITEM_TYPES[0];

  const promptText = useMemo(
    () =>
      buildLandAdd3DItemAgentPrompt({
        parcel,
        itemFormat,
        itemTitle:
          itemTitle.trim() ||
          `Custom ${itemFormat === 'voxel' ? 'Voxel' : itemFormat.toUpperCase()} Artwork`,
        itemDescription: itemDescription.trim(),
        stylePreset,
        modelUrl: modelUrl.trim(),
        anchorOffset: {
          dx: Number(dx || 0),
          dy: Number(dy || 0),
          dz: Number(dz || 0),
          yaw: Number(yaw || 0)
        },
        existingSculptures,
        apiOrigin,
        pairingCode: activePairingCode,
        ownerAddress
      }),
    [
      parcel,
      itemFormat,
      itemTitle,
      itemDescription,
      stylePreset,
      modelUrl,
      dx,
      dy,
      dz,
      yaw,
      existingSculptures,
      apiOrigin,
      activePairingCode,
      ownerAddress
    ]
  );

  const liveLandFit = useMemo(() => {
    const validatedData = validationState?.status === 'valid' ? validationState.data : null;
    if (!validatedData || !parcel) return null;
    const bbox = validatedData.stats?.bbox || null;
    if (!bbox) return validatedData.landFit || null;
    const vol = resolveParcelVolumeForPlacement({ parcel });
    const existingItems = (existingSculptures || [])
      .filter((sc) => sc && !sc.hidden)
      .map((sc) => buildPlacementItemFromSculpture(sc, vol));
    return evaluateModelFitInParcel({
      parcelVolume: vol,
      bbox,
      modelScale: Number(modelScale || 1),
      anchorOffset: {
        dx: Number(dx || 0),
        dy: Number(dy || 0),
        dz: Number(dz || 0),
        yaw: Number(yaw || 0)
      },
      existingItems
    });
  }, [validationState, parcel, existingSculptures, modelScale, dx, dy, dz, yaw]);

  const promptValidation = useMemo(() => {
    const clean = String(promptText || '');
    const parcelId = String(parcel?.parcelId || '');
    const hasParcelId = Boolean(parcelId && clean.includes(parcelId));
    const hasMcpEndpoint = clean.includes('/api/mcp');
    const hasRealPairing =
      activePairingCode !== '<YOUR_GLP_PAIRING_CODE>' && clean.includes(activePairingCode);
    const willAutoPair = Boolean(user?.id && activePairingCode === '<YOUR_GLP_PAIRING_CODE>');
    const charCount = clean.length;
    const lineCount = clean ? clean.split('\n').length : 0;
    return {
      ready: Boolean(clean.trim().length > 0 && hasParcelId && hasMcpEndpoint),
      hasParcelId,
      hasMcpEndpoint,
      hasRealPairing,
      willAutoPair,
      charCount,
      lineCount
    };
  }, [promptText, parcel?.parcelId, activePairingCode, user?.id]);

  // Clear stale "copied" highlight if user customizes prompt fields afterward
  useEffect(() => {
    setPromptCopyState((prev) => (prev?.status === 'copied' ? null : prev));
  }, [promptText]);

  if (!parcel) return null;

  async function handleValidateModelLink() {
    const cleanUrl = modelUrl.trim();
    if (!cleanUrl) {
      setValidationState({
        status: 'invalid',
        error: 'Paste a public 3D model URL (https://... or ipfs://...) first.'
      });
      return null;
    }
    setValidationState({ status: 'checking' });
    setStatusMsg('');
    setStatusIsError(false);
    setServerFitHint(null);
    try {
      const res = await api.validateModelUrl({
        modelUrl: cleanUrl,
        parcelId: parcel.parcelId,
        modelScale: Number(modelScale || 1),
        anchorOffset: {
          dx: Number(dx || 0),
          dy: Number(dy || 0),
          dz: Number(dz || 0),
          yaw: Number(yaw || 0)
        }
      });
      if (res?.valid) {
        if (res.format && SUPPORTED_ITEM_TYPES.some((t) => t.id === res.format)) {
          setItemFormat(res.format);
        }
        if (!itemTitle.trim() && res.suggestedTitle) {
          setItemTitle(res.suggestedTitle);
        }
        setValidationState({ status: 'valid', data: res });
        return res;
      }
      setValidationState({
        status: 'invalid',
        error: res?.error || 'Link is not a supported 3D model.'
      });
      return null;
    } catch (err) {
      const msg = err?.data?.error || err?.message || 'Could not validate 3D model URL.';
      setValidationState({ status: 'invalid', error: msg });
      return null;
    }
  }

  async function handleValidateAndUploadLink(e) {
    e?.preventDefault?.();
    if (isFrozen) {
      setStatusIsError(true);
      setStatusMsg('This land is frozen. Unfreeze it first to upload a new 3D model.');
      return;
    }
    setUploadBusy(true);
    setStatusMsg('');
    setStatusIsError(false);
    setServerFitHint(null);
    try {
      const validated =
        validationState?.status === 'valid' && validationState?.data?.modelUrl === modelUrl.trim()
          ? validationState.data
          : await handleValidateModelLink();
      if (!validated) return;

      const resolvedFormat = validated.format || (itemFormat !== 'voxel' ? itemFormat : 'glb');
      const landDisplayName = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
      const finalTitle =
        itemTitle.trim() || validated.suggestedTitle || `3D ${resolvedFormat.toUpperCase()} Artwork`;
      const finalDescription =
        itemDescription.trim().length >= 10
          ? itemDescription.trim()
          : `Validated .${resolvedFormat.toUpperCase()} 3D model placed on "${landDisplayName}".`;

      const res = await api.createSculptureOnLand(parcel.parcelId, {
        title: finalTitle,
        description: finalDescription,
        modelFormat: resolvedFormat,
        modelUrl: modelUrl.trim(),
        modelScale: Number(modelScale || 1),
        anchorOffset: {
          dx: Number(dx || 0),
          dy: Number(dy || 0),
          dz: Number(dz || 0),
          yaw: Number(yaw || 0)
        }
      });

      setStatusIsError(false);
      setServerFitHint(null);
      setStatusMsg(
        res?.requiresOwnerApproval
          ? res.message ||
              `Submitted "${finalTitle}" to the land holder for approval on "${landDisplayName}"! Once approved, the NFT will mint to your wallet.`
          : `Uploaded "${res?.sculpture?.title || finalTitle}" (.${resolvedFormat.toUpperCase()}) onto "${landDisplayName}"!`
      );
      setModelUrl('');
      setItemTitle('');
      setItemDescription('');
      setValidationState(null);
      if (!res?.requiresOwnerApproval) {
        await onSculptureUploaded?.(res?.sculpture);
      }
    } catch (err) {
      setStatusIsError(true);
      if (err?.data?.maxSafeScale !== undefined) {
        setServerFitHint({
          maxSafeScale: Number(err.data.maxSafeScale || 0),
          message: err?.data?.error || err?.message || '3D model exceeds land bounds.'
        });
      }
      setStatusMsg(err?.data?.error || err?.message || '3D model upload failed.');
    } finally {
      setUploadBusy(false);
    }
  }

  async function handlePlaceCatalogItem(item) {
    if (!item) return;
    if (!user?.id) {
      const landDisplay = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
      setStatusIsError(true);
      setStatusMsg(`Sign in with Google to place "${item.title}" on "${landDisplay}".`);
      onRequestLogin?.();
      return;
    }
    if (isFrozen) {
      setStatusIsError(true);
      setStatusMsg('This land is frozen. Unfreeze it first to place a new 3D item.');
      return;
    }
    setUploadBusy(true);
    setStatusMsg('');
    setStatusIsError(false);
    setServerFitHint(null);
    try {
      const landDisplay = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
      const offsetObj = {
        dx: Number(dx || 0),
        dy: Number(dy || 0),
        dz: Number(dz || 0),
        yaw: Number(yaw || 0)
      };
      let chosenScale = Number(modelScale || item.recommendedScale || 1);
      if (!Number.isFinite(chosenScale) || chosenScale <= 0) chosenScale = 1;

      const validated = await api
        .validateModelUrl({
          catalogItemId: item.id,
          modelUrl: item.modelUrl,
          modelFormat: item.modelFormat || 'glb',
          parcelId: parcel.parcelId,
          modelScale: chosenScale,
          anchorOffset: offsetObj
        })
        .catch(() => null);

      if (
        validated?.landFit &&
        !validated.landFit.fits &&
        Number(validated.landFit.maxSafeScale) >= 0.001
      ) {
        chosenScale = Math.min(chosenScale, Number(validated.landFit.maxSafeScale));
      }

      const finalTitle = String(item.title || '3D Catalog Item').trim().slice(0, 48);
      const finalDescription = `${finalTitle} from ${item.sourceName || 'SPRAY.LAND 3D Catalog'} placed on "${landDisplay}".`.slice(
        0,
        240
      );

      const res = await api.createSculptureOnLand(parcel.parcelId, {
        title: finalTitle,
        description: finalDescription,
        catalogItemId: item.id,
        modelFormat: item.modelFormat || 'glb',
        modelUrl: item.modelUrl,
        modelScale: chosenScale,
        anchorOffset: offsetObj
      });

      setStatusIsError(false);
      setStatusMsg(
        res?.requiresOwnerApproval
          ? res.message ||
              `Submitted "${finalTitle}" to the land holder for approval on "${landDisplay}"! Once approved, the NFT will mint to your wallet.`
          : `Placed "${res?.sculpture?.title || finalTitle}" onto "${landDisplay}"!`
      );
      if (!res?.requiresOwnerApproval) {
        await onSculptureUploaded?.(res?.sculpture);
      }
    } catch (err) {
      setStatusIsError(true);
      if (err?.data?.maxSafeScale !== undefined) {
        setServerFitHint({
          maxSafeScale: Number(err.data.maxSafeScale || 0),
          message: err?.data?.error || err?.message || '3D model exceeds land bounds.'
        });
      }
      setStatusMsg(err?.data?.error || err?.message || 'Could not place 3D item on land.');
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleCopyShareLink() {
    const shareUrl = buildParcelShareUrl({
      origin: typeof window !== 'undefined' ? window.location.origin : 'https://spray.land',
      pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
      parcelId: parcel.parcelId,
      customName: parcel.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      setShareLinkCopied(true);
      if (shareResetTimerRef.current) clearTimeout(shareResetTimerRef.current);
      shareResetTimerRef.current = setTimeout(() => setShareLinkCopied(false), 2000);
    }
    setStatusIsError(false);
    setStatusMsg(ok ? `Copied share link: ${shareUrl}` : shareUrl);
  }

  async function handleCopyPrompt() {
    setBusy(true);
    setStatusMsg('');
    setStatusIsError(false);
    setPromptCopyState(null);
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    try {
      let codeToUse = activePairingCode;
      if (user?.id && codeToUse === '<YOUR_GLP_PAIRING_CODE>') {
        const created = await api.createMcpPairing({ apiOrigin }).catch(() => null);
        if (created?.pairing?.code) {
          codeToUse = created.pairing.code;
          setPairingOverride(codeToUse);
          const refreshed = await api.listMcpPairings().catch(() => null);
          if (refreshed) onMcpStateChange?.(refreshed);
        }
      }
      const finalPrompt = buildLandAdd3DItemAgentPrompt({
        parcel,
        itemFormat,
        itemTitle:
          itemTitle.trim() ||
          `Custom ${itemFormat === 'voxel' ? 'Voxel' : itemFormat.toUpperCase()} Artwork`,
        itemDescription: itemDescription.trim(),
        stylePreset,
        modelUrl: modelUrl.trim(),
        anchorOffset: {
          dx: Number(dx || 0),
          dy: Number(dy || 0),
          dz: Number(dz || 0),
          yaw: Number(yaw || 0)
        },
        existingSculptures,
        apiOrigin,
        pairingCode: codeToUse,
        ownerAddress
      });
      const promptIntact = Boolean(
        finalPrompt &&
          finalPrompt.trim().length > 0 &&
          (!parcel?.parcelId || finalPrompt.includes(parcel.parcelId))
      );
      const ok = promptIntact ? await copyToClipboard(finalPrompt) : false;
      const landDisplayName = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
      const verifiedLines = finalPrompt ? finalPrompt.split('\n').length : 0;
      const hasRealPairing = codeToUse !== '<YOUR_GLP_PAIRING_CODE>';
      if (ok) {
        setPromptCopyState({
          status: 'copied',
          verifiedChars: finalPrompt.length,
          verifiedLines,
          pairingCode: codeToUse,
          hasRealPairing
        });
        setStatusIsError(false);
        setStatusMsg(
          `Copied 3D item agent prompt for "${landDisplayName}"! Paste into your AI agent.`
        );
        copyResetTimerRef.current = setTimeout(() => {
          setPromptCopyState((prev) => (prev?.status === 'copied' ? null : prev));
        }, 4500);
      } else {
        setPromptCopyState({
          status: 'fallback',
          verifiedChars: finalPrompt.length,
          verifiedLines,
          pairingCode: codeToUse,
          hasRealPairing
        });
        setStatusIsError(false);
        setStatusMsg('Prompt ready below — select & copy.');
        if (promptTextareaRef.current) {
          promptTextareaRef.current.focus();
          promptTextareaRef.current.select();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleFreezeClick() {
    if (!onToggleFreeze) return;
    setFreezeBusy(true);
    setStatusMsg('');
    setStatusIsError(false);
    try {
      await onToggleFreeze(parcel.parcelId, !isFrozen);
      const landDisplayName = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
      setStatusMsg(
        !isFrozen
          ? `Frozen "${landDisplayName}" — no new sculptures can be placed here.`
          : `Unfrozen "${landDisplayName}" — new sculptures are allowed again.`
      );
    } catch (err) {
      setStatusIsError(true);
      setStatusMsg(err?.message || 'Could not update freeze setting.');
    } finally {
      setFreezeBusy(false);
    }
  }

  const landDisplayName = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });

  return (
    <div
      className="modal-backdrop add-item-modal-backdrop"
      data-testid="add-item-modal-backdrop"
      data-mobile-full-viewport="true"
      onClick={onClose}
    >
      <div
        className="modal-card add-item-modal-card"
        data-testid="add-item-modal-card"
        style={{ maxWidth: 720 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Add 3D item to ${landDisplayName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="add-item-plus-badge">+</span>
            <span>Add 3D Item to {landDisplayName}</span>
            <InfoTip title="AI Agent Prompt, Search to Add & Manual Upload">
              Copy the ready-to-paste MCP prompt below so your AI agent can search &amp; place 3D
              items, use <strong>Search to Add</strong> to pick ready-made 3D props &amp; emojis
              from SimReady Pile, Pixels Atlas, and XeroEmoji Pile one at a time, or expand{' '}
              <strong>Add Manually</strong> to upload any custom 3D model URL
              (.glb/.gltf/.obj/.stl/.ply).
            </InfoTip>
          </h2>
          <div className="modal-header-actions">
            <GlobalNotificationBell compact testId="add-item-notif-bell-btn" />
            <button
              type="button"
              className={`btn ${shareLinkCopied ? 'is-copy-confirmed' : ''}`}
              data-testid="add-item-header-copy-link-btn"
              aria-label={`Copy share link for ${landDisplayName}`}
              title="Copy shareable visit link for this minted parcel"
              onClick={handleCopyShareLink}
            >
              {shareLinkCopied ? '✓' : <XeroIcon emoji="📋" size={16} />}
            </button>
            <button
              type="button"
              className="btn"
              aria-label="Close add 3D item modal"
              onClick={onClose}
            >
              <XeroIcon emoji="✕" size={15} />
            </button>
          </div>
        </div>

        <div className="add-item-meta-strip mono">
          <span>
            <strong>{landDisplayName}</strong>
            {parcel.volume
              ? ` · ${Math.round(parcel.volume.widthMeters)}×${Math.round(parcel.volume.depthMeters)}×${Math.round(parcel.volume.heightMeters)}m`
              : ''}
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              className={`badge ${
                isFrozen ? 'badge-error' : !isLandOwner && requiresApproval ? 'gold' : 'teal'
              }`}
            >
              {isFrozen
                ? '❄️ Frozen (Placements Blocked)'
                : !isLandOwner && requiresApproval
                  ? '🛡️ Requires Land Holder Approval'
                  : !isLandOwner
                    ? '✅ Open Land · Owner Notified'
                    : '✅ Open for 3D Placements'}
            </span>
            {isLandOwner && onToggleFreeze && (
              <button
                type="button"
                className={`btn btn-xs ${isFrozen ? 'btn-primary' : ''}`}
                disabled={freezeBusy}
                onClick={handleFreezeClick}
              >
                {freezeBusy ? 'Saving…' : isFrozen ? '🔓 Unfreeze Land' : '❄️ Freeze Land'}
              </button>
            )}
          </div>
        </div>

        {/* PRIMARY TOP SECTION: Clean AI Agent Prompt (MCP) with Clear Copy Validation */}
        <section
          className={`add-item-agent-card ${
            promptCopyState?.status === 'copied' ? 'is-copied' : ''
          }`}
          data-testid="add-item-agent-section"
          aria-label="AI Agent Prompt"
        >
          <div className="add-item-agent-head">
            <div className="add-item-agent-title-group">
              <strong style={{ fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🤖" size={15} />
                <span>AI Agent Prompt (MCP)</span>
              </strong>
              <span className="add-item-agent-sub">
                Paste into your AI agent to generate, fit-check &amp; place 3D art on {landDisplayName}
              </span>
            </div>
            <span
              className={`badge mono ${
                promptValidation.hasRealPairing ? 'teal' : promptValidation.willAutoPair ? 'gold' : ''
              }`}
              style={{ fontSize: 10.5 }}
              data-testid="add-item-pairing-status"
            >
              {promptValidation.hasRealPairing
                ? `✓ Paired · ${activePairingCode.slice(0, 14)}${activePairingCode.length > 14 ? '…' : ''}`
                : promptValidation.willAutoPair
                  ? '⚡ Auto-pairs on copy'
                  : 'ℹ️ Pairing code needed'}
            </span>
          </div>

          <div className="add-item-agent-actions">
            <button
              type="button"
              className={`btn btn-sm btn-primary add-item-copy-btn ${
                promptCopyState?.status === 'copied' ? 'is-copied' : ''
              }`}
              data-testid="copy-agent-prompt-btn"
              disabled={busy}
              onClick={handleCopyPrompt}
            >
              {busy ? (
                <>⏳ Preparing Prompt…</>
              ) : promptCopyState?.status === 'copied' ? (
                <>✓ Copied to Clipboard!</>
              ) : (
                <>
                  <XeroIcon emoji="📋" size={13} /> Copy 3D Item Agent Prompt
                </>
              )}
            </button>
            {isLandOwner && onOpenLandManagement && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onClose?.();
                  onOpenLandManagement(parcel.parcelId);
                }}
              >
                <XeroIcon emoji="⚙️" size={16} /> Land Settings
              </button>
            )}
          </div>

          {/* Copy Validation Strip: Pre-copy readiness + Post-copy verified status */}
          <div
            className={`add-item-copy-validation ${
              promptCopyState?.status === 'copied'
                ? 'is-verified'
                : promptCopyState?.status === 'fallback'
                  ? 'is-warning'
                  : ''
            }`}
            data-testid="add-item-copy-validation"
            role="status"
            aria-live="polite"
          >
            {promptCopyState?.status === 'copied' ? (
              <div className="add-item-copy-validation-msg" data-testid="copy-validation-confirmed">
                <span>
                  ✅ <strong>Copied &amp; verified</strong> ({promptCopyState.verifiedChars.toLocaleString()} chars ·{' '}
                  {promptCopyState.verifiedLines} lines
                  {promptCopyState.hasRealPairing ? ' · MCP pairing included' : ''}) — paste directly into your AI agent.
                </span>
              </div>
            ) : promptCopyState?.status === 'fallback' ? (
              <div className="add-item-copy-validation-msg" data-testid="copy-validation-fallback">
                <span>
                  ⚠️ Browser blocked automatic clipboard write — prompt is highlighted below. Press{' '}
                  <strong>Ctrl+C</strong> (or <strong>⌘C</strong>) to copy.
                </span>
              </div>
            ) : (
              <div className="add-item-copy-checks mono">
                <span className={promptValidation.hasParcelId ? 'is-ok' : ''}>
                  {promptValidation.hasParcelId ? '✓' : '○'} Land ID &amp; 3D bounds
                </span>
                <span className={promptValidation.hasMcpEndpoint ? 'is-ok' : ''}>
                  {promptValidation.hasMcpEndpoint ? '✓' : '○'} MCP tools ready
                </span>
                <span className={promptValidation.hasRealPairing || promptValidation.willAutoPair ? 'is-ok' : ''}>
                  {promptValidation.hasRealPairing
                    ? '✓ Pairing code included'
                    : promptValidation.willAutoPair
                      ? '⚡ Pairing auto-added on copy'
                      : '○ Sign in for pairing code'}
                </span>
                <span className="add-item-copy-size">
                  {promptValidation.charCount.toLocaleString()} chars
                </span>
              </div>
            )}
          </div>

          <textarea
            ref={promptTextareaRef}
            readOnly
            className="land-agent-preview add-item-agent-textarea"
            aria-label="Add 3D item agent prompt preview"
            value={promptText}
            onFocus={(e) => e.target.select()}
          />
        </section>

        {/* MIDDLE SECTION: Search to Add (SimReady Pile, Pixels Atlas & XeroEmoji Pile — pick & place one at a time) */}
        <Catalog3DSearchBox
          title="Search to Add"
          subtitle={`Query SimReady Pile, Pixels Atlas & XeroEmoji Pile — preview and place one item at a time on ${landDisplayName}`}
          actionLabel={requiresApproval && !isLandOwner ? '+ Propose Item' : '+ Place on Land'}
          busy={uploadBusy}
          disabled={isFrozen}
          disabledReason={isFrozen ? 'Unfreeze this land first to place items.' : ''}
          limit={6}
          onPlaceItem={handlePlaceCatalogItem}
        />

        {statusMsg && (
          <div
            className={`status-banner ${statusIsError ? 'status-banner-error' : ''}`}
            role="status"
            style={{ marginTop: 8 }}
          >
            {statusMsg}
          </div>
        )}

        {/* COLLAPSIBLE FOLD-DOWN: Add Manually (URL Upload, Format Picker, Title, Scale & Position) */}
        <section
          className={`add-item-manual-fold ${manualOpen ? 'is-open' : ''}`}
          data-testid="add-item-manual-section"
        >
          <button
            type="button"
            className="add-item-fold-trigger"
            data-testid="add-item-manual-toggle"
            aria-expanded={manualOpen}
            aria-controls="add-item-manual-body"
            onClick={() => setManualOpen((v) => !v)}
          >
            <span className="add-item-fold-left">
              <span className="add-item-fold-title">
                <XeroIcon emoji="🛠️" size={14} />
                <span>Add Manually</span>
              </span>
              <span className="add-item-fold-sub">
                Upload a 3D model URL (.GLB / .GLTF / .OBJ / .STL / .PLY) or customize title, scale &amp; offsets
              </span>
            </span>
            <span className="add-item-fold-right">
              <span className="badge mono" style={{ fontSize: 10 }}>
                .{activeTypeInfo.ext}
              </span>
              <span className="add-item-fold-chevron" aria-hidden="true">
                {manualOpen ? '▾' : '▸'}
              </span>
            </span>
          </button>

          {manualOpen && (
            <div
              id="add-item-manual-body"
              className="add-item-manual-body"
              data-testid="add-item-manual-body"
            >
              {/* Supported 3D Model Format Preview Cards with Simple Illustrations */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  Supported 3D Models Preview
                </div>
                <div
                  className="add-item-format-grid"
                  role="radiogroup"
                  aria-label="Supported 3D item format"
                >
                  {SUPPORTED_ITEM_TYPES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={itemFormat === t.id}
                      className={`add-item-format-pill ${itemFormat === t.id ? 'is-selected' : ''}`}
                      onClick={() => {
                        setItemFormat(t.id);
                        if (validationState?.status === 'invalid') setValidationState(null);
                      }}
                      title={t.note}
                    >
                      <div className="add-item-format-preview-row">
                        <ModelFormatMiniIllustration formatId={t.id} />
                        <div>
                          <strong>{t.ext}</strong>
                          <span>{t.label}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="add-item-format-caption">
                  <ModelFormatMiniIllustration formatId={activeTypeInfo.id} />
                  <div>
                    <strong>{activeTypeInfo.label}</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{activeTypeInfo.note}</div>
                  </div>
                </div>
              </div>

              {/* Direct 3D Model Link Validator & One-Click Upload */}
              <form
                onSubmit={handleValidateAndUploadLink}
                className="add-item-url-uploader"
                data-testid="direct-model-url-uploader"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 12.5, color: 'var(--accent)' }}>
                    Upload 3D Model by Link (.GLB / .GLTF / .OBJ / .STL / .PLY)
                  </strong>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                    Validates support &amp; uploads directly
                  </span>
                </div>

                <div className="add-item-url-row">
                  <input
                    type="url"
                    className="input"
                    aria-label="3D Model URL"
                    value={modelUrl}
                    onChange={(e) => {
                      setModelUrl(e.target.value);
                      if (validationState) setValidationState(null);
                    }}
                    placeholder="Paste link: https://.../model.glb or ipfs://..."
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={uploadBusy || validationState?.status === 'checking' || !modelUrl.trim()}
                    onClick={handleValidateModelLink}
                  >
                    {validationState?.status === 'checking' ? 'Checking…' : 'Validate Link'}
                  </button>
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={uploadBusy || isFrozen || !modelUrl.trim()}
                  >
                    {uploadBusy ? 'Uploading…' : 'Validate & Upload'}
                  </button>
                </div>

                {validationState?.status === 'valid' && validationState.data && (
                  <div className="add-item-validation-ok" role="status" data-testid="model-url-valid-badge">
                    ✅ Supported <strong>.{String(validationState.data.format).toUpperCase()}</strong> ·{' '}
                    {formatByteSize(validationState.data.byteLength)}
                    {validationState.data.stats?.triangleCount
                      ? ` · ${Number(validationState.data.stats.triangleCount).toLocaleString()} tris`
                      : ''}
                    {validationState.data.stats?.bbox
                      ? ` · ${Number(validationState.data.stats.bbox.width).toFixed(2)}×${Number(
                          validationState.data.stats.bbox.depth
                        ).toFixed(2)}×${Number(validationState.data.stats.bbox.height).toFixed(2)}m`
                      : ''}{' '}
                    {liveLandFit && !liveLandFit.fits ? '— Exceeds land bounds at current scale' : '— Ready to upload!'}
                  </div>
                )}
                {((liveLandFit && !liveLandFit.fits) || serverFitHint) && (() => {
                  const fitMsg =
                    (liveLandFit && !liveLandFit.fits ? liveLandFit.message : '') ||
                    serverFitHint?.message ||
                    'Model exceeds this land boundary at current scale.';
                  const fitMaxScale =
                    liveLandFit && !liveLandFit.fits
                      ? Number(liveLandFit.maxSafeScale || 0)
                      : Number(serverFitHint?.maxSafeScale || 0);
                  return (
                    <div
                      className="status-banner status-banner-error"
                      role="alert"
                      data-testid="model-land-fit-warning"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}
                    >
                      <span>⚠️ {fitMsg}</span>
                      {fitMaxScale >= 0.001 && (
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          data-testid="fit-model-to-land-btn"
                          onClick={() => {
                            setModelScale(fitMaxScale);
                            setServerFitHint(null);
                            setStatusMsg('');
                            setStatusIsError(false);
                          }}
                        >
                          📐 Fit to Land ({fitMaxScale}×)
                        </button>
                      )}
                    </div>
                  );
                })()}
                {validationState?.status === 'invalid' && (
                  <div className="status-banner status-banner-error" role="alert">
                    ❌ {validationState.error}
                  </div>
                )}
              </form>

              {/* Item Title, Description & Placement Controls (also sync live with the Agent Prompt above) */}
              <div className="add-item-form-grid">
                <label className="land-name-field">
                  <span>3D Item Title</span>
                  <EmojiInput
                    type="text"
                    maxLength={48}
                    value={itemTitle}
                    onChange={(e) => setItemTitle(e.target.value)}
                    placeholder="e.g. Glowing Cyber Dragon (type : for emojis)"
                  />
                </label>

                {itemFormat === 'voxel' ? (
                  <label className="land-name-field">
                    <span>Voxel Style / Prefab Hint</span>
                    <select
                      className="input"
                      value={stylePreset}
                      onChange={(e) => setStylePreset(e.target.value)}
                    >
                      {VOXEL_STYLES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="land-name-field">
                    <span>Model Scale</span>
                    <input
                      type="number"
                      min={0.001}
                      max={60}
                      step={0.01}
                      value={modelScale}
                      onChange={(e) => {
                        setModelScale(Number(e.target.value || 1));
                        if (serverFitHint) setServerFitHint(null);
                      }}
                    />
                  </label>
                )}
              </div>

              <label className="land-name-field" style={{ marginTop: 8 }}>
                <span>Description or AI Agent Instructions</span>
                <EmojiTextarea
                  className="textarea"
                  rows={2}
                  maxLength={240}
                  value={itemDescription}
                  onChange={(e) => setItemDescription(e.target.value)}
                  placeholder="Describe the 3D sculpture, colors, scale, or edits (type : for emojis)..."
                />
              </label>

              <div className="add-item-offset-row">
                <label>
                  <span>dx (m)</span>
                  <input type="number" step="0.5" value={dx} onChange={(e) => setDx(e.target.value)} />
                </label>
                <label>
                  <span>dy (m)</span>
                  <input type="number" step="0.5" value={dy} onChange={(e) => setDy(e.target.value)} />
                </label>
                <label>
                  <span>dz (m)</span>
                  <input type="number" step="0.5" value={dz} onChange={(e) => setDz(e.target.value)} />
                </label>
                <label>
                  <span>yaw (°)</span>
                  <input type="number" step="15" value={yaw} onChange={(e) => setYaw(e.target.value)} />
                </label>
              </div>

              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                💡 Customizations entered here also update the AI Agent Prompt above live.
              </div>
            </div>
          )}
        </section>

        {/* Existing Artworks on This Land (Quick Modify / Hide / Restore) */}
        {existingSculptures.length > 0 && (
          <div className="add-item-existing-list">
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              Artworks Currently on This Land ({existingSculptures.length})
            </div>
            {existingSculptures.map((sc) => (
              <div key={sc.id} className="add-item-existing-row">
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6
                    }}
                  >
                    <span>{sc.title}</span>
                    {sc.hidden && (
                      <span className="badge badge-error" style={{ fontSize: 10 }}>
                        Hidden
                      </span>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span>
                      {sc.modelType === 'custom-3d'
                        ? `.${sc.customModel?.format || 'glb'}`
                        : `${sc.voxelCount || 0} voxels`}
                    </span>
                    <span>·</span>
                    <UserHandleBadge
                      user={{
                        id: sc.creatorSub,
                        username: sc.creatorUsername,
                        creatorName: sc.creatorName,
                        avatarImage: sc.creatorAvatar
                      }}
                      fallback="Creator"
                      size="xs"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                  {onSelectSculpture && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => {
                        onClose?.();
                        onSelectSculpture(sc);
                      }}
                    >
                      ✏️ Inspect / Modify
                    </button>
                  )}
                  {isLandOwner && onToggleSculptureVisibility && (
                    <button
                      type="button"
                      className={`btn btn-xs ${sc.hidden ? 'btn-primary' : ''}`}
                      disabled={visBusyId === sc.id}
                      onClick={async () => {
                        setVisBusyId(sc.id);
                        setStatusIsError(false);
                        try {
                          await onToggleSculptureVisibility(sc.id, !sc.hidden);
                          setStatusMsg(
                            sc.hidden
                              ? `Restored "${sc.title}" to public map & 3D view.`
                              : `Hidden "${sc.title}" from public map & AR feeds.`
                          );
                        } catch (err) {
                          setStatusIsError(true);
                          setStatusMsg(err?.message || 'Visibility update failed.');
                        } finally {
                          setVisBusyId('');
                        }
                      }}
                    >
                      {sc.hidden ? '👁️ Unhide' : '🙈 Hide'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
