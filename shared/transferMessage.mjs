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
