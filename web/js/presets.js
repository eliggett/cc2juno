// Preset slots: whole tones set aside, and put back on demand.
//
// A preset is the same 36 numbers the synth broadcasts when its patch changes --
// parameter values in PARAMETERS order, in the synth's own units -- so a tone
// read from the instrument and a preset recorded here are the same kind of
// thing, and either can be sent back out the same way. Nothing about the
// controller is kept. Which CC reaches which parameter is configuration, and
// belongs to the config file that the Python and Tulip builds read too; a preset
// is what the synth sounds like, and would mean the same on a different rig.
//
// Only complete tones are stored, which is the one rule here worth stating.
// Before the synth has announced anything, the only values cc2juno knows are the
// ones it has itself sent -- a handful, if the user has touched a handful of
// knobs. Storing that and calling it a preset would recall as a patch with holes
// in it, and the holes would be filled by whatever the synth happened to be
// holding at the time, so the same slot would sound different on every recall.
// That is a diff, not a preset. isComplete() is the gate, and the UI keeps the
// record buttons switched off until it passes.
//
// The bank is a fixed row of slots because that is what the buttons are: five
// numbered places, always present, empty or full. A named, unbounded library is
// the next thing to be built, which is why a preset carries a name and a date it
// has no use for yet, and why what goes to localStorage is wrapped in a version.

import { PARAMETERS } from './alpha_juno.js';

export const SLOT_COUNT = 5;
export const PARAM_COUNT = PARAMETERS.length;

// Bumped when the stored shape changes in a way an older build would misread.
// Anything else is refused rather than guessed at; see fromJSON.
export const STORE_VERSION = 1;

// The synth's own tone names are ten characters. This is longer because the
// library will let names be typed rather than only inherited from the synth,
// and short enough that a name cannot bloat what goes into localStorage.
export const NAME_LIMIT = 24;

/**
 * What the display calls a slot: T1..T5.
 *
 * The synth letters its own sounds by where they live -- M for the writable
 * memories, P for the factory presets -- and a slot here is neither, so it gets a
 * letter of its own. T for temporary, which is what these are until the library
 * gives them somewhere permanent to live: they are held by the browser, and the
 * instrument knows nothing about them beyond the 36 values it was sent.
 */
export function slotLabel(index) {
  return `T${index + 1}`;
}

/**
 * True for 36 values this synth could actually hold.
 *
 * Both a completeness test and a validity test, and deliberately the same
 * function for each: unknown parameters arrive as null from the router, and
 * out-of-range ones arrive as anything at all from localStorage, which a user
 * or another build may have written. Neither can be stored, so neither passes.
 */
export function isComplete(values) {
  return Array.isArray(values)
      && values.length === PARAM_COUNT
      && values.every((value, index) => Number.isInteger(value)
                                     && value >= 0
                                     && value <= PARAMETERS[index].maxValue);
}

/** How many of the 36 are known. Only ever used to explain why storing is off. */
export function knownCount(values) {
  if (!Array.isArray(values)) return 0;
  return values.filter((value) => value !== null && value !== undefined).length;
}

export function makePreset(values, { name = '', savedAt = null } = {}) {
  if (!isComplete(values)) {
    throw new Error('a preset needs all 36 parameter values');
  }
  return {
    name: String(name || '').trim().slice(0, NAME_LIMIT),
    values: values.slice(),
    savedAt: savedAt || new Date().toISOString(),
  };
}

export class PresetBank {
  constructor(count = SLOT_COUNT) {
    this.slots = new Array(count).fill(null);
  }

  get size() {
    return this.slots.length;
  }

  inRange(index) {
    return Number.isInteger(index) && index >= 0 && index < this.slots.length;
  }

  /** The preset in a slot, or null. Never the stored object itself. */
  get(index) {
    const preset = this.inRange(index) ? this.slots[index] : null;
    return preset ? { ...preset, values: preset.values.slice() } : null;
  }

  filled(index) {
    return this.inRange(index) && this.slots[index] !== null;
  }

  count() {
    return this.slots.filter(Boolean).length;
  }

  /** Record 36 values into a slot, replacing whatever was there. */
  store(index, values, options = {}) {
    if (!this.inRange(index)) throw new Error(`no such preset slot: ${index}`);
    const preset = makePreset(values, options);
    this.slots[index] = preset;
    return { ...preset, values: preset.values.slice() };
  }

  /**
   * Empty a slot.
   *
   * Nothing presses this yet -- five buttons that record and five that recall is
   * the whole of the row, and re-recording is how a slot is changed. It is here
   * because the bank is also what the library will be built on, and because a
   * slot that turns out to hold something unusable needs a way out that is not
   * clearing the whole of localStorage by hand.
   */
  clear(index) {
    if (!this.inRange(index)) return false;
    if (this.slots[index] === null) return false;
    this.slots[index] = null;
    return true;
  }

  toJSON() {
    return {
      version: STORE_VERSION,
      slots: this.slots.map((preset) => (preset
        ? { name: preset.name, values: preset.values.slice(), savedAt: preset.savedAt }
        : null)),
    };
  }

  /**
   * Read a bank back from storage, keeping whatever is still readable.
   *
   * A slot that does not survive validation is dropped and its neighbours are
   * kept, rather than the whole bank being thrown away for one bad entry: the
   * slots are independent, and four recoverable presets are worth more than a
   * clean refusal. A version this build does not know is a different matter --
   * the values could be in another order or another unit, and sending those to
   * a synth would be worse than losing them, so that bank is not read at all.
   */
  static fromJSON(data, count = SLOT_COUNT) {
    const bank = new PresetBank(count);
    if (!data || typeof data !== 'object') return bank;
    if (data.version !== STORE_VERSION) return bank;
    if (!Array.isArray(data.slots)) return bank;

    data.slots.slice(0, count).forEach((entry, index) => {
      if (!entry || !isComplete(entry.values)) return;
      bank.slots[index] = makePreset(entry.values, {
        name: entry.name,
        savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : null,
      });
    });
    return bank;
  }
}
