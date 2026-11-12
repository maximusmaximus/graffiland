export const ROBINHOOD_NETWORKS = {
  testnet: {
    key: 'testnet',
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    nativeCurrency: 'ETH'
  },
  mainnet: {
    key: 'mainnet',
    name: 'Robinhood Chain',
    chainId: 4663,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    nativeCurrency: 'ETH'
  }
};

export const POLICY = {
  termsVersion: '2026-11-12.v1',
  titleMin: 3,
  titleMax: 48,
  descriptionMin: 10,
  descriptionMax: 240,
  descriptionMaxWords: 45,
  maxVoxels: 512,
  minVoxels: 1,
  resaleFeePercent: 5,
  resaleFeeBps: 500,
  prohibitedTerms: [
    'http://',
    'https://',
    'www.',
    't.me/',
    'discord.gg',
    'airdrop',
    'free crypto',
    'seed phrase',
    'private key',
    'nazi',
    'swastika',
    'kill yourself',
    'doxx'
  ],
  termsText: [
    '1. Physical Presence & Proof of Location: GRAFFILAND sculptures require a real mobile device with camera, gyroscope, and GPS active at the physical location. Spoofing GPS, replaying static camera frames, or automated minting is prohibited.',
    '2. Virtual Land Parcels: Each published sculpture anchors to a ~12m x 12m physical Geohash-8 Virtual Land parcel. Minting records spatial metadata and Proof-of-Location hashes on IPFS and Robinhood Chain without granting real-world property rights or permission to trespass.',
    '3. Public Permanence & Moderation: Published voxel sculptures, titles, descriptions, and location metadata are pinned to IPFS and minted on Robinhood Chain. Platform administrators reserve the right to hide items from the public map, gallery, and AR preview feeds for safety, spam, or policy violations.',
    '4. Gas Sponsorship & Ownership: Platform relayers currently cover minting gas on Robinhood Chain and deliver the ERC-721 NFT directly to your Google-linked embedded wallet (or linked payout address).',
    '5. 5% Secondary Resale Royalty: Every GRAFFILAND NFT embeds an ERC-2981 5% (500 bps) resale fee honored by compatible Robinhood Chain marketplaces.',
    '6. Limited Terms Policy: Titles must be 3–48 characters and descriptions must be 10–240 characters (max 45 words) with no links, scams, hate speech, or personal doxxing.'
  ]
};
