import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contextRequestAllowed, overridesRequestAllowed } from '../dialecto-in-context.mjs';

const request = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

test('the context request must be same-origin on a loopback host', () => {
  const host = '127.0.0.1:4321';
  assert.equal(contextRequestAllowed(request({ host, 'sec-fetch-site': 'same-origin' }), 'http'), true);
  assert.equal(contextRequestAllowed(request({ host }), 'http'), true);
  assert.equal(contextRequestAllowed(request({ host, origin: `http://${host}` }), 'http'), true);
  assert.equal(contextRequestAllowed(request({ host: 'localhost:4321' }), 'http'), true);

  assert.equal(contextRequestAllowed(request({ host: 'evil.example' }), 'http'), false);
  assert.equal(contextRequestAllowed(request({}), 'http'), false);
  assert.equal(contextRequestAllowed(request({ host, origin: 'https://evil.example' }), 'http'), false);
  assert.equal(contextRequestAllowed(request({ host, 'sec-fetch-site': 'cross-site' }), 'http'), false);
  assert.equal(contextRequestAllowed(request({ host, 'sec-fetch-site': 'same-site' }), 'http'), false);
});

test("the overrides POST must carry this site's own Origin on a loopback host", () => {
  const host = 'localhost:4321';
  assert.equal(overridesRequestAllowed(request({ host, origin: `http://${host}` }), 'http'), true);

  assert.equal(overridesRequestAllowed(request({ host }), 'http'), false);
  assert.equal(overridesRequestAllowed(request({ host, origin: 'http://evil.example' }), 'http'), false);
  assert.equal(overridesRequestAllowed(request({ host, origin: `https://${host}` }), 'http'), false);
  assert.equal(
    overridesRequestAllowed(request({ host: 'evil.example', origin: 'http://evil.example' }), 'http'),
    false
  );
});

test('only a loopback peer is served, whatever Host and X-Forwarded-For it sends', () => {
  const host = 'localhost:4321';
  const context = (address, extra = {}) => contextRequestAllowed(request({ host, ...extra }, address), 'http');
  const overrides = (address, extra = {}) =>
    overridesRequestAllowed(request({ host, origin: `http://${host}`, ...extra }, address), 'http');

  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(context(address), true, address);
    assert.equal(overrides(address), true, address);
  }
  for (const address of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', '2001:db8::1', '']) {
    for (const extra of [{}, { 'x-forwarded-for': '127.0.0.1' }]) {
      assert.equal(context(address, extra), false, `${address} ${JSON.stringify(extra)}`);
      assert.equal(overrides(address, extra), false, `${address} ${JSON.stringify(extra)}`);
    }
  }
  assert.equal(contextRequestAllowed({ headers: { host } }, 'http'), false);
});
