// The little display, and the patch numbering it shows.
//
// An Alpha Juno names the sound it has just loaded on a one-line LCD: a slot
// number, then the tone name. The slots are lettered by where they live --
//
//     M-11 .. M-88   program 0-63    the 64 writable memories
//     P-11 .. P-88   program 64-127  the 64 factory presets
//
// -- and numbered by bank and instrument within the bank, both counting from 1,
// eight of each. So program 0 is M-11, program 63 is M-88, program 64 is P-11.
// There is no zeroth bank and no bank 9; the second digit never leaves 1-8, which
// is why this is a pair of digits rather than a number.
//
// The display is drawn twice, in HTML above the knob grid and in SVG on the
// PG-300, so the text they show is worked out here rather than in either of them.

export const NAME_WIDTH = 10;    // characters of tone name, as the synth sends
export const SLOT_WIDTH = 4;     // 'M-11', 'P-88', and anything standing in for one
const GAP = '   ';               // between the slot and the name
export const COLUMNS = SLOT_WIDTH + GAP.length + NAME_WIDTH;
const BANK_SIZE = 8;
const BANKS = 8;
const MEMORIES = BANK_SIZE * BANKS;

/**
 * The slot a program number selects, as the synth writes it: 'M-11', 'P-88'.
 * Null for anything outside 0-127, which is not a program number at all.
 */
export function patchLabel(program) {
  if (!Number.isInteger(program) || program < 0 || program >= 2 * MEMORIES) return null;
  const preset = program >= MEMORIES;
  const offset = preset ? program - MEMORIES : program;
  const bank = Math.floor(offset / BANK_SIZE) + 1;
  const instrument = (offset % BANK_SIZE) + 1;
  return `${preset ? 'P' : 'M'}-${bank}${instrument}`;
}

/**
 * One line of exactly COLUMNS characters, padded the way a fixed display is.
 *
 * What is not known reads as dashes rather than as blank space: an empty screen
 * looks like a display that is not working, and the two halves arrive
 * separately -- the tone data first, the program number a moment later -- so
 * half-known is a state the screen really passes through.
 *
 * `slot` overrides the program number, for a sound that came from somewhere the
 * synth has no numbering for -- a preset recalled from cc2juno's own slots, which
 * is neither an M nor a P. It is cut and padded to the same width the synth's own
 * labels occupy, so the tone name stays in the column it is always in.
 */
export function displayText({ program = null, name = '', slot = null } = {}) {
  const label = (slot || patchLabel(program) || '----')
    .slice(0, SLOT_WIDTH).padEnd(SLOT_WIDTH);
  const tone = name ? name.slice(0, NAME_WIDTH).padEnd(NAME_WIDTH) : '-'.repeat(NAME_WIDTH);
  return `${label}${GAP}${tone}`;
}

/**
 * The HTML display, for above the knob grid.
 *
 * A bezel around a screen, and nothing else: it is a readout, not a control, so
 * it takes no events and holds no state beyond the line it is showing.
 */
export class Lcd {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'lcd';

    this.screen = document.createElement('div');
    this.screen.className = 'lcd-screen';

    this.line = document.createElement('span');
    this.line.className = 'lcd-text';

    this.screen.append(this.line);
    this.el.append(this.screen);
    this.set({});
  }

  set(patch) {
    const text = displayText(patch);
    if (text === this.text) return;
    this.text = text;
    this.line.textContent = text;
    // Read out as one thing rather than as sixteen characters of segment font.
    this.el.setAttribute('aria-label', `Synth patch: ${text.replace(/-{2,}/g, 'unknown')}`);
  }
}
