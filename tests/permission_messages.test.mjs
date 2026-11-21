import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  describeCameraError,
  describeGeolocationError
} from '../client/src/utils/permissionMessages.js';

describe('Permission denial copy', () => {
  test('geolocation errors map to distinct, actionable messages', () => {
    assert.match(
      describeGeolocationError({ code: 1, message: 'User denied Geolocation' }),
      /blocked/
    );
    assert.match(describeGeolocationError({ code: 3 }), /GPS fix/);
    assert.match(describeGeolocationError({ code: 2 }), /unavailable/);
    assert.doesNotMatch(
      describeGeolocationError({ code: 1, message: 'User denied' }),
      /User denied/
    );
  });

  test('camera errors map by DOMException name', () => {
    assert.match(describeCameraError({ name: 'NotAllowedError' }), /blocked/);
    assert.match(describeCameraError({ name: 'NotFoundError' }), /No rear camera/);
    assert.match(describeCameraError({ name: 'NotReadableError' }), /in use/);
    assert.match(describeCameraError(new Error('x')), /Retry Camera/);
  });
});
