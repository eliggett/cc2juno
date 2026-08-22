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
const GAP = '  ';                // between the slot and the name, as the synth spaces it
export const EDITED_MARK = '*';  // stands in the first of those spaces; see displayText
export const COLUMNS = SLOT_WIDTH + GAP.length + NAME_WIDTH;   // 16, as the hardware is
export const HEAD_COLUMNS = SLOT_WIDTH + GAP.length;   // the slot field, star included

/**
 * One character cell, as a fraction of the font size.
 *
 * Matrix Sans is a dot-matrix face and every glyph is a whole number of dot
 * columns wide -- but not the same number: '1' is four columns, a space is five,
 * '*' and most capitals are six. A real LCD has no such thing. Every character
 * gets a cell and stays in it, which is why the star can replace a space on the
 * hardware without the name moving, and why writing the line as one run of text
 * here made the name shuffle sideways when the star appeared.
 *
 * So the line is drawn as two fields placed on this grid rather than as one run
 * of text. 0.6em is the widest glyph in the face, which is also what CSS `ch`
 * measures for it, so a field of N cells holds N characters of any sort and can
 * never overflow into the field after it.
 */
export const CELL_EM = 0.6;
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
 * synth has no numbering for -- a preset recalled from cc2juno's own slots, or a
 * patch played straight out of a file, neither of which is an M or a P. It is cut
 * and padded to the same width the synth's own labels occupy, so the tone name
 * stays in the column it is always in.
 *
 * `edited` puts a star in the space immediately right of the slot, which is what
 * the instrument does once the sound in the edit buffer is no longer the sound
 * that was loaded. It takes a space rather than adding a character, so the name
 * stays in its column and the line stays the width it always is -- the star
 * appearing must not make everything after it shuffle sideways.
 *
 * `text` gives the whole line over to something that is not a patch at all: a
 * bulk transfer counting messages, or a prompt to go and press three buttons on
 * the synth. Those take five to ten seconds and the display is the only thing on
 * screen looking at the instrument, so it is worth borrowing. It takes precedence
 * over everything else, and is padded to the same fixed width so the screen never
 * changes size with what is on it.
 */
export function displayText({ program = null, name = '', slot = null, text = null,
                              edited = false } = {}) {
  if (text !== null && text !== undefined) {
    return String(text).slice(0, COLUMNS).padEnd(COLUMNS);
  }
  const label = (slot || patchLabel(program) || '----')
    .slice(0, SLOT_WIDTH).padEnd(SLOT_WIDTH);
  const gap = edited ? EDITED_MARK + GAP.slice(1) : GAP;
  const tone = name ? name.slice(0, NAME_WIDTH).padEnd(NAME_WIDTH) : '-'.repeat(NAME_WIDTH);
  return `${label}${gap}${tone}`;
}

/**
 * The line split where the display's two fields meet.
 *
 * The slot, its star and the gap after it are one field; the tone name is the
 * other, and it starts at a fixed cell so that nothing happening on the left can
 * move it. Joined back together these are exactly displayText(), which stays the
 * one description of what the line reads.
 *
 * A message is one field rather than two: it is a sentence, not a slot and a
 * name, and cutting it at column seven would open a gap in the middle of a word.
 * It is given to the head, which is allowed to grow past its cells to hold it.
 */
export function displayParts(patch = {}) {
  const line = displayText(patch);
  if (patch.text !== null && patch.text !== undefined) return { head: line, name: '' };
  return { head: line.slice(0, HEAD_COLUMNS), name: line.slice(HEAD_COLUMNS) };
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

    // Two fields on the cell grid rather than one run of text; see displayParts.
    // The line element stays, so its textContent is still the whole line.
    this.head = document.createElement('span');
    this.head.className = 'lcd-head';
    this.name = document.createElement('span');
    this.name.className = 'lcd-name';
    this.line.append(this.head, this.name);

    this.screen.append(this.line);
    this.el.append(this.screen);
    this.set({});
  }

  set(patch) {
    const text = displayText(patch);
    if (text === this.text) return;
    this.text = text;
    const parts = displayParts(patch);
    this.head.textContent = parts.head;
    this.name.textContent = parts.name;
    // Read out as one thing rather than as sixteen characters of segment font.
    // The star is a symbol rather than part of the name -- no tone name can
    // contain one, since the synth's six-bit charset has no star in it -- so it
    // is spoken as a word at the end instead of as punctuation in the middle.
    const starred = text.includes(EDITED_MARK);
    const spoken = text.replace(EDITED_MARK, ' ').replace(/-{2,}/g, 'unknown');
    this.el.setAttribute('aria-label',
                         `Synth patch: ${spoken}${starred ? ', edited' : ''}`);
  }
}
