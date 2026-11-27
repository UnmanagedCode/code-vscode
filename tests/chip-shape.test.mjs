import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { shapeChip, shapeEditor, CHIP_TITLE_MAX, CHIP_DATA_MAX } = createRequire(import.meta.url)('../extension/src/chipShape.js');

const pos = (line, character) => ({ line, character });
const snap = (start, end, over = {}) => ({ fileName: '/work/src/app.ts', path: '/work/src/app.ts', languageId: 'typescript', scheme: 'file', isClosed: false, selection: { start, end }, text: 'x', ...over });

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

test('a selection chip is tagged kind selection', () => {
  assert.equal(shapeChip(snap(pos(0, 0), pos(0, 1))).kind, 'selection');
});

test('an empty selection in an open file gives a path-only file chip keyed by the path', () => {
  const chip = shapeChip(snap(pos(3, 4), pos(3, 4), { text: 'SENTINEL-BODY' }));
  assert.equal(chip.kind, 'file');
  assert.equal(chip.key, '/work/src/app.ts');
  assert.equal(chip.title, 'app.ts');
  assert.match(chip.data, /^path: \/work\/src\/app\.ts\nlanguage: typescript\n/);
  assert.ok(!chip.data.includes('SENTINEL-BODY'));
});

test('file chip keys follow the file, not the cursor', () => {
  const a1 = shapeChip(snap(pos(0, 0), pos(0, 0)));
  const a2 = shapeChip(snap(pos(9, 3), pos(9, 3)));
  const b = shapeChip(snap(pos(0, 0), pos(0, 0), { path: '/work/src/b.ts', fileName: '/work/src/b.ts' }));
  assert.equal(a1.key, a2.key);
  assert.notEqual(a1.key, b.key);
});

test('an empty selection in a non-file scheme or a closed document gives no chip', () => {
  for (const scheme of ['untitled', 'output', 'git', 'vscode-notebook-cell']) {
    assert.equal(shapeChip(snap(pos(1, 1), pos(1, 1), { scheme })), null, scheme);
  }
  assert.equal(shapeChip(snap(pos(1, 1), pos(1, 1), { isClosed: true })), null);
});

test('a non-empty selection in a non-file scheme still gives a selection chip', () => {
  const chip = shapeChip(snap(pos(0, 0), pos(0, 2), { scheme: 'untitled', path: 'untitled:Untitled-1', fileName: 'Untitled-1' }));
  assert.equal(chip.kind, 'selection');
  assert.match(chip.data, /^path: untitled:Untitled-1\n/);
});

test('a hostile file name, path and language keep a file chip within the chip limits on one title line', () => {
  const chip = shapeChip(snap(pos(0, 0), pos(0, 0), {
    fileName: `/w/${'n\n'.repeat(400)}.ts`, path: `/${'p'.repeat(CHIP_DATA_MAX)}`, languageId: 'l'.repeat(300_000),
  }));
  assert.ok(chip.title.length <= CHIP_TITLE_MAX);
  assert.ok(!chip.title.includes('\n'));
  assert.ok(chip.data.length <= CHIP_DATA_MAX);
});

test('a document that is not a file is identified by its URI', () => {
  const editor = {
    document: {
      fileName: 'Untitled-1', languageId: 'plaintext',
      uri: { scheme: 'untitled', fsPath: 'Untitled-1', toString: () => 'untitled:Untitled-1' }, isClosed: false,
      getText: () => 'hi',
    },
    selection: { start: pos(0, 0), end: pos(0, 2) },
  };
  assert.match(shapeEditor(editor).data, /^path: untitled:Untitled-1\n/);
});

test('a file document is identified by its file system path', () => {
  const editor = {
    document: { isClosed: false, fileName: '/w/a.ts', languageId: 'typescript', uri: { scheme: 'file', fsPath: '/w/a.ts', toString: () => 'file:///w/a.ts' }, getText: () => 'hi' },
    selection: { start: pos(0, 0), end: pos(0, 2) },
  };
  assert.match(shapeEditor(editor).data, /^path: \/w\/a\.ts\n/);
});

test('data never exceeds the limit, even when the omitted count has eight digits', () => {
  const text = 'a'.repeat(20_000_000);
  const { data } = shapeChip(snap(pos(0, 0), pos(0, 5), { text }));
  assert.ok(data.length <= CHIP_DATA_MAX, `length ${data.length}`);
  const m = /\n… \(truncated, (\d+) chars omitted\)$/.exec(data);
  assert.ok(m && m[1].length >= 8);
  const kept = data.length - m[0].length - data.indexOf('\n\n') - 2;
  assert.equal(kept + Number(m[1]), text.length);
});

test('a path near the data limit still yields data within it, keeping the head of the text, never its tail', () => {
  const text = `HEAD${'x'.repeat(CHIP_DATA_MAX)}TAIL`;
  const { data } = shapeChip(snap(pos(0, 0), pos(0, 5), { path: `/${'p'.repeat(CHIP_DATA_MAX - 10)}`, text }));
  assert.ok(data.length <= CHIP_DATA_MAX, `length ${data.length}`);
  assert.ok(data.includes('HEAD'));
  assert.ok(!data.includes('TAIL'));
});

test('a very long language id cannot push data past the limit, and the text keeps its head', () => {
  const text = `HEAD${'x'.repeat(1_000_000)}TAIL`;
  const { data } = shapeChip(snap(pos(0, 0), pos(0, 5), { languageId: 'l'.repeat(300_000), text }));
  assert.ok(data.length <= CHIP_DATA_MAX, `length ${data.length}`);
  assert.ok(data.includes('HEAD'));
  assert.ok(!data.includes('TAIL'));
});

test('snapshotOf reads only the selection text, never the whole document', () => {
  let args;
  const editor = {
    document: { fileName: '/w/a.ts', languageId: 'typescript', isClosed: false, uri: { scheme: 'file', fsPath: '/w/a.ts' }, getText: (...a) => { args = a; return ''; } },
    selection: { start: pos(2, 2), end: pos(2, 2) },
  };
  shapeEditor(editor);
  assert.equal(args.length, 1);
  assert.deepEqual(args[0], editor.selection);
});
