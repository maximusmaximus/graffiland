export const VOXEL_RESOLUTION_SCALE = 4;
export const VOXEL_STEP = 0.05; // 4x resolution vs original 0.2m block size
export const AREA_LIMIT_BLOCKS = 10000; // 10000 x 10000 x 10000 blocks max area per axis
export const AREA_HALF_SPAN_METERS = (AREA_LIMIT_BLOCKS / 2) * VOXEL_STEP; // 250m from origin -> 500m total span

export const GRAFFITI_PALETTE = [
  '#00f5d4',
  '#ff3e7f',
  '#ffd166',
  '#7b2cbf',
  '#00bbf9',
  '#ff6b35',
  '#80ff72',
  '#ffffff',
  '#ff0054',
  '#3a86ff',
  '#f15bb5',
  '#1b263b'
];

export const VOXEL_MATERIALS = [
  { id: 'matte', label: 'Matte Pigment', roughness: 0.35, metalness: 0.24 },
  { id: 'neon', label: 'Neon Glow', roughness: 0.16, metalness: 0.35, emissiveIntensity: 0.85 },
  { id: 'glass', label: 'Reflective Glass', roughness: 0.06, metalness: 0.1, opacity: 0.72 }
];

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

export const TRANSACTION_FEES = {
  platformBps: 500, // 5% collected by Platform on every transaction
  agentStewardBps: 300, // 3% collected by Agent Land Steward
  humanContributorBps: 200, // 2% collected by verified IRL Human Contributors pro-rata
  totalBps: 1000, // 10% combined fee/royalty split
  sellerNetBps: 9000 // 90% net proceeds
};

export const STEWARD_DEFAULTS = {
  starterDormantSlots: 3,
  slotsPerAwakenedLand: 2,
  maxDormantSlots: 50,
  dormantLeaseTtlHours: 168, // 7 days before unawakened agent land recycles
  minHumanPoolVoxels: 3, // minimum voxel count to qualify for 2% Contributor pool share
  firstSparkXpHuman: 300, // 2x bonus for awakening dormant agent parcel
  humanQuestBaseXp: 150,
  agentAwakenXp: 100
};

export const LAND_VOLUME_LIMITS = {
  minWidthMeters: 4,
  maxWidthMeters: 120,
  defaultWidthMeters: 14,
  minDepthMeters: 4,
  maxDepthMeters: 120,
  defaultDepthMeters: 14,
  minHeightMeters: 4,
  maxHeightMeters: 250,
  defaultHeightMeters: 18,
  minZScale: 0.25,
  maxZScale: 10,
  defaultZScale: 1,
  rotationMinDeg: 0,
  rotationMaxDeg: 359,
  defaultRotationDeg: 0,
  maxFootprintAreaSqM: 5000,
  maxVolumeCubicM: 500000,
  maxSelectionBatch: 12,
  starterFreeHumanClaims: 3
};

export const POLICY = {
  termsVersion: '2026-11-19.v3',
  titleMin: 3,
  titleMax: 48,
  descriptionMin: 10,
  descriptionMax: 240,
  descriptionMaxWords: 45,
  maxVoxels: 4096,
  minVoxels: 1,
  resolutionScale: VOXEL_RESOLUTION_SCALE,
  voxelStepMeters: VOXEL_STEP,
  areaHalfSpanMeters: AREA_HALF_SPAN_METERS,
  areaLimitBlocks: [AREA_LIMIT_BLOCKS, AREA_LIMIT_BLOCKS, AREA_LIMIT_BLOCKS],
  landVolumeLimits: LAND_VOLUME_LIMITS,
  resaleFeePercent: 5,
  resaleFeeBps: 500,
  transactionFees: TRANSACTION_FEES,
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
  threatModelSummary:
    'Proof of Location combines live camera-gyro optical flow, solar elevation checks, GPS trajectory sanity, non-reversible ORB visual landmarks, and optional ES256 hardware Passkeys. Because client browsers still supply raw sensor streams, ultra-high-value or adversarial scenarios remain vulnerable to physical camera-replay rigs unless paired with WebXR hardware depth / remote visual verification.',
  takedownAndDisputePolicy: [
    'Prohibited Content: Hate speech, harassment, doxxing, CSAM, threats of violence, explicit fraud/phishing links, and malicious 3D assets exceeding safety budgets are strictly prohibited.',
    'Takedown Process: Property owners, rights holders, and citizens may flag any sculpture ID + Geohash parcel for moderation review. Verified violations are immediately hidden from public maps, gallery feeds, and AR previews via admin visibility controls while preserving audit logs.',
    'Virtual Land & IRL Disputes: Geohash-8 claims record art provenance and never confer physical trespass rights, municipal signage permits, or real-estate title. Parcel holders and verified IRL Contributors resolve local curation disputes through Land Management permissions or ERC-721 ownership transfer.'
  ],
  termsText: [
    '1. Physical Presence & Proof of Location: GRAFFILAND sculptures require a real mobile device with camera, gyroscope, and GPS active at the physical location. Spoofing GPS, replaying static camera frames, or automated minting is prohibited.',
    '2. Virtual Land Parcels: Each published sculpture anchors to a ~12m x 12m physical Geohash-8 Virtual Land parcel. Minting records spatial metadata and Proof-of-Location hashes on IPFS and Robinhood Chain without granting real-world property rights or permission to trespass.',
    '3. Public Permanence, Takedowns & Disputes: Published voxel sculptures, titles, descriptions, and location metadata are pinned to IPFS and minted on Robinhood Chain. Platform administrators reserve the right to hide items from public map, gallery, and AR preview feeds for safety, legal takedown, DMCA, or policy violations.',
    '4. Gas Sponsorship & Daily Quotas: Platform relayers currently sponsor gas up to daily per-account quotas on Robinhood Chain and deliver the ERC-721 NFT directly to your Google-linked embedded wallet (or custom payout address).',
    '5. 5% Secondary Resale Royalty: Every GRAFFILAND NFT embeds an ERC-2981 5% (500 bps) resale fee honored by compatible Robinhood Chain marketplaces.',
    '6. Limited Terms Policy: Titles must be 3–48 characters and descriptions must be 10–240 characters (max 45 words) with no links, scams, hate speech, or personal doxxing.'
  ]
};
