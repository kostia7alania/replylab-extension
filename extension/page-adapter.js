function editable(composer) {
  const view = composer?.ownerDocument?.defaultView;
  return Boolean(view && composer instanceof view.HTMLTextAreaElement
    && composer.isConnected && !composer.disabled && !composer.readOnly
    && composer.getAttribute('aria-disabled') !== 'true');
}

export function findComposer(doc = document, loc = location) {
  if (!/^\/app\/messages(?:\/|$)/.test(loc?.pathname ?? '')) return null;
  if (loc?.hostname && loc.hostname !== 'tinder.com' && !loc.hostname.endsWith('.tinder.com')) return null;
  const candidates = [...doc.querySelectorAll('textarea')].filter(composer => {
    if (!editable(composer) || !composer.closest('main, [role="main"], form')) return false;
    if (composer.closest('[hidden], [inert], [aria-hidden="true"], [role="search"], dialog, [role="dialog"], [aria-modal="true"], [data-replylab-helper]')) return false;
    if (composer.getAttribute('role') === 'searchbox') return false;
    const description = ['name', 'id', 'aria-label', 'placeholder'].map(name => composer.getAttribute(name) ?? '').join(' ');
    if (/search|поиск|искать/i.test(description)) return false;
    const style = doc.defaultView.getComputedStyle(composer);
    const box = composer.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && composer.getClientRects().length > 0 && box.width > 0 && box.height > 0;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function insertReply(composer, text) {
  if (!editable(composer) || typeof text !== 'string' || !text.trim() || text.length > 10000) return false;
  const view = composer.ownerDocument.defaultView;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) return false;
  composer.focus({ preventScroll: true });
  setter.call(composer, text);
  composer.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  composer.setSelectionRange(text.length, text.length);
  return true;
}
