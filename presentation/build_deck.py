#!/usr/bin/env python3
"""Build "Curating Agent Memory" — BMW-branded .pptx AND a pixel-matched .html.

A single slide spec (SLIDES) drives BOTH renderers so the layouts are identical.
All geometry is in inches on a 13.333 x 7.5 in (16:9) stage. The HTML stage is
1280 x 720 px (96 px / inch). Images are base64-embedded in the HTML so it is a
single self-contained file. A subtle ownership footer is stamped on every slide.
"""
import base64
import mimetypes
import os
import sys

sys.path.insert(
    0,
    "/home/q677724/.vscode/agent-plugins/skills.bmwgroup.net/git/ad/plugins/"
    "presentations/tools/pptx/src",
)

from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from bmw_pptx.bmw_pptx import BmwPresentation, BMW

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
ASSETS = os.path.join(HERE, "assets")

# ----------------------------------------------------------------------------
# Palette (BMW CI hex + RGBColor)
# ----------------------------------------------------------------------------
C = {
    "black": "000000",
    "white": "FFFFFF",
    "deep": "022A38",       # deep dark teal (dark-slide background)
    "deep2": "05384A",      # slightly lighter deep teal
    "teal": "035970",       # DARK_TEAL
    "secondary": "92A2BD",
    "light_blue": "39B3E6",
    "medium_blue": "079EDA",
    "soft_blue": "8CB7E3",
    "card_bg": "C8D7E0",
    "subtle_bg": "DEE5EC",
    "stripe_bg": "E8EBF1",
    "page_bg": "F4F7FA",    # light content-slide background
    "footer_dark": "3A566A",  # subtle footer on dark bg
    "footer_light": "BAC4D0",  # subtle footer on light bg
}


def rgb(hexstr):
    return RGBColor(int(hexstr[0:2], 16), int(hexstr[2:4], 16), int(hexstr[4:6], 16))


FOOTER_TEXT = "Ritwik Ghosh   Intern   EF 412"
FONT_STACK = "'BMW Group Condensed','BMWGroupTN Condensed','Arial Narrow',system-ui,sans-serif"

# ----------------------------------------------------------------------------
# Slide specification
# Element kinds: rect, text, image, icon, arrow
# Coordinates x,y,w,h in inches.
# ----------------------------------------------------------------------------


def para(t, size=14, bold=False, color="black", bullet=False, align="left", space=6):
    return {"t": t, "size": size, "bold": bold, "color": color, "bullet": bullet,
            "align": align, "space": space}


def build_slides():
    S = []

    # ---- Slide 1: Title (dark) ----
    S.append({
        "bg": "deep",
        "dark": True,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "deep"},
            {"kind": "rect", "x": 0, "y": 0, "w": 0.32, "h": 7.5, "fill": "light_blue"},
            {"kind": "icon", "x": 0.9, "y": 1.5, "d": 0.28, "fill": "light_blue", "text": ""},
            {"kind": "icon", "x": 1.32, "y": 1.5, "d": 0.28, "fill": "medium_blue", "text": ""},
            {"kind": "icon", "x": 1.74, "y": 1.5, "d": 0.28, "fill": "soft_blue", "text": ""},
            {"kind": "text", "x": 0.9, "y": 2.15, "w": 11.5, "h": 0.5,
             "paras": [para("OBSERVATIONAL  MEMORY", 15, True, "light_blue", space=0)]},
            {"kind": "text", "x": 0.85, "y": 2.7, "w": 11.7, "h": 1.6,
             "paras": [para("Curating Agent Memory", 54, True, "white", space=0)]},
            {"kind": "text", "x": 0.9, "y": 4.35, "w": 11.5, "h": 0.7,
             "paras": [para("Retention · Live-Context Retrieval · Human-in-the-Loop Feedback",
                            22, False, "soft_blue", space=0)]},
            {"kind": "rect", "x": 0.92, "y": 5.15, "w": 3.2, "h": 0.045, "fill": "medium_blue"},
            {"kind": "text", "x": 0.9, "y": 5.4, "w": 11.5, "h": 0.5,
             "paras": [para("Agent-Agnostic Observational Memory", 15, False, "secondary", space=0)]},
        ],
    })

    # ---- Slide 2: Why curate (light) ----
    S.append({
        "bg": "page_bg", "dark": False,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "page_bg"},
            {"kind": "text", "x": 0.7, "y": 0.55, "w": 12, "h": 0.8,
             "paras": [para("Why Curate Agent Memory?", 34, True, "teal", space=0)]},
            {"kind": "text", "x": 0.72, "y": 1.35, "w": 12, "h": 0.5,
             "paras": [para("Not either / or — both goals matter at once.", 17, False, "medium_blue", space=0)]},
            # Left card — tokens
            {"kind": "rect", "x": 0.7, "y": 2.1, "w": 5.7, "h": 4.35, "fill": "card_bg", "radius": 0.12},
            {"kind": "icon", "x": 1.0, "y": 2.4, "d": 0.7, "fill": "medium_blue", "text": "\u26a1", "size": 24},
            {"kind": "text", "x": 1.85, "y": 2.45, "w": 4.3, "h": 0.6,
             "paras": [para("Save Tokens", 22, True, "teal", space=0)]},
            {"kind": "text", "x": 1.0, "y": 3.35, "w": 5.15, "h": 3.0,
             "paras": [
                 para("Context windows are finite — every stale token evicts a useful one.", 14, False, "black", True),
                 para("You pay per token, on every single prompt.", 14, False, "black", True),
                 para("Latency scales with prompt size.", 14, False, "black", True),
                 para("Curation drops duplicate & low-value memory before injection.", 14, False, "black", True),
             ]},
            # Right card — misleading context
            {"kind": "rect", "x": 6.9, "y": 2.1, "w": 5.7, "h": 4.35, "fill": "subtle_bg", "radius": 0.12},
            {"kind": "icon", "x": 7.2, "y": 2.4, "d": 0.7, "fill": "teal", "text": "\U0001F3AF", "size": 22},
            {"kind": "text", "x": 8.05, "y": 2.45, "w": 4.3, "h": 0.6,
             "paras": [para("Prevent Misleading Context", 22, True, "teal", space=0)]},
            {"kind": "text", "x": 7.2, "y": 3.35, "w": 5.15, "h": 3.0,
             "paras": [
                 para("Stale insights rot — renamed files & moved routes silently mislead.", 14, False, "black", True),
                 para("Off-topic recall derails the model's reasoning.", 14, False, "black", True),
                 para("Blue-heavy cosine similarity alone can't tell relevant from related.", 14, False, "black", True),
                 para("Curation demotes unverified, off-topic, low-confidence memory.", 14, False, "black", True),
             ]},
            {"kind": "text", "x": 0.7, "y": 6.6, "w": 12, "h": 0.5,
             "paras": [para("Curation = feed the model less, but righter.", 16, True, "medium_blue", space=0, align="center")]},
        ],
    })

    # ---- Slide 3: Lifecycle (light) ----
    S.append({
        "bg": "page_bg", "dark": False,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "page_bg"},
            {"kind": "text", "x": 0.7, "y": 0.5, "w": 12, "h": 0.8,
             "paras": [para("The Agent Lifecycle — Two Hook Points", 32, True, "teal", space=0)]},
            {"kind": "text", "x": 0.72, "y": 1.28, "w": 12, "h": 0.5,
             "paras": [para("Memory is curated at exactly two events in every turn.", 16, False, "medium_blue", space=0)]},
            # lifecycle image (tall) left
            {"kind": "image", "x": 0.7, "y": 1.75, "w": 2.42, "h": 5.35,
             "path": os.path.join(ASSETS, "hooks-lifecycle.png"),
             "html": "../screenshots/hooks-lifecycle.svg"},
            # Card A — UserPromptSubmit
            {"kind": "rect", "x": 3.7, "y": 1.95, "w": 8.9, "h": 2.25, "fill": "subtle_bg", "radius": 0.1},
            {"kind": "rect", "x": 3.7, "y": 1.95, "w": 0.14, "h": 2.25, "fill": "medium_blue"},
            {"kind": "text", "x": 4.05, "y": 2.15, "w": 8.3, "h": 0.55,
             "paras": [para("UserPromptSubmit  \u2192  Knowledge Injection Hook", 20, True, "teal", space=0)]},
            {"kind": "text", "x": 4.05, "y": 2.75, "w": 8.3, "h": 1.4,
             "paras": [
                 para("Fires BEFORE the model sees the prompt.", 14, False, "black", True),
                 para("Retrieves Working + Observational memory for the draft query.", 14, False, "black", True),
                 para("Injects the token-budgeted, ranked context into the turn.", 14, False, "black", True),
             ]},
            # Card B — PostToolUse
            {"kind": "rect", "x": 3.7, "y": 4.55, "w": 8.9, "h": 2.25, "fill": "card_bg", "radius": 0.1},
            {"kind": "rect", "x": 3.7, "y": 4.55, "w": 0.14, "h": 2.25, "fill": "teal"},
            {"kind": "text", "x": 4.05, "y": 4.75, "w": 8.3, "h": 0.55,
             "paras": [para("PostToolUse  \u2192  Knowledge Retention Hook", 20, True, "teal", space=0)]},
            {"kind": "text", "x": 4.05, "y": 5.35, "w": 8.3, "h": 1.4,
             "paras": [
                 para("Fires AFTER each completed exchange / tool result.", 14, False, "black", True),
                 para("Captures the Intent / Approach / Artifacts / Result summary.", 14, False, "black", True),
                 para("Fire-and-forget hand-off to the Observation Writer (never blocks).", 14, False, "black", True),
             ]},
        ],
    })

    # ---- Slide 4: Three-tier hierarchy (light) ----
    tier_cards = [
        ("1", "medium_blue", "Observations", "card_bg",
         ["Per-exchange structured summary", "Intent / Approach / Artifacts / Result",
          "Created real-time, per prompt-set", "Fire-and-forget · ~30 / day"]),
        ("2", "teal", "Digests", "subtle_bg",
         ["Daily thematic work-session summary", "Groups a day's observations by theme",
          "Created end-of-day (cron or manual)", "~7 / day"]),
        ("3", "light_blue", "Insights", "stripe_bg",
         ["Durable, self-verifying knowledge article", "Purpose / Architecture / Key files / Usage",
          "Created weekly · when \u2265 5 new digests", "Confidence decays \u22120.05 / week · ~10 total"]),
    ]
    els = [
        {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "page_bg"},
        {"kind": "text", "x": 0.7, "y": 0.5, "w": 12, "h": 0.8,
         "paras": [para("Three-Tier Observational Memory", 32, True, "teal", space=0)]},
        {"kind": "text", "x": 0.72, "y": 1.28, "w": 12, "h": 0.5,
         "paras": [para("Rising abstraction & persistence \u2191   —   falling volume \u2193", 16, False, "medium_blue", space=0)]},
    ]
    cx = 0.7
    cw = 3.9
    gap = 0.18
    for i, (num, icol, title, fill, bullets) in enumerate(tier_cards):
        x = cx + i * (cw + gap)
        els.append({"kind": "rect", "x": x, "y": 2.0, "w": cw, "h": 4.55, "fill": fill, "radius": 0.1})
        els.append({"kind": "icon", "x": x + 0.3, "y": 2.3, "d": 0.72, "fill": icol, "text": num, "size": 26})
        els.append({"kind": "text", "x": x + 1.2, "y": 2.42, "w": cw - 1.35, "h": 0.6,
                    "paras": [para(title, 22, True, "teal", space=0)]})
        els.append({"kind": "text", "x": x + 0.32, "y": 3.35, "w": cw - 0.6, "h": 3.0,
                    "paras": [para(b, 13.5, False, "black", True) for b in bullets]})
        if i < 2:
            els.append({"kind": "arrow", "x": x + cw - 0.02, "y": 4.05, "w": gap + 0.04, "h": 0.45,
                        "dir": "right", "fill": "secondary"})
    S.append({"bg": "page_bg", "dark": False, "elements": els})

    # ---- Slide 5: Introspection -> Live Memory Context (light) ----
    S.append({
        "bg": "page_bg", "dark": False,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "page_bg"},
            {"kind": "text", "x": 0.7, "y": 0.5, "w": 12.2, "h": 0.8,
             "paras": [para("Memory Introspection \u2192 Live Memory Context", 30, True, "teal", space=0)]},
            {"kind": "text", "x": 0.72, "y": 1.3, "w": 12, "h": 0.5,
             "paras": [para("Inspect before you Submit.", 20, True, "medium_blue", space=0)]},
            # left rationale
            {"kind": "text", "x": 0.7, "y": 2.15, "w": 6.4, "h": 0.5,
             "paras": [para("Rationale", 18, True, "teal", space=0)]},
            {"kind": "text", "x": 0.72, "y": 2.75, "w": 6.4, "h": 3.6,
             "paras": [
                 para("See exactly what memory a draft prompt will pull \u2014 before pressing Enter.", 15, False, "black", True),
                 para("Spot irrelevant or duplicate hits your wording attracted.", 15, False, "black", True),
                 para("Rephrase the query to steer retrieval: sharper keywords, tighter scope.", 15, False, "black", True),
                 para("Tune thresholds live \u2014 the preview reads the same settings file as the real hook.", 15, False, "black", True),
             ]},
            # flow strip
            {"kind": "rect", "x": 0.7, "y": 6.2, "w": 6.4, "h": 0.75, "fill": "subtle_bg", "radius": 0.08},
            {"kind": "text", "x": 0.7, "y": 6.36, "w": 6.4, "h": 0.5,
             "paras": [para("Draft  \u2192  Inspect  \u2192  Rephrase  \u2192  Submit", 15, True, "teal", space=0, align="center")]},
            # right benefits card
            {"kind": "rect", "x": 7.4, "y": 2.15, "w": 5.2, "h": 4.8, "fill": "card_bg", "radius": 0.1},
            {"kind": "text", "x": 7.7, "y": 2.4, "w": 4.6, "h": 0.5,
             "paras": [para("Benefits", 18, True, "teal", space=0)]},
            {"kind": "text", "x": 7.7, "y": 3.0, "w": 4.65, "h": 3.7,
             "paras": [
                 para("Fewer tokens wasted on irrelevant memory.", 15, False, "black", True),
                 para("Higher-signal context \u2192 more accurate answers.", 15, False, "black", True),
                 para("Query rephrasing is a cheap, immediate control lever.", 15, False, "black", True),
                 para("Confidence that the injected context is the right context.", 15, False, "black", True),
             ]},
        ],
    })

    # ---- Slide 6: Human-in-the-Loop (light + crop) ----
    S.append({
        "bg": "page_bg", "dark": False,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "page_bg"},
            {"kind": "text", "x": 0.7, "y": 0.5, "w": 12, "h": 0.8,
             "paras": [para("Human-in-the-Loop Feedback", 32, True, "teal", space=0)]},
            {"kind": "text", "x": 0.72, "y": 1.28, "w": 12, "h": 0.5,
             "paras": [para("A human reorder becomes a learned, decaying rerank boost.", 16, False, "medium_blue", space=0)]},
            {"kind": "rect", "x": 0.62, "y": 1.95, "w": 6.28, "h": 4.5, "fill": "deep", "radius": 0.08},
            {"kind": "image", "x": 0.75, "y": 2.1, "w": 6.0, "h": 4.15,
             "path": os.path.join(ASSETS, "all-results-crop.png"),
             "html": os.path.join(ASSETS, "all-results-crop.png")},
            {"kind": "text", "x": 7.25, "y": 2.0, "w": 5.4, "h": 4.6,
             "paras": [
                 para("Drag results into the order you actually wanted.", 15.5, False, "black", True),
                 para("\u201cSave ranking\u201d captures ONE feedback event: the query + the reorder.", 15.5, False, "black", True),
                 para("Stored as a query-keyed vector in human_rerank_feedback (Qdrant).", 15.5, False, "black", True),
                 para("Next similar query \u2192 learned rerank nudges those items \u00d7 0.90\u20131.25.", 15.5, False, "black", True),
                 para("SCORE / RRF / WAS badges expose exactly how each item moved.", 15.5, False, "black", True),
             ]},
        ],
    })

    # ---- Slide 7: Exponential curve (light + curve) ----
    S.append({
        "bg": "page_bg", "dark": False,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "page_bg"},
            {"kind": "text", "x": 0.7, "y": 0.5, "w": 12.4, "h": 0.8,
             "paras": [para("Near-Duplicate Isolation \u2014 the Exponential Gate", 28, True, "teal", space=0)]},
            {"kind": "text", "x": 0.72, "y": 1.26, "w": 12, "h": 0.5,
             "paras": [para("Only queries above the 0.85 floor count \u2014 and the exponent decides how much.", 15, False, "medium_blue", space=0)]},
            {"kind": "rect", "x": 0.62, "y": 1.9, "w": 6.5, "h": 4.55, "fill": "white", "radius": 0.06, "line": "card_bg"},
            {"kind": "image", "x": 0.78, "y": 2.05, "w": 6.18, "h": 3.83,
             "path": os.path.join(REPO, "docs/images/learned-rerank-exponential-curve.png"),
             "html": "../docs/images/learned-rerank-exponential-curve.png"},
            {"kind": "text", "x": 7.4, "y": 1.95, "w": 5.3, "h": 3.0,
             "paras": [
                 para("Gate 1 \u2014 hard admission floor at 0.85 cosine; below it, an event is ignored entirely.", 14.5, False, "black", True),
                 para("Gate 2 \u2014 weight = similarity ^ k reshapes the narrow admitted band (0.85\u20131.00).", 14.5, False, "black", True),
                 para("k = 3 (default): 0.86\u00b3 \u2248 0.64  vs  0.97\u00b3 \u2248 0.91 \u2014 gap widens 0.11 \u2192 0.27.", 14.5, False, "black", True),
                 para("k = 8: 0.86\u2078 \u2248 0.30 suppressed; only near-identical queries survive.", 14.5, False, "black", True),
             ]},
            # mini example table
            {"kind": "rect", "x": 7.4, "y": 5.35, "w": 5.3, "h": 1.15, "fill": "subtle_bg", "radius": 0.06},
            {"kind": "text", "x": 7.55, "y": 5.45, "w": 5.0, "h": 0.35,
             "paras": [para("cosine   \u2192   k=1      k=3      k=8", 13.5, True, "teal", space=0)]},
            {"kind": "text", "x": 7.55, "y": 5.8, "w": 5.0, "h": 0.35,
             "paras": [para("0.86       0.86     0.64     0.30   (related \u2014 fades)", 13, False, "black", space=0)]},
            {"kind": "text", "x": 7.55, "y": 6.12, "w": 5.0, "h": 0.35,
             "paras": [para("0.97       0.97     0.91     0.78   (near-dup \u2014 kept)", 13, False, "medium_blue", space=0)]},
        ],
    })

    # ---- Slide 8: Thank You (dark) ----
    S.append({
        "bg": "deep", "dark": True,
        "elements": [
            {"kind": "rect", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "fill": "deep"},
            {"kind": "icon", "x": 5.72, "y": 2.35, "d": 0.3, "fill": "light_blue", "text": ""},
            {"kind": "icon", "x": 6.18, "y": 2.35, "d": 0.3, "fill": "medium_blue", "text": ""},
            {"kind": "icon", "x": 6.64, "y": 2.35, "d": 0.3, "fill": "soft_blue", "text": ""},
            {"kind": "text", "x": 1.0, "y": 3.0, "w": 11.333, "h": 1.4,
             "paras": [para("Thank You", 60, True, "white", space=0, align="center")]},
            {"kind": "text", "x": 1.0, "y": 4.5, "w": 11.333, "h": 0.6,
             "paras": [para("Curating Agent Memory \u2014 Retention, Retrieval & Human Feedback",
                            18, False, "soft_blue", space=0, align="center")]},
            {"kind": "rect", "x": 5.42, "y": 5.25, "w": 2.5, "h": 0.04, "fill": "medium_blue"},
        ],
    })
    return S


# ----------------------------------------------------------------------------
# PPTX renderer
# ----------------------------------------------------------------------------
ALIGN = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}


def render_pptx(slides, out_path):
    bmw = BmwPresentation()
    # remove any default slide (template has none, but be safe)
    for s in slides:
        slide = bmw.prs.slides.add_slide(bmw.prs.slide_layouts[2])  # Grid | 1 (blank-ish)
        # wipe inherited placeholders for a clean canvas
        for ph in list(slide.placeholders):
            ph._element.getparent().remove(ph._element)
        for el in s["elements"]:
            _pptx_element(slide, el)
        _pptx_footer(slide, s["dark"])
    bmw.save(out_path)
    return out_path


def _pptx_element(slide, el):
    k = el["kind"]
    if k == "rect":
        shp = slide.shapes.add_shape(
            MSO_SHAPE.ROUNDED_RECTANGLE if el.get("radius") else MSO_SHAPE.RECTANGLE,
            Inches(el["x"]), Inches(el["y"]), Inches(el["w"]), Inches(el["h"]))
        shp.fill.solid()
        shp.fill.fore_color.rgb = rgb(C[el["fill"]])
        if el.get("line"):
            shp.line.color.rgb = rgb(C[el["line"]])
            shp.line.width = Pt(1)
        else:
            shp.line.fill.background()
        shp.shadow.inherit = False
    elif k == "text":
        box = slide.shapes.add_textbox(Inches(el["x"]), Inches(el["y"]),
                                       Inches(el["w"]), Inches(el["h"]))
        tf = box.text_frame
        tf.word_wrap = True
        for i, p in enumerate(el["paras"]):
            pr = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            pr.text = ("\u2022  " + p["t"]) if p.get("bullet") else p["t"]
            pr.alignment = ALIGN[p.get("align", "left")]
            if p.get("space"):
                pr.space_after = Pt(p["space"])
            for run in pr.runs:
                run.font.name = BMW.FONT
                run.font.size = Pt(p["size"])
                run.font.bold = p["bold"]
                run.font.color.rgb = rgb(C[p["color"]])
    elif k == "image":
        slide.shapes.add_picture(el["path"], Inches(el["x"]), Inches(el["y"]),
                                 Inches(el["w"]), Inches(el["h"]))
    elif k == "icon":
        d = Inches(el["d"])
        shp = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(el["x"]), Inches(el["y"]), d, d)
        shp.fill.solid()
        shp.fill.fore_color.rgb = rgb(C[el["fill"]])
        shp.line.fill.background()
        shp.shadow.inherit = False
        if el.get("text"):
            shp.text = el["text"]
            for para_ in shp.text_frame.paragraphs:
                para_.alignment = PP_ALIGN.CENTER
                for run in para_.runs:
                    run.font.name = BMW.FONT
                    run.font.size = Pt(el.get("size", 16))
                    run.font.bold = True
                    run.font.color.rgb = rgb(C["white"])
    elif k == "arrow":
        amap = {"right": MSO_SHAPE.RIGHT_ARROW, "down": MSO_SHAPE.DOWN_ARROW}
        shp = slide.shapes.add_shape(amap[el["dir"]], Inches(el["x"]), Inches(el["y"]),
                                     Inches(el["w"]), Inches(el["h"]))
        shp.fill.solid()
        shp.fill.fore_color.rgb = rgb(C[el["fill"]])
        shp.line.fill.background()
        shp.shadow.inherit = False


def _pptx_footer(slide, dark):
    box = slide.shapes.add_textbox(Inches(0.3), Inches(7.16), Inches(12.73), Inches(0.26))
    tf = box.text_frame
    tf.word_wrap = False
    p = tf.paragraphs[0]
    p.text = FOOTER_TEXT
    p.alignment = PP_ALIGN.RIGHT
    for run in p.runs:
        run.font.name = BMW.FONT
        run.font.size = Pt(6)
        run.font.bold = False
        run.font.color.rgb = rgb(C["footer_dark"] if dark else C["footer_light"])


# ----------------------------------------------------------------------------
# HTML renderer (1 inch = 96 px)
# ----------------------------------------------------------------------------
PX = 96.0
PT2PX = 96.0 / 72.0


def _data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _html_element(el):
    k = el["kind"]
    if k == "rect":
        style = (f"left:{el['x']*PX:.1f}px;top:{el['y']*PX:.1f}px;"
                 f"width:{el['w']*PX:.1f}px;height:{el['h']*PX:.1f}px;"
                 f"background:#{C[el['fill']]};")
        if el.get("radius"):
            style += f"border-radius:{el['radius']*PX:.1f}px;"
        if el.get("line"):
            style += f"border:1px solid #{C[el['line']]};box-sizing:border-box;"
        return f'<div class="el" style="{style}"></div>'
    if k == "icon":
        d = el["d"] * PX
        style = (f"left:{el['x']*PX:.1f}px;top:{el['y']*PX:.1f}px;width:{d:.1f}px;"
                 f"height:{d:.1f}px;background:#{C[el['fill']]};border-radius:50%;"
                 f"display:flex;align-items:center;justify-content:center;color:#fff;"
                 f"font-weight:700;font-size:{el.get('size',16)*PT2PX:.1f}px;")
        return f'<div class="el" style="{style}">{el.get("text","")}</div>'
    if k == "arrow":
        # simple right/down triangle via borders
        w = el["w"] * PX
        h = el["h"] * PX
        col = C[el["fill"]]
        if el["dir"] == "right":
            tri = (f"width:0;height:0;border-top:{h/2:.1f}px solid transparent;"
                   f"border-bottom:{h/2:.1f}px solid transparent;"
                   f"border-left:{w:.1f}px solid #{col};")
        else:
            tri = (f"width:0;height:0;border-left:{w/2:.1f}px solid transparent;"
                   f"border-right:{w/2:.1f}px solid transparent;"
                   f"border-top:{h:.1f}px solid #{col};")
        style = f"left:{el['x']*PX:.1f}px;top:{el['y']*PX:.1f}px;{tri}"
        return f'<div class="el" style="{style}"></div>'
    if k == "image":
        src = el.get("html", el["path"])
        # embed local files as data URIs for a self-contained deck
        cand = src
        if not os.path.isabs(cand):
            cand = os.path.normpath(os.path.join(HERE, cand))
        if os.path.exists(cand):
            src = _data_uri(cand)
        style = (f"left:{el['x']*PX:.1f}px;top:{el['y']*PX:.1f}px;"
                 f"width:{el['w']*PX:.1f}px;height:{el['h']*PX:.1f}px;"
                 f"object-fit:contain;")
        return f'<img class="el" style="{style}" src="{src}"/>'
    if k == "text":
        style = (f"left:{el['x']*PX:.1f}px;top:{el['y']*PX:.1f}px;"
                 f"width:{el['w']*PX:.1f}px;height:{el['h']*PX:.1f}px;")
        rows = []
        for p in el["paras"]:
            txt = ("&bull;&nbsp;&nbsp;" + _esc(p["t"])) if p.get("bullet") else _esc(p["t"])
            pst = (f"margin:0 0 {p.get('space',6)*PT2PX:.1f}px 0;"
                   f"font-size:{p['size']*PT2PX:.1f}px;"
                   f"font-weight:{700 if p['bold'] else 400};"
                   f"color:#{C[p['color']]};text-align:{p.get('align','left')};"
                   f"line-height:1.3;")
            if p.get("bullet"):
                pst += "padding-left:16px;text-indent:-16px;"
            rows.append(f'<p style="{pst}">{txt}</p>')
        return f'<div class="el txt" style="{style}">{"".join(rows)}</div>'
    return ""


def _esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def render_html(slides, out_path):
    parts = ["""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<title>Curating Agent Memory</title>
<style>
  :root { --stage-w:1280px; --stage-h:720px; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:#0c1620;
    font-family:%(font)s; }
  .deck { display:flex; flex-direction:column; align-items:center; gap:26px;
    padding:26px 0 60px; }
  .slide { position:relative; width:var(--stage-w); height:var(--stage-h);
    overflow:hidden; box-shadow:0 10px 40px rgba(0,0,0,.5); border-radius:6px; }
  .el { position:absolute; }
  .txt p { font-family:%(font)s; }
  .footer { position:absolute; right:%(fx).1fpx; bottom:%(fb).1fpx;
    font-size:%(fs).1fpx; letter-spacing:.3px; font-family:%(font)s;
    opacity:.55; }
  @media print {
    body { background:#fff; } .deck { gap:0; padding:0; }
    .slide { box-shadow:none; border-radius:0; page-break-after:always; }
  }
</style></head><body><div class="deck">
""" % {"font": FONT_STACK, "fs": 6 * PT2PX, "fx": 0.3 * PX, "fb": (7.5 - 7.16 - 0.26) * PX}]

    for s in slides:
        bg = C[s["bg"]]
        parts.append(f'<section class="slide" style="background:#{bg};">')
        for el in s["elements"]:
            parts.append(_html_element(el))
        fcol = C["footer_dark"] if s["dark"] else C["footer_light"]
        parts.append(f'<div class="footer" style="color:#{fcol};">{_esc(FOOTER_TEXT)}</div>')
        parts.append("</section>")
    parts.append("</div></body></html>")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("".join(parts))
    return out_path


if __name__ == "__main__":
    slides = build_slides()
    pptx_out = os.path.join(HERE, "curating-agent-memory.pptx")
    html_out = os.path.join(HERE, "curating-agent-memory.html")
    render_pptx(slides, pptx_out)
    render_html(slides, html_out)
    print("pptx:", pptx_out)
    print("html:", html_out)
    print("slides:", len(slides))
