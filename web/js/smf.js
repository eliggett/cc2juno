// Reading sysex back out of a Standard MIDI File.
//
// A .syx file is the bytes themselves and nothing else, which is why loading one
// is a matter of scanning for F0..F7. A .mid file is a container: every message
// is wrapped in a delta time and, for sysex, a length -- so the same scan finds
// an F0, reads the length byte as though it were the manufacturer ID, and throws
// the message away as not being Roland's. That is exactly what used to happen,
// and it presented as "no Alpha Juno tone bulk data in this file" for a file that
// was full of it.
//
// So the container has to be unwrapped properly. The parts that matter:
//
//   MThd <len> <format> <ntrks> <division>     the header chunk
//   MTrk <len> <events...>                     one or more track chunks
//
// and inside a track, each event is a variable-length delta time followed by:
//
//   FF <type> <len> <data>     meta -- tempo, track name, end of track
//   F0 <len> <data>            sysex; the transmitted message is F0 + data
//   F7 <len> <data>            "escape": the bytes go out verbatim. Used to
//                              continue a sysex split across several events,
//                              and by some writers to hold a whole message
//   8n..En                     channel voice, one or two data bytes, and the
//                              status byte may be left out entirely if it
//                              repeats -- "running status"
//
// Running status is the reason this cannot be done by skipping to the next F0:
// without decoding every channel event, there is no way to know how many bytes
// to step over, and a data byte that happens to be 0xF0 would be read as the
// start of a message. Chunks of an unknown type are skipped by their length, as
// the specification requires.
//
// Source: Standard MIDI Files 1.0 (RP-001), sections on chunk layout, meta
// events, and "System Exclusive Events".

export class SmfError extends Error {}

const MTHD = 0x4D546864;   // 'MThd'
const MTRK = 0x4D54726B;   // 'MTrk'
const RIFF = 0x52494646;   // 'RIFF'
const RMID = 0x524D4944;   // 'RMID'
const DATA = 0x64617461;   // 'data'

const SYSEX_START = 0xF0;
const SYSEX_END = 0xF7;
const META = 0xFF;

const be32 = (data, at) => (
  (data[at] << 24 | data[at + 1] << 16 | data[at + 2] << 8 | data[at + 3]) >>> 0
);
const be16 = (data, at) => (data[at] << 8) | data[at + 1];

/** True for something that looks like a MIDI file rather than a raw dump. */
export function isSmf(data) {
  if (data.length < 8) return false;
  if (be32(data, 0) === MTHD) return true;
  // RMID: a MIDI file inside a RIFF wrapper. Rare, but it costs nothing to
  // recognise and it is indistinguishable from a broken file if we do not.
  return data.length >= 12 && be32(data, 0) === RIFF && be32(data, 8) === RMID;
}

/** The MThd..end of an RMID payload, or the data unchanged. */
function unwrapRiff(data) {
  if (be32(data, 0) !== RIFF) return data;
  let at = 12;
  while (at + 8 <= data.length) {
    const id = be32(data, at);
    const size = be32(data, at + 4);
    if (id === DATA) return data.subarray(at + 8, Math.min(data.length, at + 8 + size));
    at += 8 + size + (size & 1);      // RIFF chunks are padded to even lengths
  }
  throw new SmfError('this RIFF file has no MIDI data chunk in it');
}

/**
 * One track's worth of events, handing every complete sysex message to `emit`.
 *
 * Nothing else is kept. The notes, the tempo and the track names are read only
 * far enough to know how many bytes to step over -- this is a librarian, not a
 * sequencer, and a patch dump saved as a MIDI file is the only thing it is
 * looking for.
 */
function readTrack(data, start, end, emit) {
  let at = start;
  let running = 0;
  // A sysex too long for one event is split: an F0 event whose data does not
  // end in F7, then F7 events until one does. Held here until it is finished.
  let partial = null;

  // Seven bits per byte, top bit set on every byte but the last. Four is the
  // most the format allows, and a fifth means the track is not what it claims.
  const vlq = () => {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      if (at >= end) throw new SmfError('the track ends in the middle of a number');
      const byte = data[at];
      at += 1;
      value = (value << 7) | (byte & 0x7F);
      if (!(byte & 0x80)) return value;
    }
    throw new SmfError('a variable-length number is longer than four bytes');
  };

  const take = (length) => {
    if (at + length > end) throw new SmfError('an event runs past the end of its track');
    const slice = data.subarray(at, at + length);
    at += length;
    return slice;
  };

  const finish = (bytes) => {
    // Only complete messages are handed on. A dump that was cut off part way
    // through being saved would otherwise arrive as a tone with garbage in it,
    // which is worse than arriving as one patch fewer.
    if (bytes.length >= 2 && bytes[0] === SYSEX_START
        && bytes[bytes.length - 1] === SYSEX_END) {
      emit(Uint8Array.from(bytes));
    }
  };

  while (at < end) {
    vlq();                                   // the delta time, which we discard
    if (at >= end) break;
    const status = data[at];

    if (status === META) {
      at += 1;
      const type = data[at]; at += 1;
      const length = vlq();
      take(length);
      running = 0;                           // meta events clear running status
      if (type === 0x2F) break;              // end of track
      continue;
    }

    if (status === SYSEX_START) {
      at += 1;
      const chunk = take(vlq());
      running = 0;
      partial = [SYSEX_START, ...chunk];
      if (chunk[chunk.length - 1] === SYSEX_END) { finish(partial); partial = null; }
      continue;
    }

    if (status === SYSEX_END) {
      at += 1;
      const chunk = take(vlq());
      running = 0;
      if (partial) {
        // A continuation packet: its bytes carry on the message already begun.
        partial.push(...chunk);
        if (chunk[chunk.length - 1] === SYSEX_END) { finish(partial); partial = null; }
      } else if (chunk[0] === SYSEX_START) {
        // Some writers put a whole message in an escape event rather than in an
        // F0 event. It is legal -- the bytes go out verbatim -- and it reads as
        // an empty file if we insist on the tidier form.
        finish([...chunk]);
      }
      continue;
    }

    if (status >= 0x80) { running = status; at += 1; }
    else if (!running) throw new SmfError('a track event has no status byte to run from');
    // Program change and channel aftertouch carry one data byte; the rest carry two.
    const kind = running & 0xF0;
    at += (kind === 0xC0 || kind === 0xD0) ? 1 : 2;
  }
}

/**
 * Every complete sysex message in a MIDI file, in the order it would be played.
 *
 * Returns `{messages, format, tracks}`. The messages are separate rather than
 * concatenated so a caller can say how many it found, which is the difference
 * between "that file holds no sysex at all" and "that file holds sysex for some
 * other instrument" -- two problems with very different answers.
 */
export function sysexFromSmf(input) {
  const data = unwrapRiff(input);
  if (data.length < 14 || be32(data, 0) !== MTHD) {
    throw new SmfError('this does not start with a MIDI file header');
  }
  const headerLength = be32(data, 4);
  const format = be16(data, 8);
  const tracks = be16(data, 10);

  const messages = [];
  let at = 8 + headerLength;                 // not a fixed 14: the header may grow
  while (at + 8 <= data.length) {
    const id = be32(data, at);
    const length = be32(data, at + 4);
    const start = at + 8;
    // A length that runs past the end turns up in files truncated by a transfer.
    // Reading to the end of what is there beats refusing the whole file.
    const end = Math.min(data.length, start + length);
    if (id === MTRK) readTrack(data, start, end, (message) => messages.push(message));
    at = start + length;
    if (length === 0 && id !== MTRK) break;  // a zero-length unknown chunk: give up
  }
  return { messages, format, tracks };
}

/** The messages of a MIDI file laid end to end, which is what a .syx file is. */
export function sysexBlobFromSmf(input) {
  const { messages, format, tracks } = sysexFromSmf(input);
  const total = messages.reduce((sum, message) => sum + message.length, 0);
  const blob = new Uint8Array(total);
  let at = 0;
  for (const message of messages) { blob.set(message, at); at += message.length; }
  // The messages come back as well as the blob: a caller that finds no patches in
  // them still wants to say what it did find, and the blob has lost the boundaries.
  return { blob, messages, count: messages.length, format, tracks };
}
