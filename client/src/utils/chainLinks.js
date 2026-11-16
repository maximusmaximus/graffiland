import { ROBINHOOD_NETWORKS } from '../../../shared/constants.mjs';

export function getExplorerBaseUrl(chain, config) {
  const chainIdNum = Number(chain?.chainId);
  if (chainIdNum === Number(ROBINHOOD_NETWORKS.mainnet.chainId)) {
    return ROBINHOOD_NETWORKS.mainnet.explorerUrl;
  }
  if (chainIdNum === Number(ROBINHOOD_NETWORKS.testnet.chainId)) {
    return ROBINHOOD_NETWORKS.testnet.explorerUrl;
  }
  return (
    config?.chain?.network?.explorerUrl ||
    config?.chain?.network?.explorer ||
    ROBINHOOD_NETWORKS.testnet.explorerUrl
  );
}

export function getSculptureChainLinks(sculpture, config) {
  const chain = sculpture?.chain || {};
  const explorerBase = String(getExplorerBaseUrl(chain, config) || '').replace(/\/$/, '');
  const isSimulated = Boolean(chain.simulated);
  const txHash = String(chain.txHash || '');
  const contractAddress = String(chain.contractAddress || '');
  const tokenId = chain.tokenId;

  return {
    explorerBase,
    isSimulated,
    txUrl: !isSimulated && explorerBase && txHash ? `${explorerBase}/tx/${txHash}` : '',
    tokenUrl:
      !isSimulated && explorerBase && contractAddress && tokenId != null
        ? `${explorerBase}/token/${contractAddress}/instance/${tokenId}`
        : '',
    contractUrl:
      !isSimulated && explorerBase && contractAddress
        ? `${explorerBase}/address/${contractAddress}`
        : ''
  };
}
