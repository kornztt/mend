// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does SPEC.md sections 1 to 10: the command line, the output and exit codes, safe paths, format detection,
// JSON edits, the all-or-nothing write, matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

/**
 * Refuse to write through a symbolic link: the path itself, or any ancestor directory of it, is a
 * symlink in the starting tree, so writeFileSync would write to the link's target instead of the
 * tree. Throws Fail('unsafe', p) for the edit that names the path.
 */
function assertNoSymlink(p: string): void {
  const parts = p.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    let st;
    try {
      st = lstatSync(sub);
    } catch {
      continue; // Missing (or unreachable) component: no symlink there.
    }
    if (st.isSymbolicLink()) throw new Fail('unsafe', p);
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R old -> new` output line. */
  readonly moves: Array<[string, string]> = [];
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    assertNoSymlink(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      assertNoSymlink(p);
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

/* ------------------------------------------------------------------ */
/* Section 3: a file's lines, its line break and its final line break */
/* ------------------------------------------------------------------ */

interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers                            */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions i where O matches the file's lines i, i+1, ... at the tier, at or after `from`. */
function findOccurrences(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1 or 2) at which O occurs at least once at or after `from`, or -1. */
function firstTierWith(fileLines: string[], o: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (findOccurrences(fileLines, o, t, from).length > 0) return t;
  }
  return -1;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` marker. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bslash';
  text: string;
  raw: string;
}

/**
 * Build N from a hunk/chunk body: context lines are the file's own matched lines, `+` lines are the
 * patch's, re-indented at tier 2 (F: the leading spaces and tabs of the file's first matched line,
 * P: those of O's first line). `-` lines consume a line of O and are not in N.
 */
function buildNew(body: BodyLine[], fileLines: string[], at: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const fLead = tier === 2 ? leadingWs(fileLines[at] ?? '') : '';
  const pLead = tier === 2 ? leadingWs(o[0] ?? '') : '';
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[at + oIdx]!);
      oIdx++;
    } else if (b.kind === 'del') {
      oIdx++;
    } else if (b.kind === 'add') {
      let l = b.text;
      if (tier === 2 && l !== '' && !/^[ \t]+$/.test(l) && l.startsWith(pLead)) l = fLead + l.slice(pLead.length);
      out.push(l);
    }
  }
  return out;
}

/** Re-indent new lines at tier 2, where there are no context lines (SEARCH/REPLACE). */
function reindentLines(nLines: string[], oFirst: string, fileFirst: string): string[] {
  const fLead = leadingWs(fileFirst);
  const pLead = leadingWs(oFirst);
  return nLines.map((l) => {
    if (l === '' || /^[ \t]+$/.test(l)) return l;
    return l.startsWith(pLead) ? fLead + l.slice(pLead.length) : l;
  });
}

function lastCtxAddIdx(body: BodyLine[]): number {
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'add') return j;
  }
  return -1;
}

function lastAddIdx(body: BodyLine[]): number {
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'add') return j;
  }
  return -1;
}

/** Whether a `\` line follows body line j. */
function bslashAfter(body: BodyLine[], j: number): boolean {
  return j >= 0 && j + 1 < body.length && body[j + 1]!.kind === 'bslash';
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `, up to the first tab, spaces removed, a/ or b/ prefix removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const cut = tab < 0 ? rest : rest.slice(0, tab);
  const p = cut.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** The old start A of a hunk header, or null when the line is not a well-formed one. */
function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) return null;
  return parseInt(m[1]!, 10);
}

function hunkON(h: Hunk): { o: string[]; n: string[] } {
  const o: string[] = [];
  const n: string[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      n.push(b.text);
    }
  }
  return { o, n };
}

/**
 * Apply one hunk to a file's lines. `d` is the sum over this section's hunks applied so far of
 * (N's length minus O's length). Throws Fail('no-match', path) when O is nowhere.
 */
function applyHunk(f: FileLines, h: Hunk, strict: boolean, path: string, d: number): FileLines {
  const { o, n } = hunkON(h);
  const lines = f.lines;
  if (o.length === 0) {
    // Pure insertion: after the first A + d lines (all of them when the file has fewer).
    let pos = h.a + d;
    if (pos < 0) pos = 0;
    if (pos > lines.length) pos = lines.length;
    const newLines = [...lines.slice(0, pos), ...n, ...lines.slice(pos)];
    let final = f.final;
    if (pos === lines.length) {
      const la = lastAddIdx(h.body);
      if (la >= 0) final = !bslashAfter(h.body, la);
    }
    return { lines: newLines, br: f.br, final };
  }
  const tier = firstTierWith(lines, o, 0, strict);
  if (tier < 0) throw new Fail('no-match', path);
  const occ = findOccurrences(lines, o, tier);
  const target = h.a - 1 + d;
  let at = occ[0]!;
  let bestDist = Math.abs(at - target);
  for (const p of occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      at = p;
      bestDist = dist;
    }
  }
  const newN = buildNew(h.body, lines, at, tier, o);
  const newLines = [...lines.slice(0, at), ...newN, ...lines.slice(at + o.length)];
  let final = f.final;
  if (at + o.length === lines.length) {
    // The matched lines run to the end of the file.
    const lca = lastCtxAddIdx(h.body);
    if (lca < 0) {
      // A pure deletion at the end: the surviving last line kept its break.
      final = newLines.length > 0;
    } else {
      final = !bslashAfter(h.body, lca);
    }
  }
  return { lines: newLines, br: f.br, final };
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    f = applyHunk(f, h, strict, path, d);
    d += n.length - o.length;
  }
  return joinFile(f);
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath ?? s.renameFrom ?? s.diffOld ?? null;
  const newP = s.newPath ?? s.renameTo ?? s.diffNew ?? null;
  // `/dev/null` means no file (SPEC.md section 6): it is a creation/deletion trigger, never a
  // real path, so it must not fall through to the move branch, where safe() would reject it.
  const isCreate = s.newFile || oldP === '/dev/null' || oldP === null;
  const isDelete = !isCreate && (s.delFile || newP === '/dev/null' || newP === null);
  if (isCreate) {
    const p = newP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      assertNoSymlink(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let finalBreak = true;
      for (const h of s.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.kind === 'add') {
            plus.push(b.text);
            finalBreak = !bslashAfter(h.body, j);
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : '');
      tree.now.set(p, text);
    };
  }
  if (isDelete) {
    const p = oldP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      assertNoSymlink(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    const o = oldP!;
    const n = newP!;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      assertNoSymlink(o);
      assertNoSymlink(n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const out = applyHunks(before, s.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(n, out);
      tree.moves.push([o, n]);
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    assertNoSymlink(p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  const newSection = (): Section => {
    const s: Section = {
      oldPath: null,
      newPath: null,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    hunk = null;
    return s;
  };
  const closeHunk = (): void => {
    if (hunk !== null) {
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      cur!.hunks.push(hunk);
      hunk = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        closeHunk();
        const dg = parseDiffGit(line);
        if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
        const s = newSection();
        s.diffOld = dg[0];
        s.diffNew = dg[1];
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
        const s = newSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'bslash';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1), raw: line });
        i++;
        continue;
      }
      closeHunk();
      continue; // Re-process this line outside the body.
    }
    const inHeader = cur !== null && cur.hunks.length === 0;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = dg[0];
      s.diffNew = dg[1];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader) {
        cur!.oldPath = headerPath(line);
        cur!.newPath = headerPath(lines[i + 1]!);
      } else {
        const s = newSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a, body: [] };
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur!.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur!.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ') || line.startsWith('new file mode\t')) {
        cur!.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ') || line.startsWith('deleted file mode\t')) {
        cur!.delFile = true;
        i++;
        continue;
      }
      i++;
      continue; // Any other header line is ignored.
    }
    i++; // Outside a section, or after its hunks: ignored (prose, code fences).
  }
  closeHunk();
  return sections.map((s) => sectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    assertNoSymlink(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.now.set(path, text);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const tier = firstTierWith(f.lines, oldLines, 0, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = findOccurrences(f.lines, oldLines, tier);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const at = occ[0]!;
    const newN = tier === 2 ? reindentLines(newLines, oldLines[0]!, f.lines[at]!) : newLines;
    const out = [...f.lines.slice(0, at), ...newN, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines: out, br: f.br, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    // The path is the nearest line before the SEARCH line, and after the previous block's
    // REPLACE line (or the start of the patch), that is not blank and does not start with
    // three backticks once its surrounding whitespace is removed.
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(sIdx + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function isV4aSectionStart(t: string): boolean {
  return t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ');
}

function v4aAddEdit(path: string, secLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    assertNoSymlink(path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const text = secLines.length === 0 ? '' : secLines.join('\n') + '\n';
    tree.now.set(path, text);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    assertNoSymlink(path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `from` equal to the anchor at the first tier where one is, or -1. */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = Math.max(0, from); k < fileLines.length; k++) {
      if (lineEq(fileLines[k]!, anchor, t)) return k;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    assertNoSymlink(path);
    if (moveTo !== null) assertNoSymlink(moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const aIdx = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (aIdx < 0) throw new Fail('no-match', path);
        cursor = aIdx + 1;
      }
      const { o } = hunkON({ a: 0, body: ch.body });
      if (o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const n = ch.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const out = [...f.lines.slice(0, pos), ...n, ...f.lines.slice(pos)];
        f = { lines: out, br: f.br, final: f.final };
        cursor = pos + n.length;
        continue;
      }
      const tier = firstTierWith(f.lines, o, cursor, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occ = findOccurrences(f.lines, o, tier, cursor);
      let at: number;
      if (ch.eof) {
        const ends = occ.filter((p) => p + o.length === f.lines.length);
        if (ends.length === 0) throw new Fail('no-match', path);
        at = ends[0]!;
      } else {
        at = occ[0]!;
      }
      const newN = buildNew(ch.body, f.lines, at, tier, o);
      const out = [...f.lines.slice(0, at), ...newN, ...f.lines.slice(at + o.length)];
      f = { lines: out, br: f.br, final: f.final };
      cursor = at + newN.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const t = line.trim();
    if (t.startsWith('*** Add File: ')) {
      const path = t.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      i++;
      while (i < last) {
        const l2 = lines[i]!;
        const t2 = l2.trim();
        if (isV4aSectionStart(t2) || t2 === '*** End Patch') break;
        if (l2.startsWith('+')) secLines.push(l2.slice(1));
        else if (l2 === '') secLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      // Blank lines at the end of a section are not part of it.
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(v4aAddEdit(path, secLines));
      continue;
    }
    if (t.startsWith('*** Delete File: ')) {
      const path = t.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l2 = lines[i]!;
        const t2 = l2.trim();
        if (isV4aSectionStart(t2) || t2 === '*** End Patch') break;
        if (blank(l2)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (t.startsWith('*** Update File: ')) {
      const path = t.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && lines[i]!.trim().startsWith('*** Move to: ')) {
        moveTo = lines[i]!.trim().slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let open: V4aChunk | null = null;
      let state: 'before' | 'in' | 'between' = 'before';
      const closeChunk = (eof: boolean): void => {
        if (open !== null) {
          open.eof = eof;
          chunks.push(open);
          open = null;
        }
      };
      let done = false;
      while (!done && i < last) {
        const l2 = lines[i]!;
        const t2 = l2.trim();
        if (state === 'before') {
          if (blank(l2)) {
            i++;
            continue;
          }
          if (t2.startsWith('@@')) {
            open = { anchor: t2.slice(2).trim(), body: [], eof: false };
            state = 'in';
            i++;
            continue;
          }
          if (t2 === '*** End of File') throw new Exit2(`error: parse ${i + 1}`);
          if (isV4aSectionStart(t2) || t2 === '*** End Patch') {
            done = true;
            continue;
          }
          if (l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+') || l2 === '') {
            open = { anchor: null, body: [], eof: false };
            state = 'in';
            continue; // Re-process this line as a body line.
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (state === 'in') {
          if (l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+') || l2 === '') {
            const kind = l2 === '' || l2.startsWith(' ') ? 'ctx' : l2.startsWith('-') ? 'del' : 'add';
            open!.body.push({ kind, text: l2 === '' ? '' : l2.slice(1), raw: l2 });
            i++;
            continue;
          }
          if (t2.startsWith('@@')) {
            closeChunk(false);
            open = { anchor: t2.slice(2).trim(), body: [], eof: false };
            i++;
            continue;
          }
          if (t2 === '*** End of File') {
            closeChunk(true);
            state = 'between';
            i++;
            continue;
          }
          if (isV4aSectionStart(t2) || t2 === '*** End Patch') {
            closeChunk(false);
            done = true;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        // Between chunks, after an end-of-file chunk: only a new `@@` chunk may follow.
        if (blank(l2)) {
          i++;
          continue;
        }
        if (t2.startsWith('@@')) {
          open = { anchor: t2.slice(2).trim(), body: [], eof: false };
          state = 'in';
          i++;
          continue;
        }
        if (isV4aSectionStart(t2) || t2 === '*** End Patch') {
          done = true;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (open !== null) closeChunk(false);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      // Blank lines at the end of a section are not part of it. An end-of-file chunk keeps its
      // trailing blank context lines: they are what its O ends on at the file's last line.
      if (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        if (!lastCh.eof) {
          while (lastCh.body.length > 0) {
            const b = lastCh.body[lastCh.body.length - 1]!;
            if (b.kind === 'ctx' && b.text === '') lastCh.body.pop();
            else break;
          }
        }
      }
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 1 and 2: the command line, the output and the exit codes    */
/* ------------------------------------------------------------------ */

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths (UTF-8). A move prints
  // `R <old> -> <new>` in place of that pair's `D` and `A` lines and sorts by `<new>`.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    const wasOld = tree.original(o);
    const nowOld = tree.get(o);
    const wasNew = tree.original(n);
    const nowNew = tree.get(n);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    // Last guard before any byte is written: re-check every changed path with lstat, so a
    // symlink the edits somehow missed can never be written through or removed. Nothing has
    // been written yet at this point, so refusing here still writes nothing.
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      try {
        assertNoSymlink(p);
      } catch (e) {
        if (e instanceof Fail) return { code: 1, out: [`error: ${e.code} ${e.path}`, `failed: 1 of ${edits.length} edits`] };
        throw e;
      }
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
