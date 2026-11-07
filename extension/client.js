export const rpc = (action, payload = {}) => chrome.runtime.sendMessage({ type: 'replylab:action', action, payload });

export function stream(task, payload, { onDelta, signal } = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(); const port = chrome.runtime.connect({ name: 'replylab:stream' }); let finished = false;
    const end = (error, result) => {
      if (finished) return; finished = true; signal?.removeEventListener('abort', cancel); port.disconnect();
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => { try { port.postMessage({ type: 'cancel', id }); } catch {} end(new DOMException('Запрос отменён.', 'AbortError')); };
    port.onMessage.addListener((event) => {
      if (event.id !== id) return;
      if (event.type === 'delta') onDelta?.(event.text);
      if (event.type === 'error') end(Object.assign(new Error(event.error), { code: event.code, retryable: event.retryable }));
      if (event.type === 'result') end(null, event.result);
    });
    port.onDisconnect.addListener(() => { if (!finished) end(new Error(chrome.runtime.lastError?.message || 'Поток прерван.')); });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    port.postMessage({ id, task, payload });
  });
}
