/**
 * "Compare files": word-level diff of two documents.
 *
 * Words are mapped to integer ids and diffed with Myers' O(ND) algorithm in its
 * linear-space (middle snake / bisection) form, after trimming the common
 * prefix and suffix. Large differing regions are first split with patience
 * anchors (words occurring exactly once on each side), so big documents with
 * scattered edits stay fast; a global work budget guarantees termination time
 * on pathological inputs (the remainder then degrades to coarse replacements,
 * which are still a valid diff). Memory is O(N + M).
 *
 * Pure TypeScript, no DOM.
 */

export interface CmpWord {
  text: string;
  page: number;
  /** Page-space rect, top-left origin, pt. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CmpChange {
  kind: 'insert' | 'delete' | 'replace';
  /** Words of document A involved (deleted / replaced), in order. */
  a: CmpWord[];
  /** Words of document B involved (inserted / replacing), in order. */
  b: CmpWord[];
}

export interface CmpResult {
  changes: CmpChange[];
  stats: {
    /** Number of insert changes. */
    inserted: number;
    /** Number of delete changes. */
    deleted: number;
    /** Number of replace changes. */
    replaced: number;
    wordsA: number;
    wordsB: number;
    /** 2 × matched words / (compared words A + compared words B); 1 when both are empty. */
    similarity: number;
    /** Words of B that are new (inserted or part of a replacement). */
    insertedWords: number;
    /** Words of A that are gone (deleted or part of a replacement). */
    deletedWords: number;
  };
}

export interface CompareOptions {
  ignoreCase?: boolean;
  /** Ignore Unicode punctuation inside words; punctuation-only words are skipped entirely. */
  ignorePunctuation?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function compareWords(a: CmpWord[], b: CmpWord[], opts: CompareOptions = {}): CmpResult {
  const norm = (s: string) => normalizeToken(s, opts);

  // Tokens -> ids; words that normalize to '' are not compared.
  const vocab = new Map<string, number>();
  const encode = (words: CmpWord[]) => {
    const ids: number[] = [];
    const orig: number[] = [];
    for (let i = 0; i < words.length; i++) {
      const t = norm(words[i]?.text ?? '');
      if (!t) continue;
      let id = vocab.get(t);
      if (id === undefined) {
        id = vocab.size;
        vocab.set(t, id);
      }
      ids.push(id);
      orig.push(i);
    }
    return { ids: Int32Array.from(ids), orig };
  };
  const ea = encode(a);
  const eb = encode(b);

  const script = diffSequences(ea.ids, eb.ids, vocab.size);

  // Group consecutive non-equal ops into changes.
  const changes: CmpChange[] = [];
  let equal = 0;
  let pendA: [number, number] | null = null; // compared-index range [lo, hi)
  let pendB: [number, number] | null = null;
  const flush = () => {
    if (!pendA && !pendB) return;
    const wa = pendA ? sliceOrig(a, ea.orig, pendA[0], pendA[1]) : [];
    const wb = pendB ? sliceOrig(b, eb.orig, pendB[0], pendB[1]) : [];
    const kind: CmpChange['kind'] = wa.length && wb.length ? 'replace' : wa.length ? 'delete' : 'insert';
    changes.push({ kind, a: wa, b: wb });
    pendA = pendB = null;
  };
  for (let i = 0; i < script.kinds.length; i++) {
    const k = script.kinds[i];
    const n = script.lens[i];
    if (k === EQ) {
      flush();
      equal += n;
    } else if (k === DEL) {
      const s = script.aPos[i];
      pendA = pendA ? [pendA[0], s + n] : [s, s + n];
    } else {
      const s = script.bPos[i];
      pendB = pendB ? [pendB[0], s + n] : [s, s + n];
    }
  }
  flush();

  let inserted = 0, deleted = 0, replaced = 0, insertedWords = 0, deletedWords = 0;
  for (const c of changes) {
    if (c.kind === 'insert') inserted++;
    else if (c.kind === 'delete') deleted++;
    else replaced++;
    insertedWords += c.b.length;
    deletedWords += c.a.length;
  }
  const total = ea.ids.length + eb.ids.length;
  return {
    changes,
    stats: {
      inserted,
      deleted,
      replaced,
      wordsA: a.length,
      wordsB: b.length,
      similarity: total === 0 ? 1 : (2 * equal) / total,
      insertedWords,
      deletedWords,
    },
  };
}

/**
 * Split pdf.js text items into words with per-word rects.
 * `item.transform` = [a,b,c,d,e,f] in PDF user space (text matrix × CTM incl. font
 * size); `width` is the item's advance in user space; `view` = page.view
 * [x1,y1,x2,y2]. Rects are returned in page space with a top-left origin
 * (y grows downwards), unrotated. Glyph positions inside an item are estimated
 * from generic proportional character widths (pdf.js does not expose per-glyph
 * positions), which is accurate to a fraction of a character for typical text.
 * Words split across consecutive items (style changes, kerning splits) are
 * joined when the items touch on the same line.
 */
export function wordsFromTextItems(
  items: { str: string; transform: number[]; width: number; height: number }[],
  view: number[],
  page: number,
): CmpWord[] {
  const out: CmpWord[] = [];
  const vx = view?.[0] ?? 0;
  const vTop = view?.[3] ?? 0;

  interface Pending {
    text: string;
    x0: number; y0: number; x1: number; y1: number; // user-space bbox
    // end of the word along the text direction (for adjacency checks)
    endX: number; endY: number;
    dirX: number; dirY: number;
    size: number;
  }
  let cur: Pending | null = null;
  const emit = () => {
    if (cur && cur.text) {
      out.push({
        text: cur.text,
        page,
        x: cur.x0 - vx,
        y: vTop - cur.y1,
        w: Math.max(0, cur.x1 - cur.x0),
        h: Math.max(0, cur.y1 - cur.y0),
      });
    }
    cur = null;
  };

  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    const t = it.transform;
    if (!t || t.length < 6 || !t.every((v) => Number.isFinite(v))) continue;
    const str = it.str;
    const [a, b, c, d, e, f] = t;
    const dirLen = Math.hypot(a, b) || 1;
    const ux = a / dirLen, uy = b / dirLen; // text direction (unit)
    // "Up" direction of the glyphs; fall back to perpendicular of the baseline.
    let vxu = c, vyu = d;
    const upLen = Math.hypot(c, d);
    if (upLen > 1e-9) {
      vxu /= upLen;
      vyu /= upLen;
    } else {
      vxu = -uy;
      vyu = ux;
    }
    const size = it.height > 0 ? it.height : upLen || dirLen;
    const asc = 0.8 * size;
    const desc = 0.2 * size;

    // Continue a word across items only when they touch on the same line.
    if (cur) {
      const p: Pending = cur;
      const dx = e - p.endX, dy = f - p.endY;
      const along = dx * p.dirX + dy * p.dirY;
      const across = -dx * p.dirY + dy * p.dirX;
      const startsWithSpace = /^\s/u.test(str);
      const sameLine = Math.abs(across) < 0.3 * Math.max(size, p.size);
      const touching = along > -0.5 * size && along < 0.12 * Math.max(size, p.size);
      if (!sameLine || !touching || startsWithSpace || str === '') emit();
    }

    if (!str) continue;
    const chars = Array.from(str);
    const widths = chars.map(charWidthEstimate);
    const totalEst = widths.reduce((s, w) => s + w, 0) || 1;
    const scale = (it.width > 0 ? it.width : totalEst * size) / totalEst;

    let pos = 0; // advance along baseline (user space)
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const adv = widths[i] * scale;
      if (/\s/u.test(ch)) {
        emit();
        pos += adv;
        continue;
      }
      const sx = e + ux * pos, sy = f + uy * pos;
      const ex = e + ux * (pos + adv), ey = f + uy * (pos + adv);
      // Corners of the glyph box.
      const pts = [
        [sx - vxu * desc, sy - vyu * desc],
        [sx + vxu * asc, sy + vyu * asc],
        [ex - vxu * desc, ey - vyu * desc],
        [ex + vxu * asc, ey + vyu * asc],
      ];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [px, py] of pts) {
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      if (!cur) {
        cur = { text: ch, x0, y0, x1, y1, endX: ex, endY: ey, dirX: ux, dirY: uy, size };
      } else {
        const p: Pending = cur;
        p.text += ch;
        p.x0 = Math.min(p.x0, x0);
        p.y0 = Math.min(p.y0, y0);
        p.x1 = Math.max(p.x1, x1);
        p.y1 = Math.max(p.y1, y1);
        p.endX = ex;
        p.endY = ey;
        p.size = Math.max(p.size, size);
      }
      pos += adv;
    }
    if (cur) {
      // The item's advance may include trailing spacing not covered by glyph estimates.
      const p: Pending = cur;
      p.endX = e + ux * pos;
      p.endY = f + uy * pos;
    }
  }
  emit();
  return out;
}

// ---------------------------------------------------------------------------
// Normalization / helpers
// ---------------------------------------------------------------------------

const PUNCT_RE = /\p{P}+/gu;

function normalizeToken(s: string, opts: CompareOptions): string {
  let t = s.normalize('NFKC').replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '').trim();
  if (opts.ignoreCase) t = t.toLowerCase();
  if (opts.ignorePunctuation) t = t.replace(PUNCT_RE, '');
  return t;
}

/** Original words for compared indices [lo, hi), including skipped (ignored) words in between. */
function sliceOrig(words: CmpWord[], orig: number[], lo: number, hi: number): CmpWord[] {
  if (hi <= lo) return [];
  return words.slice(orig[lo], orig[hi - 1] + 1);
}

/** Rough relative advance widths (em) for Latin text; others default to 0.55. */
function charWidthEstimate(ch: string): number {
  if (/\s/u.test(ch)) return 0.28;
  if ('il.,;:!|\'`'.includes(ch)) return 0.25;
  if ('fjrtI()[]{}"/\\'.includes(ch)) return 0.34;
  if ('mwMW@'.includes(ch)) return 0.85;
  if (/[0-9]/.test(ch)) return 0.55;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[a-z]/.test(ch)) return 0.52;
  const cp = ch.codePointAt(0) ?? 0;
  // CJK / full-width forms are ~1 em.
  if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xff00 && cp <= 0xffef)) return 1;
  return 0.55;
}

// ---------------------------------------------------------------------------
// Diff core
// ---------------------------------------------------------------------------

const EQ = 0, DEL = 1, INS = 2;

/** Edit script: runs of (kind, aPos, bPos, len). DEL runs use aPos, INS runs use bPos. */
export interface EditScript {
  kinds: number[];
  aPos: number[];
  bPos: number[];
  lens: number[];
}

class ScriptBuilder implements EditScript {
  kinds: number[] = [];
  aPos: number[] = [];
  bPos: number[] = [];
  lens: number[] = [];
  private push(kind: number, a: number, b: number, n: number) {
    if (n <= 0) return;
    const last = this.kinds.length - 1;
    if (last >= 0 && this.kinds[last] === kind) {
      this.lens[last] += n;
      return;
    }
    this.kinds.push(kind);
    this.aPos.push(a);
    this.bPos.push(b);
    this.lens.push(n);
  }
  equal(a: number, b: number, n: number) {
    this.push(EQ, a, b, n);
  }
  del(a: number, n: number) {
    this.push(DEL, a, -1, n);
  }
  ins(b: number, n: number) {
    this.push(INS, -1, b, n);
  }
}

/** Regions with N+M up to this size are diffed with exact (uncapped) Myers. */
const EXACT_LIMIT = 4096;
/** Work units allowed for one capped bisection of a large region. */
const BISECT_BUDGET = 1e7;
/** Global work budget; beyond it remaining regions become coarse replacements. */
const GLOBAL_BUDGET = 6e7;

interface DiffCtx {
  A: Int32Array;
  B: Int32Array;
  out: ScriptBuilder;
  work: number;
  // patience scratch (indexed by token id, lazily reset via stamps)
  stamp: Int32Array;
  gen: number;
  cntA: Int32Array;
  cntB: Int32Array;
  posA: Int32Array;
  posB: Int32Array;
}

/**
 * Diff two integer sequences. Returns a run-length edit script covering both
 * sequences in order. `vocabSize` = 1 + max token id.
 */
export function diffSequences(A: Int32Array, B: Int32Array, vocabSize?: number): EditScript {
  let vs = vocabSize ?? 0;
  if (vocabSize === undefined) {
    for (let i = 0; i < A.length; i++) if (A[i] >= vs) vs = A[i] + 1;
    for (let i = 0; i < B.length; i++) if (B[i] >= vs) vs = B[i] + 1;
  }
  const ctx: DiffCtx = {
    A,
    B,
    out: new ScriptBuilder(),
    work: 0,
    stamp: new Int32Array(vs),
    gen: 0,
    cntA: new Int32Array(vs),
    cntB: new Int32Array(vs),
    posA: new Int32Array(vs),
    posB: new Int32Array(vs),
  };
  diffRegion(ctx, 0, A.length, 0, B.length);
  return ctx.out;
}

function diffRegion(ctx: DiffCtx, aLo: number, aHi: number, bLo: number, bHi: number): void {
  const { A, B, out } = ctx;
  // Common prefix.
  let p = 0;
  while (aLo + p < aHi && bLo + p < bHi && A[aLo + p] === B[bLo + p]) p++;
  if (p) {
    out.equal(aLo, bLo, p);
    aLo += p;
    bLo += p;
  }
  // Common suffix (emitted last).
  let s = 0;
  while (aHi - s > aLo && bHi - s > bLo && A[aHi - 1 - s] === B[bHi - 1 - s]) s++;
  aHi -= s;
  bHi -= s;
  ctx.work += p + s + 1;

  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0) out.ins(bLo, m);
  else if (m === 0) out.del(aLo, n);
  else if (ctx.work > GLOBAL_BUDGET) {
    out.del(aLo, n);
    out.ins(bLo, m);
  } else if (n + m <= EXACT_LIMIT || !patience(ctx, aLo, aHi, bLo, bHi)) {
    bisect(ctx, aLo, aHi, bLo, bHi);
  }
  if (s) out.equal(aHi, bHi, s);
}

/**
 * Patience anchoring: tokens that occur exactly once in both regions, kept in
 * increasing order on both sides (longest increasing subsequence). Returns
 * false when no anchor exists (and the regions do share some token).
 */
function patience(ctx: DiffCtx, aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  const { A, B, stamp, cntA, cntB, posA, posB } = ctx;
  const gen = ++ctx.gen;
  for (let i = aLo; i < aHi; i++) {
    const t = A[i];
    if (stamp[t] !== gen) {
      stamp[t] = gen;
      cntA[t] = 0;
      cntB[t] = 0;
    }
    cntA[t]++;
    posA[t] = i;
  }
  for (let j = bLo; j < bHi; j++) {
    const t = B[j];
    if (stamp[t] !== gen) {
      stamp[t] = gen;
      cntA[t] = 0;
      cntB[t] = 0;
    }
    cntB[t]++;
    posB[t] = j;
  }
  ctx.work += aHi - aLo + bHi - bLo;

  // Candidate pairs in A order.
  const ca: number[] = [];
  const cb: number[] = [];
  for (let i = aLo; i < aHi; i++) {
    const t = A[i];
    if (cntA[t] === 1 && cntB[t] === 1) {
      ca.push(i);
      cb.push(posB[t]);
    }
  }
  if (!ca.length) {
    // No anchor. If the regions share no token at all, it is a plain replacement.
    for (let i = aLo; i < aHi; i++) if (cntB[A[i]] > 0) return false;
    ctx.out.del(aLo, aHi - aLo);
    ctx.out.ins(bLo, bHi - bLo);
    return true;
  }

  // LIS on cb (patience sorting with predecessor links).
  const k = ca.length;
  const tails: number[] = []; // index into candidates
  const prev = new Int32Array(k).fill(-1);
  for (let i = 0; i < k; i++) {
    const v = cb[i];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cb[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const chain: number[] = [];
  for (let i = tails[tails.length - 1]; i >= 0; i = prev[i]) chain.push(i);
  chain.reverse();
  ctx.work += k * 4;

  let pa = aLo, pb = bLo;
  for (const ci of chain) {
    const ai = ca[ci], bj = cb[ci];
    diffRegion(ctx, pa, ai, pb, bj);
    ctx.out.equal(ai, bj, 1);
    pa = ai + 1;
    pb = bj + 1;
  }
  diffRegion(ctx, pa, aHi, pb, bHi);
  return true;
}

/**
 * Myers' bisection (middle snake) in linear space, after the formulation used
 * by diff-match-patch. Regions larger than EXACT_LIMIT get a work cap; when it
 * is hit, the region is split at the furthest-reaching forward point found so
 * far (a valid, possibly non-minimal split) or, failing that, replaced wholesale.
 */
function bisect(ctx: DiffCtx, aLo: number, aHi: number, bLo: number, bHi: number): void {
  const { A, B } = ctx;
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const vOffset = maxD;
  const vLength = 2 * maxD + 2;
  const v1 = new Int32Array(vLength).fill(-1);
  const v2 = new Int32Array(vLength).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = n - m;
  const front = (delta & 1) !== 0;
  let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
  const capped = n + m > EXACT_LIMIT;
  const budget = capped ? Math.min(BISECT_BUDGET, Math.max(0, GLOBAL_BUDGET - ctx.work)) : Infinity;
  let work = 0;
  let bestX = 0, bestY = 0;

  for (let d = 0; d < maxD; d++) {
    // Forward path.
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = vOffset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1])) x1 = v1[k1o + 1];
      else x1 = v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      const sx = x1;
      while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
        x1++;
        y1++;
      }
      work += x1 - sx + 1;
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else {
        if (x1 + y1 > bestX + bestY) {
          bestX = x1;
          bestY = y1;
        }
        if (front) {
          const k2o = vOffset + delta - k1;
          if (k2o >= 0 && k2o < vLength && v2[k2o] !== -1) {
            const x2 = n - v2[k2o];
            if (x1 >= x2) {
              ctx.work += work;
              split(ctx, aLo, aHi, bLo, bHi, x1, y1);
              return;
            }
          }
        }
      }
    }
    // Reverse path.
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = vOffset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1])) x2 = v2[k2o + 1];
      else x2 = v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      const sx = x2;
      while (x2 < n && y2 < m && A[aHi - x2 - 1] === B[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      work += x2 - sx + 1;
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = vOffset + delta - k2;
        if (k1o >= 0 && k1o < vLength && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = vOffset + x1 - k1o;
          if (x1 >= n - x2) {
            ctx.work += work;
            split(ctx, aLo, aHi, bLo, bHi, x1, y1);
            return;
          }
        }
      }
    }
    if (work > budget) {
      ctx.work += work;
      if (bestX + bestY > 0 && bestX + bestY < n + m && ctx.work < GLOBAL_BUDGET) {
        split(ctx, aLo, aHi, bLo, bHi, bestX, bestY);
      } else {
        ctx.out.del(aLo, n);
        ctx.out.ins(bLo, m);
      }
      return;
    }
  }
  // No common subsequence at all.
  ctx.work += work;
  ctx.out.del(aLo, n);
  ctx.out.ins(bLo, m);
}

function split(ctx: DiffCtx, aLo: number, aHi: number, bLo: number, bHi: number, x: number, y: number): void {
  if ((x <= 0 && y <= 0) || (aLo + x >= aHi && bLo + y >= bHi)) {
    // No progress possible (defensive; cannot happen for a proper middle snake).
    ctx.out.del(aLo, aHi - aLo);
    ctx.out.ins(bLo, bHi - bLo);
    return;
  }
  diffRegion(ctx, aLo, aLo + x, bLo, bLo + y);
  diffRegion(ctx, aLo + x, aHi, bLo + y, bHi);
}
