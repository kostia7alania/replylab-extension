import { randomUUID, randomBytes, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';

const ISSUER = 'https://auth.openai.com';
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const TTL = 10 * 60 * 1000;
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function boundedJSON(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.json();
  let total = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break;
    total += value.byteLength; if (total > 1_000_000) { await reader.cancel(); throw new Error('Ответ авторизации слишком большой.'); } chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createOAuthService({ directory, fetchImpl = fetch, now = Date.now, onCredentials = async () => {} } = {}) {
  if (!directory) throw new Error('Для OAuth требуется закрытая папка данных.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'oauth.json');
  let state;
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('OAuth-хранилище не должно быть символической ссылкой.');
    state = JSON.parse(await readFile(file, 'utf8'));
    if (state.version !== 1 || !state.hostId || !Array.isArray(state.accounts)) throw new Error('Некорректное OAuth-хранилище.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [], active: {} };
  }
  let writes = Promise.resolve();
  const save = () => { const bytes = JSON.stringify(state); const task = writes.then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, file);
  }); writes = task.catch(() => {}); return task; };
  await save();
  const pending = new Map(); const refreshing = new Map(); const signingOut = new Set(); let metadata;
  async function json(url, options = {}) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Сервис авторизации вернул HTTP ${response.status}. Повторите вход.`);
    return boundedJSON(response);
  }
  async function discovery() {
    if (!metadata) {
      const result = await json(`${ISSUER}/.well-known/openid-configuration`);
      if (result.issuer !== ISSUER) throw new Error('Неожиданный issuer OpenAI.');
      for (const field of ['jwks_uri', 'revocation_endpoint']) if (result[field]) {
        const url = new URL(result[field]); if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('Неожиданный адрес OAuth metadata.');
      }
      if (!result.jwks_uri) throw new Error('OpenAI не вернул адрес JWKS.');
      metadata = result;
    }
    return metadata;
  }
  async function identity(token, clientId, nonce, expectedSubject) {
    if (typeof token !== 'string' || token.length > 30000) throw new Error('Нет корректного ID token.');
    const parts = token.split('.'); if (parts.length !== 3) throw new Error('Некорректный ID token.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url')); const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') throw new Error('Неподдерживаемая подпись ID token.');
    const config = await discovery(); const jwks = await json(config.jwks_uri);
    const jwk = jwks.keys?.find((key) => key.kid === header.kid && (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg));
    if (!jwk || (header.alg === 'RS256' && jwk.kty !== 'RSA') || (header.alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256'))) throw new Error('Ключ подписи ID token не найден.');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const keyOptions = header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key;
    if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), keyOptions, Buffer.from(parts[2], 'base64url'))) throw new Error('Подпись ID token не прошла проверку.');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]; const seconds = Math.floor(now() / 1000);
    if (claims.iss !== ISSUER || !audiences.includes(clientId) || (claims.azp && claims.azp !== clientId)
      || !Number.isFinite(claims.exp) || claims.exp <= seconds || (claims.nbf && claims.nbf > seconds + 30)
      || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && !equal(claims.nonce, nonce))
      || (expectedSubject && claims.sub !== expectedSubject)) throw new Error('Параметры ID token не прошли проверку.');
    return claims;
  }
  function safe(account) {
    return { id: account.id, provider: account.provider, label: account.label, connected: Boolean(account.accessToken || account.apiKey),
      active: state.active[account.provider] === account.id, inferenceGranted: account.provider !== 'chatgpt' || account.scopes?.includes(DIRECT_SCOPE) === true,
      expiresAt: account.expiresAt ?? null };
  }
  async function start(provider, callbackBase, { accountId } = {}) {
    if (!['chatgpt', 'openrouter'].includes(provider)) throw new Error('Неизвестный OAuth provider.');
    const base = new URL(callbackBase);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('OAuth требует HTTP callback на 127.0.0.1.');
    for (const [key, attempt] of pending) if (attempt.expiresAt <= now()) pending.delete(key);
    if (pending.size >= 16) throw new Error('Слишком много незавершённых входов. Подождите 10 минут.');
    const account = accountId ? state.accounts.find((item) => item.id === accountId && item.provider === provider) : null;
    if (accountId && !account) throw new Error('Сохранённый аккаунт не найден.');
    const verifier = random(); const csrf = random(); const nonce = random();
    const redirect = new URL(provider === 'chatgpt' ? '/auth/callback' : '/oauth/openrouter/callback', base).href;
    const attempt = { provider, verifier, csrf, nonce, redirect, accountId: account?.id, clientId: account?.clientId, expiresAt: now() + TTL };
    pending.set(csrf, attempt);
    const url = new URL(provider === 'chatgpt' ? `${ISSUER}/api/accounts/authorize` : 'https://openrouter.ai/auth');
    url.searchParams.set(provider === 'chatgpt' ? 'redirect_uri' : 'callback_url', redirect);
    url.searchParams.set('state', csrf); url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url')); url.searchParams.set('code_challenge_method', 'S256');
    if (provider === 'chatgpt') {
      url.searchParams.set('client_id', account?.clientId ?? 'dynamic_agent_client');
      if (!account) url.searchParams.set('agent_name_hint', 'ReplyLab');
      url.searchParams.set('ext_agent_host_id', state.hostId); url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', SCOPES); url.searchParams.set('resource', RESOURCE); url.searchParams.set('nonce', nonce);
      if (account?.idToken) url.searchParams.set('id_token_hint', account.idToken);
    } else url.searchParams.set('key_label', 'ReplyLab');
    return { url: url.href, expiresAt: new Date(attempt.expiresAt).toISOString() };
  }
  async function callback(input) {
    const url = input instanceof URL ? input : new URL(input); const csrf = url.searchParams.get('state');
    const attempt = pending.get(csrf); if (!attempt || attempt.expiresAt <= now()) throw new Error('Вход истёк или state не совпал. Начните заново.');
    if (url.origin + url.pathname !== attempt.redirect) throw new Error('OAuth callback не совпал с запросом.');
    pending.delete(csrf);
    if (url.searchParams.has('error')) throw new Error('Вход отменён пользователем.');
    const code = url.searchParams.get('code'); if (!code || code.length > 10000) throw new Error('Нет корректного кода авторизации.');
    let account;
    if (attempt.provider === 'openrouter') {
      const result = await json('https://openrouter.ai/api/v1/auth/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, code_verifier: attempt.verifier, code_challenge_method: 'S256' }) });
      if (typeof result.key !== 'string' || !result.key) throw new Error('Provider не вернул ключ.');
      account = { id: attempt.accountId ?? randomUUID(), provider: 'openrouter', label: 'OpenRouter', apiKey: result.key };
    } else {
      const issued = url.searchParams.get('client_id') ?? attempt.clientId;
      if (!issued || issued === 'dynamic_agent_client' || (attempt.clientId && issued !== attempt.clientId)) throw new Error('Регистрация не вернула ожидаемый client_id.');
      const result = await json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirect, resource: RESOURCE }).toString() });
      const previous = state.accounts.find((item) => item.id === attempt.accountId);
      const claims = await identity(result.id_token, issued, attempt.nonce, previous?.subject);
      if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('Некорректный token response.');
      account = { id: previous?.id ?? randomUUID(), provider: 'chatgpt', clientId: issued, subject: claims.sub,
        label: typeof claims.email === 'string' ? claims.email : `ChatGPT ${issued.slice(-8)}`, idToken: result.id_token,
        accessToken: result.access_token, refreshToken: result.refresh_token, scopes: String(result.scope ?? '').split(/\s+/).filter(Boolean),
        expiresAt: now() + result.expires_in * 1000 };
    }
    state.accounts = [...state.accounts.filter((item) => item.id !== account.id), account]; state.active[account.provider] = account.id;
    signingOut.delete(account.id);
    await save(); await onCredentials(account.provider); return { provider: account.provider, connected: true, account: safe(account) };
  }
  async function credential(provider) {
    let account = state.accounts.find((item) => item.id === state.active[provider]);
    if (!account || signingOut.has(account.id) || !(account.accessToken || account.apiKey)) return null;
    if (provider === 'chatgpt') {
      if (account.expiresAt <= now() + 60000) {
        if (!account.refreshToken) throw new Error('Сессия истекла. Повторите вход в ChatGPT.');
        if (!refreshing.has(account.id)) {
          const task = (async () => {
            const result = await json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE }).toString() });
            if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in) || !result.refresh_token) throw new Error('Не удалось обновить сессию ChatGPT.');
            if (result.id_token) await identity(result.id_token, account.clientId, undefined, account.subject);
            Object.assign(account, { accessToken: result.access_token, refreshToken: result.refresh_token,
              idToken: result.id_token ?? account.idToken, expiresAt: now() + result.expires_in * 1000,
              scopes: result.scope ? result.scope.split(/\s+/) : account.scopes }); await save();
          })(); refreshing.set(account.id, task); task.finally(() => refreshing.delete(account.id)).catch(() => {});
        }
        await refreshing.get(account.id);
      }
      if (signingOut.has(account.id)) return null;
      if (!account.scopes?.includes(DIRECT_SCOPE)) throw new Error('Вход выполнен, но разрешение на использование плана ChatGPT не выдано.');
      return { provider, apiKey: account.accessToken, baseUrl: RESOURCE, protocol: 'responses' };
    }
    return { provider, apiKey: account.apiKey, baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat' };
  }
  async function disconnect(provider, accountId) {
    const account = state.accounts.find((item) => item.id === (accountId ?? state.active[provider]) && item.provider === provider);
    if (!account) return { disconnected: true, revocationConfirmed: false };
    signingOut.add(account.id);
    await refreshing.get(account.id)?.catch(() => {});
    let revocationConfirmed = false;
    if (provider === 'chatgpt' && account.refreshToken) {
      try { const config = await discovery(); if (config.revocation_endpoint) {
        const response = await fetchImpl(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }).toString(), redirect: 'error', signal: AbortSignal.timeout(15000) }); revocationConfirmed = response.status === 200;
      } } catch { revocationConfirmed = false; }
    }
    delete account.accessToken; delete account.refreshToken; delete account.idToken; delete account.apiKey;
    if (state.active[provider] === account.id) delete state.active[provider]; await save();
    return { disconnected: true, revocationConfirmed };
  }
  async function select(provider, accountId) {
    const account = state.accounts.find((item) => item.provider === provider && item.id === accountId);
    if (!account || !(account.accessToken || account.apiKey)) throw new Error('Сначала войдите в этот аккаунт.');
    state.active[provider] = account.id; await save(); return safe(account);
  }
  return { start, callback, credential, disconnect, select, status: () => ({ accounts: state.accounts.map(safe) }) };
}
