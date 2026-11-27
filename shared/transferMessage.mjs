export const ERC721_TRANSFER_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function contractURI() view returns (string)',
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

export const ERC721_LAND_DEED_ABI = [
  ...ERC721_TRANSFER_ABI,
  'function mintLandDeed(address recipient, bytes32 landParcelId, string calldata metadataURI, bytes32 proofOfLocationHash, int32 latE6, int32 lngE6) external returns (uint256)',
  'function updateLandURI(uint256 tokenId, string calldata newURI) external',
  'function ownerOfParcel(bytes32 landParcelId) view returns (address)',
  'function parcelTokenId(bytes32 landParcelId) view returns (uint256)',
  'event LandDeedMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)',
  'event LandDeedTransferred(uint256 indexed tokenId, bytes32 indexed landParcelId, address indexed from, address to)'
];

export function buildTransferAuthMessage({
  sculptureId,
  tokenId,
  fromAddress,
  toAddress,
  contractAddress,
  chainId
}) {
  return [
    'GRAFFILAND NFT Transfer Authorization',
    `Sculpture: ${sculptureId}`,
    `Token ID: ${tokenId}`,
    `Contract: ${contractAddress}`,
    `Chain ID: ${chainId}`,
    `From: ${fromAddress}`,
    `To: ${toAddress}`
  ].join('\n');
}

export function buildLandTransferAuthMessage({
  parcelId,
  tokenId,
  fromAddress,
  toAddress,
  contractAddress,
  chainId,
  includeOwnedArtworks = false
}) {
  return [
    'SPRAY.LAND Land Deed NFT Transfer Authorization',
    `Parcel: ${String(parcelId || '').trim().toUpperCase()}`,
    `Land Deed Token ID: ${tokenId}`,
    `Contract: ${contractAddress}`,
    `Chain ID: ${chainId}`,
    `From: ${fromAddress}`,
    `To: ${toAddress}`,
    `Include Owned Artworks: ${includeOwnedArtworks ? 'yes' : 'no'}`
  ].join('\n');
}
