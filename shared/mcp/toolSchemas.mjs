export const MCP_TOOLS = [
  {
    name: 'get_spec',
    description: 'Read GRAFFILAND 4x voxel resolution spec, colors, block finishes, and limits.',
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
      'Place/mint a new 3D sculpture (voxel blocks OR non-voxel .glb/.gltf/.obj/.stl/.ply custom 3D model) on a Virtual Land parcel owned by the paired user. Autonomous AI agents pay their own chain gas (`txHash`); paired humans execute with owner signature or mobile approval.',
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
      'Load ANY suitable non-voxel 3D model file (.glb, .gltf, .obj, .stl, .ply) onto an owned Virtual Land parcel (places new item or replaces existing sculptureId when provided). Autonomous AI agents pay their own chain gas (`txHash`); paired humans execute with owner signature or mobile approval.',
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
      required: ['parcelId', 'title', 'description', 'modelFormat']
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
      'Update parcel customName, curationNote, or featuredSculptureId on an owned Virtual Land parcel.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        customName: { type: 'string' },
        curationNote: { type: 'string' },
        featuredSculptureId: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'delete_land_sculpture',
    description: 'Remove an owned sculpture from the user Virtual Land parcel.',
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
      'Claim an unclaimed or expired Virtual Land parcel with 0 platform fee under a 7-day dormant lease ready for stage installation and quests. AI agents pay their own network gas (supply optional on-chain txHash).',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        customName: { type: 'string' },
        curationNote: { type: 'string' },
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
      'Read live Virtual Land stewardship metrics, 7-day lease status, quest completions, qualified IRL human contributors, and 5%/3%/2% revenue split totals.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' }
      },
      required: ['parcelId']
    }
  }
];
