// One knob on screen: an SVG dial, its labels, and the pointer handling.
//
// The dial sweeps 270 degrees, the way a real pot does, with 7 o'clock as 0 and
// 5 o'clock as 127. Nothing here knows what a parameter is; the app decides what
// each knob says and what colour it is, and this draws it.

const SWEEP = 270;          // degrees of travel, 7 o'clock round to 5 o'clock
const START = -135;         // 0 sits here, measured clockwise from 12 o'clock
const RADIUS = 34;
const CENTRE = 44;
const FULL_TRAVEL_PX = 160; // pixels of drag for the whole 0-127 range

const SVG_NS = 'http://www.w3.org/2000/svg';

function point(t) {
  const radians = ((START + t * SWEEP) * Math.PI) / 180;
  return [
    CENTRE + RADIUS * Math.sin(radians),
    CENTRE - RADIUS * Math.cos(radians),
  ];
}

/** An arc path from fraction `from` to fraction `to`, both 0..1. */
function arc(from, to) {
  const [x0, y0] = point(from);
  const [x1, y1] = point(to);
  const large = (to - from) * SWEEP > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} `
       + `A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function element(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

export class Knob {
  /**
   * @param hooks {onSelect, onInput} - onInput(value 0..127) fires while dragging
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.fraction = 0;
    this.draggable = false;
    this.flashTimer = null;
    this.wheelRemainder = 0;

    this.el = document.createElement('div');
    this.el.className = 'knob';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'button');

    const svg = element('svg', { viewBox: '0 0 88 88', class: 'knob-dial' });
    svg.append(
      element('path', { class: 'knob-track', d: arc(0, 1) }),
      this.valueArc = element('path', { class: 'knob-value', d: arc(0, 0) }),
      this.pointer = element('line', {
        class: 'knob-pointer', x1: CENTRE, y1: CENTRE, x2: CENTRE, y2: CENTRE - RADIUS + 6,
      }),
      element('circle', { class: 'knob-cap', cx: CENTRE, cy: CENTRE, r: 15 }),
      this.reading = element('text', {
        class: 'knob-reading', x: CENTRE, y: CENTRE + 4, 'text-anchor': 'middle',
      }),
    );

    this.name = document.createElement('div');
    this.name.className = 'knob-name';
    this.detail = document.createElement('div');
    this.detail.className = 'knob-detail';

    this.el.append(svg, this.name, this.detail);

    this.el.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.el.addEventListener('keydown', (event) => this.onKeyDown(event));
    // Not passive: over a live knob the wheel turns the knob rather than
    // scrolling the page, which needs preventDefault.
    this.el.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.el.addEventListener('click', (event) => {
      // A click that ended a drag is not a selection: dragging a knob in
      // performance mode should not also open its editor.
      if (this.dragged) { this.dragged = false; return; }
      if (this.hooks.onSelect) this.hooks.onSelect(event);
    });
  }

  /**
   * @param state {name, detail, reading, fraction, kind, selected, learning, draggable}
   */
  update(state) {
    const { name = '', detail = '', reading = '', fraction = 0, kind = 'empty' } = state;
    this.name.textContent = name;
    this.detail.textContent = detail;
    this.reading.textContent = reading;
    this.setFraction(fraction);
    this.draggable = Boolean(state.draggable);

    this.el.className = `knob knob-${kind}`;
    if (state.selected) this.el.classList.add('is-selected');
    if (state.learning) this.el.classList.add('is-learning');
    if (state.stale) this.el.classList.add('is-stale');
    this.el.classList.toggle('is-fixed', !this.draggable);
    this.el.title = state.title || '';
    this.el.setAttribute('aria-label',
      `${name || 'unassigned knob'} ${detail}${state.stale ? ', not sent yet' : ''}`.trim());
  }

  setFraction(fraction) {
    this.fraction = Math.max(0, Math.min(1, fraction));
    // An arc of exactly zero length draws nothing, which is what we want at 0,
    // but Safari and Chrome disagree about a zero-length path with a round cap,
    // so the arc is hidden outright rather than drawn empty.
    this.valueArc.setAttribute('d', arc(0, this.fraction));
    this.valueArc.style.visibility = this.fraction > 0.001 ? 'visible' : 'hidden';
    const angle = START + this.fraction * SWEEP;
    this.pointer.setAttribute('transform', `rotate(${angle.toFixed(2)} ${CENTRE} ${CENTRE})`);
  }

  /** Light the knob up briefly, so a moving control is obvious at a glance. */
  flash() {
    this.el.classList.add('is-active');
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.el.classList.remove('is-active');
      this.flashTimer = null;
    }, 220);
  }

  onPointerDown(event) {
    if (!this.draggable || event.button !== 0) return;
    event.preventDefault();
    // Capture keeps the drag alive when the pointer leaves the little dial, but
    // it throws if the pointer is already gone, which is not worth a broken drag.
    try { this.el.setPointerCapture(event.pointerId); } catch (exc) { /* not fatal */ }
    this.dragged = false;

    const startY = event.clientY;
    const startValue = Math.round(this.fraction * 127);

    const move = (moveEvent) => {
      // Vertical drag, because a rotary gesture on a 60-pixel dial is fussy and
      // every hardware editor ever written works this way. Shift is fine control.
      const step = moveEvent.shiftKey ? 5 : 1;
      const travel = (startY - moveEvent.clientY) / step;
      const value = Math.max(0, Math.min(127,
        Math.round(startValue + (travel / FULL_TRAVEL_PX) * 127)));
      if (value !== Math.round(this.fraction * 127)) {
        this.dragged = true;
        this.setFraction(value / 127);
        if (this.hooks.onInput) this.hooks.onInput(value);
      }
    };

    const up = (upEvent) => {
      try { this.el.releasePointerCapture(upEvent.pointerId); } catch (exc) { /* ditto */ }
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
    };

    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  /**
   * Scroll wheel over a live knob turns it.
   *
   * Browsers report wheel movement in pixels, lines or pages depending on the
   * device and the platform, and a trackpad emits a stream of small deltas where
   * a mouse emits one big one. Everything is converted to CC counts and the
   * fraction left over is carried, so one click of a mouse wheel is a definite
   * four counts while a trackpad glides a count at a time instead of doing
   * nothing until it has accumulated a whole notch.
   */
  onWheel(event) {
    if (!this.draggable) return;
    event.preventDefault();

    // Chrome sends 100px per mouse notch, Firefox 3 lines; both mean four counts.
    const perCount = event.deltaMode === 0 ? 25 : (event.deltaMode === 1 ? 0.75 : 0.25);
    let counts = event.deltaY / perCount;
    if (event.shiftKey) counts /= 4;          // fine control, as with a drag
    this.wheelRemainder += counts;

    const whole = Math.trunc(this.wheelRemainder);
    if (!whole) return;
    this.wheelRemainder -= whole;

    const current = Math.round(this.fraction * 127);
    const value = Math.max(0, Math.min(127, current - whole));
    if (value === current) return;
    this.setFraction(value / 127);
    if (this.hooks.onInput) this.hooks.onInput(value);
  }

  onKeyDown(event) {
    if (!this.draggable) return;
    const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1,
                    PageUp: 8, PageDown: -8 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const value = Math.max(0, Math.min(127, Math.round(this.fraction * 127) + steps[event.key]));
    this.setFraction(value / 127);
    if (this.hooks.onInput) this.hooks.onInput(value);
  }
}
