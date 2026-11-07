// Explicit opt-in smoke test. Sends synthetic text to the configured compatible model.
import { createGateway } from '../scripts/gateway.mjs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const model = process.env.REPLYLAB_LIVE_MODEL;
if (!model || !process.env.COMPATIBLE_API_BASE || !process.env.CHROME_PATH) throw new Error('Set REPLYLAB_LIVE_MODEL, COMPATIBLE_API_BASE and CHROME_PATH explicitly.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await fs.mkdtemp(join(tmpdir(), 'replylab-live-'));
const extension = join(directory, 'extension');
await fs.cp(join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(await fs.readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await fs.writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const server = createGateway({ directory: join(directory, 'server'), env: {
  COMPATIBLE_API_BASE: process.env.COMPATIBLE_API_BASE,
  ...(process.env.COMPATIBLE_API_KEY ? { COMPATIBLE_API_KEY: process.env.COMPATIBLE_API_KEY } : {}),
  ...(process.env.COMPATIBLE_REASONING_EFFORT ? { COMPATIBLE_REASONING_EFFORT: process.env.COMPATIBLE_REASONING_EFFORT } : {}),
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    executablePath: process.env.CHROME_PATH, headless: true, viewport: { width: 1240, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--no-first-run'],
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('chrome://extensions');
  const installed = await page.evaluate(() => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }));
  const id = installed.find(item => item.name === 'ReplyLab')?.id;
  assert(id, 'ReplyLab must load');
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.locator('#code').fill('REPLYLAB-LOCAL');
  await page.getByRole('button', { name: 'Включить тест', exact: true }).click();
  await page.getByText('Локальный доступ открыт', { exact: true }).waitFor();
  const saved = await page.evaluate(async ({ serverUrl, model }) => chrome.runtime.sendMessage({
    type: 'replylab:action', action: 'save-settings', payload: { settings: { serverUrl, provider: 'compatible', suggestionModel: model, suggestionCount: 2, replyLanguage: 'en' } },
  }), { serverUrl: 'http://127.0.0.1:' + server.address().port, model });
  assert.equal(saved.ok, true, saved.error);
  await page.locator('#mode').selectOption('gpt');
  await page.locator('#model').fill(model);
  await page.locator('#conversation').fill('Other person: Want to get coffee tomorrow?\nMe: I would like to accept and ask what time works.');
  const started = Date.now();
  await page.locator('#generate').click();
  await page.waitForFunction(() => document.querySelectorAll('#suggestions .reply').length === 2 || document.querySelector('#message').classList.contains('error'), null, { timeout: 100000 });
  assert.equal(await page.locator('#message.error').count(), 0, await page.locator('#message').textContent());
  const replies = await page.locator('#suggestions .reply > p').allTextContents();
  assert.equal(replies.length, 2); assert(replies.every(text => text.trim()));
  assert.deepEqual(errors, []);
  if (process.env.REPLYLAB_LIVE_SCREENSHOT) await page.screenshot({ path: process.env.REPLYLAB_LIVE_SCREENSHOT });
  const result = { model, elapsedMs: Date.now() - started, realAI: true, replies, errors,
    scope: 'Actual extension UI/worker/gateway and configured AI; synthetic text only; no live site account or messages. Test localhost permission pregranted.' };
  if (process.env.REPLYLAB_LIVE_REPORT) await fs.writeFile(process.env.REPLYLAB_LIVE_REPORT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
