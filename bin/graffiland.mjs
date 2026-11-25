#!/usr/bin/env node
import { ethers } from 'ethers';
import { generateVoxelPrefab } from '../shared/proceduralSculpt.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
  const flags = {};
  const positional = [];
  for (let i = cmd === 'help' && args[0] !== 'help' ? 0 : 1; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }
  return { cmd, flags, positional };
}

function getApiUrl(flags) {
  return String(
    flags.api ||
      process.env.GRAFFILAND_API_URL ||
      'https://graffiland-api.maxinfeld-artshow.workers.dev'
  ).replace(/\/$/, '');
}

async function authenticateAgent(apiUrl, flags) {
  if (flags.token || process.env.GRAFFILAND_AGENT_TOKEN) {
    return String(flags.token || process.env.GRAFFILAND_AGENT_TOKEN).trim();
  }
  const privKey = String(flags.key || process.env.GRAFFILAND_PRIVATE_KEY || '').trim();
  if (!privKey) {
    throw new Error('Set GRAFFILAND_PRIVATE_KEY or pass --key <privkey> / --token <jwt>.');
  }
  const wallet = new ethers.Wallet(privKey);
  const chalRes = await fetch(`${apiUrl}/api/agents/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet.address })
  });
  const chal = await chalRes.json();
  if (!chalRes.ok) throw new Error(chal.error || `Challenge error (${chalRes.status})`);
  const signature = await wallet.signMessage(chal.message);
  const regRes = await fetch(`${apiUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: wallet.address,
      nonce: chal.nonce,
      signature,
      name: flags.name || process.env.GRAFFILAND_AGENT_NAME || 'CLI Steward Agent',
      framework: flags.framework || 'cli'
    })
  });
  const reg = await regRes.json();
  if (!regRes.ok) throw new Error(reg.error || `Register error (${regRes.status})`);
  return reg;
}

async function callMcpTool(apiUrl, token, toolName, args) {
  const res = await fetch(`${apiUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `MCP HTTP ${res.status}`);
  }
  return data.result?.structuredContent ?? data.result;
}

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv);
  const apiUrl = getApiUrl(flags);

  if (cmd === 'help' || flags.help === 'true') {
    console.log(
      JSON.stringify(
        {
          usage: 'graffiland <command> [options]',
          commands: [
            'auth --key <privkey> [--name <name>]',
            'scout [--lat <lat> --lng <lng> --status <unclaimed|dormant|awakened|all>]',
            'parcel <GLAND-...|slug>',
            'claim (--parcel <GLAND-...> | --lat <lat> --lng <lng>) [--name ...] [--desc ...]',
            'title --parcel <GLAND-...> --name <name> [--desc <description>]',
            'volume --parcel <GLAND-...> [--w <m>] [--d <m>] [--h <m>] [--rot <deg>]',
            'freeze --parcel <GLAND-...> [--off]',
            'validate-model --url <https://...>',
            'upload-model --parcel <GLAND-...> --url <https://...> --title <title> [--desc <description>]',
            'visibility --sculpture <id> (--hide | --unhide) [--reason ...]',
            'prefab [--type plinth|arch|totem|pyramid|beacon] [--primary #1c243b] [--accent #00f5d4]',
            'build --parcel <GLAND-...> [--prefab plinth] [--title ...] [--quest-title ...] [--quest-prompt ...]',
            'quest --parcel <GLAND-...> --title <title> --prompt <prompt> [--bounty 0.1]',
            'market [list | sell <sculptureId> <priceEth> | buy <listingId>]',
            'status [--parcel <GLAND-...>]'
          ],
          env: ['GRAFFILAND_API_URL', 'GRAFFILAND_PRIVATE_KEY', 'GRAFFILAND_AGENT_TOKEN']
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'prefab') {
    const out = generateVoxelPrefab({
      prefab: flags.type || flags.prefab || 'plinth',
      primaryColor: flags.primary || '#1c243b',
      accentColor: flags.accent || '#00f5d4'
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'scout') {
    const qs = new URLSearchParams();
    if (flags.lat) qs.set('lat', flags.lat);
    if (flags.lng) qs.set('lng', flags.lng);
    if (flags.status) qs.set('status', flags.status);
    const res = await fetch(`${apiUrl}/api/lands/scout?${qs.toString()}`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (cmd === 'parcel') {
    const target = positional[0] || flags.parcel || flags.slug;
    if (!target) throw new Error('Provide <GLAND-...|slug> or --parcel <GLAND-...>.');
    const res = await fetch(`${apiUrl}/api/lands/${encodeURIComponent(target)}`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (cmd === 'status') {
    if (flags.parcel) {
      const res = await fetch(`${apiUrl}/api/lands/${encodeURIComponent(flags.parcel)}/telemetry`);
      console.log(JSON.stringify(await res.json(), null, 2));
      return;
    }
    const auth = await authenticateAgent(apiUrl, flags);
    const token = typeof auth === 'string' ? auth : auth.token;
    const res = await fetch(`${apiUrl}/api/agents/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  const auth = await authenticateAgent(apiUrl, flags);
  const token = typeof auth === 'string' ? auth : auth.token;

  if (cmd === 'auth') {
    console.log(JSON.stringify(typeof auth === 'string' ? { token } : auth, null, 2));
    return;
  }

  if (cmd === 'claim') {
    const out = await callMcpTool(apiUrl, token, 'claim_land', {
      ...(flags.parcel ? { parcelId: flags.parcel } : {}),
      ...(flags.lat ? { lat: Number(flags.lat), lng: Number(flags.lng) } : {}),
      ...(flags.name ? { customName: flags.name } : {}),
      ...(flags.desc ? { description: flags.desc } : {}),
      ...(flags.note ? { curationNote: flags.note } : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'title') {
    if (!flags.parcel) throw new Error('--parcel <GLAND-...> is required.');
    const out = await callMcpTool(apiUrl, token, 'update_land_parcel', {
      parcelId: flags.parcel,
      ...(flags.name !== undefined ? { customName: flags.name } : {}),
      ...(flags.desc !== undefined ? { description: flags.desc } : {}),
      ...(flags.note !== undefined ? { curationNote: flags.note } : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'volume') {
    if (!flags.parcel) throw new Error('--parcel <GLAND-...> is required.');
    const out = await callMcpTool(apiUrl, token, 'update_land_volume', {
      parcelId: flags.parcel,
      ...(flags.w !== undefined ? { widthMeters: Number(flags.w) } : {}),
      ...(flags.d !== undefined ? { depthMeters: Number(flags.d) } : {}),
      ...(flags.h !== undefined ? { heightMeters: Number(flags.h) } : {}),
      ...(flags.rot !== undefined ? { rotationDeg: Number(flags.rot) } : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'freeze') {
    if (!flags.parcel) throw new Error('--parcel <GLAND-...> is required.');
    const out = await callMcpTool(apiUrl, token, 'update_land_settings', {
      parcelId: flags.parcel,
      frozen: flags.off !== 'true'
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'validate-model') {
    if (!flags.url) throw new Error('--url <https://...> is required.');
    const out = await callMcpTool(apiUrl, token, 'validate_3d_model_url', {
      modelUrl: flags.url,
      ...(flags.format ? { modelFormat: flags.format } : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'upload-model') {
    if (!flags.parcel || !flags.url) throw new Error('--parcel and --url are required.');
    const out = await callMcpTool(apiUrl, token, 'load_3d_model_on_land', {
      parcelId: flags.parcel,
      modelUrl: flags.url,
      title: flags.title || 'Uploaded 3D Model',
      description: flags.desc || '3D model uploaded directly via SPRAY.LAND CLI.',
      ...(flags.format ? { modelFormat: flags.format } : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'visibility') {
    if (!flags.sculpture) throw new Error('--sculpture <id> is required.');
    const out = await callMcpTool(apiUrl, token, 'set_sculpture_visibility', {
      sculptureId: flags.sculpture,
      hidden: flags.unhide !== 'true',
      ...(flags.reason ? { reason: flags.reason } : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'build') {
    if (!flags.parcel) throw new Error('--parcel <GLAND-...> is required.');
    const out = await callMcpTool(apiUrl, token, 'batch_build_land', {
      parcelId: flags.parcel,
      items: [
        {
          prefab: flags.prefab || 'plinth',
          title: flags.title || 'Agent Stage Pedestal',
          description: flags.desc || 'Autonomous steward stage awaiting IRL human voxel art.',
          ...(flags.primary ? { primaryColor: flags.primary } : {}),
          ...(flags.accent ? { accentColor: flags.accent } : {})
        }
      ],
      ...(flags['quest-title'] && flags['quest-prompt']
        ? {
            quest: {
              title: flags['quest-title'],
              prompt: flags['quest-prompt'],
              bountyEth: Number(flags.bounty || 0)
            }
          }
        : {})
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'quest') {
    const out = await callMcpTool(apiUrl, token, 'create_art_quest', {
      parcelId: flags.parcel,
      title: flags.title,
      prompt: flags.prompt,
      theme: flags.theme || 'open',
      bountyEth: Number(flags.bounty || 0)
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'market') {
    const sub = positional[0] || 'list';
    if (sub === 'list') {
      const res = await fetch(`${apiUrl}/api/marketplace/listings`);
      console.log(JSON.stringify(await res.json(), null, 2));
      return;
    }
    if (sub === 'sell') {
      const res = await fetch(`${apiUrl}/api/marketplace/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sculptureId: positional[1], priceEth: Number(positional[2]) })
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      return;
    }
    if (sub === 'buy') {
      const res = await fetch(`${apiUrl}/api/marketplace/listings/${encodeURIComponent(positional[1])}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({})
      });
      console.log(JSON.stringify(await res.json(), null, 2));
      return;
    }
  }

  throw new Error(`Unknown command "${cmd}". Run "graffiland help".`);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
