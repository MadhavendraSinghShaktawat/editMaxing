#!/usr/bin/env python3
"""Draws the pixel-art banners in the project README.

    python3 -m venv /tmp/ftenv && /tmp/ftenv/bin/pip install fonttools brotli pillow
    /tmp/ftenv/bin/python assets/readme/make.py

Each scene is painted at a quarter of its size. The still parts become one upscaled PNG,
and everything that moves (the crew, screens, lamps, water, the cat) is drawn as pixel
rectangles with CSS animation, so it plays inside a README.

The crew wears the colours of the editors in the Shifu Dojo app. Titles are set in
Geist (Vercel, SIL Open Font License 1.1), subset and embedded, because an SVG shown
through <img> on GitHub can't load outside fonts. Viewers who ask for reduced motion
get a still frame.
"""
import base64
import html
import io
import math
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image

HERE = Path(__file__).resolve().parent
FONTS = HERE.parents[1] / "library/plugin/skills/motion-broll/engine/fonts"
PX = 4  # screen pixels per art pixel

EASE = {"lin": "linear", "step": "steps(1,end)"}
DEFAULTS = {"o": 1, "x": 0, "y": 0, "s": 1, "sx": 1, "sy": 1}


# Type ----------------------------------------------------------------------------------

class Face:
    def __init__(self, font, family, weight):
        self.font, self.family, self.weight = font, family, weight

    def embed(self, chars):
        buffer = io.BytesIO()
        self.font.save(buffer)
        buffer.seek(0)
        font = TTFont(buffer)
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["kern"]
        options.name_IDs = [0, 1, 2]
        options.drop_tables += ["meta"]
        subsetter = subset.Subsetter(options)
        subsetter.populate(text="".join(sorted(chars)) + " ")
        subsetter.subset(font)
        out = io.BytesIO()
        font.save(out)
        data = base64.b64encode(out.getvalue()).decode()
        return f"@font-face{{font-family:'{self.family}';font-weight:{self.weight};src:url(data:font/woff2;base64,{data}) format('woff2')}}"


FACES = {w: Face(instancer.instantiateVariableFont(TTFont(FONTS / "Geist-Variable.woff2"), {"wght": w}), "G", w) for w in (500, 800)}
FACES["mono"] = Face(TTFont(FONTS / "GeistMono-Medium.woff2"), "M", 500)


# The SVG -------------------------------------------------------------------------------

class Banner:
    def __init__(self, name, w, h, loop, still, label):
        self.name, self.w, self.h, self.loop, self.still, self.label = name, w, h, loop, still, label
        self.pixels, self.overlay, self.css = [], [], []
        self.used = {key: set() for key in FACES}
        self.count = 0

    def add(self, *parts):
        self.pixels.extend(parts)

    def text(self, x, y, value, size, weight, fill, anchor="start", spacing=0):
        """Text above the pixel art, with a hard drop shadow so it reads on any sky."""
        self.used[weight].update(value)
        family, w = ("M", 500) if weight == "mono" else ("G", weight)
        attrs = f' font-family="{family}" font-weight="{w}" font-size="{size}"'
        attrs += (f' text-anchor="{anchor}"' if anchor != "start" else "") + (f' letter-spacing="{spacing}"' if spacing else "")
        body = html.escape(value)
        self.overlay.append(f'<text x="{x}" y="{y + 4}" fill="#120E24" fill-opacity=".6"{attrs}>{body}</text><text x="{x}" y="{y}" fill="{fill}"{attrs}>{body}</text>')

    def anim(self, keys, origin="center", loop=None):
        """Attributes that move an element. keys are (seconds, props, timing into the next key)."""
        loop = loop or self.loop
        self.count += 1
        name = f"k{self.count}"
        state, frames = dict(DEFAULTS), []
        for key in keys:
            state = {**state, **key[1]}
            frames.append((key[0], dict(state), key[2] if len(key) > 2 else "lin"))
        if frames[0][0] > 0:
            frames.insert(0, (0, frames[0][1], "step"))
        if frames[-1][0] < loop:
            frames.append((loop, frames[-1][1], "lin"))
        moves = any(f[1][p] != DEFAULTS[p] for f in frames for p in ("x", "y", "s", "sx", "sy"))

        def style(p):
            out = f"opacity:{p['o']:.3g}"
            if moves:
                out += f";transform:translate({p['x']:.2f}px,{p['y']:.2f}px) scale({p['s'] * p['sx']:.3f},{p['s'] * p['sy']:.3f})"
            return out

        blocks = "".join(f"{t / loop * 100:.3f}%{{{style(p)};animation-timing-function:{EASE.get(e, e)}}}" for t, p, e in frames)
        self.css.append(f"@keyframes {name}{{{blocks}}}.{name}{{animation:{name} {loop}s infinite both;transform-box:fill-box;transform-origin:{origin}}}")
        return f' class="{name}" style="{style(self.at(frames, self.still % loop))}"'

    @staticmethod
    def at(frames, t):
        for (t0, a, e), (t1, b, _) in zip(frames, frames[1:]):
            if t0 <= t < t1:
                if e != "lin":
                    return a
                p = (t - t0) / (t1 - t0)
                return {k: a[k] + (b[k] - a[k]) * p for k in a}
        return frames[-1][1]

    def flip(self, frames, period, offset=0.0):
        """Cycles through sprite frames, an equal time on each, starting `offset` seconds in."""
        n = len(frames)
        out = []
        for i, art in enumerate(frames):
            on, off = period * i / n, period * (i + 1) / n
            visible = lambda t: on <= (t + offset) % period < off
            times = sorted({0.0} | {(edge - offset) % period for edge in (on, off)})
            keys = [(t, {"o": 1 if visible(t + 1e-6) else 0}, "step") for t in times]
            out.append(f"<g{self.anim(keys, loop=period)}>{art}</g>")
        return "".join(out)

    def save(self, background):
        fonts = "".join(FACES[k].embed(c) for k, c in self.used.items() if c)
        png = io.BytesIO()
        background.resize((self.w, self.h), Image.NEAREST).save(png, "PNG", optimize=True)
        css = fonts + "".join(self.css) + "@media (prefers-reduced-motion:reduce){*{animation:none!important}}"
        label = html.escape(self.label)
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" role="img" aria-label="{label}">'
            f"<title>{label}</title><!-- Built by make.py. Geist and Geist Mono: Vercel, SIL Open Font License 1.1. -->"
            f'<defs><style>{css}</style><clipPath id="frame"><rect width="{self.w}" height="{self.h}" rx="16"/></clipPath></defs>'
            f'<g clip-path="url(#frame)"><image width="{self.w}" height="{self.h}" href="data:image/png;base64,{base64.b64encode(png.getvalue()).decode()}"/>'
            f'<g transform="scale({PX})" shape-rendering="crispEdges">{"".join(self.pixels)}</g>{"".join(self.overlay)}</g></svg>'
        )
        (HERE / f"{self.name}.svg").write_text(svg)
        print(f"{self.name}.svg  {len(svg) / 1024:.0f} KB")


def sprite(rows, palette, ox, oy):
    """Pixel art from strings. Each run of one colour becomes one rect."""
    out = []
    for y, row in enumerate(rows):
        x = 0
        while x < len(row):
            c = row[x]
            if c in ". ":
                x += 1
                continue
            end = x
            while end < len(row) and row[end] == c:
                end += 1
            out.append(f'<rect x="{ox + x}" y="{oy + y}" width="{end - x}" height="1" fill="{palette[c]}"/>')
            x = end
    return "".join(out)


def box(x, y, w, h, color):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{color}"/>'


def twinkle(i):
    start = (i * 0.37) % 3
    return [(0, {"o": 1}, "step"), (start, {"o": 0.25}, "step"), (start + 0.3, {"o": 1}, "step")]


# Painting the still scene ---------------------------------------------------------------

BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]


def bayer(x, y):
    return (BAYER[(x & 3) + ((y & 3) << 2)] + 0.5) / 16


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def hash2(x, y):
    h = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 4294967296


def noise(x, y):
    xi, yi = math.floor(x), math.floor(y)
    u, v = x - xi, y - yi
    u, v = u * u * (3 - 2 * u), v * v * (3 - 2 * v)
    a, b, c, d = hash2(xi, yi), hash2(xi + 1, yi), hash2(xi, yi + 1), hash2(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


class Canvas:
    def __init__(self, w, h):
        self.img = Image.new("RGB", (w, h))
        self.w, self.h = w, h

    def px(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.img.putpixel((int(x), int(y)), hexrgb(c))

    def rect(self, x, y, w, h, c):
        for yy in range(int(y), int(y + h)):
            for xx in range(int(x), int(x + w)):
                self.px(xx, yy, c)

    def gradient(self, y0, y1, stops):
        """A dithered vertical gradient through a list of colours."""
        for y in range(y0, y1):
            t = (y - y0) / max(1, y1 - y0 - 1) * (len(stops) - 1)
            i = min(int(t), len(stops) - 2)
            for x in range(self.w):
                self.px(x, y, stops[i + 1] if t - i > bayer(x, y) else stops[i])

    def sprite(self, rows, palette, ox, oy):
        for y, row in enumerate(rows):
            for x, c in enumerate(row):
                if c not in ". ":
                    self.px(ox + x, oy + y, palette[c])

    def boards(self, x, y, w, h, tones, seam, board, vertical=True):
        """Wooden boards with seams, each board a slightly different tone along its length."""
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                a, b = (xx - x, yy - y) if vertical else (yy - y, xx - x)
                lane = a // board
                if a % board == board - 1:
                    self.px(xx, yy, seam)
                else:
                    self.px(xx, yy, tones[int(hash2(lane, (b + lane * 7) // 14) * len(tones))])

    def water(self, top, stops, sparkle_top, sparkle_low):
        self.gradient(top, self.h, stops)
        for y in range(top + 1, self.h, 2):
            for x in range(self.w):
                if noise(x / 7, y * 1.7) > 0.72:
                    self.px(x, y, sparkle_top if y < top + 5 else sparkle_low)


FONT3 = {  # a small pixel font for signs
    "S": ["###", "#..", "###", "..#", "###"], "H": ["#.#", "#.#", "###", "#.#", "#.#"], "I": ["###", ".#.", ".#.", ".#.", "###"],
    "F": ["###", "#..", "##.", "#..", "#.."], "U": ["#.#", "#.#", "#.#", "#.#", "###"], "D": ["##.", "#.#", "#.#", "#.#", "##."],
    "O": ["###", "#.#", "#.#", "#.#", "###"], "J": ["..#", "..#", "..#", "#.#", "###"], " ": ["..", "..", "..", "..", ".."],
    "A": ["###", "#.#", "###", "#.#", "#.#"], "B": ["##.", "#.#", "##.", "#.#", "##."], "C": ["###", "#..", "#..", "#..", "###"],
    "L": ["#..", "#..", "#..", "#..", "###"], "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#"], "N": ["#..#", "##.#", "#.##", "#..#", "#..#"],
    "P": ["###", "#.#", "###", "#..", "#.."], "R": ["##.", "#.#", "##.", "#.#", "#.#"], "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "-": ["..", "..", "##", "..", ".."],
}


def text_width(text):
    return sum(len(FONT3[ch][0]) + 1 for ch in text) - 1


def pixel_text(c, x, y, text, color):
    for ch in text:
        glyph = FONT3[ch]
        c.sprite([row.replace("#", "a") for row in glyph], {"a": color}, x, y)
        x += len(glyph[0]) + 1


# The crew ------------------------------------------------------------------------------

# Shirts, hair, skin and trousers of the editors in the app.
CREW = [
    {"shirt": "#F28A2E", "hair": "#2B1D1A", "skin": "#E6AE80", "pants": "#2F5D6E", "phones": "#F6EFE0"},
    {"shirt": "#17A5A0", "hair": "#7D3F22", "skin": "#F8D2AC", "pants": "#6D4A33"},
    {"shirt": "#7F55D4", "hair": "#3A2318", "skin": "#E6AE80", "pants": "#2E2A3D"},
    {"shirt": "#D9403A", "hair": "#1E1720", "skin": "#BD7F52", "pants": "#2C3F5E"},
    {"shirt": "#45A85A", "hair": "#2B1D1A", "skin": "#BD7F52", "pants": "#5D3622"},
    {"shirt": "#3D7FD9", "hair": "#231815", "skin": "#8A5433", "pants": "#EFE0BD"},
    {"shirt": "#F2C230", "hair": "#17121A", "skin": "#8A5433", "pants": "#4F3A60"},
]


def shade(hexcolor, k=0.78):
    r, g, b = hexrgb(hexcolor)
    return "#%02X%02X%02X" % (int(r * k), int(g * k), int(b * k))


def seated(look, typing):
    """An editor at a desk, seen from behind. Two frames: hands down, hands up."""
    p = {"h": look["hair"], "s": look["skin"], "t": look["shirt"], "d": shade(look["shirt"]), "p": look["pants"], "w": "#5A3420", "e": look.get("phones", look["hair"])}
    head = [".hhhhh.", "ehhhhhe", "ehhhhhe", ".hhhhh.", "..sss.."] if "phones" in look else [".hhhhh.", "hhhhhhh", "hhhhhhh", ".hhhhh.", "..sss.."]
    arms = ["sttttts", "dtttttd", ".ttttt."] if typing else ["ttttttt", "dtttttd", "dtttttd"]
    body = [".ttttt.", ".ppppp.", "wwwwwww", ".w...w.", ".w...w."]
    return sprite(head + arms + body, p, 0, 0)


def walker(look, step):
    """Side view, carrying a film can."""
    p = {"h": look["hair"], "s": look["skin"], "t": look["shirt"], "d": shade(look["shirt"]), "p": look["pants"], "b": "#2D1B16", "r": "#1B1E2B", "g": "#C9CED8"}
    top = ["..hhh.", ".hhhhs", ".hhsss", "..sss.", "..tt..", ".tttt.", ".tdtrr", ".tttrg", ".tttt."]
    legs = ["..pp..", ".p..p.", "b....b"] if step else ["..pp..", "..pp..", "..bb.."]
    return sprite(top + legs, p, 0, 0)


CAT = {"k": "#1D1A24", "y": "#F2C230"}


def cat(tail_up):
    rows = ["k.k.....", "kkk.....", "kyk.....", "kkkk...k", "kkkkk..k", "kkkkkkkk"] if tail_up else ["k.k.....", "kkk.....", "kyk.....", "kkkk....", "kkkkk...", "kkkkkkkk"]
    return sprite(rows, CAT, 0, 0)


BUBBLE = [".wwwwwww.", "wwwwwwwww", "wwwwwwwww", "wwwwwwwww", "wwwwwwwww", "wwwwwwwww", ".wwwwwww.", "..ww.....", "..w......"]
ICONS = {
    "cut": ["i...i", ".i.i.", "..i..", ".i.i.", "ii.ii"],
    "note": ["..iii", "..i.i", "..i..", "iii..", "iii.."],
    "star": ["..i..", ".iii.", "iiiii", ".iii.", "..i.."],
    "heart": [".i.i.", "iiiii", "iiiii", ".iii.", "..i.."],
    "type": ["iiiii", "..i..", "..i..", "..i..", "..i.."],
    "film": ["iiiii", "i.i.i", "iiiii", "i.i.i", "iiiii"],
}


def bubble(icon, color):
    return sprite(BUBBLE, {"w": "#FFF7E6"}, 0, 0) + sprite(ICONS[icon], {"i": color}, 2, 1)


def pop(b, art, x, y, times, hold=1.6):
    """A speech bubble that pops up at the given times, like the ones over the crew in the app."""
    keys = [(0, {"o": 0, "y": 2}, "step")]
    for t in times:
        keys += [(t, {"o": 1, "y": 1}, "step"), (t + 0.1, {"o": 1, "y": 0}, "step"), (t + hold, {"o": 0, "y": 2}, "step")]
    return f'<g transform="translate({x} {y})"><g{b.anim(keys, "center bottom")}>{art}</g></g>'


# Shared pieces of the studio -----------------------------------------------------------

WOOD = ["#C77A45", "#BF7140", "#CF8650"]
WALL = ["#E3A76B", "#DA9C60", "#E8B077", "#D49558"]
THATCH = ["#B9771F", "#D2932A", "#EAB23D", "#F6C958", "#FFDF85"]


def desk(c, dx):
    """A desk with a dark monitor. The screen is at (dx + 8, 57), 12 by 8."""
    c.rect(dx, 67, 28, 2, "#8A5230")
    c.rect(dx, 67, 28, 1, "#A86A40")
    c.rect(dx + 1, 69, 1, 10, "#6A3E26")
    c.rect(dx + 26, 69, 1, 10, "#6A3E26")
    c.rect(dx + 7, 56, 14, 10, "#1B1E2B")
    c.rect(dx + 13, 66, 2, 1, "#1B1E2B")
    c.rect(dx + 8, 57, 12, 8, "#0F2233")
    c.rect(dx + 23, 65, 3, 2, "#F6EFE0")


def timeline(b, sx, sy):
    b.add(box(sx + 1, sy + 1, 6, 1, "#5B8DEF") + box(sx + 8, sy + 1, 3, 1, "#5B8DEF") + box(sx + 1, sy + 3, 4, 1, "#4CC38A") + box(sx + 6, sy + 3, 5, 1, "#4CC38A") + box(sx + 2, sy + 5, 8, 1, "#F2C230"))
    b.add(f'<rect x="{sx}" y="{sy}" width="1" height="8" fill="#FFF7E6"{b.anim([(0, {"x": 0}, "steps(11,end)"), (2.2, {"x": 11}, "step"), (2.4, {"x": 11})], "left top", loop=2.4)}/>')


def meter(b, sx, sy):
    for i, heights in enumerate(([3, 6, 4, 8, 2], [5, 2, 7, 3, 6], [2, 5, 3, 6, 4], [6, 3, 5, 2, 7], [4, 7, 2, 5, 3], [7, 4, 6, 3, 5])):
        keys = [(k * 0.18, {"sy": h / 8}, "step") for k, h in enumerate(heights)]
        b.add(f'<rect x="{sx + 1 + i * 2}" y="{sy}" width="1" height="8" fill="{"#4CC38A" if i < 4 else "#F2C230"}"{b.anim(keys, "center bottom", loop=0.9)}/>')


def motion_screen(b, sx, sy):
    path = [(1, 3), (3, 1), (6, 0), (9, 1), (10, 3), (8, 4), (5, 4), (2, 4)]
    b.add(f'<rect x="{sx}" y="{sy + 1}" width="2" height="2" fill="#F07FA8"{b.anim([(i * 0.25, {"x": x, "y": y}, "step") for i, (x, y) in enumerate(path)], "left top", loop=2.0)}/>')
    b.add(box(sx, sy + 7, 12, 1, "#3D3A5C"))
    b.add(f'<rect x="{sx}" y="{sy + 7}" width="12" height="1" fill="#A78BFA"{b.anim([(0, {"sx": 1 / 12}, "steps(11,end)"), (2.0, {"sx": 1})], "left center", loop=2.0)}/>')


def broll_screen(b, sx, sy):
    """A grid of clips that keeps reshuffling as the editor searches."""
    tones = ["#F2A65E", "#7FC8E8", "#3F4A57", "#9FE2E8", "#F07FA8", "#45A85A"]
    for i in range(6):
        x, y = sx + (i % 3) * 4, sy + 1 + (i // 3) * 3
        frames = [box(x, y, 3, 2, tones[(i + k) % 6]) for k in range(3)]
        b.add(b.flip(frames, 1.8, i * 0.21))
    b.add(f'<rect x="{sx}" y="{sy}" width="4" height="4" fill="none" stroke="#FFF7E6" stroke-width=".5"{b.anim([(0, {"x": 0, "y": 0}, "step"), (0.6, {"x": 4, "y": 0}, "step"), (1.2, {"x": 8, "y": 3}, "step"), (1.8, {"x": 4, "y": 3}, "step")], "left top", loop=2.4)}/>')


def caption_screen(b, sx, sy):
    """A speaker, and captions arriving one word at a time."""
    b.add(box(sx + 4, sy + 1, 4, 3, "#BD7F52") + box(sx + 3, sy + 4, 6, 3, "#3D7FD9"))
    for i, (x, w) in enumerate(((1, 3), (5, 2), (8, 3))):
        keys = [(0, {"o": 0}, "step"), (0.3 + i * 0.35, {"o": 1}, "step"), (2.0, {"o": 0}, "step")]
        b.add(f'<rect x="{sx + x}" y="{sy + 6}" width="{w}" height="1" fill="{"#F2C230" if i == 1 else "#FFF7E6"}"{b.anim(keys, loop=2.4)}/>')


def lamp_glow(b, x, y, r):
    glow = f'<circle cx="{x + 0.5}" cy="{y}" r="{r}" fill="#FFC76A" fill-opacity=".16"/><circle cx="{x + 0.5}" cy="{y}" r="{r * 0.55:.1f}" fill="#FFC76A" fill-opacity=".16"/>'
    b.add(f'<g{b.anim([(0, {"o": 1}, "step"), (1.1, {"o": 0.7}, "step"), (1.3, {"o": 1}, "step"), (2.6, {"o": 0.85}, "step"), (2.8, {"o": 1}, "step")], loop=3.4 + (x % 7) * 0.1)}>{glow}</g>')


def stars(b, points):
    for i, (sx, sy) in enumerate(points):
        b.add(f'<rect x="{sx}" y="{sy}" width="1" height="1" fill="#FFF3D6"{b.anim(twinkle(i), loop=3 + i % 3)}/>')


def editor_at(b, look, dx, period, offset):
    frames = [f'<g transform="translate({dx + 10} 66)">{seated(look, typing)}</g>' for typing in (False, True)]
    b.add(b.flip(frames, period, offset))


# Banner 1: the studio at golden hour ---------------------------------------------------

W, H = 300, 105
WATER = 90


def paint_hero():
    c = Canvas(W, H)
    c.gradient(0, WATER, ["#141532", "#1B1C40", "#26224D", "#352858", "#513060", "#83405F", "#C25A5A", "#EC8752", "#FBB560"])
    # The low sun and the far island with its palms.
    for y in range(78, WATER):
        for x in range(56, 86):
            d = math.hypot(x - 70.5, y - 90)
            if d < 10.5:
                c.px(x, y, "#FFF0B8" if d < 7 else "#FFD27A")
    for x in range(0, 48):
        top = 86 - int(3 * math.sin(x / 9) + 2 * noise(x / 5, 3))
        for y in range(top, WATER):
            c.px(x, y, "#3A2242")
    for root, height in ((14, 12), (31, 15)):
        for k in range(height):
            c.px(root + k // 6, 86 - k, "#3A2242")
        tx, ty = root + height // 6, 86 - height
        for dx, dy in ((-4, 1), (-3, 0), (-2, -1), (-1, -1), (1, -1), (2, -1), (3, 0), (4, 1), (-5, 2), (5, 2), (0, -2)):
            c.px(tx + dx, ty + dy, "#3A2242")
    # Water, the sun's path across it, lily pads.
    c.water(WATER, ["#C96A5A", "#7A4466", "#4A3460", "#2C2752", "#1E1D45"], "#F29A62", "#5C4778")
    for y in range(WATER, H, 2):
        half = 9 - (y - WATER) * 0.45
        for x in range(int(70 - half), int(71 + half)):
            if (x + y * 3) % 5 < 3:
                c.px(x, y, "#FFD27A")
    for lx, ly in ((104, 98), (124, 101), (44, 99), (294, 99)):
        c.rect(lx, ly, 6, 2, "#3F7F5A")
        c.rect(lx + 1, ly - 1, 4, 1, "#5DA06E")
        c.px(lx + 3, ly, "#2C5E42")

    # Stilts and the dock.
    for sx in (146, 168, 192, 216, 240, 264, 287):
        c.rect(sx, 84, 3, 13, "#4A2A1A")
        c.rect(sx, 84, 1, 13, "#6A3E26")
        c.rect(sx - 1, 96, 5, 1, "#8B6A98")
    for sx in (88, 112):
        c.rect(sx, 84, 2, 12, "#4A2A1A")
        c.rect(sx - 1, 95, 4, 1, "#8B6A98")
    c.boards(84, 80, 58, 4, WOOD, "#7A4428", 2, vertical=False)
    c.rect(84, 80, 58, 1, "#E6A069")
    c.boards(140, 79, 156, 5, WOOD, "#7A4428", 5, vertical=False)
    c.rect(140, 79, 156, 1, "#E6A069")
    c.rect(140, 84, 156, 1, "#5A3420")
    for lx in (89, 137):
        c.rect(lx, 70, 1, 10, "#4A2A1A")
        c.rect(lx - 1, 69, 3, 1, "#3A2214")

    # The back wall and three rooms.
    c.boards(146, 47, 144, 32, WALL, "#B47A45", 6)
    for rx, rw, rug, edge in ((146, 48, "#2F8F83", "#257369"), (197, 45, "#C8473B", "#A23A30"), (245, 45, "#6B5FB5", "#564C94")):
        c.rect(rx, 77, rw, 2, rug)
        c.rect(rx, 78, rw, 1, edge)
        for k in range(rx + 2, rx + rw - 2, 4):
            c.px(k, 77, "#F6EFE0")
    for wx in (142, 194, 242, 290):
        c.rect(wx, 46, 3 if wx in (194, 242) else 4, 33, "#7A4428")
        c.rect(wx, 46, 1, 33, "#9A5A34")
    c.rect(142, 46, 152, 2, "#5A3420")
    for dx in (152, 203, 251):
        desk(c, dx)
    # A plant and a poster in the cutting room.
    c.rect(184, 70, 6, 9, "#B8603A")
    c.rect(184, 70, 6, 1, "#D07848")
    for k, (dx, dy) in enumerate(((0, -5), (2, -7), (4, -5), (1, -3), (3, -3), (5, -6), (-1, -6))):
        c.rect(185 + dx, 70 + dy, 2, 3 + k % 2, "#3E8F55" if k % 2 else "#5DB06E")
    c.rect(148, 51, 10, 12, "#F6EFE0")
    c.rect(149, 52, 8, 6, "#F28A2E")
    c.rect(149, 59, 8, 1, "#2B1D1A")
    c.rect(149, 61, 5, 1, "#2B1D1A")
    # Speakers in the sound room.
    for sx in (199, 236):
        c.rect(sx, 63, 5, 16, "#2E2A3D")
        c.rect(sx + 1, 65, 3, 3, "#4F4A63")
        c.rect(sx + 1, 70, 3, 4, "#4F4A63")
        c.px(sx + 2, 66, "#1B1E2B")
        c.px(sx + 2, 72, "#1B1E2B")
    # Books and a poster in the motion room.
    c.rect(281, 50, 9, 29, "#7A4428")
    for k, shelf in enumerate((56, 63, 70, 77)):
        c.rect(281, shelf, 9, 1, "#5A3420")
        for j in range(4):
            c.rect(282 + j * 2, shelf - 5 + (j + k) % 2, 2, 5 - (j + k) % 2, ["#F2C230", "#3D7FD9", "#D9403A", "#45A85A", "#F07FA8"][(j + k) % 5])
    c.rect(247, 51, 9, 9, "#F6EFE0")
    c.sprite(ICONS["star"], {"i": "#7F55D4"}, 249, 53)
    for lx in (170, 219, 267):
        c.rect(lx, 48, 1, 3, "#3A2214")
        c.rect(lx - 2, 51, 5, 2, "#FFCF6B")
        c.rect(lx - 2, 51, 5, 1, "#E8A03A")

    # Chimney, then the thatched roof over it, then the sign.
    c.rect(256, 12, 6, 20, "#6B6470")
    c.rect(255, 11, 8, 2, "#857D8C")
    c.rect(257, 14, 1, 16, "#7E7685")
    for y in range(20, 47):
        f = (y - 20) / 26
        for x in range(int(184 - f * 50), int(250 + f * 50)):
            if y >= 44 and hash2(x, 3) * 3 < y - 43.5:
                continue
            v = noise(x * 0.5, y * 0.14) * 0.65 + noise(x * 0.09, y * 0.4) * 0.35 + (0.25 - f * 0.35) + (bayer(x, y) - 0.5) * 0.08
            c.px(x, y, THATCH[max(0, min(4, int(v * 7 - 1.6)))])
    c.rect(182, 19, 70, 2, "#8A5A20")
    c.rect(186, 18, 62, 1, "#A06A26")
    c.rect(196, 29, 44, 9, "#3A2214")
    c.rect(197, 30, 42, 7, "#5A3420")
    pixel_text(c, 200, 31, "SHIFU DOJO", "#FFE9B0")
    return c


def hero():
    b = Banner("hero", W * PX, H * PX, 12, 3.2, "Shifu Dojo: automated video editing with Claude. A pixel-art editing studio on stilts over a lagoon at golden hour, where editors work at their screens, one carries film along the dock and a cat watches.")
    bg = paint_hero()

    stars(b, ((132, 6), (158, 3), (176, 11), (206, 6), (229, 13), (284, 5), (296, 16), (122, 20), (274, 28), (143, 25)))
    for cx, cy, w in ((120, 34, 18), (208, 8, 14), (104, 52, 12)):
        cloud = box(cx + 3, cy, w - 6, 1, "#B9637A") + box(cx, cy + 1, w, 2, "#8E4F70") + box(cx + 2, cy + 3, w - 4, 1, "#6E4068")
        b.add(f'<g{b.anim([(0, {"x": 0}, "steps(4,end)"), (6, {"x": 4}, "steps(4,end)"), (12, {"x": 0})])}>{cloud}</g>')

    for lx, ly, r in ((170, 53, 9), (219, 53, 9), (267, 53, 9), (89, 67, 6), (137, 67, 6)):
        lamp_glow(b, lx, ly, r)
    for lx in (88, 136):
        b.add(b.flip([box(lx, 66, 3, 3, "#FFCF6B") + box(lx + 1, 67, 1, 1, "#FFF0B8"), box(lx, 66, 3, 3, "#F2B04E") + box(lx + 1, 67, 1, 1, "#FFE08A")], 0.9, (lx % 5) * 0.1))

    timeline(b, 160, 57)
    meter(b, 211, 57)
    motion_screen(b, 259, 57)
    for k, dx in enumerate((152, 203, 251)):
        editor_at(b, CREW[k], dx, (0.34, 0.42, 0.3)[k], k * 0.11)
    b.add(pop(b, bubble("cut", "#D9403A"), 174, 52, [0.6, 6.6]))
    b.add(pop(b, bubble("note", "#17A5A0"), 225, 52, [2.6, 8.6]))
    b.add(pop(b, bubble("star", "#7F55D4"), 273, 52, [4.4, 10.4]))

    # One editor carries film along the dock and back.
    steps_ = b.flip([walker(CREW[3], s) for s in (0, 1)], 0.36)
    route = [(0, {"x": 0, "sx": 1}, "steps(30,end)"), (5.2, {"x": 30, "sx": 1}, "step"), (6.0, {"x": 30, "sx": -1}, "steps(30,end)"), (11.2, {"x": 0, "sx": -1}, "step"), (12, {"x": 0, "sx": 1})]
    b.add(f'<g transform="translate(102 68)"><g{b.anim(route)}>{steps_}</g></g>')
    b.add(pop(b, bubble("heart", "#D9403A"), 130, 57, [5.3]))

    # The cat at the end of the dock, and a fish that jumps now and then.
    b.add(f'<g transform="translate(83 74)">{b.flip([cat(True), cat(False)], 1.6)}</g>')
    b.add(f'<g{b.anim([(0, {"o": 0}, "step"), (4.0, {"o": 1}, "step"), (4.15, {"o": 0}, "step")], loop=5.5)}>{box(84, 76, 1, 1, "#1D1A24")}</g>')
    fish = box(0, 0, 3, 1, "#F28A2E") + box(3, 0, 1, 1, "#C95E2A") + box(1, -1, 1, 1, "#F6A55E")
    arc = [(0, {"o": 0, "x": 0, "y": 0}, "step")]
    for k in range(9):
        arc.append((7.45 + k * 0.09, {"o": 1, "x": k, "y": -int(10 * math.sin(k / 8 * math.pi))}, "step"))
    arc.append((8.3, {"o": 0, "x": 8, "y": 0}, "step"))
    b.add(f'<g transform="translate(116 91)"><g{b.anim(arc, "left top")}>{fish}</g></g>')
    for ox, t in ((116, 7.4), (124, 8.25)):
        splash = box(ox - 1, 90, 1, 1, "#FFF3D6") + box(ox + 3, 90, 1, 1, "#FFF3D6") + box(ox + 1, 89, 1, 1, "#FFF3D6")
        b.add(f'<g{b.anim([(0, {"o": 0}, "step"), (t, {"o": 1}, "step"), (t + 0.35, {"o": 0}, "step")])}>{splash}</g>')

    # Sun glints on the water, smoke from the chimney, fireflies.
    for k in range(3):
        y = WATER + 1 + k * 4
        a = "".join(box(x, y, 2, 1, "#FFE3A0") for x in range(61 + k * 2, 81 - k * 2, 6))
        a2 = "".join(box(x + 3, y, 2, 1, "#FFE3A0") for x in range(61 + k * 2, 79 - k * 2, 6))
        b.add(b.flip([a, a2], 1.0, k * 0.3))
    for k in range(3):
        keys = [(0, {"o": 0.8, "y": 0, "x": 0}, "steps(8,end)"), (3.0 + k * 0.5, {"o": 0, "y": -10, "x": 4})]
        b.add(f'<rect x="{257 + k}" y="{9 - k}" width="2" height="2" fill="#D8CFE0"{b.anim(keys, loop=3.0 + k * 0.5)}/>')
    for k, (fx, fy) in enumerate(((126, 66), (148, 88), (100, 62), (138, 58))):
        keys = [(0, {"x": 0, "y": 0, "o": 0.2}, "steps(3,end)"), (1.2, {"x": 2, "y": -2, "o": 1}, "steps(3,end)"), (2.4, {"x": 4, "y": 0, "o": 0.3}, "steps(3,end)"), (3.6, {"x": 2, "y": 2, "o": 1}, "steps(3,end)"), (4.8, {"x": 0, "y": 0, "o": 0.2})]
        b.add(f'<rect x="{fx}" y="{fy}" width="1" height="1" fill="#FFF0A0"{b.anim(keys, loop=4.8 + k * 0.4)}/>')

    b.text(64, 104, "OPEN-SOURCE AI VIDEO STUDIO", 12.5, "mono", "#FFC56A", spacing=2.4)
    b.text(64, 166, "Shifu Dojo", 58, 800, "#FFF7E6", spacing=-1.6)
    b.text(64, 206, "Automated video editing with Claude,", 19, 500, "#E8DCF0")
    b.text(64, 232, "on your own Mac.", 19, 500, "#E8DCF0")
    b.save(bg.img)


# Banner 2: the crew, one room for each part of an edit ---------------------------------

ROOMS = [  # sign, rug, rug edge, editor, screen
    ("CUTS", "#2F8F83", "#257369", 3, timeline, "cut", "#D9403A"),
    ("B-ROLL", "#C8473B", "#A23A30", 1, broll_screen, "film", "#17A5A0"),
    ("CAPTIONS", "#D08A2A", "#A86E1E", 5, caption_screen, "type", "#3D7FD9"),
    ("MOTION", "#6B5FB5", "#564C94", 2, motion_screen, "star", "#7F55D4"),
    ("SOUND", "#3F7F5A", "#2C5E42", 0, meter, "note", "#45A85A"),
]


def room_x(i):
    return 10 + i * 57


def paint_crew():
    c = Canvas(W, H)
    c.gradient(0, WATER, ["#141532", "#191A3E", "#22204A", "#2E2654", "#3E2C5C", "#5A3462", "#7E3E62"])
    c.water(WATER, ["#6A3A64", "#4A3460", "#2C2752", "#1E1D45"], "#8E4F70", "#4A3C70")
    for sx in range(12, 292, 24):
        c.rect(sx, 84, 3, 13, "#4A2A1A")
        c.rect(sx, 84, 1, 13, "#6A3E26")
        c.rect(sx - 1, 96, 5, 1, "#6B5C94")
    c.boards(4, 79, 292, 5, WOOD, "#7A4428", 5, vertical=False)
    c.rect(4, 79, 292, 1, "#E6A069")
    c.rect(4, 84, 292, 1, "#5A3420")
    c.boards(10, 47, 282, 32, WALL, "#B47A45", 6)
    # A low thatched eave along the whole roof line.
    for y in range(36, 47):
        for x in range(2, 298):
            if y >= 44 and hash2(x, 5) * 3 < y - 43.5:
                continue
            v = noise(x * 0.5, y * 0.3) * 0.7 + noise(x * 0.09, y * 0.5) * 0.3 + (bayer(x, y) - 0.5) * 0.08 + (0.2 - (y - 36) * 0.02)
            c.px(x, y, THATCH[max(0, min(4, int(v * 7 - 1.4)))])
    c.rect(2, 35, 296, 1, "#8A5A20")
    for i, (sign, rug, edge, *_rest) in enumerate(ROOMS):
        x0 = room_x(i)
        c.rect(x0, 77, 54, 2, rug)
        c.rect(x0, 78, 54, 1, edge)
        for k in range(x0 + 2, x0 + 52, 4):
            c.px(k, 77, "#F6EFE0")
        w = text_width(sign)
        c.rect(x0 + 27 - w // 2 - 3, 48, w + 6, 8, "#3A2214")
        c.rect(x0 + 27 - w // 2 - 2, 49, w + 4, 6, "#5A3420")
        pixel_text(c, x0 + 27 - w // 2, 50, sign, "#FFE9B0")
        desk(c, x0 + 13)
    for wx in (7, 64, 121, 178, 235, 292):
        c.rect(wx, 46, 3, 33, "#7A4428")
        c.rect(wx, 46, 1, 33, "#9A5A34")
    c.rect(7, 46, 288, 1, "#5A3420")
    # A shelf of film cans in the B-roll room, speakers in the sound room, plants by the doors.
    for k in range(3):
        c.rect(room_x(1) + 3, 60 + k * 6, 8, 1, "#5A3420")
        for j in range(3):
            c.rect(room_x(1) + 3 + j * 3, 57 + k * 6, 2, 3, ["#C9CED8", "#1B1E2B", "#F28A2E"][(j + k) % 3])
    for sx in (room_x(4) + 3, room_x(4) + 46):
        c.rect(sx, 63, 5, 16, "#2E2A3D")
        c.rect(sx + 1, 65, 3, 3, "#4F4A63")
        c.rect(sx + 1, 70, 3, 4, "#4F4A63")
    for px_ in (room_x(0) + 45, room_x(2) + 45, room_x(3) + 45):
        c.rect(px_, 72, 5, 7, "#B8603A")
        c.rect(px_, 72, 5, 1, "#D07848")
        for k, (dx, dy) in enumerate(((0, -4), (2, -6), (4, -4), (1, -2), (3, -3))):
            c.rect(px_ + dx, 72 + dy, 1, 3, "#3E8F55" if k % 2 else "#5DB06E")
    return c


def crew():
    b = Banner("crew", W * PX, H * PX, 10, 2.2, "Meet the crew: one room of the studio for each part of an edit. Editors cut, pick B-roll, caption, build motion graphics and mix sound, each at their own screen.")
    bg = paint_crew()
    stars(b, ((150, 6), (176, 14), (204, 4), (230, 10), (258, 3), (284, 12), (296, 24), (166, 26), (214, 22), (246, 28), (272, 30)))
    for i, (_sign, _rug, _edge, who, screen, icon, color) in enumerate(ROOMS):
        x0 = room_x(i)
        dx = x0 + 13
        screen(b, dx + 8, 57)
        editor_at(b, CREW[who], dx, (0.34, 0.4, 0.3, 0.36, 0.42)[i], i * 0.07)
        b.add(pop(b, bubble(icon, color), dx + 21, 56, [0.3 + i * 1.8], hold=1.6))
    # The studio cat naps on the sound room rug.
    b.add(f'<g transform="translate({room_x(4) + 40} 71)">{b.flip([cat(True), cat(False)], 1.8)}</g>')
    b.text(64, 52, "MEET THE CREW", 12.5, "mono", "#FFC56A", spacing=2.4)
    b.text(64, 100, "One studio, every part of the edit", 34, 800, "#FFF7E6", spacing=-0.8)
    b.save(bg.img)


# Banner 3: the credits, the crew rowing home under the moon ----------------------------

FW, FH = 300, 55


def paint_credits():
    c = Canvas(FW, FH)
    c.gradient(0, 40, ["#0E0F26", "#15163A", "#1B1B42", "#211F4A", "#352A5C", "#4E3466"])
    for y in range(6, 20):
        for x in range(235, 249):
            if math.hypot(x - 241.5, y - 12.5) < 5.2:
                c.px(x, y, "#FFF3D6" if math.hypot(x - 240.5, y - 11.5) < 4.2 else "#E8DCC0")
    for x in range(FW):
        if x < 70 or x > 210:
            for y in range(38 - int(2 * noise(x / 14, 1) + 1.5 * math.sin(x / 23)), 40):
                c.px(x, y, "#1E1838")
    c.water(40, ["#3A2C5C", "#262250", "#191A3C", "#121331"], "#4A3C70", "#4A3C70")
    return c


def credits():
    b = Banner("credits", FW * PX, FH * PX, 16, 6, "Thanks for watching: the crew rows a little boat home across the lagoon under the moon.")
    bg = paint_credits()
    stars(b, ((20, 4), (48, 9), (77, 3), (110, 4), (150, 3), (182, 5), (210, 3), (268, 6), (290, 14), (62, 20), (226, 24), (30, 28)))
    for k in range(4):
        y = 42 + k * 2
        a = "".join(box(x, y, 2, 1, "#E8DCC0") for x in range(234 + k, 250 - k, 5))
        a2 = "".join(box(x + 2, y, 2, 1, "#E8DCC0") for x in range(234 + k, 248 - k, 5))
        b.add(b.flip([a, a2], 1.1, k * 0.25))
    boat = box(0, -1, 30, 1, "#A86A40") + box(0, 0, 30, 2, "#8A5230") + box(1, 2, 28, 1, "#6A3E26") + box(3, 3, 24, 1, "#4A2A1A")
    boat += box(28, -6, 1, 5, "#4A2A1A") + box(27, -8, 3, 2, "#FFCF6B") + '<circle cx="28.5" cy="-7" r="5" fill="#FFC76A" fill-opacity=".18"/>'
    for k, look in enumerate((CREW[4], CREW[5], CREW[0])):
        boat += sprite(["hhh", "hss", "sss", "ttt", "tdt"], {"h": look["hair"], "s": look["skin"], "t": look["shirt"], "d": shade(look["shirt"])}, 5 + k * 8, -6)
    oar = "#C9A06A"
    back = "".join(box(x + 9, -2, 1, 1, oar) + box(x + 10, -1, 1, 1, oar) + box(x + 11, 0, 1, 3, oar) for x in (0, 8))
    forward = "".join(box(x + 8, -2, 1, 1, oar) + box(x + 7, -1, 1, 1, oar) + box(x + 6, 0, 1, 3, oar) for x in (0, 8))
    wake = box(-4, 3, 3, 1, "#6B5C94") + box(-9, 3, 3, 1, "#4A3C70")
    rowing = b.flip([f"<g>{boat}{back}</g>", f'<g transform="translate(0 1)">{boat}{forward}</g>'], 0.8)
    b.add(f'<g transform="translate(-34 44)"><g{b.anim([(0, {"x": 0}, "steps(184,end)"), (16, {"x": 368})], "left top")}>{wake}{rowing}</g></g>')
    b.text(600, 78, "Thanks for watching.", 30, 800, "#FFF7E6", "middle", -0.6)
    b.text(600, 110, "shifu dojo  ·  open source  ·  made with claude", 12, "mono", "#E8DCF0", "middle", 2.2)
    b.save(bg.img)


if __name__ == "__main__":
    hero()
    crew()
    credits()
