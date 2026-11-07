import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { translate, SOURCE_MESSAGES, DICTIONARY, SUPPORTED_LANGUAGES } from '../extension/locales.js';

const TARGETS = ['de', 'fr', 'es', 'pt', 'da', 'sv', 'fi', 'lt', 'pl'];
const tokens = value => (value.match(/\{\{[^}]+\}\}|\$\{[^}]+\}|%[sd]|\b(?:OAuth|JSON|URL|ID)\b/g) ?? []).sort();

test('every workspace message has complete translations in all eleven languages', () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ['ru', 'en', ...TARGETS]);
  assert.ok(SOURCE_MESSAGES.length >= 121);
  assert.equal(new Set(SOURCE_MESSAGES.map(message => message.en)).size, SOURCE_MESSAGES.length);
  for (const { ru, en } of SOURCE_MESSAGES) {
    assert.equal(translate(ru, en, 'ru'), ru);
    assert.equal(translate(ru, en, 'en'), en);
    for (const language of TARGETS) {
      const translated = translate(ru, en, language);
      assert.equal(typeof translated, 'string', `${language}: ${en}`);
      assert.ok(translated.trim(), `${language}: ${en}`);
      assert.equal(translated, DICTIONARY[en][language]);
      assert.deepEqual(tokens(translated), tokens(en), `${language}: placeholders or technical identifiers changed in ${en}`);
      if (en.includes('marked automatic')) assert.match(translated, /\bautomatic\b/);
    }
  }
});

test('locales contain translations rather than copied English paragraphs', () => {
  for (const language of TARGETS) {
    const unchanged = SOURCE_MESSAGES.filter(({ en }) => DICTIONARY[en][language] === en);
    // A few UI cognates, such as Latitude, are identical in several languages.
    assert.ok(unchanged.length / SOURCE_MESSAGES.length < 0.05, `${language} contains too much untranslated English`);
  }
});

test('unknown language falls back to English; missing supported translation fails explicitly', () => {
  assert.equal(translate('Новый текст {{name}}', 'New text {{name}}', 'ja'), 'New text {{name}}');
  assert.equal(translate('Новый текст ${id}', 'New text ${id}', 'en'), 'New text ${id}');
  assert.throws(() => translate('Неизвестная строка', 'Unknown new string', 'de'), /Missing de translation/);
  assert.equal(translate('Сохранить', 'Unrecognized alias', 'de'), 'Speichern');
});

test('literal workspace translation calls resolve in every supported locale', async () => {
  const source = await readFile(new URL('../extension/workspace.js', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/\bt\(\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'/g)];
  assert.ok(calls.length >= 118, 'Workspace translation source was not found');
  const unescape = value => value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  for (const [, ru, en] of calls) {
    for (const language of TARGETS) assert.ok(translate(unescape(ru), unescape(en), language));
  }
});
