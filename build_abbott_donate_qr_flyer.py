"""Regenerate the styled Greg Abbott donation QR PDF (square QR, improved layout)."""
import io
import os

import qrcode
from PIL import Image
from qrcode.constants import ERROR_CORRECT_H
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

URL = "https://donate.gregabbott.com/26jones?exitintent=true"
OUT = os.path.join(os.path.dirname(__file__), "donate-gregabbott-26jones-qr-styled.pdf")

NAVY = colors.HexColor("#000080")
NAVY_ACCENT = colors.HexColor("#023d7b")
MAROON = colors.HexColor("#800000")
RED = colors.HexColor("#d0021a")
PAGE = colors.HexColor("#fbfcfd")
CARD = colors.white
SHADOW = colors.HexColor("#d8dee6")
TEXT_MUTED = colors.HexColor("#2c3e50")
RULE = colors.HexColor("#c4a35a")


def register_fonts():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    body_candidates = [
        r"C:\Windows\Fonts\georgia.ttf",
        r"C:\Windows\Fonts\Georgia.ttf",
        r"C:\Windows\Fonts\times.ttf",
    ]
    bold_candidates = [
        r"C:\Windows\Fonts\georgiab.ttf",
        r"C:\Windows\Fonts\Georgia Bold.ttf",
        r"C:\Windows\Fonts\timesbd.ttf",
    ]
    body_path = next((p for p in body_candidates if os.path.isfile(p)), None)
    bold_path = next((p for p in bold_candidates if os.path.isfile(p)), None)
    if not body_path:
        raise FileNotFoundError("No serif body font (Georgia/Times) found.")
    pdfmetrics.registerFont(TTFont("FlyerBody", body_path))
    if not bold_path:
        bold_path = body_path
    pdfmetrics.registerFont(TTFont("FlyerBold", bold_path))
    return "FlyerBody", "FlyerBold"


def square_qr_png_pixels(px: int = 800) -> io.BytesIO:
    qr = qrcode.QRCode(
        version=None, error_correction=ERROR_CORRECT_H, box_size=12, border=3
    )
    qr.add_data(URL)
    qr.make(fit=True)
    im = qr.make_image(fill_color="#000000", back_color="#FFFFFF").convert("RGB")
    im = im.resize((px, px), Image.Resampling.NEAREST)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    return buf


def main():
    W, H = letter
    body, bold = register_fonts()

    buf = square_qr_png_pixels(800)
    qr_img = ImageReader(buf)

    c = canvas.Canvas(OUT, pagesize=letter)

    c.setFillColor(PAGE)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    margin_x = 0.72 * inch
    col_w = W - 2 * margin_x
    card_top = H - 0.5 * inch
    card_bottom = 0.45 * inch
    card_x = margin_x - 0.08 * inch
    card_w = col_w + 0.16 * inch

    c.setFillColor(SHADOW)
    c.roundRect(card_x + 4, card_bottom - 4, card_w, card_top - card_bottom + 4, 14, fill=1, stroke=0)
    c.setFillColor(CARD)
    c.setStrokeColor(colors.HexColor("#e8ecf0"))
    c.setLineWidth(0.6)
    c.roundRect(card_x, card_bottom, card_w, card_top - card_bottom, 14, fill=1, stroke=1)

    bar_h = 0.2 * inch
    inner_left = card_x + 0.32 * inch
    inner_w = card_w - 0.64 * inch
    bar_y0 = card_top - 0.28 * inch - bar_h
    c.setFillColor(RED)
    c.rect(inner_left, bar_y0, inner_w, bar_h, fill=1, stroke=0)
    c.setFillColor(NAVY_ACCENT)
    c.rect(inner_left, bar_y0 - 0.055 * inch, inner_w, 0.055 * inch, fill=1, stroke=0)

    cx = W / 2
    header_bottom = bar_y0 - 0.055 * inch
    rule_y = header_bottom - 0.1 * inch
    c.setStrokeColor(RULE)
    c.setLineWidth(0.9)
    c.line(inner_left + 0.42 * inch, rule_y, inner_left + inner_w - 0.42 * inch, rule_y)

    y = rule_y - 0.4 * inch

    c.setFillColor(MAROON)
    c.setFont(bold, 24)
    c.drawCentredString(cx, y, "Support Governor Abbott")
    y -= 0.32 * inch

    c.setFont(bold, 15)
    c.drawCentredString(cx, y, "GREG ABBOTT")
    y -= 0.34 * inch

    c.setFillColor(NAVY_ACCENT)
    c.setFont(bold, 11.5)
    c.drawCentredString(cx, y, "Texans for Greg Abbott")
    y -= 0.3 * inch

    c.setFillColor(NAVY)
    c.setFont(body, 10.5)
    c.drawCentredString(cx, y, "Please scan the code below to open the secure donation page.")
    y -= 0.48 * inch

    qr_pt = 2.45 * inch
    qx = (W - qr_pt) / 2
    qy = y - qr_pt

    pad = 22
    c.setFillColor(colors.HexColor("#fafbfc"))
    c.setStrokeColor(NAVY_ACCENT)
    c.setLineWidth(1.25)
    c.roundRect(qx - pad, qy - pad, qr_pt + 2 * pad, qr_pt + 2 * pad, 12, fill=1, stroke=1)

    c.drawImage(qr_img, qx, qy, width=qr_pt, height=qr_pt, mask="auto")

    y_url = qy - 0.36 * inch
    c.setFillColor(TEXT_MUTED)
    c.setFont(body, 9)
    c.drawCentredString(cx, y_url, URL)

    c.setFont(body, 8)
    c.setFillColor(colors.HexColor("#333333"))
    c.drawCentredString(
        cx,
        y_url - 0.22 * inch,
        "Your contribution will benefit Texans for Greg Abbott.",
    )

    c.showPage()
    c.save()
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
