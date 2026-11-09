/** Tests for lib/pdf/tools/compare.ts */
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { assert, near, pdfjsItems, rng } from './helpers.mjs';

const W = (text, i = 0) => ({ text, page: 0, x: i, y: 0, w: 1, h: 1 });
const words = (s) => s.split(/\s+/).filter(Boolean).map(W);

/** Brute-force LCS length (O(nm) DP). */
function lcs(a, b) {
  const m = b.length;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/**
 * Validate that `changes` is a correct diff of A→B (under `eq`), with changes
 * separated by non-empty equal runs. Returns the number of matched words.
 */
function validate(A, B, res, eq = (x, y) => x.text === y.text) {
  const ia = new Map(A.map((w, i) => [w, i]));
  const ib = new Map(B.map((w, i) => [w, i]));
  let i = 0, j = 0, matched = 0;
  res.changes.forEach((c, ci) => {
    assert(c.a.length || c.b.length, 'empty change');
    assert(c.kind === (c.a.length && c.b.length ? 'replace' : c.a.length ? 'delete' : 'insert'), `kind ${c.kind}`);
    let a0 = c.a.length ? ia.get(c.a[0]) : undefined;
    let b0 = c.b.length ? ib.get(c.b[0]) : undefined;
    const eqLen = a0 !== undefined ? a0 - i : b0 - j;
    if (a0 === undefined) a0 = i + eqLen;
    if (b0 === undefined) b0 = j + eqLen;
    assert(a0 - i === b0 - j && eqLen >= 0, `misaligned change ${ci}: ${a0 - i} vs ${b0 - j}`);
    if (ci > 0) assert(eqLen > 0, `adjacent changes not merged at ${ci}`);
    for (let k = 0; k < eqLen; k++) assert(eq(A[i + k], B[j + k]), `equal run mismatch at A${i + k}/B${j + k}: ${A[i + k].text} vs ${B[j + k].text}`);
    c.a.forEach((w, k) => assert(A[a0 + k] === w, 'non-contiguous a words'));
    c.b.forEach((w, k) => assert(B[b0 + k] === w, 'non-contiguous b words'));
    matched += eqLen;
    i = a0 + c.a.length;
    j = b0 + c.b.length;
  });
  assert(A.length - i === B.length - j, `tail length mismatch ${A.length - i} vs ${B.length - j}`);
  for (let k = 0; i + k < A.length; k++) assert(eq(A[i + k], B[j + k]), 'tail mismatch');
  matched += A.length - i;
  return matched;
}

function zipfVocab(r, size) {
  const vocab = Array.from({ length: size }, (_, i) => `w${i}`);
  return () => vocab[Math.min(size - 1, Math.floor(Math.pow(r(), 2.2) * size))];
}

function applyEdits(r, A, count, nextWord) {
  const B = A.map((w) => W(w.text));
  let untouched = new Uint8Array(A.length).fill(1);
  // Edits on random positions of A; build B from scratch to track untouched A words.
  const ops = [];
  for (let e = 0; e < count; e++) ops.push({ pos: Math.floor(r() * A.length), kind: Math.floor(r() * 3), len: 1 + Math.floor(r() * 4) });
  ops.sort((x, y) => x.pos - y.pos);
  const out = [];
  let p = 0;
  for (const op of ops) {
    if (op.pos < p) continue;
    while (p < op.pos) out.push(W(A[p++].text));
    if (op.kind === 0) for (let k = 0; k < op.len; k++) out.push(W(nextWord())); // insert
    else if (op.kind === 1) for (let k = 0; k < op.len && p < A.length; k++) untouched[p++] = 0; // delete
    else {
      for (let k = 0; k < op.len && p < A.length; k++) {
        untouched[p++] = 0;
        out.push(W(nextWord() + 'x'));
      }
    }
  }
  while (p < A.length) out.push(W(A[p++].text));
  void B;
  return { B: out, untouched: untouched.reduce((s, v) => s + v, 0) };
}

export const tests = [
  {
    name: 'compare: random small inputs match brute-force LCS',
    run({ compare }) {
      const r = rng(42);
      let cases = 0;
      for (let t = 0; t < 3000; t++) {
        const alpha = 2 + Math.floor(r() * 5);
        const na = Math.floor(r() * 40), nb = Math.floor(r() * 40);
        const A = Array.from({ length: na }, () => W(String.fromCharCode(97 + Math.floor(r() * alpha))));
        const B = Array.from({ length: nb }, () => W(String.fromCharCode(97 + Math.floor(r() * alpha))));
        const res = compare.compareWords(A, B);
        const matched = validate(A, B, res);
        const best = lcs(A.map((w) => w.text), B.map((w) => w.text));
        assert(matched === best, `case ${t}: matched ${matched} != LCS ${best}`);
        const total = na + nb;
        near(res.stats.similarity, total ? (2 * best) / total : 1, 1e-9, 'similarity');
        assert(res.stats.wordsA === na && res.stats.wordsB === nb, 'word counts');
        cases++;
      }
      return [`${cases} random cases optimal and valid`];
    },
  },
  {
    name: 'compare: replace grouping, ignoreCase, ignorePunctuation',
    run({ compare }) {
      const A = words('The quick brown fox jumps over the lazy dog');
      const B = words('The quick red fox leaps high over the lazy dog today');
      const res = compare.compareWords(A, B);
      validate(A, B, res);
      const sum = res.changes.map((c) => `${c.kind}:${c.a.map((w) => w.text).join(' ')}>${c.b.map((w) => w.text).join(' ')}`);
      assert(JSON.stringify(sum) === JSON.stringify(['replace:brown>red', 'replace:jumps>leaps high', 'insert:>today']), sum.join(' | '));
      assert(res.stats.replaced === 2 && res.stats.inserted === 1 && res.stats.deleted === 0, JSON.stringify(res.stats));
      assert(res.stats.insertedWords === 4 && res.stats.deletedWords === 2, 'word stats');

      const del = compare.compareWords(words('a b c d e'), words('a b e'));
      assert(del.changes.length === 1 && del.changes[0].kind === 'delete' && del.changes[0].a.map((w) => w.text).join(' ') === 'c d', 'delete');

      assert(compare.compareWords(words('Hello World'), words('hello world')).changes.length === 1, 'case-sensitive by default');
      assert(compare.compareWords(words('Hello World'), words('hello world'), { ignoreCase: true }).changes.length === 0, 'ignoreCase');
      const p1 = words('Hello, world! — said “Bob”.');
      const p2 = words('Hello world said Bob');
      assert(compare.compareWords(p1, p2).changes.length > 0, 'punctuation matters by default');
      const pr = compare.compareWords(p1, p2, { ignorePunctuation: true });
      assert(pr.changes.length === 0, `ignorePunctuation: ${JSON.stringify(pr.changes)}`);
      assert(pr.stats.similarity === 1, 'similarity 1');
      // Ignored words inside a change are carried along (for highlighting continuity).
      const q = compare.compareWords(words('x alpha — beta y'), words('x gamma y'), { ignorePunctuation: true });
      assert(q.changes.length === 1 && q.changes[0].a.map((w) => w.text).join(' ') === 'alpha — beta', JSON.stringify(q.changes[0].a));
      // Ligatures / NFKC.
      assert(compare.compareWords(words('ﬁnal'), words('final')).changes.length === 0, 'NFKC');
      // Empty inputs.
      const e = compare.compareWords([], []);
      assert(e.changes.length === 0 && e.stats.similarity === 1, 'empty');
      const e2 = compare.compareWords([], words('a b'));
      assert(e2.changes.length === 1 && e2.changes[0].kind === 'insert' && e2.stats.similarity === 0, 'insert all');
    },
  },
  {
    name: 'compare: medium documents with scattered edits (valid, near-optimal)',
    run({ compare }) {
      const notes = [];
      for (const [n, edits, vocab, seed] of [
        [3000, 30, 800, 1],
        [20000, 200, 5000, 2],
        [20000, 2000, 300, 3],
      ]) {
        const r = rng(seed);
        const next = zipfVocab(r, vocab);
        const A = Array.from({ length: n }, () => W(next()));
        const { B, untouched } = applyEdits(r, A, edits, next);
        const t0 = Date.now();
        const res = compare.compareWords(A, B);
        const ms = Date.now() - t0;
        const matched = validate(A, B, res);
        assert(matched >= untouched, `n=${n}: matched ${matched} < untouched ${untouched}`);
        notes.push(`n=${n} edits=${edits}: ${res.changes.length} changes, matched ${matched} (≥ ${untouched} untouched), ${ms} ms`);
      }
      return notes;
    },
  },
  {
    name: 'compare: 60k-word performance (< 2 s each)',
    run({ compare }) {
      const notes = [];
      const slow = [];
      const n = 60000;
      const r = rng(9);
      const next = zipfVocab(r, 20000);
      const A = Array.from({ length: n }, () => W(next()));
      const scenarios = {
        'few edits (1%)': () => applyEdits(r, A, 600, next).B,
        'heavy edits (10%)': () => applyEdits(r, A, 6000, next).B,
        'paragraphs reordered': () => {
          const paras = [];
          for (let i = 0; i < n; i += 120) paras.push(A.slice(i, i + 120));
          for (let i = paras.length - 1; i > 0; i--) {
            const k = Math.floor(r() * (i + 1));
            [paras[i], paras[k]] = [paras[k], paras[i]];
          }
          return paras.flat().map((w) => W(w.text));
        },
        'unrelated document': () => Array.from({ length: n }, () => W('z' + next())),
        'same vocabulary, random order': () => Array.from({ length: n }, () => W(next())),
        'tiny vocabulary (pathological)': () => null,
      };
      for (const [label, make] of Object.entries(scenarios)) {
        let a = A;
        let b = make();
        if (!b) {
          a = Array.from({ length: n }, () => W('t' + Math.floor(r() * 4)));
          b = Array.from({ length: n }, () => W('t' + Math.floor(r() * 4)));
        }
        const t0 = performance.now();
        const res = compare.compareWords(a, b);
        const ms = performance.now() - t0;
        validate(a, b, res);
        if (ms >= 2000) slow.push(`${label}: ${ms.toFixed(0)} ms`);
        notes.push(`${label}: ${ms.toFixed(0)} ms, ${res.changes.length} changes, similarity ${res.stats.similarity.toFixed(3)}`);
      }
      assert(!slow.length, `too slow: ${slow.join('; ')}\n${notes.join('\n')}`);
      return notes;
    },
  },
  {
    name: 'compare: wordsFromTextItems splits/joins items and computes rects',
    run({ compare }) {
      const view = [0, 0, 612, 792];
      const items = [
        { str: 'Hel', transform: [10, 0, 0, 10, 100, 700], width: 15, height: 10 },
        { str: 'lo world', transform: [10, 0, 0, 10, 115, 700], width: 40, height: 10 },
        { str: '', transform: [10, 0, 0, 10, 155, 700], width: 0, height: 10 },
        { str: 'next line', transform: [10, 0, 0, 10, 100, 680], width: 45, height: 10 },
        { str: 'up', transform: [0, 10, -10, 0, 300, 300], width: 12, height: 10 },
      ];
      const w = compare.wordsFromTextItems(items, view, 3);
      assert(JSON.stringify(w.map((x) => x.text)) === JSON.stringify(['Hello', 'world', 'next', 'line', 'up']), JSON.stringify(w.map((x) => x.text)));
      assert(w.every((x) => x.page === 3), 'page');
      const hello = w[0];
      near(hello.x, 100, 0.5, 'Hello x');
      near(hello.y, 792 - 708, 1, 'Hello top');
      near(hello.h, 10, 0.5, 'Hello h');
      assert(hello.w > 20 && hello.w < 30, `Hello w ${hello.w}`);
      const up = w[4];
      assert(up.h > up.w, 'rotated word is tall');
      near(up.x, 300 - 8, 0.5, 'rotated x');
      // Non-zero view origin.
      const w2 = compare.wordsFromTextItems([{ str: 'a', transform: [10, 0, 0, 10, 110, 120], width: 5, height: 10 }], [10, 20, 210, 220], 0);
      near(w2[0].x, 100, 0.01, 'offset x');
      near(w2[0].y, 220 - 128, 0.01, 'offset y');
    },
  },
  {
    name: 'compare: two PDFs differing in a few words',
    async run({ compare }) {
      const base = [
        'Annual report of the regional water authority for the year two thousand twenty five.',
        'The board approved the budget of four million dollars after a long debate.',
        'Maintenance of the northern pipeline will begin in March and end in June.',
        'Customers in the eastern district reported fewer outages than last year.',
        'The authority hired twelve new engineers to support the expansion program.',
        'Water quality tests met all federal standards during every quarter.',
      ];
      const changed = [
        base[0],
        'The board approved the budget of five million dollars after a short debate.',
        'Maintenance of the northern pipeline will begin in April and end in June.',
        'Customers in the eastern district reported fewer outages than last year.',
        'The authority hired twelve engineers to support the expansion program.',
        'Water quality tests met all federal and state standards during every quarter.',
      ];
      const make = async (lines) => {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (let p = 0; p < 2; p++) {
          const page = doc.addPage([612, 792]);
          lines.forEach((l, i) => page.drawText(`${p + 1}. ${l}`, { x: 50, y: 740 - i * 20, size: 11, font }));
        }
        return { bytes: await doc.save(), font };
      };
      const A = await make(base);
      const B = await make(changed);
      const toWords = async (bytes) => {
        const pages = await pdfjsItems(bytes);
        return pages.flatMap((p, i) => compare.wordsFromTextItems(p.items, p.view, i));
      };
      const wa = await toWords(A.bytes);
      const wb = await toWords(B.bytes);
      const res = compare.compareWords(wa, wb);
      validate(wa, wb, res);
      const sum = res.changes.map((c) => `${c.kind}:${c.a.map((w) => w.text).join(' ')}>${c.b.map((w) => w.text).join(' ')}`);
      const perPage = ['replace:four>five', 'replace:long>short', 'replace:March>April', 'delete:new>', 'insert:>and state'];
      const expected = [...perPage, ...perPage];
      assert(JSON.stringify(sum) === JSON.stringify(expected), sum.join(' | '));
      assert(res.changes[5].a[0].page === 1, 'second page changes on page index 1');
      // Rect of "March" on page 1 (line 3).
      const march = res.changes[2].a[0];
      const prefix = '1. Maintenance of the northern pipeline will begin in ';
      near(march.x, 50 + A.font.widthOfTextAtSize(prefix, 11), 2.5, 'March x');
      near(march.w, A.font.widthOfTextAtSize('March', 11), 4, 'March width');
      const baseline = 740 - 2 * 20;
      near(march.y, 792 - (baseline + 0.8 * 11), 1.5, 'March top');
      return [`${res.changes.length} changes; similarity ${res.stats.similarity.toFixed(3)}`];
    },
  },
];
