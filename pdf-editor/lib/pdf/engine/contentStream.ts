/**
 * PDF content-stream tokenizer / parser / serializer.
 *
 * The parser turns a decoded content stream into a flat list of operations
 * (operands + operator). Every parsed operation keeps a `raw` view of its exact
 * source bytes, so unchanged operations are re-emitted byte-for-byte by the
 * serializer; only operations created or modified by callers (which must not
 * carry `raw`) are re-serialized from their structured form.
 */
import {
  PDFRawStream,
  decodePDFRawStream,
  type PDFStream,
} from '@cantoo/pdf-lib';

// ---------------------------------------------------------------------------
// Object model
// ---------------------------------------------------------------------------

export interface CSNumber {
  type: 'number';
  value: number;
  /** Source text, used verbatim when serializing (keeps the original precision). */
  raw?: string;
}
export interface CSName {
  type: 'name';
  /** Decoded name (`#xx` escapes resolved), without the leading slash. */
  value: string;
  /** Name as written in the source (escapes kept), without the leading slash. */
  raw: string;
}
export interface CSString {
  type: 'string';
  bytes: Uint8Array;
  /** Written as `<hex>` (true) or `(literal)` (false). */
  hex: boolean;
}
export interface CSArray {
  type: 'array';
  items: CSObject[];
}
export interface CSDict {
  type: 'dict';
  entries: Array<[CSName, CSObject]>;
}
export interface CSBool {
  type: 'bool';
  value: boolean;
}
export interface CSNull {
  type: 'null';
}
export type CSObject = CSNumber | CSName | CSString | CSArray | CSDict | CSBool | CSNull;

export interface CSInlineImage {
  /** Image dictionary entries between BI and ID (abbreviated keys as written). */
  dict: CSDict;
  /** Raw image data between `ID<ws>` and `EI` (encoded). */
  data: Uint8Array;
}

export interface CSOperation {
  /** Operator, e.g. `Tj`, `cm`, `T*`. Inline images use `BI` (covering BI … ID … EI). */
  op: string;
  operands: CSObject[];
  inlineImage?: CSInlineImage;
  /**
   * Exact source bytes of the operation (operands + operator). When present the
   * serializer writes these verbatim. Drop it (create a new object) when modifying.
   */
  raw?: Uint8Array;
}

/** All operators defined by ISO 32000 for content streams. */
export const KNOWN_OPERATORS: ReadonlySet<string> = new Set([
  'b', 'B', 'b*', 'B*', 'BDC', 'BI', 'BMC', 'BT', 'BX', 'c', 'cm', 'CS', 'cs', 'd', 'd0', 'd1',
  'Do', 'DP', 'EI', 'EMC', 'ET', 'EX', 'f', 'F', 'f*', 'G', 'g', 'gs', 'h', 'i', 'ID', 'j', 'J',
  'K', 'k', 'l', 'm', 'M', 'MP', 'n', 'q', 'Q', 're', 'RG', 'rg', 'ri', 's', 'S', 'SC', 'sc',
  'SCN', 'scn', 'sh', 'T*', 'Tc', 'Td', 'TD', 'Tf', 'Tj', 'TJ', 'TL', 'Tm', 'Tr', 'Ts', 'Tw',
  'Tz', 'v', 'w', 'W', 'W*', 'y', "'", '"',
]);

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

const WHITESPACE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITESPACE[c] = 1;
const DELIMITER = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIMITER[c.charCodeAt(0)] = 1;

const isWhite = (c: number) => WHITESPACE[c] === 1;
const isRegular = (c: number) => WHITESPACE[c] === 0 && DELIMITER[c] === 0;

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  if (end - start <= 64) {
    // Fast path for tokens.
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  for (let i = start; i < end; i += 8192) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(end, i + 8192))),
    );
  }
  return s;
}

/** Decode `#xx` escapes of a PDF name. */
export function decodeNameEscapes(raw: string): string {
  if (raw.indexOf('#') < 0) return raw;
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

/** Encode a (decoded) name for output, escaping delimiters, whitespace, `#` and non-printables. */
export function encodeName(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i) & 0xff;
    if (c < 0x21 || c > 0x7e || c === 0x23 || DELIMITER[c]) {
      out += '#' + c.toString(16).padStart(2, '0');
    } else out += value[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

interface OpToken {
  type: 'op';
  value: string;
}
/** Stray closing delimiter or other junk byte; ignored by the parser. */
interface JunkToken {
  type: 'junk';
}
type Token = CSObject | OpToken | JunkToken;

const JUNK: JunkToken = { type: 'junk' };
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

class Lexer {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Skip whitespace and comments. */
  skipWhitespace(): void {
    const { buf } = this;
    const n = buf.length;
    while (this.pos < n) {
      const c = buf[this.pos];
      if (isWhite(c)) this.pos++;
      else if (c === 0x25 /* % */) {
        while (this.pos < n && buf[this.pos] !== 0x0a && buf[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  private readRegular(): string {
    const start = this.pos;
    const { buf } = this;
    while (this.pos < buf.length && isRegular(buf[this.pos])) this.pos++;
    return latin1(buf, start, this.pos);
  }

  /** Read one token/object. Caller must have skipped whitespace and checked EOF. */
  read(depth = 0): Token {
    const { buf } = this;
    const c = buf[this.pos];
    switch (c) {
      case 0x28: // (
        return this.readLiteralString();
      case 0x3c: // <
        if (buf[this.pos + 1] === 0x3c) return this.readDict(depth);
        return this.readHexString();
      case 0x3e: // >  (stray '>' or '>>')
        this.pos += buf[this.pos + 1] === 0x3e ? 2 : 1;
        return JUNK;
      case 0x5b: // [
        return this.readArray(depth);
      case 0x2f: {
        // /
        this.pos++;
        const raw = this.readRegular();
        return { type: 'name', raw, value: decodeNameEscapes(raw) };
      }
      case 0x5d: // ]
      case 0x29: // )
      case 0x7b: // {
      case 0x7d: // }
        this.pos++;
        return JUNK;
      default: {
        const text = this.readRegular();
        if (!text) {
          this.pos++;
          return JUNK;
        }
        const first = text.charCodeAt(0);
        if ((first >= 0x30 && first <= 0x39) || first === 0x2b || first === 0x2d || first === 0x2e) {
          if (NUMBER_RE.test(text)) return { type: 'number', value: parseFloat(text), raw: text };
          // Lenient forms seen in the wild: "--5", "5.-2", "1.2.3".
          const lenient = parseFloat(text.replace(/^[+-]+/, (m) => m[m.length - 1]));
          if (!Number.isNaN(lenient)) return { type: 'number', value: lenient };
        }
        if (text === 'true') return { type: 'bool', value: true };
        if (text === 'false') return { type: 'bool', value: false };
        if (text === 'null') return { type: 'null' };
        return { type: 'op', value: text };
      }
    }
  }

  private readLiteralString(): CSString {
    const { buf } = this;
    const n = buf.length;
    this.pos++; // (
    const out: number[] = [];
    let nesting = 1;
    while (this.pos < n) {
      let c = buf[this.pos++];
      if (c === 0x28) {
        nesting++;
        out.push(c);
      } else if (c === 0x29) {
        if (--nesting === 0) break;
        out.push(c);
      } else if (c === 0x5c) {
        if (this.pos >= n) break;
        c = buf[this.pos++];
        switch (c) {
          case 0x6e: out.push(0x0a); break; // \n
          case 0x72: out.push(0x0d); break; // \r
          case 0x74: out.push(0x09); break; // \t
          case 0x62: out.push(0x08); break; // \b
          case 0x66: out.push(0x0c); break; // \f
          case 0x0d: // line continuation (\CR or \CRLF)
            if (buf[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a: // line continuation (\LF)
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && this.pos < n; k++) {
                const d = buf[this.pos];
                if (d < 0x30 || d > 0x37) break;
                v = v * 8 + (d - 0x30);
                this.pos++;
              }
              out.push(v & 0xff);
            } else {
              // \\ \( \) and unknown escapes: the escaped char itself
              out.push(c);
            }
        }
      } else {
        out.push(c);
      }
    }
    return { type: 'string', bytes: Uint8Array.from(out), hex: false };
  }

  private readHexString(): CSString {
    const { buf } = this;
    const n = buf.length;
    this.pos++; // <
    const out: number[] = [];
    let hi = -1;
    while (this.pos < n) {
      const c = buf[this.pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue; // whitespace / junk
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return { type: 'string', bytes: Uint8Array.from(out), hex: true };
  }

  private readArray(depth: number): CSArray {
    this.pos++; // [
    const items: CSObject[] = [];
    while (true) {
      this.skipWhitespace();
      if (this.eof) break;
      if (this.buf[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      const start = this.pos;
      const t = depth > 64 ? (this.pos++, JUNK) : this.read(depth + 1);
      if (t.type === 'op') {
        // Operator inside an array: the array is unterminated. End it here and
        // let the parser see the operator.
        this.pos = start;
        break;
      }
      if (t.type !== 'junk') items.push(t);
    }
    return { type: 'array', items };
  }

  private readDict(depth: number): CSDict {
    this.pos += 2; // <<
    const entries: Array<[CSName, CSObject]> = [];
    let key: CSName | null = null;
    while (true) {
      this.skipWhitespace();
      if (this.eof) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const start = this.pos;
      const t = depth > 64 ? (this.pos++, JUNK) : this.read(depth + 1);
      if (t.type === 'op') {
        this.pos = start;
        break;
      }
      if (t.type === 'junk') continue;
      if (key === null) {
        if (t.type === 'name') key = t;
        // non-name where a key is expected: skip it
      } else {
        entries.push([key, t]);
        key = null;
      }
    }
    return { type: 'dict', entries };
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function dictGet(dict: CSDict, ...keys: string[]): CSObject | undefined {
  for (const [k, v] of dict.entries) if (keys.includes(k.value)) return v;
  return undefined;
}

function indexOfSeq(buf: Uint8Array, seq: number[], from: number): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let k = 0; k < seq.length; k++) if (buf[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Check that the bytes following a candidate `EI` look like content-stream
 * syntax (ASCII, followed by a known operator or EOF).
 */
function plausibleAfterEI(buf: Uint8Array, pos: number): boolean {
  const limit = Math.min(buf.length, pos + 24);
  for (let i = pos; i < limit; i++) {
    const c = buf[i];
    if (c !== 0x09 && c !== 0x0a && c !== 0x0d && (c < 0x20 || c > 0x7e)) return false;
  }
  const lx = new Lexer(buf.subarray(0, Math.min(buf.length, pos + 200)));
  lx.pos = pos;
  for (let n = 0; n < 12; n++) {
    lx.skipWhitespace();
    if (lx.eof) return true;
    const t = lx.read();
    if (t.type === 'op') return KNOWN_OPERATORS.has(t.value);
  }
  return false;
}

/**
 * Locate the `EI` of an inline image whose data starts at `dataStart`.
 * Returns [dataEnd, positionAfterEI].
 */
function findInlineImageEnd(buf: Uint8Array, dataStart: number, dict: CSDict): [number, number] {
  const n = buf.length;
  const isEI = (i: number) =>
    buf[i] === 0x45 && buf[i + 1] === 0x49 && (i + 2 >= n || isWhite(buf[i + 2]));

  // PDF 2.0: explicit length.
  const len = dictGet(dict, 'L', 'Length');
  if (len && len.type === 'number' && len.value >= 0) {
    let p = dataStart + Math.floor(len.value);
    while (p < n && isWhite(buf[p])) p++;
    if (isEI(p)) return [dataStart + Math.floor(len.value), p + 2];
  }

  // ASCII filters have explicit end-of-data markers; start searching after them.
  let searchFrom = dataStart;
  const filter = dictGet(dict, 'F', 'Filter');
  const firstFilter =
    filter?.type === 'name' ? filter.value : filter?.type === 'array' && filter.items[0]?.type === 'name' ? (filter.items[0] as CSName).value : '';
  if (firstFilter === 'AHx' || firstFilter === 'ASCIIHexDecode') {
    const e = buf.indexOf(0x3e, dataStart);
    if (e >= 0) searchFrom = e + 1;
  } else if (firstFilter === 'A85' || firstFilter === 'ASCII85Decode') {
    const e = indexOfSeq(buf, [0x7e, 0x3e], dataStart);
    if (e >= 0) searchFrom = e + 2;
  }

  for (let i = searchFrom; i < n - 1; i++) {
    if (buf[i] !== 0x45 || !isEI(i)) continue;
    // Prefer EI preceded by whitespace; verify what follows looks like operators.
    if (!plausibleAfterEI(buf, i + 2)) continue;
    const dataEnd = i > dataStart && isWhite(buf[i - 1]) ? i - 1 : i;
    return [dataEnd, i + 2];
  }
  return [n, n]; // unterminated: image runs to EOF
}

/**
 * Parse a decoded content stream into operations. Never throws: malformed
 * input degrades gracefully (stray tokens are skipped).
 */
export function parseContentStream(bytes: Uint8Array): CSOperation[] {
  const lx = new Lexer(bytes);
  const ops: CSOperation[] = [];
  let operands: CSObject[] = [];
  let start = 0;
  while (true) {
    lx.skipWhitespace();
    if (lx.eof) break;
    if (operands.length === 0) start = lx.pos;
    const t = lx.read();
    if (t.type === 'junk') continue;
    if (t.type !== 'op') {
      operands.push(t);
      if (operands.length > 4096) operands = []; // garbage; avoid unbounded growth
      continue;
    }
    if (t.value === 'BI') {
      ops.push(parseInlineImage(lx, bytes, start, operands));
      operands = [];
      continue;
    }
    ops.push({ op: t.value, operands, raw: bytes.subarray(start, lx.pos) });
    operands = [];
  }
  return ops;
}

function parseInlineImage(lx: Lexer, bytes: Uint8Array, start: number, operands: CSObject[]): CSOperation {
  const entries: Array<[CSName, CSObject]> = [];
  let key: CSName | null = null;
  while (true) {
    lx.skipWhitespace();
    if (lx.eof) break;
    const t = lx.read();
    if (t.type === 'op') {
      if (t.value === 'ID') break;
      continue; // junk keyword inside the image dictionary
    }
    if (t.type === 'junk') continue;
    if (key === null) {
      if (t.type === 'name') key = t;
    } else {
      entries.push([key, t]);
      key = null;
    }
  }
  const dict: CSDict = { type: 'dict', entries };
  // Exactly one whitespace byte separates ID from the data.
  if (!lx.eof && isWhite(bytes[lx.pos])) lx.pos++;
  const dataStart = lx.pos;
  const [dataEnd, after] = findInlineImageEnd(bytes, dataStart, dict);
  lx.pos = after;
  return {
    op: 'BI',
    operands,
    inlineImage: { dict, data: bytes.subarray(dataStart, Math.max(dataStart, dataEnd)) },
    raw: bytes.subarray(start, after),
  };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(1024);
  length = 0;

  private ensure(extra: number) {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  text(s: string) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.length++] = s.charCodeAt(i) & 0xff;
  }

  byte(c: number) {
    this.ensure(1);
    this.buf[this.length++] = c;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Format a number compactly for PDF output (no exponent notation). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0' || s === '') return '0';
  return s;
}

function writeObject(w: ByteWriter, obj: CSObject): void {
  switch (obj.type) {
    case 'number':
      w.text(obj.raw ?? formatNumber(obj.value));
      break;
    case 'name':
      w.text('/' + (obj.raw || encodeName(obj.value)));
      break;
    case 'bool':
      w.text(obj.value ? 'true' : 'false');
      break;
    case 'null':
      w.text('null');
      break;
    case 'string':
      if (obj.hex) {
        let s = '<';
        for (let i = 0; i < obj.bytes.length; i++) s += obj.bytes[i].toString(16).padStart(2, '0');
        w.text(s + '>');
      } else {
        w.byte(0x28);
        for (let i = 0; i < obj.bytes.length; i++) {
          const c = obj.bytes[i];
          if (c === 0x28 || c === 0x29 || c === 0x5c) {
            w.byte(0x5c);
            w.byte(c);
          } else if (c < 0x20 || c > 0x7e) {
            w.text('\\' + c.toString(8).padStart(3, '0'));
          } else w.byte(c);
        }
        w.byte(0x29);
      }
      break;
    case 'array':
      w.byte(0x5b);
      obj.items.forEach((it, i) => {
        if (i > 0) w.byte(0x20);
        writeObject(w, it);
      });
      w.byte(0x5d);
      break;
    case 'dict':
      w.text('<<');
      for (const [k, v] of obj.entries) {
        writeObject(w, k);
        w.byte(0x20);
        writeObject(w, v);
        w.byte(0x20);
      }
      w.text('>>');
      break;
  }
}

/** Serialize a single object (operand) to its PDF syntax. */
export function serializeObject(obj: CSObject): Uint8Array {
  const w = new ByteWriter();
  writeObject(w, obj);
  return w.result();
}

function writeOperation(w: ByteWriter, op: CSOperation): void {
  if (op.raw) {
    w.bytes(op.raw);
    return;
  }
  for (const operand of op.operands) {
    writeObject(w, operand);
    w.byte(0x20);
  }
  if (op.op === 'BI' && op.inlineImage) {
    w.text('BI');
    for (const [k, v] of op.inlineImage.dict.entries) {
      w.byte(0x20);
      writeObject(w, k);
      w.byte(0x20);
      writeObject(w, v);
    }
    w.text(' ID ');
    w.bytes(op.inlineImage.data);
    w.text('\nEI');
    return;
  }
  w.text(op.op);
}

/** Serialize operations back to content-stream bytes (one operation per line). */
export function serializeContentStream(ops: CSOperation[]): Uint8Array {
  const w = new ByteWriter();
  for (const op of ops) {
    writeOperation(w, op);
    w.byte(0x0a);
  }
  return w.result();
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

export const csNum = (value: number): CSNumber => ({ type: 'number', value });
export const csName = (value: string): CSName => ({ type: 'name', value, raw: encodeName(value) });
export const csOp = (op: string, ...operands: CSObject[]): CSOperation => ({ op, operands });

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/**
 * Return the decoded bytes of a pdf-lib stream object (raw parsed streams are
 * run through their filter chain; pdf-lib generated streams are unencoded).
 * Throws on unsupported filters.
 */
export function getStreamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  const anyStream = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  if (typeof anyStream.getUnencodedContents === 'function') return anyStream.getUnencodedContents();
  return stream.getContents();
}

/** Decode a whole stream to a latin1 string (for CMaps etc). */
export function bytesToLatin1(bytes: Uint8Array): string {
  return latin1(bytes, 0, bytes.length);
}
