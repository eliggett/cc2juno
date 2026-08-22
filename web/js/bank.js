// The Alpha Juno's *other* tone format: the 32-byte packed form a bulk dump
// carries, and the bank of 64 slots built out of it.
//
// The rest of cc2juno speaks APR/IPR, where a tone is 36 plain bytes in
// PARAMETERS order and every one of them is 0..127. A bulk dump is neither. It
// bit-packs the same sound into 32 bytes, reorders the parameters, splits eleven
// of them across single bits scattered through the block, and stores six more
// with only four bits of resolution. It also carries the one thing APR does not:
// the ten-character name.
//
// So this module is a translator, and the translation is the whole point of it:
//
//     packed 32 bytes  <->  Tone{name, params[36]}  <->  APR/IPR, presets, the panel
//
// `Tone.params` is deliberately in **APR units**, not in the bulk format's own.
// Everything else here -- router.sendTone, presets.js, the PG-300 sliders, the
// knob grid -- already works in those units, and a Tone that had to be converted
// at every use would eventually be used without converting. The four-bit fields
// are therefore widened on the way in (<<3) and narrowed on the way out (>>3),
// which round-trips exactly because (n << 3) >> 3 === n.
//
// Source: Alpha Juno-2 (JU-2) MIDI Implementation v1.1, 1986-01-27, section 3.3
// (BLD, the "TONE data format" and "Switch bit" tables) and the TONE NAME table.
// Cross-checked byte for byte against the alphamanager librarian, which drives
// real hardware with it.

import { PARAMETERS, SYSEX_START, SYSEX_END, ROLAND_ID, FORMAT_TYPE } from './alpha_juno.js';

export const PARAM_COUNT = PARAMETERS.length;   // 36
export const PACKED_SIZE = 32;
export const NAME_LENGTH = 10;

export const BANKS = 8;
export const PER_BANK = 8;
export const TONE_COUNT = BANKS * PER_BANK;     // 64

export const TONES_PER_MESSAGE = 4;
export const BULK_MESSAGE_COUNT = TONE_COUNT / TONES_PER_MESSAGE;   // 16

// Operation codes. BLD is the only one built here; the others are named so that
// a message can be recognised and ignored rather than mistaken for tone data.
export const OPCODE_BULK = 0x37;
export const GROUP = 0x01;

// Level numbers. An MKS-50 file carries patch and chord blocks alongside the
// tones; they are kept verbatim rather than parsed, so that loading and re-saving
// such a file never quietly discards them.
export const LEVEL_TONE = 0x20;
export const LEVEL_PATCH = 0x30;
export const LEVEL_CHORD = 0x40;

export class BulkError extends Error {}

// --------------------------------------------------------------- charset ---
// 0-25 = A-Z, 26-51 = a-z, 52-61 = 0-9, 62 = space, 63 = '-'. The same table
// tone_in.js decodes APR names with, written out here as well because this file
// has to *encode* too and tone_in.js never does.

export const CHARSET = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ' ', '-',
];

const CODE_OF = new Map(CHARSET.map((character, code) => [character, code]));
const SPACE_CODE = 62;

/** Decode ten six-bit codes into a name, trailing spaces kept. */
export function decodeName(codes) {
  let name = '';
  for (const code of codes) name += CHARSET[code & 0x3F];
  return name;
}

/**
 * Encode a name to exactly ten six-bit codes, padded and truncated.
 *
 * An unrepresentable character becomes a space rather than an error: a librarian
 * should never refuse to keep a patch over one bad character in its name.
 */
export function encodeName(name) {
  const padded = String(name ?? '').slice(0, NAME_LENGTH).padEnd(NAME_LENGTH);
  return Array.from(padded, (character) => (CODE_OF.has(character)
    ? CODE_OF.get(character)
    : SPACE_CODE));
}

/** Fold whatever was typed into something the synth's character set can hold. */
export function sanitizeName(name) {
  return decodeName(encodeName(name));
}

// ---------------------------------------------------------- slot numbering ---
// The Alpha Juno has no zero button: memory runs bank 1-8, number 1-8, so the
// first slot is "11" and the last is "88". Indices stay 0-63 internally and only
// become panel numbers at the edges.

export function slotLabel(index) {
  if (!Number.isInteger(index) || index < 0 || index >= TONE_COUNT) {
    throw new RangeError(`slot index out of range: ${index}`);
  }
  return `${Math.floor(index / PER_BANK) + 1}${(index % PER_BANK) + 1}`;
}

export function slotIndex(label) {
  const text = String(label).trim();
  if (!/^[1-8][1-8]$/.test(text)) throw new RangeError(`slot must be 11-88, got ${label}`);
  return (Number(text[0]) - 1) * PER_BANK + (Number(text[1]) - 1);
}

// --------------------------------------------------------- packed layout ---

// Parameters the bulk format stores in four bits while APR and IPR carry the
// same setting as 0..127. Widened going in, narrowed going out.
//
// Bender Range (35) is *not* one of them, and that is the trap: it is four bits
// in bulk as well, but its APR range is a documented 0-12, so it already means
// the same number in both worlds. Scaling it produces values like 16 for a field
// that stops at 12, which a synth may reject outright.
export const SCALED_PARAMS = new Set([13, 20, 21, 23, 33]);
export const APR_SCALE = 3;   // a 4-bit value << 3 spans 0-120 of the 0-127 range
const BENDER_RANGE = 35;

// Bytes 0-2: two 4-bit fields each, high nibble first.
const NIBBLE_FIELDS = [
  [0, 13, 20],   // DCO Aftertouch Depth | VCF Key Follow
  [1, 21, 23],   // VCF Aftertouch Depth | VCA Aftertouch Depth
  [2, 33, 35],   // Env Key Follow       | DCO Bender Range
];

// Bytes 3-20: bits 6-0 hold a 7-bit parameter; bit 7 is a switch bit (unused for
// byte 3). The index of this array is the byte number minus 3.
const SEVEN_BIT_ORDER = [
  11,  // byte  3  DCO LFO Mod Depth  (bit 7 unused)
  12,  // byte  4  DCO Env Mod Depth
  14,  // byte  5  DCO PW/PWM Depth
  15,  // byte  6  DCO PWM Rate
  16,  // byte  7  VCF Cutoff
  17,  // byte  8  VCF Resonance
  19,  // byte  9  VCF Env Mod Depth
  18,  // byte 10  VCF LFO Mod Depth
  22,  // byte 11  VCA Level
  24,  // byte 12  LFO Rate
  25,  // byte 13  LFO Delay
  26,  // byte 14  Env T1
  27,  // byte 15  Env L1
  28,  // byte 16  Env T2
  29,  // byte 17  Env L2
  30,  // byte 18  Env T3
  31,  // byte 19  Env L3
  32,  // byte 20  Env T4
];

// Switch bits b00-b22 live in bit 7 of bytes 4-26. Each entry maps a parameter
// to the bits holding it, most significant first, per the "Switch bit" table.
const SWITCH_FIELDS = [
  [10, [0]],              // Chorus
  [0, [1, 2]],            // DCO Env Mode
  [1, [3, 4]],            // VCF Env Mode
  [2, [5, 6]],            // VCA Env Mode
  [5, [7, 8, 9]],         // DCO Waveform Sub
  [4, [10, 11, 12]],      // DCO Waveform Sawtooth
  [3, [13, 14]],          // DCO Waveform Pulse
  [9, [15, 16]],          // HPF Cutoff Freq
  [6, [17, 18]],          // DCO Range
  [7, [19, 20]],          // DCO Sub Level
  [8, [21, 22]],          // DCO Noise Level
];

const NAME_FIRST_BYTE = 21;    // bytes 21-30 carry name chars 1-10 in bits 5-0
const CHORUS_RATE_PARAM = 34;

/** Byte index and mask for switch bit b`n` (b00..b22 -> bytes 4..26). */
const switchBit = (n) => [4 + n, 0x80];

/** Byte index and mask for chorus-rate bit c`k` (c0..c7 -> bytes 27-30). */
const chorusBit = (k) => [27 + Math.floor(k / 2), 0x40 << (k % 2)];

const clampParam = (index, value) => Math.max(
  0, Math.min(PARAMETERS[index].maxValue, Math.trunc(value) || 0),
);

// ------------------------------------------------------------------ tone ---

/** One Alpha Juno tone: a ten-character name and 36 parameters in APR units. */
export class Tone {
  constructor(name = '', params = null) {
    this.name = sanitizeName(name);
    this.params = params ? params.slice(0, PARAM_COUNT) : new Array(PARAM_COUNT).fill(0);
    while (this.params.length < PARAM_COUNT) this.params.push(0);
    this.params = this.params.map((value, index) => clampParam(index, value));
  }

  /** The name without its padding, which is what a list wants to show. */
  get displayName() {
    return this.name.replace(/\s+$/, '');
  }

  /**
   * True for a slot that has never been given a sound.
   *
   * A new set is 64 of these. Every parameter is zero, VCA Level included, so
   * there is nothing to hear even if the synth accepts the data -- auditioning
   * one looks exactly like a transfer that silently failed. The name is
   * deliberately not consulted: typing a name into a slot does not give it a
   * sound, and that is the case that makes an empty patch easy to send by
   * mistake.
   */
  get isEmpty() {
    return !this.params.some(Boolean);
  }

  copy() {
    return new Tone(this.name, this.params);
  }

  equals(other) {
    return other instanceof Tone
        && other.name === this.name
        && other.params.every((value, index) => value === this.params[index]);
  }

  /** Decode the 32-byte bulk-dump representation. */
  static fromPacked(data) {
    if (data.length !== PACKED_SIZE) {
      throw new BulkError(`tone data must be ${PACKED_SIZE} bytes, got ${data.length}`);
    }
    const params = new Array(PARAM_COUNT).fill(0);

    for (const [byte, high, low] of NIBBLE_FIELDS) {
      params[high] = (data[byte] >> 4) & 0x0F;
      params[low] = data[byte] & 0x0F;
    }
    for (const [offset, index] of SEVEN_BIT_ORDER.entries()) {
      params[index] = data[3 + offset] & 0x7F;
    }
    for (const [index, bits] of SWITCH_FIELDS) {
      let value = 0;
      for (const bit of bits) {              // most significant first
        const [byte, mask] = switchBit(bit);
        value = (value << 1) | (data[byte] & mask ? 1 : 0);
      }
      params[index] = value;
    }
    let rate = 0;
    for (let k = 0; k < 7; k += 1) {          // c7 is always 0; the rate is c6..c0
      const [byte, mask] = chorusBit(k);
      if (data[byte] & mask) rate |= 1 << k;
    }
    params[CHORUS_RATE_PARAM] = rate;

    // The four-bit fields become the 0..127 the rest of the program works in.
    // Bender range is left alone -- see SCALED_PARAMS.
    for (const index of SCALED_PARAMS) params[index] <<= APR_SCALE;

    const codes = [];
    for (let i = 0; i < NAME_LENGTH; i += 1) codes.push(data[NAME_FIRST_BYTE + i] & 0x3F);
    return new Tone(decodeName(codes), params);
  }

  /** Encode to the 32-byte bulk-dump representation. */
  toPacked() {
    const data = new Uint8Array(PACKED_SIZE);
    // A local copy in the bulk format's own units, so the narrowing happens once
    // and every field below can be written without wondering which world it is in.
    const params = this.params.slice();
    for (const index of SCALED_PARAMS) params[index] = (params[index] >> APR_SCALE) & 0x0F;
    params[BENDER_RANGE] &= 0x0F;

    for (const [byte, high, low] of NIBBLE_FIELDS) {
      data[byte] = ((params[high] & 0x0F) << 4) | (params[low] & 0x0F);
    }
    for (const [offset, index] of SEVEN_BIT_ORDER.entries()) {
      data[3 + offset] = params[index] & 0x7F;
    }
    for (const [index, bits] of SWITCH_FIELDS) {
      const value = params[index];
      // Least significant bit first, which is the reverse of the reading order.
      [...bits].reverse().forEach((bit, position) => {
        if (value & (1 << position)) {
          const [byte, mask] = switchBit(bit);
          data[byte] |= mask;
        }
      });
    }
    const rate = params[CHORUS_RATE_PARAM] & 0x7F;
    for (let k = 0; k < 7; k += 1) {
      if (rate & (1 << k)) {
        const [byte, mask] = chorusBit(k);
        data[byte] |= mask;
      }
    }
    encodeName(this.name).forEach((code, i) => { data[NAME_FIRST_BYTE + i] |= code & 0x3F; });
    return data;
  }

  toJSON() {
    return { name: this.name, params: this.params.slice() };
  }

  static fromJSON(data) {
    if (!data || !Array.isArray(data.params)) throw new BulkError('not a tone');
    return new Tone(data.name || '', data.params);
  }
}

// --------------------------------------------------------- nibble packing ---
// "TONE data is sent in four-bit nibbles, right justified, least significant
//  nibble sent first."

export function toNibbles(data) {
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i += 1) {
    out[i * 2] = data[i] & 0x0F;
    out[i * 2 + 1] = (data[i] >> 4) & 0x0F;
  }
  return out;
}

export function fromNibbles(nibbles) {
  if (nibbles.length % 2) throw new BulkError(`odd nibble count (${nibbles.length})`);
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (nibbles[i * 2] & 0x0F) | ((nibbles[i * 2 + 1] & 0x0F) << 4);
  }
  return out;
}

// ------------------------------------------------------ message splitting ---

// Real-time messages are allowed to interleave into the middle of a system
// exclusive message, so they are stepped over rather than ending one.
const REALTIME_FIRST = 0xF8;

/**
 * Every complete F0..F7 message in a blob, ignoring whatever lies between them.
 *
 * Files in the wild carry stray bytes between messages -- a saved MIDI stream, a
 * program that padded its output, an FTP client that turned an 0A into 0D 0A --
 * and skipping them is what lets those banks load at all.
 *
 * The subtle part is where a message *ends*. Scanning ahead for the next F7 is
 * wrong, and wrong in a way that only shows up once files are joined together: a
 * dump ending in a dangling F0 -- EZBANK1.SYX out of the MKS-50 collection is one
 * -- is harmless on its own, because the F0 simply runs off the end of the file.
 * Concatenate it with another bank and that scan runs on into the next file and
 * swallows its first message whole, costing four patches with nothing to show for
 * it but a bank that is mysteriously four short.
 *
 * So a message ends at F7 or not at all: between F0 and F7 a sysex carries data
 * bytes only, and any other status byte means this one was cut short. That is the
 * same rule SysexStream in tone_in.js applies to the wire, for the same reason.
 */
export function splitMessages(data) {
  const messages = [];
  let index = 0;
  while (index < data.length) {
    const start = data.indexOf(SYSEX_START, index);
    if (start === -1) break;

    let end = -1;
    let realtime = 0;
    for (let at = start + 1; at < data.length; at += 1) {
      const byte = data[at];
      if (byte === SYSEX_END) { end = at; break; }
      if (byte >= REALTIME_FIRST) { realtime += 1; continue; }
      if (byte >= 0x80) break;              // a status byte: this message is cut short
    }
    if (end === -1) {
      // Abandon it and look again from just past the F0, so that a message
      // starting a byte later -- the next file along -- is still found.
      index = start + 1;
      continue;
    }

    const message = data.slice(start, end + 1);
    // F0 and F7 are both below the real-time range, so they survive this.
    messages.push(realtime ? message.filter((byte) => byte < REALTIME_FIRST) : message);
    index = end + 1;
  }
  return messages;
}

/** Parse one BLD message, or null if it is not one. */
export function parseBulk(message) {
  if (message.length < 11) return null;
  if (message[0] !== SYSEX_START || message[1] !== ROLAND_ID || message[2] !== OPCODE_BULK) {
    return null;
  }
  if (message[4] !== FORMAT_TYPE) return null;

  const channel = (message[3] & 0x0F) + 1;
  const level = message[5];
  const firstTone = message[8];
  let nibbles = message.slice(9, message.length - 1);
  // A trailing stray nibble turns up in files whose writer padded the message.
  if (nibbles.length % 2) nibbles = nibbles.slice(0, -1);
  const payload = fromNibbles(nibbles);

  const tones = [];
  if (level === LEVEL_TONE) {
    for (let offset = 0; offset + PACKED_SIZE <= payload.length; offset += PACKED_SIZE) {
      tones.push(Tone.fromPacked(payload.slice(offset, offset + PACKED_SIZE)));
    }
  }
  return { channel, level, firstTone, tones, payload };
}

/**
 * Build one BLD message carrying `tones` from slot `firstTone` onward.
 *
 * Fewer than four is legal on receive -- "Program # is recognized as the first
 * TONE number... 32 bytes are recognized as a set of TONE data" -- but an Alpha
 * Juno-2 does not act on a partial set: armed in BULK LOAD it waits for all
 * sixteen messages and commits nothing until they arrive. Verified against
 * hardware by the alphamanager project, which is why this program never offers
 * to write a single slot.
 */
export function buildBulk(tones, firstTone, channel = 1, level = LEVEL_TONE) {
  if (!(tones.length >= 1 && tones.length <= TONES_PER_MESSAGE)) {
    throw new BulkError(`a bulk message holds 1-${TONES_PER_MESSAGE} tones`);
  }
  const payload = new Uint8Array(tones.length * PACKED_SIZE);
  tones.forEach((tone, i) => payload.set(tone.toPacked(), i * PACKED_SIZE));
  const nibbles = toNibbles(payload);

  const message = new Uint8Array(9 + nibbles.length + 1);
  message.set([SYSEX_START, ROLAND_ID, OPCODE_BULK, (channel - 1) & 0x0F, FORMAT_TYPE,
               level, GROUP, 0x00, firstTone & 0x7F], 0);
  message.set(nibbles, 9);
  message[message.length - 1] = SYSEX_END;
  return message;
}

// ------------------------------------------------------------------ bank ---

/**
 * 64 slots, plus whatever non-tone blocks came with them.
 *
 * Slots are fixed addresses, not a list: the synth has exactly 64 of them and no
 * notion of "make room", so dropping a patch onto one *replaces* it. move() is
 * the one exception and exists because reordering a set before writing it is the
 * main reason to have a librarian at all.
 */
export class Bank {
  constructor(tones = null) {
    this.tones = tones && tones.length === TONE_COUNT
      ? tones
      : Array.from({ length: TONE_COUNT }, () => new Tone());
    this.channel = 1;
    // Where this bank came from, for a pane showing several at once: several
    // files can be open together and each bank belongs to one of them, so the
    // label has to travel with the bank rather than with the pane.
    this.source = '';
    // Which slots a file or a dump actually supplied. A .syx holding sixteen
    // patches should list sixteen rows, not sixteen followed by 48 blanks, and
    // only the source that filled them knows the difference.
    this.filled = new Set();
    // MKS-50 patch (0x30) and chord (0x40) blocks, kept verbatim: their bit
    // layout is in a manual we do not have, and dropping them would quietly
    // damage an MKS-50 file that merely passed through here.
    this.extraBlocks = [];
  }

  get(index) {
    return this.tones[index];
  }

  set(index, tone) {
    this.tones[index] = tone;
    this.filled.add(index);
  }

  /** Slot indices worth listing: what was loaded, or all 64 once edited. */
  occupied() {
    return [...Array(TONE_COUNT).keys()].filter((i) => this.filled.has(i)
                                                    || !this.tones[i].isEmpty);
  }

  count() {
    return this.occupied().length;
  }

  copy() {
    const bank = new Bank(this.tones.map((tone) => tone.copy()));
    bank.channel = this.channel;
    bank.source = this.source;
    bank.filled = new Set(this.filled);
    bank.extraBlocks = this.extraBlocks.map((block) => block.slice());
    return bank;
  }

  /** Move a tone, sliding everything in between to close the gap. */
  move(from, to) {
    if (from === to) return;
    const [tone] = this.tones.splice(from, 1);
    this.tones.splice(to, 0, tone);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    for (let i = low; i <= high; i += 1) this.filled.add(i);
  }

  /**
   * Move several tones as a group, landing them at `to` in the new order.
   *
   * `to` is the slot they were dropped on and it is where the group starts, which
   * is the only answer that agrees with everything around it: `move()` above
   * lands a single tone on its target, and a drop from the other pane replaces
   * the target slot onward. Subtracting the tones that came from above the target
   * -- the arithmetic list insertion invites -- lands the group one short of the
   * row it was dropped on when dragging downward, which looks like the drop
   * having missed.
   *
   * The slot the group came to rest in is returned, so nothing has to redo this
   * in order to re-select what it just moved.
   */
  moveMany(indices, to) {
    const moving = new Set(indices);
    if (!moving.size) return 0;
    const taken = [...indices].sort((a, b) => a - b).map((i) => this.tones[i]);
    const rest = this.tones.filter((_, i) => !moving.has(i));
    const at = Math.max(0, Math.min(rest.length, to));
    rest.splice(at, 0, ...taken);
    this.tones = rest;
    for (let i = 0; i < TONE_COUNT; i += 1) this.filled.add(i);
    return at;
  }

  swap(first, second) {
    [this.tones[first], this.tones[second]] = [this.tones[second], this.tones[first]];
    this.filled.add(first);
    this.filled.add(second);
  }

  /**
   * Build a bank from the raw contents of a .syx file or a captured dump.
   *
   * The first bank, if the file holds more than one -- see banksFromSysex, which
   * is what anything showing a file to a user should be calling.
   */
  static fromSysex(data) {
    const banks = banksFromSysex(data);
    if (!banks.length) throw new BulkError('no Alpha Juno tone bulk data in this file');
    return banks[0];
  }

  /** The sixteen BLD messages the synth sends, as separate messages. */
  toMessages(channel = null) {
    const target = channel || this.channel;
    const messages = [];
    for (let i = 0; i < BULK_MESSAGE_COUNT; i += 1) {
      const first = i * TONES_PER_MESSAGE;
      messages.push(buildBulk(this.tones.slice(first, first + TONES_PER_MESSAGE),
                              first, target));
    }
    return messages;
  }

  /** The same thing as one blob, which is exactly a .syx file. */
  toSysex(channel = null, { includeExtra = true } = {}) {
    const blocks = this.toMessages(channel);
    if (includeExtra) blocks.push(...this.extraBlocks);
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const block of blocks) {
      out.set(block, offset);
      offset += block.length;
    }
    return out;
  }
}

// ---------------------------------------------------- more than one bank ---

/**
 * Every bank in a file, in the order they appear. Empty if there are none.
 *
 * A synth has 64 memories and a Bank has 64 slots, but a *file* is under no such
 * obligation, and plenty in circulation hold several banks. Reading one of those
 * into a single Bank loses patches without saying so, which is the worst way to
 * lose them: the later banks overwrite the earlier ones slot for slot, so the
 * result is a full, healthy-looking 64 patches that are simply not the ones the
 * file was named after.
 *
 * Two shapes turn up, and they are told apart differently:
 *
 *   Concatenated   Each bank addresses slots 0-63, because each was dumped
 *                  separately and the files were joined end to end. There is no
 *                  marker between them; what gives it away is a message landing
 *                  on a slot this bank has already been given, which within one
 *                  dump never happens.
 *   Numbered       The messages address slots 64 and up, so the bank number is
 *                  in the address: slot 70 is bank 2, slot 6.
 *
 * A message repeated inside one genuine dump -- a librarian writing a correction
 * over its own output -- would be read as the start of a new bank. That is rare,
 * and erring that way shows the patches instead of hiding them.
 */
export function banksFromSysex(data) {
  const banks = [];
  const used = [];
  const extraBlocks = [];
  let channel = null;
  let current = 0;

  const ensure = (index) => {
    while (banks.length <= index) { banks.push(new Bank()); used.push(new Set()); }
  };

  for (const message of splitMessages(data)) {
    const parsed = parseBulk(message);
    if (!parsed) continue;
    if (channel === null) channel = parsed.channel;
    if (parsed.level !== LEVEL_TONE) { extraBlocks.push(message); continue; }

    const numbered = Math.floor(parsed.firstTone / TONE_COUNT);
    const base = parsed.firstTone % TONE_COUNT;
    let target;
    if (numbered > 0) {
      target = numbered;
      ensure(target);
    } else {
      ensure(current);
      if (used[current].has(base)) { current += 1; ensure(current); }
      target = current;
    }

    parsed.tones.forEach((tone, offset) => {
      const index = base + offset;
      // A message near the end of a bank whose four tones would run past slot 88.
      // The overflow belongs to no address the synth has, so it is dropped rather
      // than wrapped into the next bank.
      if (index < 0 || index >= TONE_COUNT) return;
      banks[target].tones[index] = tone;
      banks[target].filled.add(index);
      used[target].add(index);
    });
  }

  // A numbered file may leave gaps -- bank 3 present, bank 2 absent -- and a
  // blank bank in the middle of a browser is a puzzle rather than information.
  const filled = banks.filter((bank) => bank.filled.size);
  for (const bank of filled) bank.channel = channel || 1;
  // The MKS-50 patch and chord blocks belong to the file rather than to any one
  // bank of tones, so they ride with the first and are written back with it.
  if (filled.length) filled[0].extraBlocks = extraBlocks;
  return filled;
}
