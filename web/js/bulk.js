// Bulk transfer: the whole of the synth's memory, in one direction or the other.
//
// Both directions need the player to arm the instrument from its front panel
// first, because an Alpha Juno will not start or accept a bulk transfer on its
// own. That is not a limitation to work around, it is the protocol -- so the two
// classes here are shaped around waiting for a human rather than around waiting
// for a wire:
//
//   Receive   [DATA TRANSFER] + [WRITE] + [1 BULK DUMP]
//             The synth starts sending the moment those are pressed. We listen,
//             collect sixteen BLD messages, and stop early if the stream goes
//             quiet -- an MKS-50 sends more blocks than a Juno does, and a Juno
//             sends nothing at all if the player wandered off.
//
//   Send      Memory Protect OFF, then [DATA TRANSFER] + [WRITE] + [2 BULK LOAD]
//             The synth then sits waiting, and we push sixteen messages at it
//             with a gap between each.
//
// The gap is the one number that decides whether a transfer arrives whole. The
// synth has to write each block of four tones to memory before it can take the
// next, and it drops -- silently, without complaint -- whatever arrives while it
// is busy. 60 ms loses patches on real hardware; 200 ms was measured to carry all
// 64 reliably, and is what the alphamanager project settled on after doing it the
// other way first. A whole bank still goes over in about four seconds, which is a
// cheap price for not having to check afterwards which patches made it.

import { Bank, BULK_MESSAGE_COUNT, TONES_PER_MESSAGE, LEVEL_TONE, parseBulk } from './bank.js';

export const DEFAULT_GAP_MS = 200;
export const MIN_GAP_MS = 20;
export const MAX_GAP_MS = 500;

// How long to wait for the first byte of a dump the player triggers by hand.
// Generous: they have to find three buttons on a 1986 front panel first.
export const DEFAULT_START_TIMEOUT_MS = 120000;
// Once data is flowing, a gap this long means the dump has finished.
export const DEFAULT_IDLE_TIMEOUT_MS = 2000;

/** What a progress callback is handed. `fraction` is what a bar wants. */
function progressOf(messages, note) {
  return {
    messages,
    expected: BULK_MESSAGE_COUNT,
    tones: messages * TONES_PER_MESSAGE,
    fraction: Math.min(1, messages / BULK_MESSAGE_COUNT),
    note,
  };
}

/**
 * Collects a bulk dump the player triggers from the synth's panel.
 *
 * It does not open a port or install a handler of its own: the app already has
 * one listening to the synth's MIDI out, and a second one would either fight it
 * or miss the messages it swallowed. So this is fed complete sysex messages from
 * there, and its whole job is deciding when a dump has started, finished, or
 * failed to turn up.
 */
export class BulkReceiver {
  constructor({
    onProgress = null,
    onDone = null,
    onFail = null,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  } = {}) {
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.onFail = onFail;
    this.startTimeoutMs = startTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;

    this.active = false;
    this.messages = [];
    this.toneMessages = 0;
    this.timer = null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.messages = [];
    this.toneMessages = 0;
    this.report('Waiting for the synth…');
    this.arm(this.startTimeoutMs);
  }

  /**
   * One complete F0..F7 message from the synth.
   *
   * Anything that is not an Alpha Juno bulk block is ignored *and does not
   * restart the idle clock*: a synth left sending active sensing or a clock
   * would otherwise hold a finished transfer open for ever.
   */
  feed(bytes) {
    if (!this.active) return false;
    const parsed = parseBulk(bytes);
    if (!parsed) return false;

    this.messages.push(bytes);
    if (parsed.level === LEVEL_TONE) this.toneMessages += 1;
    this.report(`Received slot ${parsed.firstTone + 1}…`);

    if (this.toneMessages >= BULK_MESSAGE_COUNT) {
      // An MKS-50 sends its patch and chord blocks after the tones. Rather than
      // finish on the sixteenth and drop them, wait out one idle period more --
      // by then either they have arrived or there were none.
      this.arm(this.idleTimeoutMs, true);
    } else {
      this.arm(this.idleTimeoutMs);
    }
    return true;
  }

  /** Restart the clock. `complete` decides what running out of it means. */
  arm(delay, complete = false) {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (complete || this.toneMessages >= BULK_MESSAGE_COUNT) this.finish();
      else if (this.messages.length) {
        this.fail(`the dump stopped after ${this.toneMessages} of `
                  + `${BULK_MESSAGE_COUNT} messages`);
      } else {
        this.fail('nothing arrived — is the synth set to send a bulk dump, and is '
                  + 'its MIDI out connected to the "From Synth" port?');
      }
    }, delay);
  }

  disarm() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  finish() {
    const collected = this.messages;
    this.stop();
    const total = collected.reduce((sum, message) => sum + message.length, 0);
    const blob = new Uint8Array(total);
    let offset = 0;
    for (const message of collected) {
      blob.set(message, offset);
      offset += message.length;
    }
    let bank;
    try {
      bank = Bank.fromSysex(blob);
    } catch (exc) {
      if (this.onFail) this.onFail(exc.message);
      return;
    }
    if (this.onDone) this.onDone(bank, blob);
  }

  cancel() {
    if (!this.active) return;
    this.fail('cancelled');
  }

  fail(reason) {
    this.stop();
    if (this.onFail) this.onFail(reason);
  }

  stop() {
    this.disarm();
    this.active = false;
    this.messages = [];
    this.toneMessages = 0;
  }

  report(note) {
    if (this.onProgress) this.onProgress(progressOf(this.toneMessages, note));
  }
}

/**
 * Pushes all 64 patches at a synth already armed for BULK LOAD.
 *
 * A timer chain rather than one burst, for the reason in the file header: the
 * gap is what makes the transfer land whole. It is also what makes cancelling
 * mean anything -- sixteen messages handed to the browser at once are gone, and
 * there is nothing left to call off.
 */
export class BulkSender {
  constructor({
    send,
    onProgress = null,
    onDone = null,
    onFail = null,
    gapMs = DEFAULT_GAP_MS,
  } = {}) {
    this.send = send;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.onFail = onFail;
    this.gapMs = Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, gapMs));

    this.active = false;
    this.messages = [];
    this.index = 0;
    this.timer = null;
  }

  /** Roughly how long a transfer will take, for something to say beforehand. */
  static estimateSeconds(gapMs = DEFAULT_GAP_MS) {
    // One BLD message is 266 bytes, and MIDI carries 10 bits per byte at 31.25
    // kbaud -- so the wire alone accounts for about 85 ms of every message,
    // before any gap we add. Worth counting: it explains why a "3 second"
    // transfer is not.
    const wire = (266 * 10) / 31250;
    return BULK_MESSAGE_COUNT * (wire + gapMs / 1000);
  }

  start(bank, channel = null) {
    if (this.active) return;
    this.messages = bank.toMessages(channel);
    this.index = 0;
    this.active = true;
    this.step();
  }

  step() {
    if (!this.active) return;
    if (this.index >= this.messages.length) {
      this.stop();
      if (this.onDone) this.onDone();
      return;
    }
    const first = this.index * TONES_PER_MESSAGE;
    try {
      this.send(this.messages[this.index]);
    } catch (exc) {
      this.stop();
      if (this.onFail) this.onFail(exc.message || String(exc));
      return;
    }
    this.index += 1;
    if (this.onProgress) {
      this.onProgress(progressOf(this.index, `Sent slots ${first + 1}-${first + 4}…`));
    }
    this.timer = setTimeout(() => { this.timer = null; this.step(); }, this.gapMs);
  }

  /**
   * Stop part-way, which leaves the synth holding a half-written set.
   *
   * There is nothing to be done about that from here -- the messages already
   * sent have been written -- so the caller is expected to say so rather than
   * report a clean cancellation.
   */
  cancel() {
    if (!this.active) return;
    const sent = this.index;
    this.stop();
    if (this.onFail) {
      this.onFail(sent
        ? `cancelled after ${sent} of ${BULK_MESSAGE_COUNT} messages — the synth now `
          + `holds a half-written set, so send the whole bank again`
        : 'cancelled');
    }
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.active = false;
  }
}
