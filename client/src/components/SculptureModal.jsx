import React, { useEffect, useState } from 'react';
import { BrowserProvider, Contract, isAddress } from 'ethers';
import {
  buildTransferAuthMessage,
  ERC721_TRANSFER_ABI
} from '../../../shared/transferMessage.mjs';
import { api, resolveApiUrl } from '../utils/api.js';
import SculptureViewer3D from './SculptureViewer3D.jsx';
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
  onSculptureUpdated,
  onClose
}) {
  const [sculpture, setSculpture] = useState(initialSculpture);
  const [toAddress, setToAddress] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [nftNotice, setNftNotice] = useState('');
  const [nftError, setNftError] = useState('');

  useEffect(() => {
    setSculpture(initialSculpture);
    setNftNotice('');
    setNftError('');
    if (!initialSculpture?.id) return;
    let cancelled = false;
    api
      .getSculpture(initialSculpture.id)
      .then((res) => {
        if (!cancelled && res?.sculpture) {
          setSculpture(res.sculpture);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialSculpture]);

  if (!sculpture) return null;

  const pol = sculpture.proofOfLocation || {};
  const geo = pol.geoInfo || {};
  const sensors = pol.sensors || {};
  const solar = pol.solar || {};
  const elevation = sculpture.elevation || pol.elevation || {};
  const ownerAddr = sculpture.recipientAddress || sculpture.ownerAddress || '';
  const isEmbeddedOwner = Boolean(
    user?.walletAddress &&
      ownerAddr &&
      user.walletAddress.toLowerCase() === ownerAddr.toLowerCase()
  );
  const glbUrl = resolveApiUrl(
    sculpture.modelGlbUrl || `/api/sculptures/${encodeURIComponent(sculpture.id)}/model.glb`
  );
  const tokenMetaUrl = resolveApiUrl(
    sculpture.metadataUrl || `/api/sculptures/${encodeURIComponent(sculpture.id)}/metadata.json`
  );
  const explorerBase = config?.chain?.network?.explorer || '';
  const explorerTokenUrl =
    !sculpture.chain?.simulated && explorerBase && sculpture.chain?.contractAddress
      ? `${explorerBase}/token/${sculpture.chain.contractAddress}/instance/${sculpture.chain.tokenId}`
      : '';
  const transfers = Array.isArray(sculpture.transfers) ? sculpture.transfers : [];

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

        <SculptureViewer3D voxels={sculpture.voxels || []} height={300} autoRotate />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <span className="badge teal">
            <XeroIcon emoji="📍" size={13} /> Land {sculpture.parcelId}
          </span>
          <span className="badge gold">
            <XeroIcon emoji="✅" size={13} /> PoL Score {sculpture.polScore}/100
          </span>
          <span className="badge pink">
            <XeroIcon emoji="🪙" size={13} /> {sculpture.chain?.royaltyPercent || 5}% Resale Fee
          </span>
          <span className="badge">
            <XeroIcon emoji="🧱" size={13} /> {sculpture.voxelCount} voxels
          </span>
        </div>

        <p style={{ fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>{sculpture.description}</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="🗺️" size={18} /> Location &amp; Virtual Land Metadata
            </div>
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
                  #{sculpture.chain?.tokenId} · {sculpture.chain?.contractAddress}
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
                <th>Tx Hash</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>{sculpture.chain?.txHash}</td>
              </tr>
            </tbody>
          </table>

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
            {explorerTokenUrl && (
              <a className="btn" href={explorerTokenUrl} target="_blank" rel="noreferrer">
                <XeroIcon emoji="🌐" size={15} /> Blockscout
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

        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <XeroIcon emoji="🔐" size={18} /> Camera-Locked Location Chat Board (E2EE)
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
            <span className="badge">
              <XeroIcon emoji="🔒" size={12} /> {sculpture.chatSummary?.messageCount ?? 0} encrypted messages
            </span>
            <span>
              Locked to physical in-person mobile AR camera selection only. Neither desktop browsers nor our servers can decrypt past chat history.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
