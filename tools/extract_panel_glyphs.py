"""Turn the drawn glyph sheets in reference/panel_glyphs into web/js/pg300_glyphs.js.

The PG-300 prints a little picture beside some of its sliders instead of a
number: waveforms for the DCO, envelope shapes for the three ENV MODE switches.
Those are drawn in Inkscape, one file per slider, as a vertical stack of cells
with one cell per switch position.  This script lifts the drawings out of those
files and writes them as a JavaScript module the panel can draw directly.

Why a generated module rather than loading the SVGs at runtime:

  * The panel is built synchronously at startup, on purpose -- the page opens on
    it, so the first paint should already be the view the app is about to show.
    Fetching and parsing six files would make that async for no gain.
  * The panel is dark.  The artwork is black on transparent, so it has to arrive
    as paths that CSS can recolour, not as <image>.
  * js/pg300.js already carries geometry transcribed by hand from the panel
    drawing.  A generated transcription of the glyphs is the same bargain, only
    checked by a machine instead of by eye.

What comes out is in the *sheet's* own units, not the panel's.  Each mark is
placed relative to the centre of its cell, and js/pg300.js scales the cell down
to the size a slider has room for.  Keeping the two coordinate systems apart is
what lets the artwork be redrawn without touching the panel, and the other way
about.

Two things are deliberately dropped.  The cell rectangles are alignment guides,
not panel legend -- no synth has boxes round its waveforms.  Text is dropped
too: the OFF in the pulse and sawtooth sheets is already drawn by the panel's
own tick mechanism, in the panel's own font, and the DYN bracket beside the ENV
MODE sheets does not fit in the space those two sliders have (see GLYPH in
js/pg300.js for the widths).

Run it from the repository root:

    python3 tools/extract_panel_glyphs.py

It rewrites web/js/pg300_glyphs.js in place and prints a summary to check
against the drawings.
"""

import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SVG_NS = 'http://www.w3.org/2000/svg'
ROOT = Path(__file__).resolve().parent.parent
SHEETS = ROOT / 'reference' / 'panel_glyphs'
OUTPUT = ROOT / 'web' / 'js' / 'pg300_glyphs.js'

# The height every cell is drawn at, which is how a cell is told from any other
# rectangle in the file.  Width varies: the two low sub-oscillator waveforms are
# drawn elongated, as they are on the real panel, and get a wider box.
CELL_HEIGHT = 55.723171
CELL_TOLERANCE = 0.5

# A mark drawn in this colour is a ghost -- the dotted part of a waveform, where
# the panel is showing the shape sweeping rather than a line that is really
# there.  Colour is the tag because it is the one thing that survives being
# drawn, saved and reopened; the dash pattern itself is set in the stylesheet,
# in units the panel can actually see.  See .pg300-glyph-ghost in css/app.css.
GHOST_STROKE = '#666666'

# Which sheet belongs to which parameter, and which end of the stack value 0 is
# drawn at.  The sheets are drawn the way the slider reads on screen, so a sheet
# whose slider is flipped has value 0 at the top.  Naming the direction here,
# rather than assuming it, means the cells come out in value order like every
# other per-step table in the app -- `ticks`, `options` -- and a slider can be
# flipped later without the pictures going with it.
SHEET_PARAMS = [
    # file,            param, name,           value 0 is at the
    ('DCO_env_mode',   0,     'DCO Env Mode', 'top'),
    ('VCF_env_mode',   1,     'VCF Env Mode', 'top'),
    ('VCA_env_mode',   2,     'VCA Env Mode', 'top'),
    ('DCO_pulse',      3,     'DCO Wave Pulse', 'bottom'),
    ('DCO_saw',        4,     'DCO Wave Saw', 'bottom'),
    ('DCO_sub',        5,     'DCO Wave Sub', 'bottom'),
]

# How many steps each parameter has, so that a sheet with the wrong number of
# cells is caught here rather than drawn wrong.  Kept in step with PARAMETERS in
# web/js/alpha_juno.js.
STEP_COUNT = {0: 4, 1: 4, 2: 4, 3: 4, 4: 6, 5: 6}


# ------------------------------------------------------------------ matrices --
#
# The usual SVG 2x3, as (a, b, c, d, e, f):  x' = a*x + c*y + e
#                                            y' = b*x + d*y + f

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def multiply(m, n):
    """m applied after n, i.e. the matrix for a child n inside a parent m."""
    a1, b1, c1, d1, e1, f1 = m
    a2, b2, c2, d2, e2, f2 = n
    return (a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


TRANSFORM = re.compile(r'(matrix|translate|scale|rotate)\s*\(([^)]*)\)')


def parse_transform(text):
    """An element's transform attribute, as a single matrix."""
    result = IDENTITY
    for name, body in TRANSFORM.findall(text or ''):
        n = [float(v) for v in re.split(r'[,\s]+', body.strip()) if v]
        if name == 'matrix':
            m = tuple(n)
        elif name == 'translate':
            m = (1, 0, 0, 1, n[0], n[1] if len(n) > 1 else 0)
        elif name == 'scale':
            m = (n[0], 0, 0, n[1] if len(n) > 1 else n[0], 0, 0)
        else:                                    # rotate, degrees, maybe about a point
            r = math.radians(n[0])
            m = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(n) == 3:
                m = multiply((1, 0, 0, 1, n[1], n[2]),
                             multiply(m, (1, 0, 0, 1, -n[1], -n[2])))
        result = multiply(result, m)
    return result


# ---------------------------------------------------------------- path data --
#
# The sheets use M m L l H h V v C c Z only -- no arcs, no quadratics -- which is
# what makes baking a transform into the coordinates straightforward.  Anything
# else is refused rather than silently mangled.

TOKEN = re.compile(r'([A-Za-z])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)')
SUPPORTED = set('MmLlHhVvCcZz')


def transform_path(d, matrix):
    """Rewrite path data with `matrix` folded into the coordinates.

    Comes out absolute, in M/L/C/Z only.  Folding rather than emitting a nested
    <path transform> matters for one sheet in particular: the elongated sub
    waveforms are drawn by stretching a cell horizontally, and a stroke under a
    non-uniform transform comes out heavier across than along.  Once the stretch
    is in the coordinates the shape keeps its width and the stroke goes even.
    """
    tokens = [(c, n) for c, n in TOKEN.findall(d)]
    out = []
    i = 0
    cmd = None
    x = y = 0.0            # current point, in the source's own coordinates
    start_x = start_y = 0.0

    def move(px, py, letter):
        out.append(letter + ' ' + ' '.join(fmt(v) for v in apply(matrix, px, py)))

    def numbers(count):
        nonlocal i
        values = []
        while len(values) < count:
            if i >= len(tokens) or tokens[i][0]:
                raise ValueError(f'{cmd}: wanted {count} numbers, ran out')
            values.append(float(tokens[i][1]))
            i += 1
        return values

    while i < len(tokens):
        letter, number = tokens[i]
        if letter:
            if letter not in SUPPORTED:
                raise ValueError(f'unsupported path command {letter!r}')
            cmd = letter
            i += 1
            if cmd in 'Zz':
                out.append('Z')
                x, y = start_x, start_y
                continue
        elif cmd is None:
            raise ValueError('path data starts with a number')
        else:
            # A repeated coordinate: after a moveto it means lineto, otherwise
            # the command simply carries on.
            if cmd == 'M':
                cmd = 'L'
            elif cmd == 'm':
                cmd = 'l'

        relative = cmd.islower()
        upper = cmd.upper()
        if upper == 'H':
            (h,) = numbers(1)
            x = x + h if relative else h
            move(x, y, 'L')
        elif upper == 'V':
            (v,) = numbers(1)
            y = y + v if relative else v
            move(x, y, 'L')
        elif upper in 'ML':
            px, py = numbers(2)
            x = x + px if relative else px
            y = y + py if relative else py
            move(x, y, 'M' if upper == 'M' else 'L')
            if upper == 'M':
                start_x, start_y = x, y
        elif upper == 'C':
            c = numbers(6)
            points = []
            for j in range(0, 6, 2):
                px = x + c[j] if relative else c[j]
                py = y + c[j + 1] if relative else c[j + 1]
                points.append(apply(matrix, px, py))
            x, y = (x + c[4], y + c[5]) if relative else (c[4], c[5])
            out.append('C ' + ' '.join(fmt(v) for p in points for v in p))

    return ' '.join(out)


def fmt(value):
    """Three decimals is finer than the panel can draw and keeps the file small."""
    text = f'{value:.3f}'.rstrip('0').rstrip('.')
    return '0' if text in ('', '-0') else text


def path_points(d):
    """Every coordinate pair in *transformed* path data, i.e. the output of
    transform_path, which is absolute and carries nothing but xy pairs.

    Reading pairs straight off the source would be wrong: Inkscape writes mostly
    relative commands, where the numbers are deltas rather than positions, and
    h/v carry one number rather than two.

    Control points are included, which is fine: this only has to be good enough
    to land the mark in the right box, and a curve never strays a whole cell
    away from the hull of its own control points.
    """
    numbers = [float(n) for c, n in TOKEN.findall(d) if n]
    return list(zip(numbers[0::2], numbers[1::2]))


# -------------------------------------------------------------------- sheets --

def style_of(element):
    return dict(re.findall(r'([\w-]+)\s*:\s*([^;]+)',
                           element.get('style', '').replace(' ', '')))


def is_ghost(element):
    """A mark drawn grey, or already dashed in the drawing, is a ghost.

    Either tag will do.  Grey is the easier one to draw with, but a dash pattern
    put in by hand says the same thing, and both end up dashed by the stylesheet
    at a size that survives being shrunk to slider scale.
    """
    style = style_of(element)
    return (style.get('stroke', '').lower() == GHOST_STROKE
            or style.get('stroke-dasharray', 'none').lower() != 'none')


def walk(element, matrix, rects, paths):
    matrix = multiply(matrix, parse_transform(element.get('transform')))
    tag = element.tag.replace(f'{{{SVG_NS}}}', '')
    if tag == 'rect':
        x, y = float(element.get('x', 0)), float(element.get('y', 0))
        w, h = float(element.get('width', 0)), float(element.get('height', 0))
        corners = [apply(matrix, x + dx * w, y + dy * h)
                   for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1))]
        rects.append((min(c[0] for c in corners), min(c[1] for c in corners),
                      max(c[0] for c in corners), max(c[1] for c in corners)))
    elif tag == 'path':
        paths.append((element, matrix))
    for child in element:
        walk(child, matrix, rects, paths)


def read_sheet(path):
    """The cells of one sheet, top to bottom, each with the marks drawn in it."""
    root = ET.parse(path).getroot()
    rects, paths = [], []
    for child in root:
        walk(child, IDENTITY, rects, paths)

    cells = sorted((r for r in rects
                    if abs((r[3] - r[1]) - CELL_HEIGHT) < CELL_TOLERANCE),
                   key=lambda r: r[1])
    if not cells:
        raise SystemExit(f'{path.name}: no cells found')

    marks = [[] for _ in cells]
    for element, matrix in paths:
        d = element.get('d', '')
        points = path_points(transform_path(d, matrix))
        if not points:
            continue
        cx = (min(p[0] for p in points) + max(p[0] for p in points)) / 2
        cy = (min(p[1] for p in points) + max(p[1] for p in points)) / 2
        index = next((i for i, (x0, y0, x1, y1) in enumerate(cells)
                      if x0 <= cx <= x1 and y0 <= cy <= y1), None)
        if index is None:
            continue                            # the DYN bracket, and its like
        x0, y0, x1, y1 = cells[index]
        centred = multiply((1, 0, 0, 1, -(x0 + x1) / 2, -(y0 + y1) / 2), matrix)
        marks[index].append((transform_path(d, centred), is_ghost(element)))

    return [{'width': round(x1 - x0, 3), 'height': round(y1 - y0, 3),
             'marks': m}
            for (x0, y0, x1, y1), m in zip(cells, marks)]


# ------------------------------------------------------------------- output --

HEADER = '''// The pictures the PG-300 prints beside its stepped sliders, as path data.
//
// GENERATED by tools/extract_panel_glyphs.py from reference/panel_glyphs/*.svg.
// Edit the drawings and run the script again; do not edit this file.
//
// Keyed by parameter index.  `steps` is one entry per value, value 0 first, the
// same order as `ticks` in js/pg300.js and `options` in js/alpha_juno.js.  Each
// step is the marks drawn in its cell, in the drawing's own units and measured
// from the middle of the cell, so a step is placed by putting its middle on the
// rung it belongs to and scaling `cell` down to the room the slider has.
//
// `ghost` marks are the dotted parts of a waveform -- the panel showing a shape
// sweeping rather than a line that is really there.  They are drawn solid here;
// the dashes are in the stylesheet, where they can be set in units near the size
// they are actually seen at.
'''


def main():
    module = [HEADER, 'export const GLYPHS = {']
    for name, param, label, zero_at in SHEET_PARAMS:
        cells = read_sheet(SHEETS / f'{name}.svg')
        if zero_at == 'bottom':
            cells.reverse()
        expected = STEP_COUNT[param]
        if len(cells) != expected:
            raise SystemExit(f'{name}.svg: {len(cells)} cells, '
                             f'but {label} has {expected} steps')

        widths = sorted({c['width'] for c in cells})
        print(f'  {label:15} param {param}: {len(cells)} steps, '
              f'{sum(len(c["marks"]) for c in cells)} marks, '
              f'cell {"/".join(str(w) for w in widths)} x {cells[0]["height"]}'
              + (f', {sum(1 for c in cells for _, g in c["marks"] if g)} ghost'
                 if any(g for c in cells for _, g in c['marks']) else ''))

        module.append(f'  // {label}, value 0 first.')
        module.append(f'  {param}: {{')
        module.append(f'    cell: [{max(c["width"] for c in cells)}, '
                      f'{cells[0]["height"]}],')
        module.append('    steps: [')
        for value, cell in enumerate(cells):
            ink = [d for d, ghost in cell['marks'] if not ghost]
            ghosts = [d for d, ghost in cell['marks'] if ghost]
            body = '\n'.join(f"        '{d}'," for d in ink)
            module.append(f'      // {value}')
            module.append('      { ink: [' + ('\n' + body + '\n      ' if body else ''
                                              ) + '],')
            if ghosts:
                body = '\n'.join(f"        '{d}'," for d in ghosts)
                module.append('        ghost: [\n' + body + '\n        ],')
            module.append('      },')
        module.append('    ],')
        module.append('  },')
    module.append('};')
    OUTPUT.write_text('\n'.join(module) + '\n')
    print(f'  -> {OUTPUT.relative_to(ROOT)}')


if __name__ == '__main__':
    sys.exit(main())
