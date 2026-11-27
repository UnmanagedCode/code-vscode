'use strict';
// An editor's state → the {title, data} of a cc context chip: the selected lines, or the file when nothing is selected.

// The same limits as cc's contextChip module (CHIP_TITLE_MAX, CHIP_DATA_MAX in src/contextChip.ts); cc rejects a chip past either.
const CHIP_TITLE_MAX = 200;
const CHIP_DATA_MAX = 256 * 1024;

const ELLIPSIS = '…';
// Cap the header's variable fields so the whole header stays far below CHIP_DATA_MAX and the text always has room.
const PATH_MAX = 4096;
const LANGUAGE_MAX = 256;

const capped = (value, max) => (value.length > max ? value.slice(0, max - 1) + ELLIPSIS : value);

function basenameOf(fileName) {
  return String(fileName).split(/[\\/]/).filter(Boolean).pop() ?? String(fileName);
}

function isEmpty({ start, end }) {
  return start.line === end.line && start.character === end.character;
}

// 1-based first and last line; a selection ending at column 0 of a later line excludes that line.
function lineRange({ start, end }) {
  const first = start.line + 1;
  const last = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
  return [first, last];
}

// The base name on one line, shortened so name plus suffix fit CHIP_TITLE_MAX.
function titleOf(fileName, suffix = '') {
  const base = basenameOf(fileName).replace(/[\r\n]+/g, ' ');
  const room = CHIP_TITLE_MAX - suffix.length;
  return `${base.length > room ? base.slice(0, Math.max(room - 1, 0)) + ELLIPSIS : base}${suffix}`;
}

const rangeSuffix = (first, last) => (first === last ? `:${first}` : `:${first}-${last} (${last - first + 1} lines)`);

function dataOf({ path, languageId, text }, first, last) {
  const head = `path: ${capped(path, PATH_MAX)}\nlines: ${first}-${last}\nlanguage: ${capped(languageId, LANGUAGE_MAX)}\n\n`;
  if (head.length + text.length <= CHIP_DATA_MAX) return head + text;
  const marker = (omitted) => `\n${ELLIPSIS} (truncated, ${omitted} chars omitted)`;
  // The omitted count is at most text.length, so this reserves at least the marker's real length.
  let keep = Math.max(0, CHIP_DATA_MAX - head.length - marker(text.length).length);
  const code = text.charCodeAt(keep - 1);
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1; // never split a surrogate pair
  return head + text.slice(0, keep) + marker(text.length - keep);
}

const FILE_NOTE = 'This file is open in the editor; its contents are not included.';

/**
 * snapshot: {fileName, path, languageId, scheme, isClosed, selection: {start, end: {line, character}}, text}
 * `path` is the file's path for a file document and the URI string otherwise.
 * Returns {kind: 'selection', title, data} for a selection; {kind: 'file', key, title, data} (path only, no
 * contents) for an empty selection in an open `file` document; null for anything else.
 */
function shapeChip(snapshot) {
  if (!isEmpty(snapshot.selection)) {
    const [first, last] = lineRange(snapshot.selection);
    return { kind: 'selection', title: titleOf(snapshot.fileName, rangeSuffix(first, last)), data: dataOf(snapshot, first, last) };
  }
  if (snapshot.scheme !== 'file' || snapshot.isClosed) return null;
  const head = `path: ${capped(snapshot.path, PATH_MAX)}\nlanguage: ${capped(snapshot.languageId, LANGUAGE_MAX)}\n\n`;
  return { kind: 'file', key: snapshot.path, title: titleOf(snapshot.fileName), data: head + FILE_NOTE };
}

/** A snapshot of a vscode TextEditor's primary selection. The document's text is read for the selection only. */
function snapshotOf(editor) {
  const { document, selection } = editor;
  const { uri } = document;
  return {
    fileName: document.fileName,
    path: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    languageId: document.languageId,
    scheme: uri.scheme,
    isClosed: document.isClosed,
    selection: { start: selection.start, end: selection.end },
    text: document.getText(selection),
  };
}

/** The chip for an editor, or null when it gives none. */
function shapeEditor(editor) {
  return shapeChip(snapshotOf(editor));
}

module.exports = { CHIP_TITLE_MAX, CHIP_DATA_MAX, shapeChip, snapshotOf, shapeEditor };
