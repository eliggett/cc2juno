// The PG-300 view: the Alpha Juno's own hardware programmer, drawn on screen.
//
// The knob grid is a picture of *your controller* -- whatever knobs you happen
// to own, wherever you put them. This is a picture of *the synth*: all 36
// parameters, always, in the places Roland put them. Which one is more use
// depends on whether you are looking for a knob or looking for a parameter.
//
// The geometry below is lifted from reference/PG-300_Panel.svg with that file's
// layer transform folded in, so any measurement taken off the drawing can be
// pasted straight in here. Two consequences worth knowing:
//
//   * Slider length is not decoration. The panel gives the low-resolution
//     parameters short travel and the 0..127 ones full travel, exactly as the
//     hardware does, so the lengths here come from the artwork rather than from
//     the parameter table -- and they agree with it.
//   * Labels are re-centred on their slider rather than being placed at the
//     drawing's x. The original is set in Compacta, which no browser has; a
//     substitute font at the same left edge would drift off centre by however
//     much the two fonts disagree about the width of "TOOTH".
//
// Nothing here knows what a parameter means. The app hands it a reading per
// parameter and gets back "the user moved this one", the same bargain knob.js
// makes.

import * as aj from './alpha_juno.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The frame, squared up.
 *
 * The sketch these came from was drawn by hand, so its corners are a unit or
 * two out -- most visibly where the VCF box's bottom edge meets the top of the
 * sections below it, which reads as a crooked line. Rather than carry the wobble
 * about, the frame is rebuilt here from the coordinates it was aiming at, in the
 * drawing's own units so that everything else can stay as measured.
 */
const FRAME = {
  left: 32,
  right: 452,
  top: 49.5,
  bottom: 361,
  vcfTop: 151.5,      // the VCF box's top edge
  rowTop: 256.5,      // the bottom row's top edge, and so the VCF box's bottom
  stepIn: 400,        // right of here the panel stops at the VCF: nothing below it
  lfoRight: 91,       // the LFO box, carved out of the DCO section's top left
  lfoBottom: 153.4,
  dcoRight: 241.5,
  vcaRight: 129,
  chorusRight: 184,
  envRight: 364.5,
};

/** Bare card around the outermost lines. The original sketch had ~30 units. */
const MARGIN = 5;

// The visible area. Everything is drawn in the drawing's coordinates and the
// viewBox crops to the part that matters, so a measurement taken off the
// artwork still pastes straight in even though the panel is no longer the size
// of the page it was drawn on.
export const PANEL = {
  x: FRAME.left - MARGIN,
  y: FRAME.top - MARGIN,
  width: (FRAME.right - FRAME.left) + 2 * MARGIN,
  height: (FRAME.bottom - FRAME.top) + 2 * MARGIN,
};

const TRACK_WIDTH = 4.9666;
const CAP_WIDTH = 11;
const CAP_HEIGHT = 5;
const CAP_INSET = CAP_HEIGHT / 2 + 0.6;   // how far a cap's centre stays off the ends
const RUNG = 6;                           // half-width of a scale rung
const LINE_HEIGHT = 6.4;                  // the artwork's own label leading
const MAX_LABEL = 20;                     // a label may not be wider than its column

// A 0..127 parameter, marked 0-5-10 down the side the way the hardware is.
const UNIT = 'unit';

// The sliders, in reading order down the panel. `ticks` is either UNIT or one
// label per step from the bottom up, where '' draws the rung without a numeral.
// The stepped scales come off the panel of an MKS-50 programmer (see
// reference/bigctrlr2.jpg); where its legend is a waveform glyph rather than a
// number the rung is left bare and the readout names the value instead.
export const LAYOUT = [
  // ---- LFO and DCO, top row
  { param: 24, cx: 59.50, top: 79.63, len: 63.78, labelY: 75.11, label: ['RATE'], ticks: UNIT },
  { param: 25, cx: 80.28, top: 79.63, len: 63.78, labelY: 74.85, label: ['DELAY'], ticks: UNIT },
  { param: 6, cx: 109.81, top: 79.63, len: 43.39, labelY: 74.14, label: ['RANGE'],
    ticks: ["4'", "8'", "16'", "32'"] },
  { param: 11, cx: 135.43, top: 79.63, len: 63.78, labelY: 74.14, label: ['LFO'], ticks: UNIT },
  { param: 12, cx: 156.21, top: 79.63, len: 63.78, labelY: 74.14, label: ['ENV'], ticks: UNIT },
  { param: 0, cx: 198.95, top: 79.63, len: 43.00, labelY: 70.93, label: ['ENV', 'MODE'],
    ticks: ['', '', '', ''] },
  { param: 13, cx: 224.44, top: 79.63, len: 63.78, labelY: 74.14, label: ['AFTER'], ticks: UNIT },

  // ---- DCO waveforms and PWM, second row
  { param: 3, cx: 59.36, top: 182.36, len: 43.52, labelY: 176.17, label: ['PULSE'],
    ticks: ['OFF', '', '', ''] },
  { param: 4, cx: 87.20, top: 182.36, len: 63.78, labelY: 171.73, label: ['SAW', 'TOOTH'],
    ticks: ['OFF', '', '', '', '', ''] },
  { param: 5, cx: 114.78, top: 182.36, len: 63.78, labelY: 176.17, label: ['SUB'],
    ticks: ['', '', '', '', '', ''] },
  { param: 7, cx: 156.61, top: 202.35, len: 43.52, labelY: 189.68, label: ['SUB', 'LEVEL'],
    ticks: ['0', '1', '2', '3'] },
  { param: 8, cx: 177.26, top: 202.35, len: 43.52, labelY: 188.63, label: ['NOISE', 'LEVEL'],
    ticks: ['0', '1', '2', '3'] },
  { param: 14, cx: 203.13, top: 182.23, len: 63.65, labelY: 175.71, label: ['PWM'], ticks: UNIT },
  { param: 15, cx: 225.35, top: 182.23, len: 63.65, labelY: 172.88, label: ['PWM', 'RATE'],
    ticks: UNIT },

  // ---- VCF
  { param: 9, cx: 264.13, top: 202.72, len: 43.52, labelY: 194.51, label: ['HPF'],
    ticks: ['0', '1', '2', '3'] },
  { param: 16, cx: 289.79, top: 181.62, len: 63.78, labelY: 173.86, label: ['FREQ'], ticks: UNIT },
  { param: 17, cx: 311.09, top: 181.62, len: 63.78, labelY: 174.25, label: ['RES'], ticks: UNIT },
  { param: 18, cx: 332.00, top: 181.62, len: 63.78, labelY: 174.38, label: ['LFO'], ticks: UNIT },
  { param: 19, cx: 353.57, top: 181.62, len: 63.78, labelY: 174.91, label: ['ENV'], ticks: UNIT },
  { param: 1, cx: 387.60, top: 181.65, len: 43.52, labelY: 172.31, label: ['ENV', 'MODE'],
    ticks: ['', '', '', ''] },
  { param: 20, cx: 412.96, top: 183.10, len: 63.78, labelY: 171.69, label: ['KEY', 'FOLLOW'],
    ticks: UNIT },
  { param: 21, cx: 434.53, top: 183.10, len: 63.78, labelY: 173.99, label: ['AFTER'], ticks: UNIT },

  // ---- VCA and chorus
  { param: 22, cx: 59.50, top: 285.87, len: 63.78, labelY: 280.05, label: ['LEVEL'], ticks: UNIT },
  { param: 2, cx: 92.43, top: 285.87, len: 43.00, labelY: 276.62, label: ['ENV', 'MODE'],
    ticks: ['', '', '', ''] },
  { param: 23, cx: 118.96, top: 285.87, len: 63.78, labelY: 280.38, label: ['AFTER'], ticks: UNIT },
  // The chorus switch keeps the artwork's ON/OFF beside it instead of a label
  // above it, which is why this one has no label lines of its own.
  { param: 10, cx: 152.16, top: 327.30, len: 22.22, labelY: 0, label: [], ticks: ['', ''] },
  { param: 34, cx: 173.07, top: 285.87, len: 63.78, labelY: 277.77, label: ['RATE'], ticks: UNIT },

  // ---- envelope and bender
  { param: 26, cx: 203.27, top: 285.87, len: 63.78, labelY: 280.03, label: ['T1'], ticks: UNIT },
  { param: 27, cx: 225.35, top: 285.87, len: 63.78, labelY: 280.03, label: ['L1'], ticks: UNIT },
  { param: 28, cx: 246.27, top: 285.87, len: 63.78, labelY: 280.03, label: ['T2'], ticks: UNIT },
  { param: 29, cx: 268.35, top: 285.87, len: 63.78, labelY: 280.03, label: ['L2'], ticks: UNIT },
  { param: 30, cx: 289.79, top: 285.87, len: 63.78, labelY: 280.02, label: ['T3'], ticks: UNIT },
  { param: 31, cx: 311.09, top: 285.87, len: 63.78, labelY: 280.02, label: ['L3'], ticks: UNIT },
  { param: 32, cx: 332.00, top: 285.87, len: 63.78, labelY: 280.03, label: ['T4'], ticks: UNIT },
  { param: 33, cx: 353.57, top: 285.87, len: 63.78, labelY: 273.62, label: ['KEY', 'FOLLOW'],
    ticks: UNIT },
  { param: 35, cx: 387.68, top: 285.87, len: 63.78, labelY: 273.12, label: ['BENDER', 'RANGE'],
    ticks: ['0', '', '', '', '', '', '6', '', '', '', '', '', '12'] },
];

// The outline and the lines that divide it into sections, in the same order the
// drawing had them: the panel's own edge first, then the LFO box carved out of
// the top left, the row divider, and the four verticals.
const SECTION_LINES = [
  `M ${FRAME.dcoRight} ${FRAME.top} H ${FRAME.left} V ${FRAME.bottom} `
  + `H ${FRAME.stepIn} V ${FRAME.rowTop} H ${FRAME.right} V ${FRAME.vcfTop} `
  + `H ${FRAME.dcoRight} Z`,
  `M ${FRAME.lfoRight} ${FRAME.top} V ${FRAME.lfoBottom} H ${FRAME.left}`,
  `M ${FRAME.left} ${FRAME.rowTop} H ${FRAME.stepIn}`,
  `M ${FRAME.dcoRight} ${FRAME.vcfTop} V ${FRAME.rowTop}`,
  `M ${FRAME.vcaRight} ${FRAME.rowTop} V ${FRAME.bottom}`,
  `M ${FRAME.chorusRight} ${FRAME.rowTop} V ${FRAME.bottom}`,
  `M ${FRAME.envRight} ${FRAME.rowTop} V ${FRAME.bottom}`,
];

/** How far below its section's top line a heading's baseline sits, everywhere. */
const SECTION_DROP = 13.5;

// Each heading is centred across its section and dropped the same distance from
// the line above it. DCO's box is the awkward one: the section is L-shaped,
// wrapping under the LFO box to pick up the waveform sliders, so the heading is
// centred on the part of it that is actually beside the heading.
const SECTIONS = [
  { text: 'LFO', left: FRAME.left, right: FRAME.lfoRight, top: FRAME.top },
  { text: 'DCO', left: FRAME.lfoRight, right: FRAME.dcoRight, top: FRAME.top },
  { text: 'VCF', left: FRAME.dcoRight, right: FRAME.right, top: FRAME.vcfTop },
  { text: 'VCA', left: FRAME.left, right: FRAME.vcaRight, top: FRAME.rowTop },
  { text: 'CHORUS', left: FRAME.vcaRight, right: FRAME.chorusRight, top: FRAME.rowTop },
  { text: 'ENV', left: FRAME.chorusRight, right: FRAME.envRight, top: FRAME.rowTop },
];

// ---------------------------------------------------------------- helpers ---

function element(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function text(content, attributes) {
  const node = element('text', attributes);
  node.textContent = content;
  return node;
}

/** Where a cap's centre sits for `fraction` of full travel, 0 at the bottom. */
function capCentre(entry, fraction) {
  const low = entry.top + entry.len - CAP_INSET;
  const high = entry.top + CAP_INSET;
  return low - fraction * (low - high);
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** The reading a slider shows, as a fraction of its travel. */
export function fractionOf(param, value) {
  if (value === null || value === undefined) return 0;
  return clamp01(value / param.maxValue);
}

/** The step count a drag of the whole track covers. */
const stepsOf = (param) => param.maxValue;

// ------------------------------------------------------------------ panel ---

export class Pg300Panel {
  /**
   * @param hooks {onInput, onHover} - onInput(paramIndex, value) fires while
   *        dragging, in parameter units rather than CC units, since a slider on
   *        this panel is a parameter and may have no CC behind it at all.
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.sliders = new Map();     // parameter index -> the bits that move
    this.hovered = null;
    this.dragging = null;

    this.el = document.createElement('div');
    this.el.className = 'pg300';

    this.svg = element('svg', {
      viewBox: `${PANEL.x} ${PANEL.y} ${PANEL.width} ${PANEL.height}`,
      class: 'pg300-svg',
      role: 'group',
      'aria-label': 'PG-300 panel',
    });
    this.build();

    this.hint = document.createElement('p');
    this.hint.className = 'pg300-hint';
    this.el.append(this.svg, this.hint);
    this.setHint(null);

    // Leaving by any route puts the hint back, including the pointer going
    // straight from a slider out of the window.
    this.svg.addEventListener('pointerleave', () => this.setHint(null));
  }

  build() {
    this.svg.append(element('rect', {
      class: 'pg300-face',
      x: PANEL.x, y: PANEL.y, width: PANEL.width, height: PANEL.height, rx: 3, ry: 3,
    }));

    const sections = element('g', { class: 'pg300-sections' });
    for (const d of SECTION_LINES) sections.append(element('path', { d }));
    this.svg.append(sections);

    for (const section of SECTIONS) {
      const heading = text(section.text, {
        class: 'pg300-section pg300-fit',
        x: (section.left + section.right) / 2,
        y: section.top + SECTION_DROP,
        'text-anchor': 'middle',
      });
      // CHORUS very nearly fills its box in a condensed face and overruns it in
      // anything wider, so a heading is squeezed to its own section the way a
      // slider label is squeezed to its column.
      heading.dataset.max = String(section.right - section.left - 8);
      this.svg.append(heading);
    }

    this.buildLogo();

    // The chorus switch's own legend, which sits beside the switch rather than
    // above it. Right-aligned, because ON and OFF are different widths and the
    // drawing lines up their right edges.
    this.svg.append(
      text('ON', { class: 'pg300-label', x: 146.5, y: 332.14, 'text-anchor': 'end' }),
      text('OFF', { class: 'pg300-label', x: 146.5, y: 344.55, 'text-anchor': 'end' }),
    );

    for (const entry of LAYOUT) this.buildSlider(entry);
  }

  /**
   * The top right of the panel, where Roland put their logo.
   *
   * A placeholder until there is a real one: replace the contents of this group
   * and nothing else has to move. The area is the whole rectangle the panel's
   * outline steps around -- x from the DCO box's right edge to the panel's, y
   * from the top down to where the VCF section starts.
   */
  buildLogo() {
    const cx = (FRAME.dcoRight + FRAME.right) / 2;
    const logo = element('g', { class: 'pg300-logo', id: 'pg300-logo' });
    logo.append(
      text('cc2juno', { class: 'pg300-wordmark', x: cx, y: 98, 'text-anchor': 'middle' }),
      text('PROGRAMMER FOR ALPHA JUNO', {
        class: 'pg300-wordmark-sub', x: cx, y: 114, 'text-anchor': 'middle',
      }),
    );
    this.svg.append(logo);
  }

  buildSlider(entry) {
    const param = aj.PARAMETERS[entry.param];
    const group = element('g', {
      class: 'pg300-slider',
      tabindex: '0',
      role: 'slider',
      'aria-valuemin': '0',
      'aria-valuemax': String(param.maxValue),
    });

    const title = element('title');
    group.append(title);

    // Rungs first, so that the cap rides over them the way it does on the panel.
    const rungs = element('g', { class: 'pg300-rungs' });
    const marks = entry.ticks === UNIT
      ? [['0', 0], ['5', 0.5], ['10', 1]]
      : entry.ticks.map((mark, i) => [mark, i / Math.max(1, entry.ticks.length - 1)]);
    const positions = entry.ticks === UNIT
      ? Array.from({ length: 11 }, (unused, i) => i / 10)
      : marks.map(([, fraction]) => fraction);

    for (const fraction of positions) {
      const y = capCentre(entry, fraction);
      rungs.append(element('line', {
        x1: entry.cx - RUNG, y1: y, x2: entry.cx + RUNG, y2: y,
      }));
    }
    for (const [mark, fraction] of marks) {
      if (!mark) continue;
      rungs.append(text(mark, {
        class: 'pg300-tick',
        x: entry.cx - RUNG - 1.5,
        y: capCentre(entry, fraction),
        'text-anchor': 'end',
        'dominant-baseline': 'middle',
      }));
    }
    group.append(rungs);

    group.append(element('rect', {
      class: 'pg300-track',
      x: entry.cx - TRACK_WIDTH / 2, y: entry.top,
      width: TRACK_WIDTH, height: entry.len,
      rx: TRACK_WIDTH / 2, ry: TRACK_WIDTH / 2,
    }));

    const cap = element('g', { class: 'pg300-cap' });
    cap.append(
      element('rect', {
        x: entry.cx - CAP_WIDTH / 2, y: -CAP_HEIGHT / 2,
        width: CAP_WIDTH, height: CAP_HEIGHT, rx: 1.4, ry: 1.4,
      }),
      element('line', {
        class: 'pg300-cap-line',
        x1: entry.cx - CAP_WIDTH / 2 + 1.6, y1: 0,
        x2: entry.cx + CAP_WIDTH / 2 - 1.6, y2: 0,
      }),
    );
    group.append(cap);

    entry.label.forEach((line, i) => {
      group.append(text(line, {
        class: 'pg300-label pg300-fit',
        x: entry.cx,
        y: entry.labelY + i * LINE_HEIGHT,
        'text-anchor': 'middle',
      }));
    });

    const reading = text('', {
      class: 'pg300-reading',
      x: entry.cx,
      y: entry.top + entry.len + 8,
      'text-anchor': 'middle',
    });
    group.append(reading);

    // A transparent grab area, so the whole column is draggable rather than just
    // the 5-unit-wide track and the cap that happens to be somewhere on it.
    const hit = element('rect', {
      class: 'pg300-hit',
      x: entry.cx - CAP_WIDTH / 2 - 1, y: entry.top - 2,
      width: CAP_WIDTH + 2, height: entry.len + 4,
    });
    group.append(hit);

    const slider = {
      entry, param, group, cap, reading, title,
      track: group.querySelector('.pg300-track'),
      fraction: 0,
      value: null,
      flashTimer: null,
      wheelRemainder: 0,
    };
    this.sliders.set(entry.param, slider);

    group.addEventListener('pointerdown', (event) => this.onPointerDown(slider, event));
    group.addEventListener('wheel', (event) => this.onWheel(slider, event), { passive: false });
    group.addEventListener('keydown', (event) => this.onKeyDown(slider, event));
    group.addEventListener('pointerenter', () => this.setHint(slider));
    group.addEventListener('focus', () => this.setHint(slider));
    group.addEventListener('blur', () => this.setHint(null));

    this.svg.append(group);
    this.place(slider, 0);
  }

  /**
   * Squeeze any label wider than its column.
   *
   * The panel is set in Compacta, a condensed face nobody has, so a browser
   * without a condensed substitute renders "FOLLOW" wide enough to run into the
   * slider next door. Anything over the column width gets squeezed to fit,
   * which is what the original typeface was doing anyway.
   *
   * Only measurable once the panel is in the document and visible, so this is
   * called from the first draw and gives up quietly until then.
   */
  fit() {
    if (this.fitted) return;
    for (const label of this.svg.querySelectorAll('.pg300-fit')) {
      const width = label.getComputedTextLength();
      if (!width) return;                    // not rendered yet; try again later
      this.fitted = true;
      const max = Number(label.dataset.max || MAX_LABEL);
      if (width <= max) continue;
      label.setAttribute('textLength', max);
      label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }

  place(slider, fraction) {
    slider.fraction = clamp01(fraction);
    const y = capCentre(slider.entry, slider.fraction);
    slider.cap.setAttribute('transform', `translate(0 ${y.toFixed(2)})`);
  }

  // --------------------------------------------------------------- drawing ---

  /**
   * Redraw from one reading per parameter, indexed by parameter number.
   *
   * A reading is {value, reach, cc}: `value` is the last value the synth was
   * actually sent, or null if it never was, and `reach` says whether a knob on
   * this layer can move it ('layer'), a knob on some other layer can ('other'),
   * or nothing on the controller can ('none').
   *
   * A null value is drawn at the bottom of its travel but marked unknown, and it
   * matters that those are two different things. The synth's patch cannot be
   * read back, so a slider that has never been sent anything is not at zero --
   * we simply have no idea where it is, and a fader has to be drawn somewhere.
   */
  update(readings) {
    this.fit();
    for (const [index, slider] of this.sliders) {
      const reading = readings[index] || {};
      const value = reading.value === undefined ? null : reading.value;
      const reach = reading.reach || 'none';

      slider.cc = reading.cc ?? null;
      slider.group.classList.toggle('reach-layer', reach === 'layer');
      slider.group.classList.toggle('reach-other', reach === 'other');
      slider.group.classList.toggle('reach-none', reach === 'none');

      // The one under the pointer keeps the value the hand gave it. The rate
      // limiter means the value actually sent trails a fast drag by a few
      // messages, and a cap that snapped back to it would fight the drag.
      if (this.dragging !== slider) {
        slider.value = value;
        this.place(slider, fractionOf(slider.param, value));
        slider.group.classList.toggle('is-unknown', value === null);
        slider.reading.textContent = value === null ? '' : this.shortLabel(slider, value);
      }

      slider.title.textContent = this.describe(slider);
      slider.group.setAttribute('aria-label', this.describe(slider));
      if (slider.value === null) slider.group.removeAttribute('aria-valuenow');
      else slider.group.setAttribute('aria-valuenow', String(slider.value));
    }
    if (this.hovered) this.setHint(this.hovered);
  }

  /** What fits under a slider: the option name when it is short, else the number. */
  shortLabel(slider, value) {
    const option = slider.param.options[value];
    return option && option.length <= 6 ? option : String(value);
  }

  describe(slider) {
    const { param, value, cc } = slider;
    const where = value === null
      ? 'not set this session'
      : aj.label(param, value);
    const reach = cc === null || cc === undefined ? '' : ` · CC${cc}`;
    return `${param.name} — ${where}${reach}`;
  }

  setHint(slider) {
    this.hovered = slider || null;
    if (!slider) {
      this.hint.textContent = 'Drag, scroll or arrow a slider to send it, mapped or not. '
                            + 'Lit sliders are the ones a knob can reach on this layer.';
      this.hint.classList.remove('is-reading');
      return;
    }
    this.hint.textContent = this.describe(slider);
    this.hint.classList.add('is-reading');
  }

  /** Light a slider up briefly, so a moving control is obvious at a glance. */
  flash(paramIndex) {
    const slider = this.sliders.get(paramIndex);
    if (!slider) return;
    slider.group.classList.add('is-active');
    if (slider.flashTimer !== null) clearTimeout(slider.flashTimer);
    slider.flashTimer = setTimeout(() => {
      slider.group.classList.remove('is-active');
      slider.flashTimer = null;
    }, 220);
  }

  // ----------------------------------------------------------- interaction ---

  emit(slider, value) {
    const bounded = Math.max(0, Math.min(slider.param.maxValue, Math.round(value)));
    if (bounded === slider.value) return;
    slider.value = bounded;
    this.place(slider, fractionOf(slider.param, bounded));
    slider.group.classList.remove('is-unknown');
    slider.reading.textContent = this.shortLabel(slider, bounded);
    if (this.hovered === slider) this.setHint(slider);
    if (this.hooks.onInput) this.hooks.onInput(slider.entry.param, bounded);
  }

  /**
   * Drag a fader the way a fader drags: the cap follows the pointer, one for
   * one, rather than using a fixed number of pixels for full travel as the
   * knobs do. That means the travel has to be measured on screen, since the
   * panel scales to whatever room the window has.
   */
  onPointerDown(slider, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    slider.group.focus({ preventScroll: true });
    try { slider.group.setPointerCapture(event.pointerId); } catch (exc) { /* not fatal */ }
    this.dragging = slider;

    const box = slider.track.getBoundingClientRect();
    const travelPx = box.height * ((slider.entry.len - 2 * CAP_INSET) / slider.entry.len);
    const startY = event.clientY;
    const startValue = slider.value === null ? 0 : slider.value;
    const steps = stepsOf(slider.param);

    const move = (moveEvent) => {
      const fine = moveEvent.shiftKey ? 5 : 1;
      const travel = (startY - moveEvent.clientY) / fine;
      this.emit(slider, startValue + (travel / travelPx) * steps);
    };

    const up = (upEvent) => {
      try { slider.group.releasePointerCapture(upEvent.pointerId); } catch (exc) { /* ditto */ }
      this.dragging = null;
      slider.group.removeEventListener('pointermove', move);
      slider.group.removeEventListener('pointerup', up);
      slider.group.removeEventListener('pointercancel', up);
    };

    slider.group.addEventListener('pointermove', move);
    slider.group.addEventListener('pointerup', up);
    slider.group.addEventListener('pointercancel', up);
  }

  /**
   * Scroll wheel over a slider moves it, on the same accumulate-and-carry terms
   * as the knobs: a mouse notch is a definite four counts of a 0..127 parameter,
   * a trackpad glides. A low-resolution parameter gets one step per notch, since
   * four steps of a four-position switch is the whole control.
   */
  onWheel(slider, event) {
    event.preventDefault();
    const perCount = event.deltaMode === 0 ? 25 : (event.deltaMode === 1 ? 0.75 : 0.25);
    const scale = aj.isContinuous(slider.param) ? 1 : 0.25;
    let counts = (event.deltaY / perCount) * scale;
    if (event.shiftKey) counts /= 4;
    slider.wheelRemainder += counts;

    const whole = Math.trunc(slider.wheelRemainder);
    if (!whole) return;
    slider.wheelRemainder -= whole;
    this.emit(slider, (slider.value === null ? 0 : slider.value) - whole);
  }

  onKeyDown(slider, event) {
    const page = aj.isContinuous(slider.param) ? 8 : 1;
    const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1,
                    PageUp: page, PageDown: -page,
                    Home: -slider.param.maxValue, End: slider.param.maxValue };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const from = slider.value === null ? 0 : slider.value;
    const to = event.key === 'Home' ? 0
             : event.key === 'End' ? slider.param.maxValue
             : from + steps[event.key];
    this.emit(slider, to);
  }
}
