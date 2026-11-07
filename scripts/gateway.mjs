import http from 'node:http';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createStore, StoreConflictError, StoreNotFoundError } from './server-store.mjs';
import { createProviders, ProviderError } from './providers.mjs';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
function localHost(header) {
  if (typeof header !== 'string') return false;
  try { const url = new URL(`http://${header}`); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
}
function validToken(provided, expected) {
  const a = Buffer.from(provided ?? ''); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(request, limit = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0; let chunks = []; let overflow = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { chunks = []; overflow = true; reject(new RequestError(413, 'Запрос слишком большой.')); }
      else if (!overflow) chunks.push(chunk);
    });
    request.on('end', () => { if (!overflow) { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new RequestError(400, 'Нужен корректный JSON-запрос.')); } } });
    request.on('error', () => reject(new RequestError(400, 'Запрос прерван.')));
  });
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function shareHtml(share) {
  const conversation = share.conversation;
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>ReplyLab: диалог</title><body><main><h1>${escape(conversation.title ?? 'Диалог')}</h1><p>Ссылка доступна до ${escape(share.expiresAt)}.</p>${conversation.messages.map(message => `<article><h2>${escape(message.role ?? 'Сообщение')}</h2><p>${escape(message.text ?? message.content ?? '')}</p></article>`).join('')}</main></body></html>`;
}

export function createGateway({ apiKey, fetchImpl = fetch, env = process.env, directory = '.replylab', store: suppliedStore, providers: suppliedProviders, serverToken = env.REPLYLAB_SERVER_TOKEN ?? '', publicUrl = env.PUBLIC_URL ?? '', oauth } = {}) {
  const store = suppliedStore ?? createStore({ directory });
  let oauthPromise;
  const getOAuth = () => oauth ? Promise.resolve(oauth) : (oauthPromise ??= import('./oauth.mjs').then(module => module.createOAuthService({ directory: join(directory, 'oauth'), fetchImpl })));
  const providers = suppliedProviders ?? createProviders({ apiKey, fetchImpl, env, directory, credentialResolver: async provider => {
    try { return await (await getOAuth()).credential(provider); }
    catch { throw new ProviderError(503, 'Подключите аккаунт provider в настройках OAuth.', 'auth', false); }
  } });
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : '';
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new TypeError('PUBLIC_URL должен быть HTTP(S) URL.');
  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Некорректный URL запроса.' })); return; }
    const shared = request.method === 'GET' && /^\/s\/[A-Za-z0-9_-]+$/.test(url.pathname);
    let allowedOrigin = false;
    try {
      const hostUrl = new URL(`http://${host}`);
      allowedOrigin = Boolean(origin && (EXTENSION_ORIGIN.test(origin) || origin === publicOrigin || (localHost(host) && ['http://127.0.0.1', 'http://localhost'].some(base => origin === `${base}${hostUrl.port ? `:${hostUrl.port}` : ''}`))));
    } catch { /* Host validation below reports the request. */ }
    const commonHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin', ...(allowedOrigin ? { 'Access-Control-Allow-Origin': origin } : {}) };
    const send = (status, body) => { if (!response.destroyed && !response.headersSent) { response.writeHead(status, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); } };
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    const event = (name, body) => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      response.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...body })}\n\n`);
    };
    try {
      const isLocal = localHost(host);
      if (!isLocal && (!publicOrigin || new URL(publicOrigin).host !== host)) throw new RequestError(403, 'Используйте локальный адрес шлюза.');
      const address = request.socket.localAddress ?? '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) && (!serverToken || !publicUrl)) throw new RequestError(503, 'Для сетевого сервера нужны REPLYLAB_SERVER_TOKEN и PUBLIC_URL.');
      if (request.method === 'GET' && ['/auth/callback', '/oauth/openrouter/callback'].includes(url.pathname)) {
        let result;
        try { result = await (await getOAuth()).callback(new URL(request.url, `http://127.0.0.1:${server.address().port}`)); }
        catch { throw new RequestError(400, 'OAuth callback отклонён. Начните подключение заново.'); }
        response.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
        response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="robots" content="noindex"><title>ReplyLab</title><body><h1>Аккаунт подключён</h1><p>${escape(result.provider)}. Эту вкладку можно закрыть.</p></body></html>`); return;
      }
      if (shared) {
        const token = url.pathname.slice(3);
        const share = SHARE_TOKEN.test(token) ? await store.share(token) : null;
        if (!share) { send(404, { error: 'Ссылка не найдена или истекла.' }); return; }
        response.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer' });
        response.end(shareHtml(share)); return;
      }
      if (origin !== undefined && !allowedOrigin) throw new RequestError(403, 'Этот источник запроса не разрешён.');
      if (request.method === 'OPTIONS') {
        if (!origin) throw new RequestError(403, 'Для preflight нужен источник расширения.');
        response.writeHead(204, { ...commonHeaders, 'Access-Control-Allow-Methods': url.pathname === '/replies' ? 'POST, OPTIONS' : 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': serverToken ? 'Content-Type, X-ReplyLab, Authorization' : 'Content-Type, X-ReplyLab' }); response.end(); return;
      }
      if (request.headers['x-replylab'] !== '1') throw new RequestError(403, 'Нет заголовка X-ReplyLab: 1.');
      if (serverToken && !validToken(request.headers.authorization?.replace(/^Bearer /, ''), serverToken)) throw new RequestError(401, 'Нужен действующий токен локального сервера.');
      const resource = /^\/(catalog|templates)(?:\/([^/]+))?$/.exec(url.pathname);
      let resourceId;
      try { resourceId = resource?.[2] ? decodeURIComponent(resource[2]) : undefined; }
      catch { throw new RequestError(400, 'Некорректный ID записи.'); }
      if (request.method === 'GET') {
        if (url.pathname === '/status') { send(200, { version: 1, providers: await providers.status(), oauth: await (await getOAuth()).status(), capabilities: ['sync', 'import', 'search', 'shares', 'analytics', 'replies', 'assistant', 'assistant-tools', 'stream', 'oauth', 'catalog', 'templates'] }); return; }
        if (resource) {
          const result = await (resource[1] === 'catalog' ? store.catalog() : store.templates());
          if (resourceId) {
            const item = result.items.find(item => item.id === resourceId);
            if (!item) throw new RequestError(404, 'Запись не найдена.'); send(200, { item, revision: result.revision, source: result.source });
          } else send(200, result);
          return;
        }
        if (url.pathname === '/oauth/status') { send(200, await (await getOAuth()).status()); return; }
        if (url.pathname === '/models') { send(200, { models: await providers.models(url.searchParams.get('provider') ?? 'openai', controller.signal) }); return; }
        if (url.pathname === '/provider-usage') { send(200, await providers.usage(url.searchParams.get('provider') ?? 'openai', controller.signal)); return; }
        if (url.pathname === '/sync') { send(200, await store.read()); return; }
        if (url.pathname === '/search') { send(200, { results: await store.search(url.searchParams.get('q') ?? '') }); return; }
        if (url.pathname === '/analytics') { send(200, await store.analytics(url.searchParams.get('tz') ?? 'UTC')); return; }
        throw new RequestError(404, 'Маршрут не найден.');
      }
      if (request.method === 'DELETE' && resource && resourceId) { send(200, await (resource[1] === 'catalog' ? store.deleteCatalog(resourceId) : store.deleteTemplate(resourceId))); return; }
      if (request.method === 'DELETE' && /^\/shares\/[A-Za-z0-9_-]{32}$/.test(url.pathname)) { send(200, await store.deleteShare(url.pathname.slice(8))); return; }
      if (request.method !== 'POST' && !(request.method === 'PUT' && resource && resourceId)) throw new RequestError(405, 'Метод запроса не поддерживается.');
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(415, 'Нужен Content-Type: application/json.');
      const limit = ['/sync', '/import', '/assistant', '/stream', '/replies'].includes(url.pathname) ? 8 * 1024 * 1024 : 64 * 1024;
      if (Number(request.headers['content-length']) > limit) throw new RequestError(413, 'Запрос слишком большой.');
      const input = await readBody(request, limit);
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new RequestError(400, 'Нужен JSON-объект.');
      if (resource) {
        if (request.method === 'POST' && resourceId) throw new RequestError(405, 'Для изменения записи используйте PUT.');
        const field = resource[1] === 'catalog' ? 'style' : 'template';
        if (!input[field] || Object.keys(input).some(key => ![field, 'id'].includes(key))) throw new RequestError(400, `Нужно поле ${field}.`);
        send(request.method === 'POST' ? 201 : 200, await (resource[1] === 'catalog' ? store.saveCatalog(input.style, resourceId) : store.saveTemplate(input.template, resourceId))); return;
      }
      if (url.pathname === '/oauth/start') { send(200, await (await getOAuth()).start(input.provider, `http://127.0.0.1:${server.address().port}`, { accountId: input.accountId })); return; }
      if (url.pathname === '/oauth/disconnect') { send(200, await (await getOAuth()).disconnect(input.provider, input.accountId)); return; }
      if (url.pathname === '/oauth/select') { send(200, await (await getOAuth()).select(input.provider, input.accountId)); return; }
      if (url.pathname === '/sync' || url.pathname === '/import') { send(200, await store.merge(input)); return; }
      if (url.pathname === '/schedules/claim') { send(200, await store.claimSchedule(input)); return; }
      if (url.pathname === '/shares') {
        const share = await store.createShare(input.conversation, input.ttlHours);
        send(201, { ...share, url: `${publicUrl.replace(/\/$/, '') || `http://${host}`}/s/${share.token}` }); return;
      }
      if (url.pathname === '/credentials') {
        if (!serverToken) throw new RequestError(403, 'Сначала задайте REPLYLAB_SERVER_TOKEN для изменения credentials.');
        if (!isLocal || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new RequestError(403, 'Ключи задаются только через loopback.');
        send(200, await providers.credentials(input)); return;
      }
      if (!['/replies', '/assistant', '/stream'].includes(url.pathname)) throw new RequestError(404, 'Маршрут не найден.');
      const { state } = await store.read();
      const task = url.pathname === '/replies' ? 'replies' : input.task ?? 'assistant';
      const style = input.style ?? state.styles.find(item => item.id === input.styleId && !item.deleted);
      const session = input.sessionId ? state.assistantChats.find(item => item.id === input.sessionId && !item.deleted) : null;
      const history = input.messages ?? session?.messages ?? [];
      if (input.sessionId && history.length > 38) throw new RequestError(409, 'Сначала экспортируйте историю: в сессии уже 39–40 сообщений.');
      const aiInput = { ...input, style, model: input.model ?? style?.model ?? state.settings[task === 'replies' ? 'suggestionModel' : 'assistantModel'], provider: input.provider ?? state.settings.provider ?? 'openai', systemPrompt: input.systemPrompt ?? style?.prompt ?? state.settings.systemPrompt ?? '', memories: input.memories ?? state.memories, ...(task === 'replies' ? {} : { messages: history }) };
      const result = await providers.complete(aiInput, { task, signal: controller.signal, executeTool: async (name, args) => {
        if (name !== 'searchPastReplies') throw new TypeError('Инструмент не разрешён.');
        return store.searchPastReplies(args);
      }, ...(url.pathname === '/stream' ? { onDelta: text => event('delta', { text }) } : {}) });
      if (input.sessionId && task === 'assistant') {
        const now = new Date().toISOString();
        const message = (role, text) => ({ id: randomUUID(), role, text, createdAt: now });
        await store.merge({ version: 1, assistantChats: [{ ...session, id: input.sessionId, title: session?.title ?? input.title ?? input.text.slice(0, 80), model: aiInput.model, messages: [...history, message('user', input.text), { ...message('assistant', result.text), ...(result.toolResults?.length ? { toolResults: result.toolResults } : {}) }], createdAt: session?.createdAt ?? now, updatedAt: now }] });
      }
      if (url.pathname === '/stream') { event('result', result); event('done', {}); response.end(); }
      else send(200, result);
    } catch (error) {
      request.resume();
      const status = error instanceof RequestError || error instanceof ProviderError || error instanceof StoreConflictError || error instanceof StoreNotFoundError ? error.status : error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      const message = status === 500 ? 'Локальная ошибка шлюза.' : error.message;
      const failure = { error: message, ...(error instanceof ProviderError ? { code: error.code, retryable: error.retryable,
        ...(typeof error.model === 'string' ? { model: error.model } : {}), ...(Number.isFinite(error.elapsedMs) ? { elapsedMs: error.elapsedMs } : {}) } : {}) };
      if (response.headersSent) { if (!response.destroyed) { event('error', failure); response.end(); } }
      else send(status, failure);
    }
  });
  server.store = store; server.providers = providers;
  server.requestTimeout = 100000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.REPLYLAB_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!process.env.REPLYLAB_SERVER_TOKEN || !process.env.PUBLIC_URL)) throw new Error('Для сетевого сервера задайте REPLYLAB_SERVER_TOKEN и PUBLIC_URL.');
  createGateway().listen(Number(process.env.PORT ?? 4318), host, () => console.log(`ReplyLab: порт ${process.env.PORT ?? 4318} · остановить Ctrl+C`));
}
