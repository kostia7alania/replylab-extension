export function allowedSender(sender, extensionId) {
  if (sender.id !== extensionId) return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId) return true;
    return Boolean(sender.tab) && sender.frameId === 0 && ((url.origin === 'https://tinder.com' && /^\/app\/(?:messages|recs|profile)(?:\/|$)/.test(url.pathname)) || url.origin === 'https://web.whatsapp.com');
  } catch { return false; }
}
