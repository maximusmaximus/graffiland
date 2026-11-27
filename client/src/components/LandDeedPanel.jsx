import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import {
  buildLandTransferAuthMessage,
  ERC721_LAND_DEED_ABI
} from '../../../shared/transferMessage.mjs';
import { api } from '../utils/api.js';
import { getAddressExplorerUrl, getTxExplorerUrl } from '../utils/chainLinks.js';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function LandDeedPanel({
  parcel,
  onDeedChanged = null,
  onNotice = null,
  onError = null,
  fetchDeedFn = null,
  transferDeedFn = null,
  listForSaleFn = null,
  cancelListingFn = null,
  syncDeedFn = null
}) {
  const parcelId = parcel?.parcelId || '';
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [includeOwnedArtworks, setIncludeOwnedArtworks] = useState(false);
  const [listPriceEth, setListPriceEth] = useState('');
  const [bundleSaleArtworks, setBundleSaleArtworks] = useState(false);
  const [localNotice, setLocalNotice] = useState('');
  const [localError, setLocalError] = useState('');

  const loadDeed = useCallback(async () => {
    if (!parcelId) return;
    setLoading(true);
    setLocalError('');
    try {
      const loader = fetchDeedFn || ((id) => api.getLandDeed(id));
      const res = await loader(parcelId);
      setSummary(res || null);
    } catch (err) {
      setLocalError(err?.message || 'Could not load Land Deed NFT status.');
    } finally {
      setLoading(false);
    }
  }, [fetchDeedFn, parcelId]);

  useEffect(() => {
    setToAddress('');
    setIncludeOwnedArtworks(false);
    setListPriceEth('');
    setBundleSaleArtworks(false);
    setLocalNotice('');
    setLocalError('');
    loadDeed();
  }, [loadDeed]);

  const deed = summary?.deed || parcel?.landDeed || null;
  const activeListing = summary?.activeListing || parcel?.activeLandListing || null;
  const eligible = summary ? Boolean(summary.eligible) : Boolean(deed || parcel?.landDeedEligible);
  const eligibilityReason =
    summary?.eligibilityReason ||
    parcel?.landDeedEligibilityReason ||
    'Add mobile AR art on this land to clear its timer and mint its permanent Land Deed NFT.';
  const ownerOwnedCount = Number(
    summary?.ownerOwnedArtworkCount ?? parcel?.ownerOwnedArtworkCount ?? 0
  );
  const thirdPartyCount = Number(summary?.thirdPartyArtworkCount ?? 0);
  const transfers = Array.isArray(summary?.transfers) ? summary.transfers : [];

  const handleEmbeddedTransfer = async (e) => {
    e.preventDefault();
    const cleanTo = toAddress.trim();
    if (!ethers.isAddress(cleanTo)) {
      setLocalError('Enter a valid destination 0x EVM wallet address.');
      return;
    }
    setBusy('transfer');
    setLocalError('');
    setLocalNotice('');
    try {
      const fn = transferDeedFn || ((id, body) => api.transferLandDeed(id, body));
      const res = await fn(parcelId, {
        toAddress: cleanTo,
        includeOwnedArtworks: Boolean(includeOwnedArtworks)
      });
      const bundledN = res?.bundledSculptureIds?.length || 0;
      const msg = `Land Deed NFT #${res?.deed?.tokenId || deed?.tokenId} transferred to ${cleanTo.slice(0, 8)}…${cleanTo.slice(-4)}${
        bundledN > 0 ? ` (+ ${bundledN} artwork${bundledN === 1 ? '' : 's'})` : ''
      }.`;
      setLocalNotice(msg);
      onNotice?.(msg);
      setToAddress('');
      await loadDeed();
      await onDeedChanged?.(res);
    } catch (err) {
      const msg = err?.message || 'Land Deed transfer failed.';
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setBusy('');
    }
  };

  const handleExternalWalletTransfer = async () => {
    const cleanTo = toAddress.trim();
    if (!ethers.isAddress(cleanTo)) {
      setLocalError('Enter a valid destination 0x EVM wallet address first.');
      return;
    }
    if (!deed) return;
    if (typeof window === 'undefined' || !window.ethereum) {
      setLocalError('MetaMask / Web3 wallet extension is required for external wallet transfers.');
      return;
    }
    setBusy('transfer-external');
    setLocalError('');
    setLocalNotice('');
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const signerAddr = await signer.getAddress();
      const payload = {
        toAddress: cleanTo,
        includeOwnedArtworks: Boolean(includeOwnedArtworks)
      };

      if (!deed.simulated && deed.contractAddress && deed.tokenId) {
        const contract = new ethers.Contract(deed.contractAddress, ERC721_LAND_DEED_ABI, signer);
        const tx = await contract['safeTransferFrom(address,address,uint256)'](
          signerAddr,
          cleanTo,
          BigInt(deed.tokenId)
        );
        const receipt = await tx.wait();
        payload.externalTxHash = receipt?.hash || tx.hash;
      } else {
        const msgToSign = buildLandTransferAuthMessage({
          parcelId,
          tokenId: deed.tokenId,
          fromAddress: deed.ownerAddress,
          toAddress: cleanTo,
          contractAddress: deed.contractAddress,
          chainId: deed.chainId,
          includeOwnedArtworks: Boolean(includeOwnedArtworks)
        });
        payload.walletSignature = await signer.signMessage(msgToSign);
      }

      const fn = transferDeedFn || ((id, body) => api.transferLandDeed(id, body));
      const res = await fn(parcelId, payload);
      const msg = `External wallet transfer confirmed for Land Deed #${deed.tokenId} -> ${cleanTo.slice(0, 8)}…${cleanTo.slice(-4)}.`;
      setLocalNotice(msg);
      onNotice?.(msg);
      setToAddress('');
      await loadDeed();
      await onDeedChanged?.(res);
    } catch (err) {
      const msg = err?.message || 'External wallet transfer failed.';
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setBusy('');
    }
  };

  const handleListForSale = async (e) => {
    e.preventDefault();
    const price = Number(listPriceEth);
    if (!Number.isFinite(price) || price <= 0) {
      setLocalError('Enter a sale price in ETH greater than 0.');
      return;
    }
    setBusy('list');
    setLocalError('');
    setLocalNotice('');
    try {
      const fn = listForSaleFn || ((body) => api.listLandForSale(body));
      const res = await fn({
        parcelId,
        priceEth: price,
        includeSellerArtworks: Boolean(bundleSaleArtworks)
      });
      const msg = `Land Deed #${res?.deed?.tokenId || deed?.tokenId} listed for ${price} ETH.`;
      setLocalNotice(msg);
      onNotice?.(msg);
      setListPriceEth('');
      await loadDeed();
      await onDeedChanged?.(res);
    } catch (err) {
      const msg = err?.message || 'Could not list Land Deed for sale.';
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setBusy('');
    }
  };

  const handleCancelListing = async () => {
    if (!activeListing?.id) return;
    setBusy('cancel-list');
    setLocalError('');
    setLocalNotice('');
    try {
      const fn = cancelListingFn || ((id) => api.cancelLandListing(id));
      await fn(activeListing.id);
      const msg = 'Land Deed marketplace listing cancelled.';
      setLocalNotice(msg);
      onNotice?.(msg);
      await loadDeed();
      await onDeedChanged?.();
    } catch (err) {
      const msg = err?.message || 'Could not cancel listing.';
      setLocalError(msg);
      onError?.(msg);
    } finally {
      setBusy('');
    }
  };

  const handleSyncOnChain = async () => {
    setBusy('sync');
    setLocalError('');
    setLocalNotice('');
    try {
      const fn = syncDeedFn || ((id) => api.syncLandDeed(id));
      const res = await fn(parcelId);
      const msg = res?.changed
        ? `Synced new on-chain owner: ${res.ownerAddress}`
        : `On-chain owner verified (${res?.ownerAddress?.slice(0, 10) || 'synced'}…).`;
      setLocalNotice(msg);
      onNotice?.(msg);
      await loadDeed();
      if (res?.changed) await onDeedChanged?.(res);
    } catch (err) {
      setLocalError(err?.message || 'Could not sync Land Deed ownership.');
    } finally {
      setBusy('');
    }
  };

  const txExplorerUrl = deed?.txHash ? getTxExplorerUrl(deed.txHash, deed.chainId) : '';
  const contractExplorerUrl = deed?.contractAddress
    ? getAddressExplorerUrl(deed.contractAddress, deed.chainId)
    : '';

  return (
    <div className="card land-mgmt-section land-deed-panel" data-testid="land-deed-panel">
      <div className="land-mgmt-section-head">
        <div className="land-mgmt-heading">
          <XeroIcon emoji="🏷️" size={15} />
          <strong>Land Deed NFT (SLAND)</strong>
          <InfoTip title="Transferable Virtual Land Deed NFT">
            Every permanent / awakened parcel mints its own ERC-721 Land Deed NFT (separate from
            individual artwork NFTs). Transferring or selling this Deed moves curation control and
            all future <strong>3% Land Steward royalties</strong> to the new owner, while keeping
            the <strong>2% Human Contributor pool</strong> with the original IRL artists and
            auto-cancelling previous pending agent approvals.
          </InfoTip>
        </div>
        {deed ? (
          <span className="badge teal mono" data-testid="land-deed-token-badge" style={{ fontSize: 10.5 }}>
            Deed #{deed.tokenId} · Permanent
          </span>
        ) : loading ? (
          <span className="badge" style={{ fontSize: 10 }}>Loading…</span>
        ) : (
          <span className="badge gold" data-testid="land-deed-pending-badge" style={{ fontSize: 10 }}>
            ⏳ Not Minted Yet
          </span>
        )}
      </div>

      {localError && (
        <div className="badge danger" role="alert" style={{ fontSize: 11, whiteSpace: 'normal' }}>
          {localError}
        </div>
      )}
      {localNotice && (
        <div className="badge teal" role="status" style={{ fontSize: 11, whiteSpace: 'normal' }}>
          {localNotice}
        </div>
      )}

      {!deed && !loading && !eligible && (
        <div className="land-deed-unminted-box" data-testid="land-deed-unminted-notice">
          <div style={{ fontSize: 12, fontWeight: 600 }}>Land Deed NFT unlocks once permanent</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
            {eligibilityReason}
          </div>
        </div>
      )}

      {deed && (
        <>
          <div className="land-deed-meta-row mono">
            <span>
              Owner: <strong>{deed.ownerAddress.slice(0, 8)}…{deed.ownerAddress.slice(-4)}</strong>
            </span>
            <span>·</span>
            <span>{deed.chainName}</span>
            {contractExplorerUrl && !deed.simulated && (
              <>
                <span>·</span>
                <a href={contractExplorerUrl} target="_blank" rel="noreferrer">
                  Contract ↗
                </a>
              </>
            )}
            {txExplorerUrl && !deed.simulated && (
              <>
                <span>·</span>
                <a href={txExplorerUrl} target="_blank" rel="noreferrer">
                  Mint Tx ↗
                </a>
              </>
            )}
            <button
              type="button"
              className="btn btn-xs"
              disabled={busy !== ''}
              onClick={handleSyncOnChain}
              style={{ marginLeft: 'auto' }}
            >
              🔄 Sync
            </button>
          </div>

          {/* Transfer Land Deed (+ Optional 1-click Bundle of Owner's Artworks) */}
          <form onSubmit={handleEmbeddedTransfer} className="land-deed-subcard">
            <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="📤" size={13} /> Transfer Land Deed to Wallet / Agent
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input
                className="input"
                data-testid="land-deed-transfer-to-input"
                value={toAddress}
                onChange={(e) => setToAddress(e.target.value)}
                placeholder="Recipient 0x wallet address (human or AI agent)…"
                style={{ flex: '1 1 200px' }}
              />
            </div>

            {ownerOwnedCount > 0 && (
              <label className="land-deed-bundle-toggle">
                <input
                  type="checkbox"
                  data-testid="land-deed-bundle-checkbox"
                  checked={includeOwnedArtworks}
                  onChange={(e) => setIncludeOwnedArtworks(e.target.checked)}
                />
                <span>
                  Also bundle my <strong>{ownerOwnedCount}</strong> artwork
                  {ownerOwnedCount === 1 ? '' : 's'} on this land
                </span>
              </label>
            )}

            <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.35 }}>
              Transfers curation rights &amp; future <strong>3% Steward royalties</strong> and cancels
              pending agent approvals.
              {thirdPartyCount > 0
                ? ` ${thirdPartyCount} third-party artwork${thirdPartyCount === 1 ? ' stays' : 's stay'} with their creators.`
                : ''}
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="submit"
                className="btn btn-xs btn-primary"
                data-testid="land-deed-transfer-submit-btn"
                disabled={busy !== '' || !toAddress.trim()}
              >
                <XeroIcon emoji="📤" size={12} />{' '}
                {busy === 'transfer' ? 'Transferring…' : 'Transfer Land Deed'}
              </button>
              <button
                type="button"
                className="btn btn-xs"
                data-testid="land-deed-external-transfer-btn"
                disabled={busy !== '' || !toAddress.trim()}
                onClick={handleExternalWalletTransfer}
              >
                🦊 External Wallet
              </button>
            </div>
          </form>

          {/* Sell Land Deed on SPRAY.LAND Marketplace */}
          <div className="land-deed-subcard">
            <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="💎" size={13} /> Marketplace Listing (5% Platform · 3% Steward · 2% Human Pool)
            </div>
            {activeListing ? (
              <div className="land-deed-active-listing" data-testid="land-deed-active-listing">
                <div style={{ fontSize: 12 }}>
                  Listed for <strong>{activeListing.priceEth} ETH</strong>
                  {activeListing.includeSellerArtworks && activeListing.bundledSculptureIds?.length > 0
                    ? ` (includes ${activeListing.bundledSculptureIds.length} bundled artwork${
                        activeListing.bundledSculptureIds.length === 1 ? '' : 's'
                      })`
                    : ' (Land Deed only)'}
                </div>
                <button
                  type="button"
                  className="btn btn-xs btn-danger"
                  data-testid="land-deed-cancel-listing-btn"
                  disabled={busy !== ''}
                  onClick={handleCancelListing}
                >
                  {busy === 'cancel-list' ? 'Cancelling…' : 'Cancel Listing'}
                </button>
              </div>
            ) : (
              <form onSubmit={handleListForSale} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    className="input"
                    type="number"
                    step="0.001"
                    min="0.0001"
                    data-testid="land-deed-list-price-input"
                    value={listPriceEth}
                    onChange={(e) => setListPriceEth(e.target.value)}
                    placeholder="Price in ETH (e.g. 0.25)"
                    style={{ flex: '1 1 140px' }}
                  />
                  <button
                    type="submit"
                    className="btn btn-xs btn-primary"
                    data-testid="land-deed-list-submit-btn"
                    disabled={busy !== '' || !listPriceEth}
                  >
                    {busy === 'list' ? 'Listing…' : 'List Land for Sale'}
                  </button>
                </div>
                {ownerOwnedCount > 0 && (
                  <label className="land-deed-bundle-toggle">
                    <input
                      type="checkbox"
                      data-testid="land-deed-sale-bundle-checkbox"
                      checked={bundleSaleArtworks}
                      onChange={(e) => setBundleSaleArtworks(e.target.checked)}
                    />
                    <span>
                      Include my <strong>{ownerOwnedCount}</strong> artwork
                      {ownerOwnedCount === 1 ? '' : 's'} in this sale bundle
                    </span>
                  </label>
                )}
              </form>
            )}
          </div>

          {/* Transfer History */}
          {transfers.length > 0 && (
            <div className="land-deed-history" data-testid="land-deed-transfer-history">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>
                Land Deed Transfer History ({transfers.length})
              </div>
              {transfers.slice(0, 5).map((tr) => (
                <div key={tr.id} className="land-deed-history-row mono">
                  <span>
                    {tr.fromAddress.slice(0, 6)}… → {tr.toAddress.slice(0, 6)}…
                  </span>
                  <span>
                    {tr.method}
                    {tr.bundledSculptureIds?.length > 0
                      ? ` · +${tr.bundledSculptureIds.length} art`
                      : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
