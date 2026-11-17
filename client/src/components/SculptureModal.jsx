import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BrowserProvider, Contract, isAddress } from 'ethers';
import xeroemoji from 'xeroemoji';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import {
  buildTransferAuthMessage,
  ERC721_TRANSFER_ABI
} from '../../../shared/transferMessage.mjs';
import { api, API_BASE, resolveApiUrl } from '../utils/api.js';
import {
  decryptPinnedIpfsBatch,
  encryptPinnedIpfsBatch,
  getOrCreateDeviceIdentity
} from '../utils/chatCrypto.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import SculptureRevisionsPanel from './SculptureRevisionsPanel.jsx';
import XeroIcon from './XeroIcon.jsx';

async function switchOrAddRobinhoodNetwork(eth, chainInfo) {
  const chainIdNum = Number(chainInfo?.chainId || 46630);
  const chainHex = `0x${chainIdNum.toString(16)}`;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainHex }]
    });
  } catch (err) {
    if (err?.code === 4902 && chainInfo?.rpcUrl) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainHex,
            chainName: chainInfo.name || 'Robinhood Chain Testnet',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [chainInfo.rpcUrl],
            blockExplorerUrls: chainInfo.explorer ? [chainInfo.explorer] : []
          }
        ]
      });
    } else {
      throw err;
    }
  }
}

export default function SculptureModal({
  sculpture: initialSculpture,
  user,
  config,
  userLocation = null,
  onSculptureUpdated,
  onModifyInCanvas = null,
  onOpenLandManagement = null,
  onClose
}) {
  const [sculpture, setSculpture] = useState(initialSculpture);
  const landMapHostRef = useRef(null);
  const [toAddress, setToAddress] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [nftNotice, setNftNotice] = useState('');
  const [nftError, setNftError] = useState('');
  const [editTitle, setEditTitle] = useState(initialSculpture?.title || '');
  const [editDesc, setEditDesc] = useState(initialSculpture?.description || '');
  const [landCustomName, setLandCustomName] = useState('');
  const [landCurationNote, setLandCurationNote] = useState('');
  const [propBusy, setPropBusy] = useState('');
  const [propNotice, setPropNotice] = useState('');
  const [propError, setPropError] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  const [modalPins, setModalPins] = useState([]);
  const [pinDraftText, setPinDraftText] = useState('');
  const [editModalPinId, setEditModalPinId] = useState('');
  const [editModalPinText, setEditModalPinText] = useState('');
  const [pinBatchInfo, setPinBatchInfo] = useState(initialSculpture?.pinSummary || null);

  useEffect(() => {
    setSculpture(initialSculpture);
    setEditTitle(initialSculpture?.title || '');
    setEditDesc(initialSculpture?.description || '');
    setNftNotice('');
    setNftError('');
    setPropNotice('');
    setPropError('');
    setPromptCopied(false);
    setModalPins([]);
    setPinDraftText('');
    setEditModalPinId('');
    setPinBatchInfo(initialSculpture?.pinSummary || null);
    if (!initialSculpture?.id) return;
    let cancelled = false;
    api
      .getSculpture(initialSculpture.id)
      .then((res) => {
        if (!cancelled && res?.sculpture) {
          setSculpture(res.sculpture);
          if (res.sculpture.pinSummary) {
            setPinBatchInfo(res.sculpture.pinSummary);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialSculpture]);

  useEffect(() => {
    const host = landMapHostRef.current;
    const latNum = Number(sculpture?.lat);
    const lngNum = Number(sculpture?.lng);
    if (!host || !sculpture || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) return;

    const map = L.map(host, {
      center: [latNum, lngNum],
      zoom: 18,
      zoomControl: false,
      attributionControl: false
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(map);

    if (sculpture.parcelBounds?.sw && sculpture.parcelBounds?.ne) {
      L.rectangle([sculpture.parcelBounds.sw, sculpture.parcelBounds.ne], {
        color: '#ffd166',
        weight: 2.5,
        fillColor: '#00f5d4',
        fillOpacity: 0.25
      })
        .bindTooltip(`Virtual Land ${sculpture.parcelId}`)
        .addTo(map);
    }

    const pinUrl = xeroemoji.get('📍')?.svgUrl;
    const pinIcon = L.divIcon({
      className: 'graffiland-map-pin',
      html: pinUrl
        ? `<img src="${pinUrl}" width="26" height="26" style="filter: drop-shadow(0 2px 6px rgba(0,245,212,0.75));" />`
        : '📍',
      iconSize: [26, 26],
      iconAnchor: [13, 24]
    });
    L.marker([latNum, lngNum], { icon: pinIcon }).addTo(map);

    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 80);

    return () => {
      clearTimeout(timer);
      map.remove();
    };
  }, [sculpture?.id, sculpture?.lat, sculpture?.lng, sculpture?.parcelBounds, sculpture?.parcelId]);

  if (!sculpture) return null;

  const pol = sculpture.proofOfLocation || {};
  const geo = pol.geoInfo || {};
  const sensors = pol.sensors || {};
  const solar = pol.solar || {};
  const elevation = sculpture.elevation || pol.elevation || {};
  const ownerAddr = sculpture.recipientAddress || sculpture.ownerAddress || '';
  const ownerWallets = [user?.walletAddress, user?.customPayoutAddress]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
  const isPropertyOwner = Boolean(ownerAddr && ownerWallets.includes(ownerAddr.toLowerCase()));
  const isContributor = !isPropertyOwner && Boolean(sculpture.viewerCanContribute);
  const canModifySculpture = isPropertyOwner || isContributor;
  const isEmbeddedOwner = Boolean(
    user?.walletAddress &&
      ownerAddr &&
      user.walletAddress.toLowerCase() === ownerAddr.toLowerCase()
  );

  useEffect(() => {
    if (!isPropertyOwner || !user?.id || !sculpture?.id) return;
    let cancelled = false;
    api
      .getOwnerPinSeal(sculpture.id)
      .then(async (sealRes) => {
        if (cancelled) return;
        if (sealRes.meta) setPinBatchInfo(sealRes.meta);
        if (sealRes.encryptedBatch) {
          const dec = await decryptPinnedIpfsBatch({
            encryptedBatch: sealRes.encryptedBatch,
            parcelSealKeyB64: sealRes.parcelSealKeyB64,
            sculptureId: sculpture.id,
            parcelId: sculpture.parcelId,
            geohash: sculpture.geohash
          });
          if (!cancelled) setModalPins(dec.pins || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isPropertyOwner, sculpture?.geohash, sculpture?.id, sculpture?.parcelId, user?.id]);

  async function saveOwnerPinnedIpfsBatch(nextPins) {
    if (!user?.id || !sculpture?.id) return;
    setPropBusy('pins');
    setPropNotice('');
    setPropError('');
    try {
      const idObj = await getOrCreateDeviceIdentity(user.id);
      const sealRes = await api.getOwnerPinSeal(sculpture.id);
      const encryptedBatch = await encryptPinnedIpfsBatch({
        pins: nextPins,
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        geohash: sculpture.geohash,
        batchSeq: sealRes.nextBatchSeq,
        parcelSealKeyB64: sealRes.parcelSealKeyB64,
        identity: idObj
      });
      const saved = await api.saveEncryptedPinBatch(sculpture.id, { encryptedBatch });
      if (saved.meta) setPinBatchInfo(saved.meta);
      const dec = await decryptPinnedIpfsBatch({
        encryptedBatch,
        parcelSealKeyB64: sealRes.parcelSealKeyB64,
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        geohash: sculpture.geohash
      });
      setModalPins(dec.pins || []);
      onSculptureUpdated?.({ ...sculpture, pinSummary: saved.meta });
      setPropNotice(
        `Encrypted pin batch v${saved.meta?.batchSeq || sealRes.nextBatchSeq} saved to IPFS (${saved.ipfs?.cid?.slice(0, 14)}...).`
      );
    } catch (err) {
      setPropError(err.message || 'Could not pin encrypted batch to IPFS');
    } finally {
      setPropBusy('');
    }
  }

  async function handleSaveSculptureEdit(e) {
    e.preventDefault();
    setPropBusy('save');
    setPropNotice('');
    setPropError('');
    try {
      const res = await api.updateSculpture(sculpture.id, {
        title: editTitle,
        description: editDesc
      });
      if (res?.sculpture) {
        setSculpture((prev) => ({ ...prev, ...res.sculpture }));
        onSculptureUpdated?.({ ...sculpture, ...res.sculpture });
        setPropNotice('Sculpture metadata & IPFS bundle updated.');
      }
    } catch (err) {
      setPropError(err.message || 'Update failed');
    } finally {
      setPropBusy('');
    }
  }

  async function handleSaveLandCuration(e) {
    e.preventDefault();
    setPropBusy('land');
    setPropNotice('');
    setPropError('');
    try {
      const res = await api.updateLandParcel(sculpture.parcelId, {
        customName: landCustomName,
        curationNote: landCurationNote
      });
      setPropNotice(`Saved land curation for ${res?.parcel?.parcelId || sculpture.parcelId}.`);
    } catch (err) {
      setPropError(err.message || 'Land update failed');
    } finally {
      setPropBusy('');
    }
  }

  async function handleDeleteOwnedSculpture() {
    setPropBusy('delete');
    setPropNotice('');
    setPropError('');
    try {
      await api.deleteSculpture(sculpture.id);
      onClose?.();
    } catch (err) {
      setPropError(err.message || 'Delete failed');
    } finally {
      setPropBusy('');
    }
  }

  async function handleCopyOwnerPrompt() {
    setPropBusy('prompt');
    setPropNotice('');
    setPropError('');
    try {
      const pairingsRes = await api.listMcpPairings();
      let code = pairingsRes.activePairing?.code || pairingsRes.pairings?.find((p) => p.status === 'pending')?.code;
      const origin = API_BASE || window.location.origin;
      if (!code) {
        const created = await api.createMcpPairing({ apiOrigin: origin });
        code = created.pairing?.code;
      }
      const promptText = buildPropertyOwnerPrompt({
        apiOrigin: origin,
        pairingCode: code,
        ownerAddress: ownerAddr,
        parcelId: sculpture.parcelId
      });
      await navigator.clipboard?.writeText(promptText);
      setPromptCopied(true);
      setPropNotice(`Copied Property Owner MCP Prompt (Pairing Code: ${code}).`);
    } catch (err) {
      setPropError(err.message || 'Could not copy prompt');
    } finally {
      setPropBusy('');
    }
  }
  const glbUrl = resolveApiUrl(
    sculpture.modelGlbUrl || `/api/sculptures/${encodeURIComponent(sculpture.id)}/model.glb`
  );
  const tokenMetaUrl = resolveApiUrl(
    sculpture.metadataUrl || `/api/sculptures/${encodeURIComponent(sculpture.id)}/metadata.json`
  );
  const chainLinks = getSculptureChainLinks(sculpture, config);
  const explorerTokenUrl = chainLinks.tokenUrl;
  const explorerTxUrl = chainLinks.txUrl;
  const explorerContractUrl = chainLinks.contractUrl;
  const transfers = Array.isArray(sculpture.transfers) ? sculpture.transfers : [];
  const hasCoords =
    Number.isFinite(Number(sculpture.lat)) && Number.isFinite(Number(sculpture.lng));
  const googleMapsUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
        `${sculpture.lat},${sculpture.lng}`
      )}`
    : '';
  const distanceMeters =
    hasCoords &&
    userLocation &&
    Number.isFinite(Number(userLocation.lat)) &&
    Number.isFinite(Number(userLocation.lng))
      ? Math.round(
          haversineMeters(
            Number(userLocation.lat),
            Number(userLocation.lng),
            Number(sculpture.lat),
            Number(sculpture.lng)
          )
        )
      : null;
  const distanceLabel =
    distanceMeters === null
      ? ''
      : distanceMeters >= 1000
      ? `${(distanceMeters / 1000).toFixed(1)} km away`
      : `${distanceMeters} m away`;

  const handleAddToWallet = async () => {
    setNftNotice('');
    setNftError('');
    if (!window.ethereum) {
      setNftNotice(
        `No Web3 extension detected. Import Contract ${sculpture.chain?.contractAddress} · Token #${sculpture.chain?.tokenId} manually in MetaMask or Robinhood Wallet.`
      );
      return;
    }
    setBusyAction('wallet');
    try {
      await switchOrAddRobinhoodNetwork(window.ethereum, config?.chain?.network);
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC721',
          options: {
            address: sculpture.chain?.contractAddress,
            tokenId: String(sculpture.chain?.tokenId)
          }
        }
      });
      setNftNotice('Added ERC-721 NFT & Robinhood Chain to your connected wallet.');
    } catch (err) {
      setNftError(
        err?.message ||
          `Could not auto-import in this wallet. Contract: ${sculpture.chain?.contractAddress}, Token ID: ${sculpture.chain?.tokenId}`
      );
    } finally {
      setBusyAction('');
    }
  };

  const handleSyncOwner = async () => {
    setNftNotice('');
    setNftError('');
    setBusyAction('sync');
    try {
      const res = await api.syncSculptureOwnership(sculpture.id);
      if (res?.sculpture) {
        setSculpture(res.sculpture);
        onSculptureUpdated?.(res.sculpture);
      }
      setNftNotice(
        res?.simulated
          ? `Ownership verified (${res.ownerAddress}) — pre-deployment ledger mode.`
          : res?.changed
          ? `Synced new on-chain owner: ${res.ownerAddress}`
          : `On-chain owner matches (${res.ownerAddress}).`
      );
    } catch (err) {
      setNftError(err.message || 'Could not sync ownership.');
    } finally {
      setBusyAction('');
    }
  };

  const handleEmbeddedTransfer = async (e) => {
    e.preventDefault();
    setNftNotice('');
    setNftError('');
    if (!isAddress(toAddress.trim())) {
      setNftError('Enter a valid 0x EVM destination address.');
      return;
    }
    setBusyAction('transfer-embedded');
    try {
      const res = await api.transferSculpture(sculpture.id, { toAddress: toAddress.trim() });
      if (res?.sculpture) {
        setSculpture(res.sculpture);
        onSculptureUpdated?.(res.sculpture);
      }
      setToAddress('');
      setNftNotice(`NFT #${sculpture.chain?.tokenId} transferred to ${res.transfer?.toAddress}`);
    } catch (err) {
      setNftError(err.message || 'Transfer failed.');
    } finally {
      setBusyAction('');
    }
  };

  const handleExternalWalletTransfer = async () => {
    setNftNotice('');
    setNftError('');
    if (!isAddress(toAddress.trim())) {
      setNftError('Enter a valid 0x EVM destination address.');
      return;
    }
    if (!window.ethereum) {
      setNftError('MetaMask / Web3 wallet extension is required for external wallet transfers.');
      return;
    }
    setBusyAction('transfer-external');
    try {
      const provider = new BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const connectedAddr = await signer.getAddress();
      if (connectedAddr.toLowerCase() !== ownerAddr.toLowerCase()) {
        throw new Error(`Switch MetaMask to current owner ${ownerAddr} (currently ${connectedAddr}).`);
      }

      const dest = toAddress.trim();
      let payload;
      if (!sculpture.chain?.simulated && config?.chain?.liveReady) {
        await switchOrAddRobinhoodNetwork(window.ethereum, config?.chain?.network);
        const contract = new Contract(
          sculpture.chain.contractAddress,
          ERC721_TRANSFER_ABI,
          signer
        );
        const tx = await contract['safeTransferFrom(address,address,uint256)'](
          ownerAddr,
          dest,
          sculpture.chain.tokenId
        );
        const receipt = await tx.wait();
        payload = { toAddress: dest, txHash: receipt.hash };
      } else {
        const msg = buildTransferAuthMessage({
          sculptureId: sculpture.id,
          tokenId: sculpture.chain?.tokenId,
          fromAddress: ownerAddr,
          toAddress: dest,
          contractAddress: sculpture.chain?.contractAddress,
          chainId: sculpture.chain?.chainId
        });
        const signature = await signer.signMessage(msg);
        payload = { toAddress: dest, signature };
      }

      const res = await api.transferSculpture(sculpture.id, payload);
      if (res?.sculpture) {
        setSculpture(res.sculpture);
        onSculptureUpdated?.(res.sculpture);
      }
      setToAddress('');
      setNftNotice(`External wallet transfer confirmed -> ${res.transfer?.toAddress}`);
    } catch (err) {
      setNftError(err.message || 'External wallet transfer failed.');
    } finally {
      setBusyAction('');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 780 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            <XeroIcon emoji="🧊" size={24} />
            {sculpture.title}
          </h2>
          <button className="btn" onClick={onClose}>
            <XeroIcon emoji="❌" size={16} />
          </button>
        </div>

        <SculptureViewer3D
          sculpture={sculpture}
          voxels={sculpture.voxels || []}
          height={300}
          autoRotate
        />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
          {googleMapsUrl && (
            <a
              className="btn btn-primary"
              href={googleMapsUrl}
              target="_blank"
              rel="noreferrer"
            >
              <XeroIcon emoji="🧭" size={15} />
              <span>
                Navigate (Google Maps){distanceLabel ? ` · ${distanceLabel}` : ''}
              </span>
            </a>
          )}
          {explorerTxUrl ? (
            <a className="btn" href={explorerTxUrl} target="_blank" rel="noreferrer">
              <XeroIcon emoji="⛓️" size={14} />
              <span>Tx {sculpture.chain?.txHash?.slice(0, 10)}...</span>
            </a>
          ) : sculpture.chain?.txHash ? (
            <span className="badge">
              <XeroIcon emoji="⛓️" size={13} />{' '}
              {chainLinks.isSimulated ? 'Pre-chain' : 'Tx'} {sculpture.chain.txHash.slice(0, 10)}...
            </span>
          ) : null}
          <span className="badge teal">
            <XeroIcon emoji="📍" size={13} /> Land {sculpture.parcelId}
          </span>
          <span className="badge gold">
            <XeroIcon emoji="✅" size={13} /> PoL Score {sculpture.polScore}/100
          </span>
          <span className="badge pink">
            <XeroIcon emoji="🪙" size={13} /> {sculpture.chain?.royaltyPercent || 5}% Resale Fee
          </span>
          {sculpture.modelType === 'custom-3d' && sculpture.customModel ? (
            <span className="badge teal">
              <XeroIcon emoji="🗿" size={13} /> {String(sculpture.customModel.format || 'glb').toUpperCase()} 3D Model
              {sculpture.meshStats?.triangleCount > 0 && ` · ${sculpture.meshStats.triangleCount.toLocaleString()} tris`}
              {sculpture.meshStats?.hasDraco && ' · Draco'}
              {sculpture.meshStats?.hasMeshopt && ' · Meshopt'}
            </span>
          ) : (
            <span className="badge">
              <XeroIcon emoji="🧱" size={13} /> {sculpture.voxelCount} voxels
            </span>
          )}
          <span className="badge teal">v{sculpture.currentRev || 1}</span>
          {(sculpture.anchorOffset?.dx || sculpture.anchorOffset?.dy || sculpture.anchorOffset?.dz || sculpture.anchorOffset?.yaw) ? (
            <span className="badge">
              <XeroIcon emoji="📌" size={12} /> Offset ({sculpture.anchorOffset.dx}, {sculpture.anchorOffset.dy}, {sculpture.anchorOffset.dz}m)
            </span>
          ) : null}
          {isContributor && (
            <span className="badge gold">
              <XeroIcon emoji="🤝" size={13} /> Contributor Edit Access
            </span>
          )}
        </div>

        <p style={{ fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>{sculpture.description}</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="🗺️" size={18} /> Location &amp; Virtual Land Parcel ({sculpture.parcelId})
            </div>
            {hasCoords && (
              <div className="mini-land-map-wrap">
                <div ref={landMapHostRef} className="mini-land-map" />
                <div className="mini-land-map-caption">
                  <span>
                    <XeroIcon emoji="🗺️" size={11} /> Land {sculpture.parcelId}
                  </span>
                  {sculpture.parcelBounds?.sw && (
                    <span className="mono">
                      SW {sculpture.parcelBounds.sw[0].toFixed(5)},{sculpture.parcelBounds.sw[1].toFixed(5)}
                    </span>
                  )}
                </div>
              </div>
            )}
            <table className="kv-table">
              <tbody>
                <tr>
                  <th>Place</th>
                  <td>{geo.displayName || sculpture.placeName || 'N/A'}</td>
                </tr>
                <tr>
                  <th>Coordinates</th>
                  <td className="mono">{sculpture.lat}, {sculpture.lng}</td>
                </tr>
                <tr>
                  <th>Geohash / Parcel</th>
                  <td className="mono">{sculpture.geohash} / {sculpture.parcelId}</td>
                </tr>
                <tr>
                  <th>GPS Accuracy / Alt</th>
                  <td className="mono">
                    ±{sculpture.accuracy ?? '—'}m ·{' '}
                    {elevation.anchorAltitudeMeters != null
                      ? `${Math.round(elevation.anchorAltitudeMeters * 10) / 10}m alt`
                      : sculpture.altitude != null
                        ? `${Math.round(sculpture.altitude)}m alt`
                        : 'n/a'}
                    {elevation.altitudeAccuracyMeters != null
                      ? ` (±${Math.round(elevation.altitudeAccuracyMeters)}m)`
                      : ''}
                  </td>
                </tr>
                {(elevation.terrainElevationMeters != null ||
                  elevation.heightAboveGroundMeters != null ||
                  elevation.sculptureVerticalMaxM > elevation.sculptureVerticalMinM) && (
                  <tr>
                    <th>Elevation / Span</th>
                    <td className="mono">
                      {elevation.terrainElevationMeters != null
                        ? `${Math.round(elevation.terrainElevationMeters)}m ground`
                        : elevation.altitudeSource || 'sensor'}
                      {elevation.heightAboveGroundMeters != null
                        ? ` · ${elevation.heightAboveGroundMeters >= 0 ? '+' : ''}${elevation.heightAboveGroundMeters}m AGL`
                        : ''}
                      {Number.isFinite(elevation.sculptureVerticalMinM) &&
                      Number.isFinite(elevation.sculptureVerticalMaxM)
                        ? ` · ${elevation.sculptureVerticalMinM}m..${elevation.sculptureVerticalMaxM}m Y`
                        : ''}
                    </td>
                  </tr>
                )}
                <tr>
                  <th>Compass / Timezone</th>
                  <td className="mono">
                    {sculpture.heading != null ? `${Math.round(sculpture.heading)}°` : 'n/a'} · {sculpture.timezone}
                  </td>
                </tr>
                <tr>
                  <th>Solar Regime</th>
                  <td className="mono">
                    {solar.regime || '—'} ({solar.solarAltitudeDeg ?? '—'}° el
                    {solar.solarAzimuthDeg != null ? ` / ${solar.solarAzimuthDeg}° az` : ''})
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="📷" size={18} /> Camera + GPS Proof of Location
            </div>
            <table className="kv-table">
              <tbody>
                <tr>
                  <th>Camera-Gyro Flow</th>
                  <td className="mono">{Math.round((sensors.opticalFlowCorrelation || 0) * 100)}% match</td>
                </tr>
                <tr>
                  <th>Horizon Luminance</th>
                  <td className="mono">{sensors.horizonLuminance ?? '—'} / 255</td>
                </tr>
                <tr>
                  <th>Visual dHash</th>
                  <td className="mono">{sensors.visualDHash || '—'}</td>
                </tr>
                <tr>
                  <th>Ambient Palette</th>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {(sensors.ambientPalette || []).map((c, idx) => (
                        <span
                          key={idx}
                          title={c}
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            background: c,
                            border: '1px solid rgba(255,255,255,0.25)'
                          }}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Sensors</th>
                  <td className="mono">
                    {sensors.cameraFrames || 0} cam · {sensors.gyroSamples || 0} gyro · {sensors.gpsSampleCount || 1} gps
                  </td>
                </tr>
                <tr>
                  <th>Proof Hash</th>
                  <td className="mono" style={{ wordBreak: 'break-all', fontSize: 10 }}>
                    {sculpture.proofHash}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <XeroIcon emoji="💎" size={18} /> IPFS, 3D GLB &amp; Robinhood Chain NFT
          </div>
          <table className="kv-table">
            <tbody>
              <tr>
                <th>Network</th>
                <td className="mono">{sculpture.chain?.chainName} (Chain ID {sculpture.chain?.chainId})</td>
              </tr>
              <tr>
                <th>Current Owner</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>{ownerAddr}</td>
              </tr>
              <tr>
                <th>Token ID / Contract</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  #{sculpture.chain?.tokenId} ·{' '}
                  {explorerContractUrl ? (
                    <a
                      href={explorerContractUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      {sculpture.chain?.contractAddress}
                    </a>
                  ) : (
                    sculpture.chain?.contractAddress
                  )}
                </td>
              </tr>
              <tr>
                <th>Resale Royalty</th>
                <td className="mono">{sculpture.chain?.royaltyPercent}% ({sculpture.chain?.royaltyBps} bps ERC-2981)</td>
              </tr>
              <tr>
                <th>IPFS Metadata</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  <a
                    href={resolveApiUrl(sculpture.ipfs?.gatewayUrl)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    {sculpture.ipfs?.metadataUri}
                  </a>
                </td>
              </tr>
              <tr>
                <th>Version &amp; ERC-4906</th>
                <td className="mono">
                  Rev v{sculpture.currentRev || 1}
                  {sculpture.lastErc4906TxHash ? ` · ERC-4906 ${sculpture.lastErc4906TxHash.slice(0, 14)}...` : ''}
                </td>
              </tr>
              <tr>
                <th>Tx Hash</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  {explorerTxUrl ? (
                    <a
                      href={explorerTxUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      {sculpture.chain?.txHash}
                    </a>
                  ) : (
                    sculpture.chain?.txHash
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <SculptureRevisionsPanel
            sculptureId={sculpture.id}
            currentRev={sculpture.currentRev || 1}
            lastErc4906TxHash={sculpture.lastErc4906TxHash || ''}
            explorerUrl={config?.chain?.network?.explorerUrl || ''}
            canRollback={isPropertyOwner}
            onRolledBack={(res) => {
              if (res?.sculpture) {
                setSculpture(res.sculpture);
                onSculptureUpdated?.(res.sculpture);
                setPropNotice(
                  `Rolled back to v${res.restoredFromRev} (now v${res.revNum}) · ERC-4906 MetadataUpdate emitted.`
                );
              }
            }}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <a
              className="btn"
              href={glbUrl}
              download={`graffiland-${sculpture.id}.glb`}
              target="_blank"
              rel="noreferrer"
            >
              <XeroIcon emoji="📦" size={15} /> Export 3D .GLB
            </a>
            <a className="btn" href={tokenMetaUrl} target="_blank" rel="noreferrer">
              <XeroIcon emoji="🏷️" size={15} /> ERC-721 JSON
            </a>
            <button
              type="button"
              className="btn"
              disabled={busyAction !== ''}
              onClick={handleAddToWallet}
            >
              <XeroIcon emoji="🦊" size={15} /> Add to Wallet
            </button>
            <button
              type="button"
              className="btn"
              disabled={busyAction !== ''}
              onClick={handleSyncOwner}
            >
              <XeroIcon emoji="🔄" size={15} /> Sync Owner
            </button>
            {explorerTxUrl && (
              <a className="btn btn-primary" href={explorerTxUrl} target="_blank" rel="noreferrer">
                <XeroIcon emoji="⛓️" size={15} /> View Tx On Chain
              </a>
            )}
            {explorerTokenUrl && (
              <a className="btn" href={explorerTokenUrl} target="_blank" rel="noreferrer">
                <XeroIcon emoji="🌐" size={15} /> Blockscout Token
              </a>
            )}
          </div>

          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid rgba(255,255,255,0.08)'
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="📤" size={16} /> Transfer NFT to External Wallet / Marketplace
            </div>
            {user ? (
              <form
                onSubmit={handleEmbeddedTransfer}
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
              >
                <input
                  className="input mono"
                  style={{ flex: '1 1 260px', fontSize: 12 }}
                  placeholder="Destination 0x... (MetaMask, cold wallet, OpenSea, etc.)"
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                />
                {isEmbeddedOwner ? (
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busyAction !== ''}
                  >
                    <XeroIcon emoji="📤" size={15} /> Transfer NFT
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAction !== ''}
                    onClick={handleExternalWalletTransfer}
                  >
                    <XeroIcon emoji="🦊" size={15} /> Sign &amp; Transfer
                  </button>
                )}
              </form>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Sign in with Google or connect the owning MetaMask wallet to transfer ERC-721 custody.
              </div>
            )}
            {nftNotice && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)' }}>
                {nftNotice}
              </div>
            )}
            {nftError && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger, #ff5e7e)' }}>
                {nftError}
              </div>
            )}
            {transfers.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                  Provenance &amp; Transfer History ({transfers.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {transfers.slice(0, 5).map((t) => (
                    <div
                      key={t.id}
                      className="mono"
                      style={{
                        fontSize: 11,
                        padding: '5px 8px',
                        borderRadius: 6,
                        background: 'rgba(255,255,255,0.04)',
                        wordBreak: 'break-all'
                      }}
                    >
                      {t.fromAddress.slice(0, 8)}... -&gt; {t.toAddress.slice(0, 8)}... · {t.method} ·{' '}
                      {t.txHash.slice(0, 14)}...
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {canModifySculpture && (
          <div className="card" style={{ padding: 12, marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji={isPropertyOwner ? '🏠' : '🤝'} size={18} />{' '}
                {isPropertyOwner
                  ? `Property & Land Controls (${sculpture.parcelId})`
                  : `Contributor Sculpture Modification (${sculpture.parcelId})`}
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {onOpenLandManagement && isPropertyOwner && (
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    onClick={() => {
                      onClose?.();
                      onOpenLandManagement(sculpture.parcelId);
                    }}
                  >
                    <XeroIcon emoji="🗺️" size={14} /> Land Management
                  </button>
                )}
                {isPropertyOwner && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    disabled={propBusy !== ''}
                    onClick={handleCopyOwnerPrompt}
                  >
                    <XeroIcon emoji="📋" size={14} />{' '}
                    {promptCopied ? 'Copied MCP Prompt!' : 'Copy Property Owner MCP Prompt'}
                  </button>
                )}
              </div>
            </div>

            <form onSubmit={handleSaveSculptureEdit} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                {isPropertyOwner ? 'Edit Sculpture on Your Land' : 'Modify Sculpture as Verified Contributor'}
              </div>
              <input
                className="input"
                maxLength={48}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Sculpture title"
              />
              <textarea
                className="textarea"
                rows={2}
                maxLength={240}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description"
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="submit" className="btn btn-primary" disabled={propBusy !== ''}>
                  <XeroIcon emoji="✏️" size={14} /> Save Sculpture Changes
                </button>
                {onModifyInCanvas && sculpture.modelType !== 'custom-3d' && (
                  <button
                    type="button"
                    className="btn"
                    disabled={propBusy !== ''}
                    onClick={() => {
                      onClose?.();
                      onModifyInCanvas(sculpture);
                    }}
                  >
                    <XeroIcon emoji="🖌️" size={14} /> Modify 3D Blocks on AR Canvas
                  </button>
                )}
                {isPropertyOwner && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={propBusy !== ''}
                    onClick={handleDeleteOwnedSculpture}
                  >
                    <XeroIcon emoji="🗑️" size={14} /> Remove From Land
                  </button>
                )}
              </div>
            </form>

            {isPropertyOwner && (
              <>
                <form
              onSubmit={handleSaveLandCuration}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 10,
                borderTop: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-gold)' }}>
                Curate Virtual Land Parcel ({sculpture.parcelId})
              </div>
              <input
                className="input"
                maxLength={48}
                value={landCustomName}
                onChange={(e) => setLandCustomName(e.target.value)}
                placeholder="Custom Virtual Land title (e.g. Neon Corner Plaza)"
              />
              <input
                className="input"
                maxLength={240}
                value={landCurationNote}
                onChange={(e) => setLandCurationNote(e.target.value)}
                placeholder="Land note or curator statement"
              />
              <button type="submit" className="btn" disabled={propBusy !== ''}>
                <XeroIcon emoji="🗺️" size={14} /> Save Land Curations
              </button>
            </form>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-gold)' }}>
                  <XeroIcon emoji="📌" size={14} /> Pinned IPFS Messages (Real-Life Parcel Visitors Only)
                </span>
                {pinBatchInfo?.ipfsCid && (
                  <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                    ipfs://{pinBatchInfo.ipfsCid.slice(0, 12)}... · v{pinBatchInfo.batchSeq}
                  </span>
                )}
              </div>

              {modalPins.map((pin) => (
                <div
                  key={pin.id}
                  className="card"
                  style={{ padding: '7px 9px', borderColor: 'rgba(255, 209, 102, 0.32)' }}
                >
                  {editModalPinId === pin.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="input"
                        maxLength={500}
                        value={editModalPinText}
                        onChange={(e) => setEditModalPinText(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: 11 }}
                        disabled={propBusy !== ''}
                        onClick={async () => {
                          const txt = editModalPinText.trim();
                          if (!txt) return;
                          await saveOwnerPinnedIpfsBatch(
                            modalPins.map((m) =>
                              m.id === pin.id ? { ...m, text: txt, updatedAt: new Date().toISOString() } : m
                            )
                          );
                          setEditModalPinId('');
                          setEditModalPinText('');
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ fontSize: 11 }}
                        onClick={() => setEditModalPinId('')}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 12 }}>{pin.text}</div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 6px', fontSize: 10 }}
                          disabled={propBusy !== ''}
                          onClick={() => {
                            setEditModalPinId(pin.id);
                            setEditModalPinText(pin.text);
                          }}
                        >
                          <XeroIcon emoji="✏️" size={10} /> Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          style={{ padding: '2px 6px', fontSize: 10 }}
                          disabled={propBusy !== ''}
                          onClick={() =>
                            saveOwnerPinnedIpfsBatch(modalPins.filter((m) => m.id !== pin.id))
                          }
                        >
                          <XeroIcon emoji="🗑️" size={10} /> Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  maxLength={500}
                  value={pinDraftText}
                  onChange={(e) => setPinDraftText(e.target.value)}
                  placeholder="Pin message stored encrypted on IPFS for real-life parcel visitors..."
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={propBusy !== '' || !pinDraftText.trim()}
                  onClick={async () => {
                    const txt = pinDraftText.trim();
                    if (!txt) return;
                    const nowIso = new Date().toISOString();
                    await saveOwnerPinnedIpfsBatch([
                      ...modalPins,
                      {
                        id: crypto.randomUUID(),
                        text: txt,
                        authorName: user?.name || 'Land Holder',
                        authorAddress: ownerAddr,
                        pinnedAt: nowIso,
                        updatedAt: nowIso
                      }
                    ]);
                    setPinDraftText('');
                  }}
                >
                  <XeroIcon emoji="📌" size={13} /> Pin to IPFS
                </button>
              </div>
            </div>
              </>
            )}

            {propNotice && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)' }}>
                {propNotice}
              </div>
            )}
            {propError && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger, #ff5e7e)' }}>
                {propError}
              </div>
            )}
          </div>
        )}

        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <XeroIcon emoji="🔐" size={18} /> Camera-Locked Location Chat Board (E2EE)
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
            <span className="badge">
              <XeroIcon emoji="🔒" size={12} /> {sculpture.chatSummary?.messageCount ?? 0} encrypted messages
            </span>
            <span className="badge gold">
              <XeroIcon emoji="📌" size={12} /> {pinBatchInfo?.pinCount ?? sculpture.pinSummary?.pinCount ?? 0} pinned IPFS note(s) (in-person parcel unlock)
            </span>
            <span>
              Locked to physical in-person mobile AR camera selection only. Neither desktop browsers nor our servers can decrypt past chat history or parcel-pinned IPFS batches.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
