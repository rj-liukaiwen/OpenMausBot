import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBrokerUrl } from './connected-apps-release.mjs';

test('release metadata accepts only a credential-free non-loopback HTTPS broker', () => {
  assert.equal(releaseBrokerUrl('https://broker.example/service/'), 'https://broker.example/service');
  for (const url of ['http://broker.example', 'https://user:secret@broker.example',
    'https://broker.example?token=secret', 'https://broker.example#secret', 'https://localhost', 'https://127.0.0.1']) {
    assert.throws(() => releaseBrokerUrl(url));
  }
});
