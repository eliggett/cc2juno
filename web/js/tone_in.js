// What the synth says back: the tone data it broadcasts of its own accord.
//
// An Alpha Juno announces every patch change by sending its whole edit buffer,
// and announces a front-panel parameter edit by sending that one parameter. Both
// are addressed messages sharing the framing alpha_juno.js builds:
//
//     F0  41  <op>  0n  23  <level>  <group>  ...  F7
//         |    |     |   |     |        |
//         |    |     |   |     |        +-- group #, always 01
//         |    |     |   |     +----------- level: 20 tone (the only one we read)
//         |    |     |   +----------------- format type, 23 = JU-1/JU-2/MKS-50
//         |    |     +--------------------- unit # = basic channel - 1
//         |    +--------------------------- operation code: 35 APR, 36 IPR
//         +-------------------------------- Roland
//
// APR carries all 36 parameters, and on a JU-2 ten more bytes of tone name after
// them. The name is optional because the message is legal without it: a librarian
// sending an edit buffer has no name to give.
//
// The 36 bytes are parameter values in the same order and the same units as
// PARAMETERS, so they are used as they arrive. This is worth stating because the
// *other* Alpha Juno format, the 32-byte bulk dump, is neither: it reorders the
// parameters and stores six of them in four bits. Anything that reads a bulk dump
// has to unpack it. Nothing here does.
//
// Source: Alpha Juno-2 (JU-2) MIDI Implementation v1.1, 1986-01-27, sections 3.1
// (APR), 3.2 (IPR) and the TONE NAME table.

import {
  PARAMETERS, SYSEX_START, SYSEX_END, ROLAND_ID, FORMAT_TYPE, OPCODE_INDIVIDUAL_TONE,
} from './alpha_juno.js';

export const OPCODE_ALL_PARAMETERS = 0x35;
export const LEVEL_TONE = 0x20;

export const PARAM_COUNT = PARAMETERS.length;
export const NAME_LENGTH = 10;

const HEADER = 7;                   // F0 41 op 0n 23 level group
const APR_MIN = HEADER + PARAM_COUNT + 1;
const APR_NAMED = HEADER + PARAM_COUNT + NAME_LENGTH + 1;
const IPR_LENGTH = 10;

// 0-25 = A-Z, 26-51 = a-z, 52-61 = 0-9, 62 = space, 63 = '-'.
const CHARSET = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ' ', '-',
];

/** Decode ten six-bit codes into a tone name, trailing spaces removed. */
export function decodeName(codes) {
  let name = '';
  for (const code of codes) name += CHARSET[code & 0x3F];
  return name.replace(/\s+$/, '');
}

/** True for the framing every addressed Alpha Juno message shares. */
function addressed(bytes, opcode) {
  return bytes.length >= HEADER + 1
      && bytes[0] === SYSEX_START
      && bytes[1] === ROLAND_ID
      && bytes[2] === opcode
      && bytes[4] === FORMAT_TYPE
      && bytes[bytes.length - 1] === SYSEX_END;
}

/**
 * Read one system-exclusive message from the synth.
 *
 * Returns null for anything that is not tone data -- another manufacturer, a
 * handshake, a bulk dump, or the MKS-50's patch and chord levels, whose bytes
 * would otherwise be read as parameters they are not.
 *
 *   {kind: 'tone',  channel, values: number[36], name}
 *   {kind: 'param', channel, index, value}
 */
export function parseToneMessage(bytes) {
  const level = bytes[5];

  if (addressed(bytes, OPCODE_ALL_PARAMETERS)) {
    if (level !== LEVEL_TONE) return null;
    if (bytes.length < APR_MIN) return null;
    const values = [];
    for (let i = 0; i < PARAM_COUNT; i += 1) {
      // Clipped to the parameter's own maximum: a value the table says cannot
      // exist would otherwise send a knob past the end of its travel.
      values.push(Math.min(bytes[HEADER + i] & 0x7F, PARAMETERS[i].maxValue));
    }
    const name = bytes.length >= APR_NAMED
      ? decodeName(bytes.slice(HEADER + PARAM_COUNT, HEADER + PARAM_COUNT + NAME_LENGTH))
      : '';
    return { kind: 'tone', channel: (bytes[3] & 0x0F) + 1, values, name };
  }

  if (addressed(bytes, OPCODE_INDIVIDUAL_TONE)) {
    if (level !== LEVEL_TONE) return null;
    if (bytes.length !== IPR_LENGTH) return null;
    const index = bytes[7];
    if (index >= PARAM_COUNT) return null;
    return {
      kind: 'param',
      channel: (bytes[3] & 0x0F) + 1,
      index,
      value: Math.min(bytes[8] & 0x7F, PARAMETERS[index].maxValue),
    };
  }

  return null;
}

/**
 * Complete F0..F7 messages, gathered from however the browser hands them over.
 *
 * Web MIDI is allowed to deliver one system-exclusive message as several events,
 * and a synth is allowed to interleave clock and other real-time bytes into the
 * middle of one. Neither happens in Chrome with a patch change today, and both
 * would present as tone changes that silently do nothing, which is a poor thing
 * to debug later for the sake of the few lines it costs to handle now.
 */
export class SysexStream {
  /** @param limit bytes to gather before giving up on a message that has no end. */
  constructor(limit = 1024) {
    this.limit = limit;
    this.buffer = [];
    this.collecting = false;
  }

  feed(data) {
    const messages = [];
    for (const byte of data) {
      if (byte >= 0xF8) continue;              // real-time, legal mid-message

      if (!this.collecting) {
        if (byte === SYSEX_START) {
          this.collecting = true;
          this.buffer = [byte];
        }
        continue;
      }

      if (byte === SYSEX_END) {
        this.buffer.push(byte);
        messages.push(Uint8Array.from(this.buffer));
        this.reset();
        continue;
      }
      // Any other status byte means the message was cut short and whatever
      // follows is a different message; the fragment is dropped rather than
      // guessed at. F0 restarts the gathering, which is the same rule.
      if (byte >= 0x80) {
        this.reset();
        if (byte === SYSEX_START) {
          this.collecting = true;
          this.buffer = [byte];
        }
        continue;
      }

      this.buffer.push(byte);
      if (this.buffer.length > this.limit) this.reset();
    }
    return messages;
  }

  reset() {
    this.buffer = [];
    this.collecting = false;
  }
}
