import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeviceAuthPayloadV3 } from './device-identity';

test('buildDeviceAuthPayloadV3 normalizes platform and deviceFamily for protocol v4 device auth', () => {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: 'device-1',
    clientId: 'cli',
    clientMode: 'ui',
    role: 'operator',
    scopes: ['operator.admin'],
    signedAtMs: 1737264000000,
    token: 'secret-token',
    nonce: 'nonce-123',
    platform: 'Win32 ',
    deviceFamily: ' Desktop',
  });

  assert.equal(
    payload,
    'v3|device-1|cli|ui|operator|operator.admin|1737264000000|secret-token|nonce-123|win32|desktop'
  );
});
