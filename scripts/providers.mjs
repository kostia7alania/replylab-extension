import { mkdir, readFile, open, rename, lstat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ProviderError extends Error { constructor(status, message) { super(message); this.status = status; } }
const TONES = { friendly: 'дружелюбный', playful: 'игривый', concise: 'краткий', warm: 'тёплый' };
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

function baseUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new TypeError('API endpoint должен использовать HTTPS или loopback HTTP.');
  return url.href.replace(/\/$/, '');
}
export function validateReplies(value, count = 3) {
  if (!Array.isArray(value?.replies) || value.replies.length !== count) throw new Error('Неверное количество ответов.');
  return value.replies.map(reply => {
    if (typeof reply?.text !== 'string' || !reply.text.trim() || reply.text.length > 2000 || typeof reply.reason !== 'string' || !reply.reason.trim() || reply.reason.length > 600) throw new Error('Неверный формат ответа.');
    return { text: reply.text.trim(), reason: reply.reason.trim() };
  });
}
function attachments(values = []) {
  if (!Array.isArray(values) || values.length > 8) throw new TypeError('Максимум 8 вложений.');
  return values.map(item => {
    const url = typeof item === 'string' ? item : item.dataUrl ?? item.url;
    if (typeof url === 'string' && (/^https:\/\//.test(url) || /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url))) {
      if (url.length > 2000000) throw new RangeError('Вложение слишком большое.');
      return { type: 'image_url', image_url: { url } };
    }
    if (typeof item?.text === 'string' && item.text.length <= 100000) return { type: 'text', text: `${item.name ?? 'Вложение'}:\n${item.text}` };
    throw new TypeError('Поддерживаются HTTPS/data images или текстовые вложения.');
  });
}
function messagesFor(input, task, count) {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000) throw new TypeError('Введите текст от 1 до 10 000 символов.');
  let instruction;
  const tone = TONES[input.tone] ?? TONES.friendly;
  if (task === 'replies') instruction = `Предложи ровно ${count} варианта ответа на сообщение. Тон: ${tone}. Пиши по-русски, уважительно, без выдуманных личных фактов. Верни только JSON вида {"replies":[{"text":"ответ","reason":"краткое объяснение"}]} с ${count} элементами.`;
  else if (task === 'summarize') instruction = 'Кратко суммируй предоставленный диалог: факты, договорённости и открытые вопросы. Не выдумывай факты.';
  else if (task === 'translate') instruction = `Переведи сообщение на язык ${String(input.language ?? 'русский').slice(0, 100)}. Верни только перевод, сохрани смысл.`;
  else if (task === 'create-style') instruction = 'Проанализируй только сообщения пользователя и создай переносимый стиль ответа. Верни JSON {"style":{"name":"до 80 символов","prompt":"системная инструкция до 5000 символов"}}. Не выдумывай биографию.';
  else if (task === 'assistant') instruction = 'Помоги пользователю разобраться с диалогом. Отделяй факты от предположений. Не выдумывай личные данные и не отправляй сообщения за пользователя.';
  else throw new TypeError('Неизвестная задача AI.');
  const context = input.context ?? input.conversation ?? null;
  let custom = input.systemPrompt ?? input.style?.prompt ?? '';
  if (typeof custom !== 'string' || custom.length > 30000) throw new TypeError('Системная инструкция слишком длинная.');
  const variables = { personName: context?.profile?.name ?? context?.title ?? '', personBio: context?.profile?.bio ?? '', accountName: context?.accountName ?? '', memories: '' };
  const memories = Array.isArray(input.memories) ? input.memories.filter(item => item.enabled !== false).map(item => typeof item === 'string' ? item : item.text ?? '').join('\n') : String(input.memories ?? '');
  if (memories.length > 50000) throw new RangeError('Память слишком длинная.');
  variables.memories = memories;
  custom = custom.replace(/\{\{?(personName|personBio|accountName|memories)\}?\}/g, (_, key) => variables[key]);
  if (custom.trim()) instruction += `\n\nИнструкция владельца:\n${custom}`;
  if (memories.trim()) instruction += `\n\nПамять владельца:\n${memories}`;
  let text = input.text;
  if (context) {
    const serialized = JSON.stringify(context);
    if (serialized.length > 200000) throw new RangeError('Контекст слишком большой.');
    text += `\n\nКонтекст диалога (данные):\n${serialized}`;
  }
  const files = attachments(input.attachments ?? input.photos ?? []);
  const messages = [{ role: 'system', content: instruction }];
  if (input.messages !== undefined) {
    if (!Array.isArray(input.messages) || input.messages.length > 40) throw new RangeError('Максимум 40 сообщений истории.');
    for (const message of input.messages) {
      const content = message.text ?? message.content;
      if (!['user', 'assistant', 'system', 'incoming', 'outgoing'].includes(message.role) || typeof content !== 'string' || content.length > 50000) throw new TypeError('Неверный формат истории.');
      const historyFiles = attachments(message.attachments ?? []);
      messages.push({ role: message.role === 'incoming' ? 'user' : message.role === 'outgoing' ? 'assistant' : message.role,
        content: historyFiles.length ? [{ type: 'text', text: content }, ...historyFiles] : content });
    }
  }
  messages.push({ role: 'user', content: files.length ? [{ type: 'text', text }, ...files] : text });
  return messages;
}
function parseOutput(content, task, count) {
  if (typeof content !== 'string' || !content.trim() || content.length > 200000) throw new Error('Неверный вывод AI.');
  if (task === 'replies') {
    const parsed = JSON.parse(content);
    return { replies: validateReplies({ replies: parsed.replies ?? parsed.suggestions }, count) };
  }
  if (task === 'create-style') {
    const parsed = JSON.parse(content);
    const style = parsed?.style ?? parsed;
    if (typeof style?.name !== 'string' || !style.name.trim() || style.name.length > 80 || typeof style.prompt !== 'string' || !style.prompt.trim() || style.prompt.length > 5000) throw new Error('Неверный стиль.');
    return { style: { name: style.name.trim(), prompt: style.prompt.trim() } };
  }
  return { text: content };
}
async function* sseData(body) {
  if (!body) throw new Error('Нет потока ответа.');
  let buffer = ''; const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (buffer.length > 1000000) throw new Error('Слишком большое событие AI.');
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) yield data === '[DONE]' ? { type: 'stream.done' } : JSON.parse(data);
    }
  }
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) yield data === '[DONE]' ? { type: 'stream.done' } : JSON.parse(data);
  }
}

export function createProviders({ apiKey, fetchImpl = fetch, env = process.env, directory = '.replylab', credentialResolver } = {}) {
  const configs = {
    openai: { key: apiKey ?? env.OPENAI_API_KEY ?? '', baseUrl: 'https://api.openai.com/v1', protocol: env.OPENAI_API_PROTOCOL ?? 'chat' },
    openrouter: { key: env.OPENROUTER_API_KEY ?? '', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat' },
    compatible: { key: env.COMPATIBLE_API_KEY ?? '', baseUrl: env.COMPATIBLE_API_BASE ? baseUrl(env.COMPATIBLE_API_BASE) : '', protocol: 'chat' },
    chatgpt: { key: '', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' },
  };
  let loaded = false;
  let credentialsQueue = Promise.resolve();
  async function ensureLoaded() {
    if (loaded) return;
    try {
      const file = join(resolve(directory), 'credentials.json'); const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Недопустимый файл credentials.');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      for (const [id, value] of Object.entries(saved)) if (configs[id] && !configs[id].key) configs[id] = { ...configs[id], ...value };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    loaded = true;
  }
  async function get(id = 'openai') {
    await ensureLoaded(); let config = configs[id];
    if (!config) throw new ProviderError(400, 'Неизвестный provider.');
    if (credentialResolver && (id === 'chatgpt' || (id === 'openrouter' && !config.key))) {
      const resolved = await credentialResolver(id);
      if (resolved?.apiKey) config = { key: resolved.apiKey, baseUrl: baseUrl(resolved.baseUrl), protocol: resolved.protocol ?? 'chat' };
    }
    const anonymousLocal = id === 'compatible' && config.baseUrl && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.baseUrl).hostname);
    if ((!config.key && !anonymousLocal) || !config.baseUrl) throw new ProviderError(503, id === 'openai' ? 'Задайте OPENAI_API_KEY в окружении шлюза.' : `Настройте ключ provider ${id} на сервере.`);
    return config;
  }
  return {
    async status() { await ensureLoaded(); return Object.entries(configs).map(([id, config]) => ({ id, configured: Boolean(config.baseUrl && (config.key || (id === 'compatible' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.baseUrl).hostname)))), protocol: config.protocol, baseUrl: config.baseUrl })); },
    credentials(input) {
      const operation = credentialsQueue.then(async () => {
      await ensureLoaded(); const { provider, apiKey: key } = input;
      if (!configs[provider] || typeof key !== 'string' || !key.trim() || key.length > 8000) throw new TypeError('Нужны provider и ключ API.');
      const next = { ...configs[provider], key: key.trim() };
      if (provider === 'compatible') next.baseUrl = baseUrl(input.baseUrl);
      if (input.protocol !== undefined) { if (!['chat', 'responses'].includes(input.protocol)) throw new TypeError('Неизвестный API protocol.'); next.protocol = input.protocol; }
      const dir = resolve(directory); await mkdir(dir, { recursive: true, mode: 0o700 });
      if ((await lstat(dir)).isSymbolicLink()) throw new Error('Недопустимая папка credentials.');
      await chmod(dir, 0o700);
      const all = { ...configs, [provider]: next };
      const temporary = join(dir, `.credentials-${randomUUID()}.tmp`); const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(all)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(dir, 'credentials.json')); configs[provider] = next;
      return { provider, configured: true };
      });
      credentialsQueue = operation.catch(() => {});
      return operation;
    },
    async models(id = 'openai', signal) {
      const config = await get(id);
      const response = await fetchImpl(`${config.baseUrl}/models`, { headers: config.key ? { Authorization: `Bearer ${config.key}` } : {}, redirect: 'error', signal: signal ?? AbortSignal.timeout(30000) });
      if (!response.ok) throw new ProviderError(502, 'Не удалось получить каталог моделей.');
      const data = await response.json();
      const models = data.data ?? data.models;
      if (!Array.isArray(models)) throw new ProviderError(502, 'Неверный каталог моделей.');
      return models.filter(item => typeof (item.id ?? item.slug) === 'string' && (!item.visibility || item.visibility === 'list')).map(item => ({ id: item.id ?? item.slug, name: String(item.name ?? item.display_name ?? item.id ?? item.slug), description: String(item.description ?? '').slice(0, 1000), contextLength: item.context_length ?? null, capabilities: item.supported_parameters ?? [] }));
    },
    async usage(id = 'openai', signal) {
      if (!Object.hasOwn(configs, id)) throw new ProviderError(400, 'Неизвестный provider.');
      if (id !== 'openrouter') return { provider: id, supported: false,
        message: id === 'chatgpt' ? 'Числовая статистика через поддерживаемый API здесь недоступна. Откройте ChatGPT: Settings → Usage.' : 'Этот адаптер не предоставляет числовую статистику использования.',
        ...(id === 'chatgpt' ? { manageUrl: 'https://chatgpt.com/settings/usage' } : {}) };
      const config = await get(id);
      const response = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${config.key}` }, redirect: 'error', signal: signal ?? AbortSignal.timeout(30000) });
      if (!response.ok) throw new ProviderError(502, 'Не удалось получить статистику OpenRouter. Проверьте подключение и ключ.');
      let data;
      try { data = (await response.json()).data; }
      catch { throw new ProviderError(502, 'OpenRouter вернул некорректную статистику.'); }
      if (!data || Array.isArray(data) || typeof data !== 'object' || typeof data.usage !== 'number' || !Number.isFinite(data.usage) || data.usage < 0) throw new ProviderError(502, 'OpenRouter вернул некорректную статистику.');
      const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
      const reset = value => ['daily', 'weekly', 'monthly'].includes(value) ? value : null;
      const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
      // Only documented counters are returned; label/hash/owner IDs can reveal key metadata.
      // https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
      return { provider: id, supported: true, scope: 'current-key', currency: 'USD', checkedAt: new Date().toISOString(),
        usage: { total: data.usage, daily: number(data.usage_daily), weekly: number(data.usage_weekly), monthly: number(data.usage_monthly), byok: number(data.byok_usage) },
        limit: number(data.limit), remaining: number(data.limit_remaining), limitReset: reset(data.limit_reset), isFreeTier: data.is_free_tier === true, expiresAt: date(data.expires_at),
        freeRequests: data.free_model_daily_requests && typeof data.free_model_daily_requests === 'object' ? { limit: number(data.free_model_daily_requests.limit), remaining: number(data.free_model_daily_requests.remaining), used: number(data.free_model_daily_requests.used) } : null,
        effectiveBudget: data.effective_budget && typeof data.effective_budget === 'object' ? { limit: number(data.effective_budget.limit_usd), remaining: number(data.effective_budget.remaining_usd), spent: number(data.effective_budget.spend_usd), resetInterval: reset(data.effective_budget.reset_interval), resetsAt: date(data.effective_budget.resets_at) } : null };
    },
    async complete(input, { task = 'replies', onDelta, signal } = {}) {
      const count = input.count ?? input.suggestionCount ?? input.style?.suggestionCount ?? 3;
      if (!Number.isInteger(count) || count < 1 || count > 3) throw new TypeError('Количество вариантов: от 1 до 3.');
      if (typeof input.model !== 'string' || !MODEL.test(input.model)) throw new TypeError('Укажите корректную модель в настройках.');
      const messages = messagesFor(input, task, count);
      const config = await get(input.provider ?? 'openai');
      const temperature = input.temperature ?? input.style?.temperature;
      const maxTokens = input.maxTokens ?? input.maxCompletionTokens ?? input.style?.maxTokens ?? 1200;
      if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new TypeError('Temperature: от 0 до 2.');
      if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 16000) throw new TypeError('Лимит ответа: от 16 до 16 000 tokens.');
      const structured = ['replies', 'create-style'].includes(task);
      const stream = Boolean(onDelta) || input.provider === 'chatgpt';
      let body = { model: input.model, messages, max_completion_tokens: maxTokens, ...(temperature === undefined ? {} : { temperature }), ...(structured ? { response_format: { type: 'json_object' } } : {}), ...(stream ? { stream: true } : {}) };
      let endpoint = `${config.baseUrl}/chat/completions`;
      const replyTool = { name: 'emitReplies', description: 'Return the requested reply suggestions.', strict: true, parameters: { type: 'object', properties: { replies: { type: 'array', minItems: count, maxItems: count, items: { type: 'object', properties: { text: { type: 'string' }, reason: { type: 'string' } }, required: ['text', 'reason'], additionalProperties: false } } }, required: ['replies'], additionalProperties: false } };
      if (input.useTools === true && task === 'replies') {
        delete body.response_format;
        body.tools = [{ type: 'function', function: replyTool }];
        body.tool_choice = { type: 'function', function: { name: replyTool.name } };
      }
      if (config.protocol === 'responses') {
        endpoint = `${config.baseUrl}/responses`;
        body = { model: input.model, input: messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url }) })), max_output_tokens: maxTokens, store: false, ...(temperature === undefined ? {} : { temperature }), ...(structured ? { text: { format: { type: 'json_object' } } } : {}), ...(stream ? { stream: true } : {}) };
        if (input.useTools === true && task === 'replies') {
          delete body.text;
          body.tools = [{ type: 'function', ...replyTool }];
          body.tool_choice = { type: 'function', name: replyTool.name };
        }
        if (input.provider === 'chatgpt') {
          // Direct ChatGPT routing rejects system items and these otherwise valid API fields.
          // https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
          body.instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
          body.input = body.input.filter(message => message.role !== 'system');
          delete body.max_output_tokens;
          delete body.temperature;
          if (body.tools) {
            body.tools = [{ type: 'namespace', name: 'replylab', description: 'ReplyLab reply output.', tools: [{ type: 'function', ...replyTool }] }];
            body.tool_choice = 'required';
          }
        }
      }
      const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
      try {
        const response = await fetchImpl(endpoint, { method: 'POST', headers: { ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}), 'Content-Type': 'application/json' }, redirect: 'error', signal: abort, body: JSON.stringify(body) });
        if (!response.ok) throw new Error('AI endpoint rejected request.');
        let content = '';
        if (stream) {
          let toolArguments = ''; let toolName = '';
          let completed = false;
          for await (const event of sseData(response.body)) {
            if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('AI stream failed.');
            if (event.type === 'response.completed') completed = true;
            if (config.protocol !== 'responses' && (event.type === 'stream.done' || ['stop', 'tool_calls', 'function_call'].includes(event.choices?.[0]?.finish_reason))) completed = true;
            if (['length', 'content_filter'].includes(event.choices?.[0]?.finish_reason)) throw new Error('AI stream did not complete.');
            const delta = event.choices?.[0]?.delta;
            const text = delta?.content ?? (event.type === 'response.output_text.delta' ? event.delta : '');
            if (typeof text === 'string' && text) { content += text; await onDelta?.(text); }
            for (const tool of delta?.tool_calls ?? []) { toolName ||= tool.function?.name ?? ''; toolArguments += tool.function?.arguments ?? ''; }
            if (event.type === 'response.function_call_arguments.delta') toolArguments += event.delta ?? '';
            if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') toolName = event.item.name ?? '';
            if (event.type === 'response.function_call_arguments.done' && !toolArguments) toolArguments = event.arguments ?? '';
            if (content.length + toolArguments.length > 200000) throw new Error('AI stream exceeded limit.');
          }
          if (!completed) throw new Error('AI stream interrupted.');
          if (!content && toolArguments && (!toolName || ['emitReplies', 'emitSuggestions', 'createStyle', 'replylab.emitReplies'].includes(toolName))) content = toolArguments;
        } else {
          const data = await response.json();
          const message = data.choices?.[0]?.message;
          content = message?.content ?? data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('') ?? '';
          if (!content && message?.tool_calls?.length === 1) {
            const tool = message.tool_calls[0].function;
            if (['emitReplies', 'emitSuggestions', 'createStyle'].includes(tool?.name)) content = tool.arguments;
          }
        }
        return parseOutput(content, task, count);
      } catch (error) {
        if (signal?.aborted) throw new ProviderError(499, 'Запрос отменён.');
        throw new ProviderError(502, task === 'replies' ? 'GPT не вернул корректные ответы. Проверьте модель, ключ и повторите запрос.' : 'GPT не вернул корректный результат. Проверьте модель и повторите запрос.');
      }
    },
  };
}
