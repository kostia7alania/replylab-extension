import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOAuthService } from '../scripts/oauth.mjs';

const issuer = 'https://auth.openai.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' };
function jwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}
async function setup(t, mutate = (claims) => claims, scope = 'openid resource.invoke chatgpt.tokens.use.direct') {
  const directory = await mkdtemp(path.join(tmpdir(), 'replylab-oauth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let auth; let exchange; let refreshes = 0; let refreshBlock;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('openid-configuration')) return Response.json({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/revoke')) return new Response('', { status: 200 });
    if (url === 'https://openrouter.ai/api/v1/auth/keys') return Response.json({ key: 'test-router-key' });
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'refresh_token') {
        refreshes++; if (refreshBlock) await refreshBlock;
        return Response.json({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 3600, scope });
      }
      exchange = form;
      const claims = mutate({ iss: issuer, aud: 'oaiapp_test', sub: 'test-subject', exp: Math.floor(Date.now() / 1000) + 3600, nonce: auth.searchParams.get('nonce') });
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', id_token: jwt(claims), expires_in: 90, scope });
    }
    throw new Error('Unexpected URL ' + url);
  };
  const service = await createOAuthService({ directory, fetchImpl });
  async function login() {
    const first = await service.start('chatgpt', 'http://127.0.0.1:4318'); auth = new URL(first.url);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'test-code'); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('client_id', 'oaiapp_test');
    await service.callback(callback); return callback;
  }
  return { service, login, directory, get auth() { return auth; }, get exchange() { return exchange; }, get refreshes() { return refreshes; }, blockRefresh(promise) { refreshBlock = promise; }, fetchImpl };
}

test('dynamic registration uses issued client and validates signed identity; credentials stay private', async (t) => {
  const x = await setup(t); const callback = await x.login();
  assert.equal(x.auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(x.auth.searchParams.get('agent_name_hint'), 'ReplyLab');
  assert.equal(x.exchange.get('client_id'), 'oaiapp_test');
  assert.equal(x.exchange.get('redirect_uri'), 'http://127.0.0.1:4318/auth/callback');
  assert.equal((await x.service.credential('chatgpt')).protocol, 'responses');
  assert.equal(JSON.stringify(x.service.status()).includes('test-access'), false);
  assert.equal((await stat(path.join(x.directory, 'oauth.json'))).mode & 0o777, 0o600);
  await assert.rejects(x.service.callback(callback), /state/);
  const saved = JSON.parse(await readFile(path.join(x.directory, 'oauth.json')));
  const second = await createOAuthService({ directory: x.directory, fetchImpl: x.fetchImpl });
  const next = new URL((await second.start('chatgpt', 'http://127.0.0.1:4318', { accountId: saved.accounts[0].id })).url);
  assert.equal(next.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(next.searchParams.get('ext_agent_host_id'), x.auth.searchParams.get('ext_agent_host_id'));
});

test('wrong state, callback origin, nonce, issuer and audience cannot activate credentials', async (t) => {
  const x = await setup(t); const start = new URL((await x.service.start('chatgpt', 'http://127.0.0.1:4318')).url);
  await assert.rejects(x.service.callback('http://127.0.0.1:4318/auth/callback?state=wrong&code=code'), /state/);
  const hostile = new URL('http://localhost:4318/auth/callback'); hostile.searchParams.set('state', start.searchParams.get('state'));
  await assert.rejects(x.service.callback(hostile), /callback/);
  for (const change of [{ nonce: 'wrong' }, { iss: 'https://example.org' }, { aud: 'foreign-client' }, { exp: 1 }]) {
    const failed = await setup(t, (claims) => ({ ...claims, ...change }));
    await assert.rejects(failed.login(), /проверку/); assert.equal(failed.service.status().accounts.length, 0);
  }
});

test('identity sign-in without direct inference scope never grants model access', async (t) => {
  const x = await setup(t, (claims) => claims, 'openid profile email'); await x.login();
  assert.equal(x.service.status().accounts[0].inferenceGranted, false);
  await assert.rejects(x.service.credential('chatgpt'), /разрешение/);
});

test('refresh is serialized and sign-out cannot be undone by an in-flight refresh', async (t) => {
  const x = await setup(t); await x.login();
  // Bring the expiry into the renewal window without editing the protected file.
  const saved = JSON.parse(await readFile(path.join(x.directory, 'oauth.json')));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const service = await createOAuthService({ directory: x.directory, fetchImpl: x.fetchImpl, now: () => saved.accounts[0].expiresAt - 1000 });
  x.blockRefresh(gate);
  const one = service.credential('chatgpt'); const two = service.credential('chatgpt');
  await new Promise(setImmediate); const out = service.disconnect('chatgpt'); release();
  assert.deepEqual(await Promise.all([one, two]), [null, null]);
  assert.equal(x.refreshes, 1); assert.equal((await out).revocationConfirmed, true);
  assert.equal(await service.credential('chatgpt'), null);
});

test('OpenRouter PKCE exchanges the returned code without exposing its key', async (t) => {
  const x = await setup(t); const auth = new URL((await x.service.start('openrouter', 'http://127.0.0.1:4318')).url);
  assert.equal(auth.origin, 'https://openrouter.ai'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const callback = new URL(auth.searchParams.get('callback_url')); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'router-code');
  await x.service.callback(callback);
  assert.equal((await x.service.credential('openrouter')).apiKey, 'test-router-key');
  assert.equal(JSON.stringify(x.service.status()).includes('test-router-key'), false);
  assert.equal((await x.service.disconnect('openrouter')).revocationConfirmed, false);
});
