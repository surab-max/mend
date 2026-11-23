// mend: one patch tool for every AI edit format (SPEC.md v1).
// Implements unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// text-editor tool calls, with three-tier line matching, whitespace and
// indentation tolerance, and all-or-nothing writes. Node standard library
// only. The trial hand-over to runner.ts at the end is the kit's, kept as is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ----- file lines -----

interface FileData {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileData {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  // A lone text with no break at all splits into one line, which is right.
  return { br, lines: parts, final };
}

function writeFileData(d: FileData): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

// ----- matching (section 5) -----

let STRICT = false;

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

function tiersToTry(): number[] {
  return STRICT ? [0] : [0, 1, 2];
}

/** All start positions where O matches file lines at the given tier. */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier with at least one occurrence, and its occurrences. */
function findOccurrences(fileLines: string[], o: string[], from = 0): { tier: number; positions: number[] } | null {
  for (const tier of tiersToTry()) {
    const positions = occurrencesAt(fileLines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** First tier with a single line equal to `anchor` at or after `from`. */
function findAnchor(fileLines: string[], anchor: string, from: number): { tier: number; index: number } | null {
  for (const tier of tiersToTry()) {
    for (let i = Math.max(0, from); i < fileLines.length; i += 1) {
      if (lineEq(fileLines[i]!, anchor, tier)) return { tier, index: i };
    }
  }
  return null;
}

interface NItem {
  text: string;
  context: boolean;
  /** index into O for context items, -1 otherwise */
  oIndex: number;
}

/** Build the replacement lines for a match at `pos` found at `tier`. */
function buildReplacement(fileLines: string[], pos: number, o: string[], nItems: NItem[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadST(fileLines[pos] ?? '');
    p = leadST(o[0]!);
  }
  for (const item of nItems) {
    if (item.context) {
      out.push(fileLines[pos + item.oIndex]!);
    } else if (tier === 2) {
      const s = item.text;
      if (s !== '' && s.trim() !== '' && s.startsWith(p)) out.push(f + s.slice(p.length));
      else out.push(s);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** Plain old/new line lists (SEARCH/REPLACE) become N items with no context. */
function plainN(newLines: string[]): NItem[] {
  return newLines.map((t) => ({ text: t, context: false, oIndex: -1 }));
}

/** Tagged body lines (unified / V4A) become the O list and N items. */
function taggedON(body: { kind: string; text: string }[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'context') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, context: true, oIndex: idx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, context: false, oIndex: -1 });
    }
  }
  return { o, n };
}

// ----- tree -----

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { oldP: string; newP: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ----- format detection (section 4) -----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ----- JSON edits (section 9) -----

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ----- unified diffs (section 6) -----

interface Hunk {
  a: number;
  body: { kind: string; text: string }[];
  /** for each body index, whether a backslash line follows it */
  slashAfter: boolean[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const t = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  return t === '/dev/null' ? '/dev/null' : stripPrefix(t);
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (): Section => {
    const s: Section = { diffOld: null, diffNew: null, headOld: null, headNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (cur === null || !inHeader)) {
      // A section starting at the ---/+++ pair (not part of a current header).
      const s = newSection();
      s.headOld = headerPath(line.slice(4));
      s.headNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!((lines[i + 1] ?? '').startsWith('+++ '))) throw new Exit2(`error: parse ${ln + 1}`);
        cur.headOld = headerPath(line.slice(4));
        cur.headNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        inHeader = false;
        // fall through to hunk handling below
      } else {
        if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
        else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
        else if (line.startsWith('new file mode')) cur.newFile = true;
        else if (line.startsWith('deleted file mode')) cur.delFile = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [], slashAfter: [] };
      i += 1;
      // Body lines.
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          hunk.body.push({ kind: bl === '' ? 'context' : bl.startsWith(' ') ? 'context' : bl.startsWith('-') ? 'old' : bl.startsWith('+') ? 'new' : 'slash', text: bl === '' ? '' : bl.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'context' && last.text === '') hunk.body.pop();
        else break;
      }
      // Record slash followers.
      hunk.slashAfter = hunk.body.map((b, idx) => {
        void b;
        const nx = hunk.body[idx + 1];
        return nx !== undefined && nx.kind === 'slash';
      });
      cur.hunks.push(hunk);
      continue;
    }
    // Outside bodies and headers: ignored (prose, code fences).
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = sections.map((s) => unifiedEdit(s));
  return edits;
}

function unifiedEdit(s: Section): Edit {
  const oldPath = s.headOld ?? s.renameFrom ?? s.diffOld;
  const newPath = s.headNew ?? s.renameTo ?? s.diffNew;
  const isCreate = s.newFile || s.headOld === '/dev/null';
  const isDelete = s.delFile || s.headNew === '/dev/null';
  return (tree) => {
    // Safety first, for every path the edit names (sentinel excluded).
    if (!isCreate && oldPath !== null && oldPath !== '/dev/null') checkSafe(oldPath);
    if (!isDelete && newPath !== null && newPath !== '/dev/null') checkSafe(newPath);
    if (isCreate) {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === 'new') {
            plus.push(b.text);
            noBreak = h.slashAfter[idx]!;
          }
        });
      }
      if (plus.length === 0) {
        tree.now.set(np, '');
      } else {
        tree.now.set(np, plus.join('\n') + (noBreak ? '' : '\n'));
      }
      return;
    }
    if (isDelete) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const data = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n } = taggedON(h.body.filter((b) => b.kind !== 'slash'));
      // slashAfter was computed on the body including slashes; recompute the
      // flag for the hunk's last context/new entry directly:
      let lastCN = -1;
      h.body.forEach((b, idx) => {
        if (b.kind === 'context' || b.kind === 'new') lastCN = idx;
      });
      const slashOnLast = lastCN >= 0 ? h.slashAfter[lastCN]! : false;
      if (o.length === 0) {
        const insertAt = Math.min(h.a + d, data.lines.length);
        const plain = n.map((it) => it.text);
        const atEnd = insertAt === data.lines.length;
        data.lines.splice(insertAt, 0, ...plain);
        if (atEnd) data.final = !slashOnLast;
        d += n.length - o.length;
        continue;
      }
      const found = findOccurrences(data.lines, o);
      if (found === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const repl = buildReplacement(data.lines, best, o, n, found.tier);
      const touchesEnd = best + o.length === data.lines.length;
      data.lines.splice(best, o.length, ...repl);
      if (touchesEnd) data.final = !slashOnLast;
      d += n.length - o.length;
    }
    const out = writeFileData(data);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push({ oldP: op, newP: np });
    } else {
      tree.now.set(np, out);
    }
  };
}

// ----- SEARCH/REPLACE blocks (section 7) -----

function searchReplaceEdits(lines: string[]): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1; // index of previous REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // Find ======= then >>>>>>> REPLACE.
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Path: nearest eligible line before SEARCH, after previous block.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map(
    (b): Edit =>
      (tree) => {
        checkSafe(b.path);
        if (b.oldLines.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
          return;
        }
        const before = tree.get(b.path);
        if (before === null) throw new Fail('missing', b.path);
        const data = parseFile(before);
        const found = findOccurrences(data.lines, b.oldLines);
        if (found === null) throw new Fail('no-match', b.path);
        if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
        const pos = found.positions[0]!;
        const repl = buildReplacement(data.lines, pos, b.oldLines, plainN(b.newLines), found.tier);
        data.lines.splice(pos, b.oldLines.length, ...repl);
        tree.now.set(b.path, writeFileData(data));
      },
  );
}

// ----- V4A patches (section 8) -----

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface VSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    moveTo: string | null;
    addLines: string[];
    chunks: { anchor: string | null; eof: boolean; body: { kind: string; text: string }[] }[];
    hasChunk: boolean;
  }
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curChunk: VSection['chunks'][number] | null = null;
  // Raw section lines are validated as they come; trailing blanks trimmed later.
  const pendingBlanks: { lineNo: number }[] = [];
  const flushBlanksAsBody = (): void => {
    // Blank lines inside a section (not at its end) are body lines.
    for (const pb of pendingBlanks) {
      void pb;
      if (cur === null) continue;
      if (cur.kind === 'add') cur.addLines.push('');
      else if (cur.kind === 'update') {
        if (curChunk === null) {
          curChunk = { anchor: null, eof: false, body: [] };
          cur.chunks.push(curChunk);
          cur.hasChunk = true;
        }
        curChunk.body.push({ kind: 'context', text: '' });
      }
    }
    pendingBlanks.length = 0;
  };
  const headerOf = (l: string): { kind: VSection['kind']; path: string } | null => {
    for (const [pre, kind] of [
      ['*** Add File:', 'add'],
      ['*** Delete File:', 'delete'],
      ['*** Update File:', 'update'],
    ] as const) {
      if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    }
    return null;
  };
  for (let idx = first + 1; idx < last; idx += 1) {
    const line = lines[idx]!;
    const ln = idx + 1;
    const hdr = headerOf(line);
    if (hdr !== null) {
      pendingBlanks.length = 0;
      cur = { kind: hdr.kind, path: hdr.path, lineNo: ln, moveTo: null, addLines: [], chunks: [], hasChunk: false };
      sections.push(cur);
      curChunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${ln}`);
    }
    if (blank(line)) {
      pendingBlanks.push({ lineNo: ln });
      continue;
    }
    flushBlanksAsBody();
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push(line.slice(1));
      else throw new Exit2(`error: parse ${ln}`);
    } else if (cur.kind === 'delete') {
      throw new Exit2(`error: parse ${ln}`);
    } else {
      // update
      if (line.startsWith('*** Move to:')) {
        // Only as its first line: no chunks yet, no move yet, no body yet.
        if (cur.moveTo !== null || cur.chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur.moveTo = line.slice('*** Move to:'.length).trim();
      } else if (line === '*** End of File') {
        if (curChunk === null) {
          curChunk = { anchor: null, eof: false, body: [] };
          cur.chunks.push(curChunk);
          cur.hasChunk = true;
        }
        curChunk.eof = true;
        curChunk = null;
      } else if (line.startsWith('@@')) {
        const anchorText = line.slice(2).trim();
        curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
        cur.chunks.push(curChunk);
        cur.hasChunk = true;
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
        if (curChunk === null) {
          curChunk = { anchor: null, eof: false, body: [] };
          cur.chunks.push(curChunk);
          cur.hasChunk = true;
        }
        curChunk.body.push({ kind: line.startsWith(' ') ? 'context' : line.startsWith('-') ? 'old' : 'new', text: line.slice(1) });
      } else {
        throw new Exit2(`error: parse ${ln}`);
      }
    }
  }
  for (const s of sections) {
    if (s.kind === 'update' && !s.hasChunk && s.moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map(
    (s): Edit =>
      (tree) => {
        checkSafe(s.path);
        if (s.kind === 'add') {
          if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
          tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
          return;
        }
        if (s.kind === 'delete') {
          if (tree.get(s.path) === null) throw new Fail('missing', s.path);
          tree.now.set(s.path, null);
          return;
        }
        // update
        if (s.moveTo !== null) checkSafe(s.moveTo);
        const before = tree.get(s.path);
        if (before === null) throw new Fail('missing', s.path);
        if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
        const data = parseFile(before);
        let cursor = 0;
        for (const chunk of s.chunks) {
          if (chunk.anchor !== null) {
            const found = findAnchor(data.lines, chunk.anchor, cursor);
            if (found === null) throw new Fail('no-match', s.path);
            cursor = found.index + 1;
          }
          const { o, n } = taggedON(chunk.body);
          if (o.length === 0) {
            const insertAt = chunk.eof ? data.lines.length : Math.min(cursor, data.lines.length);
            const plain = n.map((it) => it.text);
            data.lines.splice(insertAt, 0, ...plain);
            cursor = insertAt + plain.length;
            continue;
          }
          const found = findOccurrences(data.lines, o, cursor);
          if (found === null) throw new Fail('no-match', s.path);
          let positions = found.positions;
          if (chunk.eof) positions = positions.filter((pos) => pos + o.length === data.lines.length);
          if (positions.length === 0) throw new Fail('no-match', s.path);
          const pos = positions[0]!;
          const repl = buildReplacement(data.lines, pos, o, n, found.tier);
          data.lines.splice(pos, o.length, ...repl);
          cursor = pos + repl.length;
        }
        const out = writeFileData(data);
        if (s.moveTo !== null) {
          tree.now.set(s.moveTo, out);
          tree.now.set(s.path, null);
          tree.moves.push({ oldP: s.path, newP: s.moveTo });
        } else {
          tree.now.set(s.path, out);
        }
      },
  );
}

// ----- main run (sections 1, 2, 10) -----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with move pairs folded into R lines.
  interface Row {
    sortKey: string;
    line: string;
    paths: string[];
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.oldP);
    const nowOld = tree.get(mv.oldP);
    const wasNew = tree.original(mv.newP);
    const nowNew = tree.get(mv.newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ sortKey: mv.newP, line: `R ${mv.oldP} -> ${mv.newP}`, paths: [mv.oldP, mv.newP] });
      used.add(mv.oldP);
      used.add(mv.newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.sortKey), Buffer.from(y.sortKey)));
  if (!check) {
    for (const row of rows) {
      for (const p of row.paths) {
        if (!tree.now.has(p)) continue;
        const now = tree.now.get(p)!;
        if (tree.original(p) === now) continue;
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
