import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compileAllContracts } from '../contracts/compile.mjs';
import { STEWARD_DEFAULTS, TRANSACTION_FEES } from '../shared/constants.mjs';

describe('GRAFFILAND V2 Contracts & 5%/3%/2% Economic Constants', () => {
  test('Compiles GraffilandNFT, GraffilandRoyaltyRouter, and GraffilandMarketplace with 5%/3%/2% constants & ABI', () => {
    const artifacts = compileAllContracts();

    assert.ok(artifacts.GraffilandNFT?.bytecode?.startsWith('0x60'));
    assert.ok(artifacts.GraffilandRoyaltyRouter?.bytecode?.startsWith('0x60'));
    assert.ok(artifacts.GraffilandMarketplace?.bytecode?.startsWith('0x60'));

    const nftAbiNames = new Set(artifacts.GraffilandNFT.abi.map((x) => x.name).filter(Boolean));
    for (const fn of [
      'RESALE_FEE_BPS',
      'AGENT_STEWARD_FEE_BPS',
      'HUMAN_CONTRIBUTOR_FEE_BPS',
      'TOTAL_TX_FEE_BPS',
      'claimDormantLand',
      'activateLandByHuman',
      'releaseExpiredLand',
      'setRoyaltyRouter'
    ]) {
      assert.ok(nftAbiNames.has(fn), `GraffilandNFT missing ABI member ${fn}`);
    }

    const routerAbiNames = new Set(
      artifacts.GraffilandRoyaltyRouter.abi.map((x) => x.name).filter(Boolean)
    );
    for (const fn of [
      'PLATFORM_BPS',
      'AGENT_STEWARD_BPS',
      'HUMAN_POOL_BPS',
      'TOTAL_FEE_BPS',
      'computeFeeSplit',
      'setParcelParticipants',
      'depositParcelFee',
      'withdraw'
    ]) {
      assert.ok(routerAbiNames.has(fn), `GraffilandRoyaltyRouter missing ABI member ${fn}`);
    }

    const marketAbiNames = new Set(
      artifacts.GraffilandMarketplace.abi.map((x) => x.name).filter(Boolean)
    );
    for (const fn of [
      'listSculpture',
      'cancelListing',
      'buySculpture',
      'fundQuestBounty',
      'settleQuestBounty',
      'withdrawSellerProceeds'
    ]) {
      assert.ok(marketAbiNames.has(fn), `GraffilandMarketplace missing ABI member ${fn}`);
    }

    assert.equal(TRANSACTION_FEES.platformBps, 500);
    assert.equal(TRANSACTION_FEES.agentStewardBps, 300);
    assert.equal(TRANSACTION_FEES.humanContributorBps, 200);
    assert.equal(TRANSACTION_FEES.totalBps, 1000);
    assert.equal(TRANSACTION_FEES.sellerNetBps, 9000);
    assert.equal(STEWARD_DEFAULTS.starterDormantSlots, 3);
    assert.equal(STEWARD_DEFAULTS.slotsPerAwakenedLand, 2);
    assert.equal(STEWARD_DEFAULTS.dormantLeaseTtlHours, 168);
  });
});
