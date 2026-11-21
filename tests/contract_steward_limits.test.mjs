import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { compileContract } = await import('../contracts/compile.mjs');

describe('GraffilandNFT steward limits', () => {
  test('ABI exposes per-steward dormant lease cap and owner setter', () => {
    const artifact = compileContract();
    const names = new Set(artifact.abi.map((item) => item.name));
    for (const fn of [
      'maxDormantLeasesPerSteward',
      'activeDormantLeases',
      'setMaxDormantLeasesPerSteward',
      'mintAgentStage',
      'claimDormantLand'
    ]) {
      assert.ok(names.has(fn), `${fn} present in ABI`);
    }
    assert.ok(names.has('MaxDormantLeasesUpdated'), 'MaxDormantLeasesUpdated event present');
  });
});
