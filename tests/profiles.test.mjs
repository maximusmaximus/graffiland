import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  buildPublicProfileUrl,
  findHeaderPreset,
  formatUserNumber,
  parseProfileParamFromLocation,
  suggestUsernameFromName,
  validateBio,
  validateProfileImage,
  validateUsername
} from '../shared/profileRules.mjs';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Usernames, Onboarding Validation, Bio & Public Profiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-profile-test-'));
  let srv;
  let baseUrl;

  before(async () => {
    process.env.GRAFFILAND_DB_PATH = path.join(tmpDir, 'profiles.sqlite');
    process.env.GRAFFILAND_IPFS_DIR = path.join(tmpDir, 'ipfs');
    process.env.PINATA_JWT = '';
    process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
    process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
    const { createAppServer } = await import('../server/index.mjs');
    const { server } = createAppServer();
    srv = server;
    await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${srv.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => srv?.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows SQLite WAL handle may release on process exit
    }
  });

  test('validateUsername, validateBio, URL builders, and suggestions enforce rules cleanly', () => {
    assert.equal(validateUsername('').ok, false);
    assert.equal(validateUsername('ab').ok, false);
    assert.equal(validateUsername('a'.repeat(25)).ok, false);
    assert.equal(validateUsername('bad name!').ok, false);
    assert.equal(validateUsername('_leading').ok, false);
    assert.equal(validateUsername('double__under').ok, false);
    assert.equal(validateUsername('admin').ok, false);

    const valid = validateUsername('  @Neon_Voxel-42  ');
    assert.equal(valid.ok, true);
    assert.equal(valid.username, 'neon_voxel-42');

    assert.equal(validateBio('x'.repeat(281)).ok, false);
    assert.equal(validateBio('  AR sculptor 🔥  ').bio, 'AR sculptor 🔥');

    const url = buildPublicProfileUrl({
      origin: 'https://maximusmaximus.github.io',
      pathname: '/graffiland/',
      username: 'Neon_Voxel-42'
    });
    assert.equal(url, 'https://maximusmaximus.github.io/graffiland/?u=neon_voxel-42');
    assert.equal(parseProfileParamFromLocation('?u=neon_voxel-42'), 'neon_voxel-42');
    assert.equal(parseProfileParamFromLocation('?profile=@maya_art'), 'maya_art');
    assert.equal(validateUsername(suggestUsernameFromName('Maya Chen', 'maya@test.io')).ok, true);

    // User number formatting, presets & strict raster image validation
    assert.equal(formatUserNumber(1), '#0001');
    assert.equal(formatUserNumber(42), '#0042');
    assert.equal(formatUserNumber(12345), '#12345');
    assert.equal(formatUserNumber(0), '');
    assert.equal(findHeaderPreset('preset:sunset-voxel')?.id, 'sunset-voxel');

    assert.equal(validateProfileImage('', { kind: 'avatar' }).ok, true);
    assert.equal(validateProfileImage(TINY_PNG_DATA_URL, { kind: 'avatar' }).ok, true);
    assert.equal(validateProfileImage('https://cdn.example.com/icon.webp', { kind: 'avatar' }).ok, true);
    assert.equal(validateProfileImage('preset:neon-skyline', { kind: 'header' }).ok, true);
    assert.equal(validateProfileImage('preset:neon-skyline', { kind: 'avatar' }).ok, false);
    assert.equal(
      validateProfileImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', { kind: 'avatar' }).ok,
      false,
      'SVG uploads must be blocked'
    );
    assert.equal(
      validateProfileImage('javascript:alert(1)', { kind: 'header' }).ok,
      false
    );
    assert.equal(
      validateProfileImage('https://127.0.0.1/internal.png', { kind: 'header' }).ok,
      false
    );
  });

  test('Onboarding requires username, blocks duplicate claims case-insensitively, allows rename, and serves public profile with lands, sculptures & actions', async () => {
    // 1. User A signs in -> needsUsernameOnboarding must be true
    const authA = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'alice@graffiland.test', name: 'Alice Art' } })
    }).then((r) => r.json());
    assert.equal(authA.user.username, '');
    assert.equal(authA.user.needsUsernameOnboarding, true);

    // 2. Check username availability before saving
    const check1 = await fetch(`${baseUrl}/api/profile/check-username?username=alice_3d`, {
      headers: { Authorization: `Bearer ${authA.token}` }
    }).then((r) => r.json());
    assert.equal(check1.available, true);

    // 3. Save username + bio during onboarding
    const saveA = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ username: '@Alice_3D', bio: 'Building neon voxel skylines 🎨' })
    }).then((r) => r.json());
    assert.equal(saveA.user.username, 'alice_3d');
    assert.equal(saveA.user.bio, 'Building neon voxel skylines 🎨');
    assert.equal(saveA.user.needsUsernameOnboarding, false);

    // 4. User B signs in and cannot steal Alice's username (case-insensitive)
    const authB = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'bob@graffiland.test', name: 'Bob Builder' } })
    }).then((r) => r.json());
    assert.equal(authB.user.needsUsernameOnboarding, true);

    const checkTaken = await fetch(`${baseUrl}/api/profile/check-username?username=ALICE_3D`, {
      headers: { Authorization: `Bearer ${authB.token}` }
    }).then((r) => r.json());
    assert.equal(checkTaken.available, false);

    const conflictRes = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authB.token}` },
      body: JSON.stringify({ username: 'ALICE_3D', bio: 'Trying to copy handle' })
    });
    assert.equal(conflictRes.status, 409);

    // 5. Alice changes her username to @alice_cyber -> releases @alice_3d for Bob
    const renameA = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ username: 'alice_cyber', bio: 'Updated cyberpunk bio ⚡' })
    });
    assert.equal(renameA.status, 200);
    const renameJson = await renameA.json();
    assert.equal(renameJson.user.username, 'alice_cyber');
    assert.equal(renameJson.user.bio, 'Updated cyberpunk bio ⚡');

    // Bob can now claim @alice_3d cleanly
    const claimOldByB = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authB.token}` },
      body: JSON.stringify({ username: 'alice_3d' })
    });
    assert.equal(claimOldByB.status, 200);

    // 6. Seed land + sculpture for Alice and verify public profile returns public links & zero private fields
    const claimLand = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ lat: 37.775, lng: -122.419, customName: 'Alice Neon Plaza' })
    }).then((r) => r.json());
    assert.ok(claimLand.parcelId);

    const pubSculpture = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authA.token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'Alice Sky Spire',
        description: 'Glowing AR spire',
        termsAccepted: true,
        location: { lat: 37.775, lng: -122.419, altitude: 12, accuracy: 6 },
        proofOfLocation: {
          cameraFrames: 6,
          gpsSamples: [
            { lat: 37.775, lng: -122.419, t: Date.now() - 2500 },
            { lat: 37.77501, lng: -122.41901, t: Date.now() - 400 }
          ],
          frameHashes: ['p1', 'p2', 'p3', 'p4'],
          gyroSamples: [
            { alpha: 2, beta: 3, gamma: 4 },
            { alpha: 12, beta: 6, gamma: 3 }
          ],
          flowCorrelation: 0.85,
          skyPalette: ['#00f5d4'],
          visualDHash: '1010101010101010',
          frameCount: 6,
          flowScore: 0.85
        },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'neon' },
          { x: 0.05, y: 0, z: 0, color: '#ffd166', material: 'matte' }
        ]
      })
    }).then((r) => r.json());
    assert.ok(pubSculpture.sculpture?.id);

    // Fetch public profile WITHOUT auth header
    const pubRes = await fetch(`${baseUrl}/api/profiles/ALICE_CYBER`);
    assert.equal(pubRes.status, 200);
    const pub = await pubRes.json();

    assert.equal(pub.profile.username, 'alice_cyber');
    assert.equal(pub.profile.bio, 'Updated cyberpunk bio ⚡');
    assert.equal(pub.profile.email, undefined);
    assert.ok(pub.profile.profileUrl.includes('?u=alice_cyber'));

    assert.ok(pub.lands.length >= 1);
    assert.ok(pub.lands.some((l) => l.parcelId === claimLand.parcelId && l.shareUrl.includes(claimLand.parcelId)));
    assert.ok(pub.lands[0].googleMapsUrl.startsWith('https://www.google.com/maps/dir/'));

    assert.equal(pub.sculptures.length, 1);
    assert.equal(pub.sculptures[0].title, 'Alice Sky Spire');
    assert.ok(pub.sculptures[0].shareUrl.includes(`?sculpture=${pubSculpture.sculpture.id}`));

    assert.ok(pub.actions.length >= 2);
    assert.ok(pub.actions.some((a) => a.type === 'sculpture_published' && a.url.includes('?sculpture=')));
    assert.ok(pub.actions.some((a) => a.type === 'land_claimed' && a.url.includes(claimLand.parcelId)));

    // 7. Sequential user numbers, custom bio image & profile header persist cleanly (and reject SVG)
    assert.ok(pub.profile.userNumber >= 1);
    assert.equal(pub.profile.userNumberLabel, formatUserNumber(pub.profile.userNumber));
    assert.ok(authB.user.userNumber > authA.user.userNumber, 'User B gets a higher sequential user number');

    const badSvgRes = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({ avatarImage: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
    });
    assert.equal(badSvgRes.status, 400);

    const mediaUpdate = await fetch(`${baseUrl}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authA.token}` },
      body: JSON.stringify({
        avatarImage: TINY_PNG_DATA_URL,
        headerImage: 'preset:neon-skyline'
      })
    });
    assert.equal(mediaUpdate.status, 200);
    const mediaJson = await mediaUpdate.json();
    assert.equal(mediaJson.user.avatarImage, TINY_PNG_DATA_URL);
    assert.equal(mediaJson.user.picture, TINY_PNG_DATA_URL);
    assert.equal(mediaJson.user.headerImage, 'preset:neon-skyline');

    // Google re-login must NOT overwrite the user's custom bio image or header background
    const reloginA = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: {
          email: 'alice@graffiland.test',
          name: 'Alice Art',
          picture: 'https://lh3.googleusercontent.com/google-default.png'
        }
      })
    }).then((r) => r.json());
    assert.equal(reloginA.user.avatarImage, TINY_PNG_DATA_URL);
    assert.equal(reloginA.user.picture, TINY_PNG_DATA_URL);
    assert.equal(reloginA.user.headerImage, 'preset:neon-skyline');
    assert.equal(reloginA.user.userNumber, pub.profile.userNumber);

    // Public profile serves custom bio image, header background, and user number banner metadata
    const pubMedia = await fetch(`${baseUrl}/api/profiles/alice_cyber`).then((r) => r.json());
    assert.equal(pubMedia.profile.avatarImage, TINY_PNG_DATA_URL);
    assert.equal(pubMedia.profile.picture, TINY_PNG_DATA_URL);
    assert.equal(pubMedia.profile.headerImage, 'preset:neon-skyline');
    assert.equal(pubMedia.profile.userNumber, pub.profile.userNumber);
    assert.equal(pubMedia.profile.userNumberLabel, formatUserNumber(pub.profile.userNumber));
  });
});
