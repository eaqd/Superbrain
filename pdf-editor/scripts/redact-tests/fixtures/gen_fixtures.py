#!/usr/bin/env python3
"""Generate "real-world style" PDFs for the redaction tests.

  python3 scripts/redact-tests/fixtures/gen_fixtures.py

Produces (next to this script):
  reportlab_mixed.pdf  - ReportLab: standard-14 text, embedded TrueType subset,
                         CID font with predefined UniGB-UCS2-H CMap, RGB image,
                         vector shapes, rotated text, multi-page.
  libreoffice.pdf      - LibreOffice Writer export (shared /Resources, TrueType
                         subsets incl. CJK, JPEG image, table).
  chrome_print.pdf     - headless Chrome "print to PDF" (Type0 / Identity-H
                         CIDFontType2 fonts, CJK, image, link annotation,
                         CSS-rotated text).
Requires reportlab, Pillow and (optionally) soffice / google-chrome.
"""
import os
import shutil
import subprocess
import tempfile

from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def make_image(path, w=160, h=100):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 3) % 256, (y * 5) % 256, ((x + y) * 2) % 256)
    img.save(path)


def reportlab_pdf(path, img_path):
    pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    c = canvas.Canvas(path, pagesize=letter)
    c.setTitle("fixture")
    # Page 1
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 720, "Quarterly report confidential draft")
    c.setFont("Times-Roman", 12)
    y = 690
    for line in [
        "The account number 4417 1234 5678 9113 belongs to Jane Example.",
        "Her phone number is 555 0199 and her badge id is QX-77.",
        "Kerning test: AVATAR WAVE Type Yellow office efficient.",
    ]:
        c.drawString(72, y, line)
        y -= 18
    c.setFont("DejaVu", 13)
    c.drawString(72, y - 10, "Embedded TrueType: secret project codename Bluebird.")
    c.setFont("STSong-Light", 14)
    c.drawString(72, y - 40, "中文 保密 文本 123")
    c.drawImage(img_path, 72, 380, width=240, height=150)
    c.setFillColorRGB(0.9, 0.2, 0.2)
    c.rect(350, 400, 120, 60, fill=1, stroke=0)
    c.setStrokeColorRGB(0, 0, 0.6)
    c.setLineWidth(3)
    c.line(350, 380, 500, 380)
    c.saveState()
    c.translate(400, 250)
    c.rotate(25)
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica", 14)
    c.drawString(0, 0, "rotated sensitive label here")
    c.restoreState()
    c.setFont("Courier", 10)
    c.drawString(72, 200, "Monospace: user=admin password=hunter2 host=db01")
    c.showPage()
    # Page 2
    c.setFont("Helvetica", 11)
    t = c.beginText(72, 720)
    t.setCharSpace(0.5)
    t.setWordSpace(2)
    for i in range(12):
        t.textLine(f"Line {i}: patient Alice Smith visited on 2024-0{i % 9 + 1}-1{i % 9} for checkup.")
    c.drawText(t)
    c.drawImage(img_path, 300, 300, width=160, height=100)
    c.showPage()
    c.save()


HTML = """<html><head><meta charset="utf-8"><style>
body { font-family: 'Liberation Serif'; font-size: 12pt }
h1 { font-family: 'Liberation Sans' }
td { border: 1px solid #333; padding: 4px }
</style></head><body>
<h1>Employee record CONFIDENTIAL</h1>
<p>Name: Robert Tables. Salary: 98,500 USD. Social security 078-05-1120.</p>
<p>Address: 742 Evergreen Terrace, Springfield.</p>
<p style="font-family: 'WenQuanYi Zen Hei'">测试 机密 信息 就是这些</p>
<p><img src="IMG" width="240" height="150"></p>
<table><tr><td>Project</td><td>Budget</td></tr><tr><td>Nightingale</td><td>1.2M</td></tr><tr><td>Kestrel</td><td>0.4M</td></tr></table>
<p>Second paragraph with more words to keep around the redaction.</p>
</body></html>
"""


def libreoffice_pdf(path, img_path):
    soffice = shutil.which("soffice")
    if not soffice:
        print("soffice not found; skipping libreoffice.pdf")
        return
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "doc.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(HTML.replace("IMG", img_path))
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf:writer_web_pdf_Export", "--outdir", tmp, src],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=180,
        )
        shutil.copy(os.path.join(tmp, "doc.pdf"), path)


CHROME_HTML = """<html><head><meta charset="utf-8"><style>
@page { size: 8.5in 11in; margin: 0.6in }
body { font-family: 'DejaVu Sans'; font-size: 12pt }
h1 { font-family: 'DejaVu Serif' }
td { border: 1px solid #333; padding: 4px }
.rot { display: inline-block; transform: rotate(-20deg); margin: 30px }
</style></head><body>
<h1>Incident report PRIVATE</h1>
<p>Reporter: Maria Garcia, employee 99812, phone 555 0142.</p>
<p>Visit <a href="https://example.com/case/4471">case portal link</a> for details.</p>
<p style="font-family: 'WenQuanYi Zen Hei'">\u62a5\u544a \u673a\u5bc6 \u5185\u5bb9 \u7ed3\u675f</p>
<p><img src="IMG" width="240" height="150"></p>
<div class="rot">tilted stamp approved</div>
<table><tr><td>Item</td><td>Amount</td></tr><tr><td>Laptop</td><td>1,999</td></tr></table>
<p>Closing paragraph that should stay readable after redaction.</p>
</body></html>
"""


def chrome_pdf(path, img_path):
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        print("chrome not found; skipping chrome_print.pdf")
        return
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "doc.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(CHROME_HTML.replace("IMG", img_path))
        subprocess.run(
            [chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
             "--print-to-pdf=" + path, "file://" + src],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
        )


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        img = os.path.join(tmp, "img.png")
        make_image(img)
        reportlab_pdf(os.path.join(HERE, "reportlab_mixed.pdf"), img)
        libreoffice_pdf(os.path.join(HERE, "libreoffice.pdf"), img)
        chrome_pdf(os.path.join(HERE, "chrome_print.pdf"), img)
    print("fixtures written to", HERE)
