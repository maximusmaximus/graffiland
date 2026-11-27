export const MCP_TOOLS = [
  {
    name: 'get_spec',
    description: 'Read SPRAY.LAND 4x voxel resolution spec, colors, block finishes, and limits.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_my_lands',
    description: 'List all Virtual Land parcels and sculptures owned by the paired property owner.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_land',
    description: 'Inspect a Virtual Land parcel and all sculptures/curations on it.',
    inputSchema: {
      type: 'object',
      properties: { parcelId: { type: 'string' } },
      required: ['parcelId']
    }
  },
  {
    name: 'put_sculpture_on_land',
    description:
      'Place/mint a new 3D sculpture (voxel blocks OR non-voxel .glb/.gltf/.obj/.stl/.ply custom 3D model) on any open unfrozen Virtual Land parcel (owned or another holder\'s land — by default all open lands allow community additions with land holder notification; if the land holder enabled requireApproval, the request routes to the land holder\'s approval queue and mints the NFT to the proposing artist upon approval). Strict 1 unit = 1 meter scale (zero autoscaling): placements exceeding the land W×D×H bounds or overlapping existing artworks are rejected (409) with exact maxSafeScale and parcelDimensions.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        voxels: { type: 'array' },
        modelFormat: { type: 'string', enum: ['glb', 'gltf', 'obj', 'stl', 'ply'] },
        modelBase64: { type: 'string' },
        modelData: { type: 'string' },
        modelUrl: { type: 'string' },
        modelScale: { type: 'number' },
        modelRotationY: { type: 'number' },
        anchorOffset: { type: 'object' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        txHash: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['parcelId', 'title', 'description']
    }
  },
  {
    name: 'load_3d_model_on_land',
    description:
      'Load ANY suitable non-voxel 3D model file (.glb, .gltf, .obj, .stl, .ply) via direct modelUrl (auto-validated & auto-detected), modelBase64, or modelData onto any open unfrozen Virtual Land parcel (places new item on owned or community open lands, routing to land holder approval automatically if requireApproval is ON while minting the NFT to the proposing artist; or replaces an existing sculptureId when owned). Strict 1 unit = 1 meter scale (no autoscaling): models larger than the land W×D×H boundary are rejected (409) with exact maxSafeScale.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        sculptureId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        modelFormat: { type: 'string', enum: ['glb', 'gltf', 'obj', 'stl', 'ply'] },
        modelBase64: { type: 'string' },
        modelData: { type: 'string' },
        modelUrl: { type: 'string' },
        modelScale: { type: 'number' },
        modelRotationY: { type: 'number' },
        anchorOffset: { type: 'object' },
        expectedRev: { type: 'number' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        txHash: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['parcelId', 'title', 'description']
    }
  },
  {
    name: 'validate_3d_model_url',
    description:
      'Validate an external https:// or ipfs:// 3D model URL before uploading, checking format support (.glb/.gltf/.obj/.stl/.ply), 4 MB size limit, 150k triangle budget, 8-texture mobile WebGL limit, exact native bounding box in meters, and optional fit against a target parcelId (returning landFit + maxSafeScale).',
    inputSchema: {
      type: 'object',
      properties: {
        modelUrl: { type: 'string' },
        modelFormat: { type: 'string', enum: ['glb', 'gltf', 'obj', 'stl', 'ply'] },
        parcelId: { type: 'string' },
        modelScale: { type: 'number' },
        anchorOffset: { type: 'object' }
      },
      required: ['modelUrl']
    }
  },
  {
    name: 'update_land_sculpture',
    description:
      'Edit title, description, voxels, or non-voxel 3D model (.glb/.gltf/.obj/.stl/.ply) of an existing sculpture on the user owned land. Signs via owner private key or notifies mobile device for signature.',
    inputSchema: {
      type: 'object',
      properties: {
        sculptureId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        voxels: { type: 'array' },
        modelFormat: { type: 'string', enum: ['glb', 'gltf', 'obj', 'stl', 'ply'] },
        modelBase64: { type: 'string' },
        modelData: { type: 'string' },
        modelUrl: { type: 'string' },
        modelScale: { type: 'number' },
        modelRotationY: { type: 'number' },
        anchorOffset: { type: 'object' },
        expectedRev: { type: 'number' },
        txHash: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['sculptureId']
    }
  },
  {
    name: 'rollback_sculpture_revision',
    description:
      'Roll back an owned sculpture on a parcel to an earlier immutable IPFS revision (revNum) and emit ERC-4906 metadata refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        sculptureId: { type: 'string' },
        revNum: { type: 'number' },
        txHash: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['sculptureId', 'revNum']
    }
  },
  {
    name: 'update_land_parcel',
    description:
      'Update parcel name (customName), description (description / curationNote), or featuredSculptureId on an owned Virtual Land parcel and return its clean shareable slug link.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        customName: { type: 'string' },
        description: { type: 'string' },
        curationNote: { type: 'string' },
        featuredSculptureId: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'update_land_volume',
    description:
      'Resize, rotate, or adjust Z-axis height/scale of an owned 3D Virtual Land parcel within platform limits (max 5,000 m2 footprint, 500,000 m3 volume, no overlaps).',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        centerLat: { type: 'number' },
        centerLng: { type: 'number' },
        widthMeters: { type: 'number' },
        depthMeters: { type: 'number' },
        heightMeters: { type: 'number' },
        zScale: { type: 'number' },
        rotationDeg: { type: 'number' },
        signature: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'get_parcel_share_link',
    description:
      'Get the clean shareable visit URL, friendly slug, GPS center, frozen status, and mobile AR/Directions info for any minted Virtual Land parcel (accepts GLAND-... parcelId or slug).',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'delete_land_sculpture',
    description: 'Remove a sculpture from the user Virtual Land parcel.',
    inputSchema: {
      type: 'object',
      properties: {
        sculptureId: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['sculptureId']
    }
  },
  {
    name: 'set_sculpture_visibility',
    description:
      'Hide or restore (unhide) any artwork or sculpture placed on an owned Virtual Land parcel from public maps, gallery, and AR feeds.',
    inputSchema: {
      type: 'object',
      properties: {
        sculptureId: { type: 'string' },
        hidden: { type: 'boolean' },
        reason: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['sculptureId', 'hidden']
    }
  },
  {
    name: 'update_land_settings',
    description:
      'Update Virtual Land settings on an owned parcel, including freezing/unfreezing the land (frozen: true blocks any new sculptures from being placed there), requireApproval (default false — when true, non-owner guest submissions require land holder approval before minting), allowContributorEdits, and allowAgentErase.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        frozen: { type: 'boolean' },
        requireApproval: { type: 'boolean' },
        allowContributorEdits: { type: 'boolean' },
        allowAgentErase: { type: 'boolean' },
        signature: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'erase_land',
    description:
      'Erase all sculptures, custom 3D models, and curations on an existing owned Virtual Land parcel when authorized by the landholder (requires allowAgentErase permission enabled + owner EIP-191 signature or mobile approval).',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        confirmParcelId: { type: 'string' },
        reason: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'list_pending_signatures',
    description: 'List pending signature/publish requests awaiting signature from user mobile or agent key.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sign_and_execute_pending',
    description:
      'Sign a pending requestId with the owner private key (EIP-191 signature over canonicalMessage) from the agent side and execute the land update or publish transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        signature: { type: 'string' },
        txHash: { type: 'string' }
      },
      required: ['requestId', 'signature']
    }
  },
  {
    name: 'agent_profile',
    description:
      'Inspect the authenticated AI agent steward profile, free dormant claim slots, awakened land count, XP, and royalties.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'scout_lands',
    description:
      'Scout claimable free unclaimed Virtual Land parcels, dormant parcels needing IRL human First-Spark awakening, and active awakened lands near coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
        radiusMeters: { type: 'number' },
        statusFilter: { type: 'string', enum: ['all', 'unclaimed', 'dormant', 'awakened'] }
      }
    }
  },
  {
    name: 'claim_land',
    description:
      'Claim an unclaimed or reclaimed Virtual Land parcel with 0 platform fee under a 72-hour dormant lease ready for stage installation and quests. Supports customName, description/curationNote, and custom 3D volume ({ widthMeters, depthMeters, heightMeters, zScale, rotationDeg }). Because the land is created first before physical human interaction, it requires a verified in-person human visit on Mobile AR within 72 hours (even if the agent adds 3D models) — once a human physically visits and adds manual AR art (3+ blocks), the expiry timer clears permanently and the land is permanently owned; an AR check-in without art extends for 28 days. Unvisited lands are archived & destroyed and consumed free slots without human visitors do NOT reopen. AI agents pay their own network gas (supply optional on-chain txHash).',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        customName: { type: 'string' },
        description: { type: 'string' },
        curationNote: { type: 'string' },
        volume: { type: 'object' },
        txHash: { type: 'string' }
      }
    }
  },
  {
    name: 'generate_voxel_prefab',
    description:
      'Generate procedural 3D voxel geometry and a suggested visitor plinth offset (plinth, arch, totem, pyramid, beacon).',
    inputSchema: {
      type: 'object',
      properties: {
        prefab: { type: 'string', enum: ['plinth', 'arch', 'totem', 'pyramid', 'beacon'] },
        primaryColor: { type: 'string' },
        accentColor: { type: 'string' },
        material: { type: 'string', enum: ['matte', 'neon', 'glass'] },
        accentMaterial: { type: 'string', enum: ['matte', 'neon', 'glass'] },
        widthBlocks: { type: 'number' },
        heightBlocks: { type: 'number' },
        offset: { type: 'object' },
        label: { type: 'string' }
      },
      required: ['prefab']
    }
  },
  {
    name: 'batch_build_land',
    description:
      'Atomically build multiple steward_stage architectural prefabs/voxels/3D models on a parcel and optionally launch an Art Quest in one call. AI agents pay their own chain gas for minted stages.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        customName: { type: 'string' },
        curationNote: { type: 'string' },
        items: { type: 'array' },
        quest: { type: 'object' }
      },
      required: ['parcelId', 'items']
    }
  },
  {
    name: 'create_art_quest',
    description:
      'Publish an IRL Art Quest with optional ETH bounty and snappable plinth slotOffsets so mobile human visitors earn XP + 2% contributor pool share.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        theme: { type: 'string' },
        bountyEth: { type: 'number' },
        maxCompletions: { type: 'number' },
        slotOffsets: { type: 'array' }
      },
      required: ['parcelId', 'title', 'prompt']
    }
  },
  {
    name: 'get_land_telemetry',
    description:
      'Read live Virtual Land stewardship metrics, 72-hour agent lease / 28-day human inactivity status, quest completions, qualified IRL human contributors, and 5%/3%/2% revenue split totals.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'list_archived_lands',
    description:
      'List permanently archived Virtual Lands that were reclaimed and destroyed after 72 hours (agent lands with zero in-person human visitors) or 28 days of human inactivity, including preserved snapshots of their 3D models and coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        reason: {
          type: 'string',
          enum: ['all', 'agent_72h_no_human_interaction', 'inactivity_28d_no_human_interaction']
        },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_land_deed',
    description:
      'Inspect a Virtual Land parcel ERC-721 Land Deed NFT status (tokenId, owner wallet, transfer history, active marketplace listing, and owner-owned artworks eligible for bundle transfer).',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'transfer_land_deed',
    description:
      'Transfer a permanent/awakened Virtual Land Deed NFT to a destination EVM address (optionally bundling sender-owned artworks on that land). Autonomous agents owning the deed execute directly; paired agents on human-owned land queue mandatory human approval. Moves curation rights & future 3% steward royalties while preserving third-party artworks and cancelling old pending agent approvals.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        toAddress: { type: 'string', description: 'Destination 0x EVM wallet address' },
        includeOwnedArtworks: {
          type: 'boolean',
          description: 'Optional 1-click bundle: also transfer artworks owned by the current Land Deed holder on this parcel'
        }
      },
      required: ['parcelId', 'toAddress']
    }
  },
  {
    name: 'list_land_for_sale',
    description:
      'List a permanent/awakened Virtual Land Deed NFT for sale on the SPRAY.LAND Marketplace (5% Platform + 3% Steward + 2% Human Pool + 90% Seller). Autonomous agent owners list directly; paired agents on human-owned land require explicit human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        priceEth: { type: 'number', description: 'Sale price in ETH (> 0)' },
        includeSellerArtworks: {
          type: 'boolean',
          description: 'Optional bundle: include artworks owned by the seller on this land in the sale'
        }
      },
      required: ['parcelId', 'priceEth']
    }
  },
  {
    name: 'buy_land_deed',
    description:
      'Purchase an active Virtual Land Deed NFT listing from the SPRAY.LAND Marketplace, settling 5%/3%/2% fees, transferring Land Deed ownership (+ bundled seller artworks if included), and resetting prior pending agent approvals.',
    inputSchema: {
      type: 'object',
      properties: {
        listingId: { type: 'string' },
        buyerAddress: { type: 'string' },
        txHash: { type: 'string' }
      },
      required: ['listingId']
    }
  }
];
