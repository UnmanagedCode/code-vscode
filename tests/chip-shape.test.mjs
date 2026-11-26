import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { shapeChip, shapeEditor, CHIP_TITLE_MAX, CHIP_DATA_MAX } = createRequire(import.meta.url)('../extension/src/chipShape.js');

const pos = (line, character) => ({ line, character });
const snap = (start, end, over = {}) => ({ fileName: '/work/src/app.ts', path: '/work/src/app.ts', languageId: 'typescript', selection: { start, end }, text: 'x', ...over });

test('a one-line selection is titled file:line, lines 1-based', () => {
  assert.equal(shapeChip(snap(pos(11, 2), pos(11, 9))).title, 'app.ts:12');
});

test('a multi-line selection is titled with its range and line count', () => {
  assert.equal(shapeChip(snap(pos(11, 0), pos(17, 4))).title, 'app.ts:12-18 (7 lines)');
});

test('a selection ending at column 0 of a later line excludes that line', () => {
  assert.equal(shapeChip(snap(pos(11, 0), pos(14, 0))).title, 'app.ts:12-14 (3 lines)');
  assert.equal(shapeChip(snap(pos(11, 3), pos(12, 0))).title, 'app.ts:12');
});

test('a long file name is truncated so the title stays within the chip limit', () => {
  const long = `${'n'.repeat(500)}.ts`;
  const { title } = shapeChip(snap(pos(0, 0), pos(9, 1), { fileName: `/w/${long}` }));
  assert.equal(title.length, CHIP_TITLE_MAX);
  assert.ok(title.includes('…'));
  assert.ok(title.endsWith(':1-10 (10 lines)'));
});

test('the data names path, lines and language, then the selected text after a blank line', () => {
  const { data } = shapeChip(snap(pos(1, 0), pos(2, 3), { text: 'foo\nbar' }));
  assert.equal(data, 'path: /work/src/app.ts\nlines: 2-3\nlanguage: typescript\n\nfoo\nbar');
});

test('text past the data limit is cut with a marker counting the omitted characters', () => {
  const text = 'a'.repeat(CHIP_DATA_MAX + 1000);
  const { data } = shapeChip(snap(pos(0, 0), pos(0, 5), { text }));
  assert.ok(data.length <= CHIP_DATA_MAX);
  const m = /\n… \(truncated, (\d+) chars omitted\)$/.exec(data);
  assert.ok(m);
  const kept = data.length - m[0].length - data.indexOf('\n\n') - 2;
  assert.equal(kept + Number(m[1]), text.length);
});

test('truncation never leaves half of a surrogate pair', () => {
  const text = '😀'.repeat(CHIP_DATA_MAX);
  const { data } = shapeChip(snap(pos(0, 0), pos(0, 5), { text }));
  assert.ok(data.length <= CHIP_DATA_MAX);
  assert.doesNotMatch(data, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('an empty selection gives null', () => {
  assert.equal(shapeChip(snap(pos(3, 4), pos(3, 4))), null);
});

test('a document that is not a file is identified by its URI', () => {
  const editor = {
    document: {
      fileName: 'Untitled-1', languageId: 'plaintext',
      uri: { scheme: 'untitled', fsPath: 'Untitled-1', toString: () => 'untitled:Untitled-1' },
      getText: () => 'hi',
    },
    selection: { start: pos(0, 0), end: pos(0, 2) },
  };
  assert.match(shapeEditor(editor).data, /^path: untitled:Untitled-1\n/);
});

test('a file document is identified by its file system path', () => {
  const editor = {
    document: { fileName: '/w/a.ts', languageId: 'typescript', uri: { scheme: 'file', fsPath: '/w/a.ts', toString: () => 'file:///w/a.ts' }, getText: () => 'hi' },
    selection: { start: pos(0, 0), end: pos(0, 2) },
  };
  assert.match(shapeEditor(editor).data, /^path: \/w\/a\.ts\n/);
});
