// Web MIDI access: port discovery, selection, and decoding.
//
// The browser hands over raw bytes rather than the parsed messages mido gives
// the Python build, so the small amount of decoding the router needs lives here.
// Only channel voice messages are picked apart; everything else is passed along
// as bytes, which is all `thru` ever needs to do with it.

export const CC_STATUS = 0xB0;

// Real-time messages that would drown any log they were written to. They are
// still forwarded by thru, just never mentioned. Matches QUIET_TYPES in the CLI.
const QUIET_STATUS = new Set([0xF8, 0xFA, 0xFB, 0xFC, 0xFE, 0xF2]);

const MESSAGE_NAMES = {
  0x80: 'note off',
  0x90: 'note on',
  0xA0: 'polytouch',
  0xB0: 'control change',
  0xC0: 'program change',
  0xD0: 'aftertouch',
  0xE0: 'pitchwheel',
};

/** Decode enough of a MIDI message to route it. */
export function decode(data) {
  const status = data[0];
  if (status < 0x80) return { type: 'unknown', data, quiet: false };

  if (status >= 0xF0) {
    return { type: 'system', data, quiet: QUIET_STATUS.has(status), name: 'system' };
  }

  const kind = status & 0xF0;
  const channel = (status & 0x0F) + 1;      // 1-16, the way the config writes it
  if (kind === CC_STATUS) {
    return { type: 'cc', channel, cc: data[1], value: data[2], data, quiet: false };
  }
  return {
    type: 'channel',
    channel,
    data,
    quiet: false,
    name: MESSAGE_NAMES[kind] || `status ${status.toString(16)}`,
  };
}

export function describe(message) {
  if (message.type === 'cc') {
    return `CC${message.cc} val ${message.value} ch ${message.channel}`;
  }
  if (message.type === 'channel') return `${message.name} ch ${message.channel}`;
  return `${message.data.length} byte${message.data.length === 1 ? '' : 's'}`;
}

/**
 * The MIDI access object plus whichever input and output are currently chosen.
 *
 * Ports are remembered by name rather than by id, because the config file is
 * shared with builds that have never heard of a Web MIDI id, and because ids are
 * not stable across browsers. Names are matched the way the CLI matches them:
 * exact first, then any distinctive part, first match winning.
 */
export class MidiPorts {
  constructor() {
    this.access = null;
    this.input = null;            // the controller
    this.output = null;           // the synth's MIDI in
    this.synthInput = null;       // the synth's MIDI out, which reports patches
    this.onMessage = null;        // (Uint8Array) => void, from the controller
    this.onSynthMessage = null;   // (Uint8Array) => void, from the synth
    this.onPortsChanged = null;   // () => void
    this.attached = new Set();    // ports we have installed a handler on
  }

  get supported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async open() {
    if (!this.supported) {
      throw new Error('This browser has no Web MIDI. Chrome, Chromium, Edge and Opera '
                      + 'have it; Safari does not. A secure context (https, or localhost) '
                      + 'is required.');
    }
    // sysex: true is the whole point of this program, and it is the permission
    // the browser prompts about. Without it the mapping would have nothing to
    // send, so there is no useful fallback to a non-sysex access object.
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => {
      // A port that vanishes leaves a dead handle behind; drop it so the UI
      // shows the port as gone rather than silently sending into nothing.
      if (this.input && this.input.state === 'disconnected') this.setInput(null);
      if (this.output && this.output.state === 'disconnected') this.setOutput(null);
      if (this.synthInput && this.synthInput.state === 'disconnected') this.setSynthInput(null);
      if (this.onPortsChanged) this.onPortsChanged();
    };
    return this.access;
  }

  inputs() {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  outputs() {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  /** Exact name, then exact id, then first substring match. Null if nothing fits. */
  find(ports, wanted) {
    if (!wanted) return null;
    const text = String(wanted).trim();
    if (!text) return null;
    return ports.find((port) => port.name === text)
        || ports.find((port) => port.id === text)
        || ports.find((port) => port.name.toLowerCase().includes(text.toLowerCase()))
        || null;
  }

  setInput(port) {
    this.input = port || null;
    this.listen();
  }

  /**
   * The port the synth's own MIDI out arrives on, or null not to listen.
   *
   * Kept apart from the controller input because the two carry different things:
   * one is knob movements to be translated, the other is the synth telling us
   * what patch it is on. On a bidirectional interface they can be the same port,
   * which is why listen() dispatches by role rather than by handler.
   */
  setSynthInput(port) {
    this.synthInput = port || null;
    this.listen();
  }

  setOutput(port) {
    this.output = port || null;
  }

  /**
   * Install one handler per distinct port, dispatching to the roles it serves.
   *
   * A port serving both roles must not deliver its messages twice -- one
   * controller knob would translate to two sysex messages -- so the handlers are
   * keyed by port and not by role.
   */
  listen() {
    for (const port of this.attached) port.onmidimessage = null;
    this.attached.clear();

    for (const port of [this.input, this.synthInput]) {
      if (!port || this.attached.has(port)) continue;
      const controller = port === this.input;
      const synth = port === this.synthInput;
      port.onmidimessage = (event) => {
        if (controller && this.onMessage) this.onMessage(event.data);
        if (synth && this.onSynthMessage) this.onSynthMessage(event.data);
      };
      this.attached.add(port);
    }
  }

  send(bytes) {
    if (this.output) this.output.send(bytes);
  }

  /** True when thru would echo straight back into the input. */
  get echoing() {
    return Boolean(this.input && this.output && this.input.name === this.output.name);
  }
}
