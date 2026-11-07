export function serverOrigin(value = 'http://127.0.0.1:4318') {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Сервер должен использовать HTTPS или HTTP на localhost.');
  return url.origin;
}
export function permissionFor(origin) { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }

async function requirePermission(origin, canConnect) {
  if (!canConnect) throw new Error('Разрешите подключение к своему серверу в настройках ReplyLab.');
  if (globalThis.chrome?.permissions?.contains && !await chrome.permissions.contains({ origins: [permissionFor(origin)] })) throw new Error('Доступ к этому серверу не разрешён.');
}

export async function serverRequest(route, { settings = {}, token = '', method = 'GET', body, signal, fetchImpl = fetch, canConnect = false } = {}) {
  const origin = serverOrigin(settings.serverUrl);
  await requirePermission(origin, canConnect);
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Некорректный маршрут сервера.');
  const response = await fetchImpl(origin + route, { method,
    headers: { 'X-ReplyLab': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(100000)]) : AbortSignal.timeout(100000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Сервер вернул HTTP ${response.status}.`);
  return data;
}

export async function streamServer(body, options, onEvent) {
  const origin = serverOrigin(options.settings?.serverUrl);
  await requirePermission(origin, options.canConnect);
  const response = await (options.fetchImpl ?? fetch)(origin + '/stream', { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-ReplyLab': '1', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: JSON.stringify(body), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(100000)]) : AbortSignal.timeout(100000) });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || `HTTP ${response.status}`); }
  if (!response.body) throw new Error('Сервер не открыл поток.');
  const decoder = new TextDecoder(); let buffer = ''; let result; let done = false;
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true });
    if (buffer.length > 2_000_000) throw new Error('Событие сервера слишком большое.');
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
      const line = block.split(/\r?\n/).filter(value => value.startsWith('data:')).map(value => value.slice(5).trimStart()).join('\n');
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.error || 'Ошибка потока.');
      if (event.type === 'delta') onEvent?.(event);
      if (event.type === 'result') result = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type'));
      if (event.type === 'done') done = true;
    }
  }
  if (!done || !result) throw new Error('Поток завершился без подтверждённого результата.');
  return result;
}
