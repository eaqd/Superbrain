"""Validate and summarize a .docx for the tools tests.

Usage: python3 -I inspect_docx.py file.docx
Prints JSON: every XML part must parse (xml.etree); then python-docx reads the
document and we dump paragraphs (text, style, alignment, runs, indents, page
break flags), sections and inline shapes.
"""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

path = sys.argv[1]
out = {"parts": [], "xml_errors": []}
with zipfile.ZipFile(path) as z:
    bad = z.testzip()
    if bad:
        out["xml_errors"].append("bad zip member " + bad)
    for name in z.namelist():
        out["parts"].append(name)
        if name.endswith(".xml") or name.endswith(".rels"):
            try:
                ET.fromstring(z.read(name))
            except ET.ParseError as e:
                out["xml_errors"].append(f"{name}: {e}")

try:
    import docx  # python-docx
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    d = docx.Document(path)
    align_names = {
        WD_ALIGN_PARAGRAPH.CENTER: "center",
        WD_ALIGN_PARAGRAPH.RIGHT: "right",
        WD_ALIGN_PARAGRAPH.JUSTIFY: "both",
        WD_ALIGN_PARAGRAPH.LEFT: "left",
        None: None,
    }
    paras = []
    for p in d.paragraphs:
        pf = p.paragraph_format
        runs = []
        for r in p.runs:
            runs.append(
                {
                    "text": r.text,
                    "bold": bool(r.bold),
                    "italic": bool(r.italic),
                    "size": r.font.size.pt if r.font.size else None,
                    "font": r.font.name,
                    "superscript": bool(r.font.superscript),
                    "subscript": bool(r.font.subscript),
                    "color": str(r.font.color.rgb) if r.font.color and r.font.color.type is not None else None,
                }
            )
        paras.append(
            {
                "text": p.text,
                "style": p.style.name if p.style is not None else None,
                "align": align_names.get(p.alignment, str(p.alignment)),
                "page_break_before": bool(pf.page_break_before),
                "left": pf.left_indent.pt if pf.left_indent is not None else None,
                "first_line": pf.first_line_indent.pt if pf.first_line_indent is not None else None,
                "space_before": pf.space_before.pt if pf.space_before is not None else None,
                "has_drawing": bool(p._p.xpath(".//w:drawing")),
                "runs": runs,
            }
        )
    out["paragraphs"] = paras
    out["sections"] = [
        {
            "w": s.page_width.pt,
            "h": s.page_height.pt,
            "orient": str(s.orientation),
            "left": s.left_margin.pt,
            "right": s.right_margin.pt,
            "top": s.top_margin.pt,
            "bottom": s.bottom_margin.pt,
        }
        for s in d.sections
    ]
    out["inline_shapes"] = [{"w": sh.width.pt, "h": sh.height.pt} for sh in d.inline_shapes]
    out["core"] = {"title": d.core_properties.title, "author": d.core_properties.author}
except ImportError:
    out["python_docx"] = False

print(json.dumps(out))
