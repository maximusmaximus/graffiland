import React from 'react';
import { resolveApiUrl } from '../utils/api.js';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function SculptureModal({ sculpture, onClose }) {
  if (!sculpture) return null;

  const pol = sculpture.proofOfLocation || {};
  const geo = pol.geoInfo || {};
  const sensors = pol.sensors || {};
  const solar = pol.solar || {};
  const elevation = sculpture.elevation || pol.elevation || {};

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
            <XeroIcon emoji="💎" size={18} /> IPFS &amp; Robinhood Chain Mint
          </div>
          <table className="kv-table">
            <tbody>
              <tr>
                <th>Network</th>
                <td className="mono">{sculpture.chain?.chainName} (Chain ID {sculpture.chain?.chainId})</td>
              </tr>
              <tr>
                <th>Owner / Recipient</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>{sculpture.recipientAddress}</td>
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
        </div>
      </div>
    </div>
  );
}
