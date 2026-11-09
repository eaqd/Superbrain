/**
 * Document model for the PDF editor.
 *
 * Coordinates: every object lives in the *unrotated page space* of its page,
 * measured in PDF points with a TOP-LEFT origin relative to the page's visible
 * box (pdf.js `page.view`, i.e. the crop box). Page rotation is applied purely
 * as a display transform, so objects rotate together with the page — exactly
 * like content and annotations do in Acrobat.
 */

export type Rot = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FontKey = "Helvetica" | "Times" | "Courier";

/** Where an object ends up when the PDF is saved. */
export type ObjLayer =
  /** Drawn into the page content stream (Edit PDF / Fill & Sign). */
  | "content"
  /** Written as a real PDF annotation (Comment tools) – editable in other viewers. */
  | "annot";

interface ObjBase {
  id: string;
  /** Bounding box in unrotated page space (pt, top-left origin). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise orientation of the object's content inside its box. */
  rotate: Rot;
  opacity: number;
  layer: ObjLayer;
  author: string;
  created: number;
  modified: number;
  /** Comment/popup text attached to an annotation. */
  comment?: string;
  locked?: boolean;
}

export interface TextObj extends ObjBase {
  type: "text";
  text: string;
  font: FontKey;
  bold: boolean;
  italic: boolean;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  /** Background fill, null = transparent. */
  fill: string | null;
  border: string | null;
  borderWidth: number;
  /** When true the box grows with the text instead of wrapping. */
  autoWidth: boolean;
  /**
   * Set when this text replaces existing page text ("Edit text").
   * `rects` are the original glyph boxes; on save the original glyphs are
   * removed from the content stream (falling back to painting `color` over them).
   */
  replaces?: { rects: Rect[]; color: string; original: string };
}

export interface ImageObj extends ObjBase {
  type: "image";
  /** data: URL (PNG or JPEG). */
  src: string;
  kind: "image" | "signature" | "initials";
}

export interface ShapeObj extends ObjBase {
  type: "rect" | "ellipse";
  stroke: string | null;
  strokeWidth: number;
  fill: string | null;
  dash: boolean;
}

export interface LineObj extends ObjBase {
  type: "line" | "arrow";
  /** Endpoints in page space (x/y/w/h are kept as the derived bbox). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  dash: boolean;
}

export interface InkObj extends ObjBase {
  type: "ink";
  /** Polylines as flat [x0, y0, x1, y1, ...] arrays in page space. */
  paths: number[][];
  stroke: string;
  strokeWidth: number;
}

export interface MarkupObj extends ObjBase {
  type: "highlight" | "underline" | "strikeout" | "squiggly";
  /** One rect per text line fragment, in page space. */
  rects: Rect[];
  color: string;
  /** The text that was marked up (for the comments list). */
  text: string;
}

export interface NoteObj extends ObjBase {
  type: "note";
  color: string;
  text: string;
}

export interface StampObj extends ObjBase {
  type: "stamp";
  label: string;
  sub: string;
  color: string;
}

export interface MarkObj extends ObjBase {
  type: "mark";
  mark: "check" | "cross" | "dot" | "dash";
  color: string;
}

export interface RedactObj extends ObjBase {
  type: "redact";
  /** Additional rects (text redactions spanning several lines). */
  rects: Rect[];
  fill: string;
  overlayText: string;
}

export interface LinkObj extends ObjBase {
  type: "link";
  url: string;
  /** Internal link target (page id). Wins over url when set. */
  pageId: string | null;
}

export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "listbox" | "signature" | "button";

export interface FieldObj extends ObjBase {
  type: "field";
  fieldType: FieldKind;
  name: string;
  options: string[];
  multiline: boolean;
  required: boolean;
  readOnly: boolean;
  /** Text value / selected option / radio export value. */
  value: string;
  checked: boolean;
  fontSize: number;
  tooltip: string;
  /** For radio buttons: the export value of this button. */
  exportValue: string;
}

export type EditObj =
  | TextObj
  | ImageObj
  | ShapeObj
  | LineObj
  | InkObj
  | MarkupObj
  | NoteObj
  | StampObj
  | MarkObj
  | RedactObj
  | LinkObj
  | FieldObj;

export type ObjType = EditObj["type"];

export interface PageModel {
  id: string;
  /** null for pages created inside the editor (blank pages). */
  sourceId: string | null;
  sourceIndex: number;
  /** The page's own /Rotate. */
  baseRotation: Rot;
  /** Extra rotation applied in the editor. */
  rotation: Rot;
  /** Unrotated visible size (pt). */
  width: number;
  height: number;
  objects: EditObj[];
  /** pdf.js ids ("12R") of existing annotations the user deleted. */
  hiddenAnnots: string[];
}

export interface OutlineItem {
  id: string;
  title: string;
  pageId: string | null;
  /** Optional y position (page space, top-left origin). */
  top: number | null;
  children: OutlineItem[];
  open: boolean;
}

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export type FieldValue = string | boolean | string[];

export interface Watermark {
  kind: "text" | "image";
  text: string;
  font: FontKey;
  bold: boolean;
  size: number;
  color: string;
  imageSrc: string | null;
  /** Image width as a fraction of the page width. */
  imageScale: number;
  opacity: number;
  /** Counter-clockwise degrees. */
  rotation: number;
  position: "center" | "top" | "bottom";
  layer: "over" | "under";
  /** Page range ("" = all pages). */
  pages: string;
}

export interface HeaderFooter {
  /** Six slots; tokens: {page} {pages} {date} {bates} {file} {title} */
  hl: string;
  hc: string;
  hr: string;
  fl: string;
  fc: string;
  fr: string;
  font: FontKey;
  size: number;
  color: string;
  marginX: number;
  marginY: number;
  startNumber: number;
  pages: string;
  batesPrefix: string;
  batesSuffix: string;
  batesStart: number;
  batesDigits: number;
}

export interface Decorations {
  watermark: Watermark | null;
  headerFooter: HeaderFooter | null;
}

export interface DocState {
  pages: PageModel[];
  /** Values typed into the document's existing AcroForm fields, per source. */
  forms: Record<string, Record<string, FieldValue>>;
  /** null = keep the original bookmarks untouched. */
  outline: OutlineItem[] | null;
  outlineEdited: boolean;
  meta: DocMeta;
  decor: Decorations;
}

/** A PDF file loaded into the session (immutable). */
export interface SourceDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  password?: string;
  numPages: number;
  /** pdf.js document proxy (typed loosely to keep pdfjs out of the main bundle). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: any;
  hasForm: boolean;
  encrypted: boolean;
}

export const PAGE_SIZES: Record<string, [number, number]> = {
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
};
