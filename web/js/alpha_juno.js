// Roland Alpha Juno 1/2 & MKS-50 tone parameter table, value scaling, sysex framing.
//
// A direct port of alpha_juno.py. The arithmetic here decides what the synth
// hears, so it is kept line-for-line comparable with the Python original rather
// than rewritten in a more idiomatic JavaScript style: a divergence between the
// two would show up as one build sounding subtly different from the other, which
// is a miserable thing to track down.
//
// The real-time "Individual Tone Parameter" message is:
//
//     F0 41 36 0n 23 20 01 pp vv F7
//
// where 0n is the synth basic channel (0-15), pp the parameter index (0..35) and
// vv the value.

export const SYSEX_START = 0xF0;
export const SYSEX_END = 0xF7;
export const ROLAND_ID = 0x41;
export const OPCODE_INDIVIDUAL_TONE = 0x36;
export const FORMAT_TYPE = 0x23;
export const DEFAULT_LEVEL = 0x20;
export const DEFAULT_GROUP = 0x01;

export const CC_RANGE = 128;
export const MAX_LAYERS = 10;

function param(index, name, maxValue, options = [], aliases = [], note = '') {
  return { index, name, maxValue, options, aliases, note };
}

export const PARAMETERS = [
  param(0, 'DCO Env. Mode', 3,
        ['Normal', 'Inverted', 'Normal-Dynamic', 'Inverted-Dynamic'], ['DCO ENV mode']),
  param(1, 'VCF Env. Mode', 3,
        ['Normal', 'Inverted', 'Normal-Dynamic', 'Dynamic'], ['VCF ENV mode']),
  param(2, 'VCA Env. Mode', 3,
        ['Normal', 'Gate', 'Normal-Dynamic', 'Gate-Dynamic'], ['VCA ENV mode']),
  param(3, 'DCO Wave Pulse', 3, [], ['DCO waveform pulse']),
  param(4, 'DCO Wave Saw', 5, [], ['DCO waveform sawtooth', 'DCO Wave Sawtooth']),
  param(5, 'DCO Wave Sub', 5, [], ['DCO waveform sub']),
  param(6, 'DCO Range', 3, ["4'", "8'", "16'", "32'"]),
  param(7, 'DCO Sub Level', 3),
  param(8, 'DCO Noise', 3, [], ['DCO noise level']),
  param(9, 'HPF Cutoff', 3, [], ['HPF cutoff frequency']),
  param(10, 'Chorus Switch', 1, ['Off', 'On'], ['Chorus']),
  param(11, 'DCO LFO Mod.', 127, [], ['DCO LFO modulation depth']),
  param(12, 'DCO ENV Mod.', 127, [], ['DCO ENV modulation depth']),
  param(13, 'DCO After Mod.', 127, [], ['DCO aftertouch depth']),
  param(14, 'DCO PWM Depth', 127, [], ['DCO PW/PWM depth']),
  param(15, 'DCO PWM Rate', 127, [], [], '0 = pulse width manual, 1..127 = PW LFO rate'),
  param(16, 'VCF Cutoff', 127, [], ['VCF cutoff frequency']),
  param(17, 'VCF Resonance', 127),
  param(18, 'VCF LFO Mod.', 127, [], ['VCF LFO modulation depth']),
  param(19, 'VCF ENV Mod.', 127, [], ['VCF ENV modulation depth']),
  param(20, 'VCF Key Follow', 127),
  param(21, 'VCF Aftertouch', 127, [], ['VCF aftertouch depth']),
  param(22, 'VCA Level', 127),
  param(23, 'VCA Aftertouch', 127, [], ['VCA aftertouch depth']),
  param(24, 'LFO Rate', 127),
  param(25, 'LFO Delay', 127, [], ['LFO delay time']),
  param(26, 'ENV T1', 127, [], ['Attack Time'], 'attack time'),
  param(27, 'ENV L1', 127, [], ['Attack Level'], 'attack level'),
  param(28, 'ENV T2', 127, [], ['Break Time'], 'break time'),
  param(29, 'ENV L2', 127, [], ['Break Level'], 'break level'),
  param(30, 'ENV T3', 127, [], ['Decay Time'], 'decay time'),
  param(31, 'ENV L3', 127, [], ['Sustain Level'], 'sustain level'),
  param(32, 'ENV T4', 127, [], ['Release Time'], 'release time'),
  param(33, 'ENV Key Follow', 127),
  param(34, 'Chorus Rate', 127),
  param(35, 'Bender Range', 12, [], ['BENDER range', 'Bend Range']),
];

if (PARAMETERS.length !== 36) throw new Error('the tone table must have 36 entries');

/** True when the parameter accepts the full 0..127 CC range unchanged. */
export function isContinuous(p) {
  return p.maxValue >= 127;
}

export function regionCount(p) {
  return p.maxValue + 1;
}

export function describeRange(p) {
  if (p.options.length) {
    return p.options.map((option, i) => `${i}=${option}`).join(', ');
  }
  return `0..${p.maxValue}`;
}

/** Render a parameter value for display, naming the enum option if there is one. */
export function label(p, value) {
  if (p.options.length && value >= 0 && value < p.options.length) {
    return `${value} (${p.options[value]})`;
  }
  return String(value);
}

/** Fold a name so 'VCF Cutoff', 'vcf_cutoff' and 'VCF cutoff' all match. */
export function normalize(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BY_NORMALIZED = new Map();
for (const p of PARAMETERS) {
  for (const name of [p.name, ...p.aliases]) BY_NORMALIZED.set(normalize(name), p);
  BY_NORMALIZED.set(String(p.index), p);
}

/** Find a parameter by name, alias, or numeric index. Null if unknown. */
export function lookup(name) {
  if (typeof name === 'number') {
    return Number.isInteger(name) && name >= 0 && name < PARAMETERS.length
      ? PARAMETERS[name]
      : null;
  }
  return BY_NORMALIZED.get(normalize(name)) || null;
}

/**
 * A stand-in Parameter for the layer-select knob.
 *
 * Choosing a layer is the same job as any other low-granularity control -- cut
 * the 128 CC steps into `count` even regions -- so it borrows scale(), convert()
 * and the boundary hysteresis rather than growing a second copy of that
 * arithmetic. The index is -1 because a layer is never sent to the synth.
 */
export function makeLayerParam(count) {
  if (!(count >= 1 && count <= MAX_LAYERS)) {
    throw new Error(`layer count must be 1-${MAX_LAYERS}, got ${count}`);
  }
  return param(-1, 'Layer', count - 1);
}

/** Lowest CC value that maps into the region for `value` (ceil division). */
export function regionStart(p, value) {
  return Math.floor((value * CC_RANGE + p.maxValue) / regionCount(p));
}

/** Lowest and highest CC value that land in the region for `value`. */
export function regionBounds(p, value) {
  const low = value > 0 ? regionStart(p, value) : 0;
  const high = value < p.maxValue ? regionStart(p, value + 1) - 1 : CC_RANGE - 1;
  return [low, high];
}

/**
 * A CC value that converts back to `value`: the middle of its region.
 *
 * The inverse of scale(), used when something on screen is moved in parameter
 * units and has to be fed back in as though a knob had produced it. The middle
 * rather than the edge, so that the boundary dead zone in convert() cannot
 * bounce the answer into the neighbouring region.
 *
 * There is no counterpart in alpha_juno.py: only the browser build has controls
 * you can move with a mouse.
 */
export function ccForValue(p, value) {
  const bounded = Math.max(0, Math.min(p.maxValue, Math.trunc(value)));
  if (isContinuous(p)) return bounded;
  const [low, high] = regionBounds(p, bounded);
  return Math.round((low + high) / 2);
}

/**
 * Map a 0..127 CC value onto 0..maxValue by splitting 128 into equal regions.
 *
 * For a 4-option parameter this gives 0-31 -> 0, 32-63 -> 1, 64-95 -> 2, 96-127 -> 3.
 * For a full-range parameter it is a pass-through.
 */
export function scale(p, ccValue) {
  const cc = Math.max(0, Math.min(CC_RANGE - 1, Math.trunc(ccValue)));
  if (isContinuous(p)) return cc;
  return Math.min(p.maxValue, Math.floor((cc * regionCount(p)) / CC_RANGE));
}

/** Take the CC value literally, clipping anything above the parameter's maximum. */
export function clamp(p, ccValue) {
  return Math.max(0, Math.min(p.maxValue, Math.trunc(ccValue)));
}

/**
 * Convert a CC value to a parameter value, with a dead zone at region boundaries.
 *
 * The dead zone stops a jittery pot sitting on a boundary from machine-gunning
 * the synth between two adjacent enum values. It only applies to quantized
 * parameters and only to single-region moves, so a fast sweep is never held back.
 */
export function convert(p, ccValue, { mode = 'scale', previous = null, hysteresis = 2 } = {}) {
  const value = mode === 'clamp' ? clamp(p, ccValue) : scale(p, ccValue);

  if (previous === null || previous === undefined || isContinuous(p) || hysteresis <= 0) {
    return value;
  }
  if (Math.abs(value - previous) !== 1) return value;

  const boundary = mode === 'clamp'
    ? Math.max(value, previous)
    : regionStart(p, Math.max(value, previous));

  if (value > previous) {
    // Moving up: ccValue >= boundary already. Require it to have cleared the edge.
    if (ccValue - boundary < hysteresis) return previous;
  } else {
    // Moving down: ccValue <= boundary - 1. Require it to have cleared the edge.
    if (boundary - 1 - ccValue < hysteresis) return previous;
  }
  return value;
}

/**
 * Build the complete 10-byte tone parameter message, F0 through F7.
 * `channel` is the synth's basic channel, 1-16.
 */
export function buildSysex(paramIndex, value, channel = 1,
                           level = DEFAULT_LEVEL, group = DEFAULT_GROUP) {
  if (!(channel >= 1 && channel <= 16)) {
    throw new Error(`MIDI channel must be 1-16, got ${channel}`);
  }
  if (!(paramIndex >= 0 && paramIndex <= 35)) {
    throw new Error(`parameter index must be 0-35, got ${paramIndex}`);
  }
  if (!(value >= 0 && value <= 127)) {
    throw new Error(`parameter value must be 0-127, got ${value}`);
  }
  return [
    SYSEX_START,
    ROLAND_ID,
    OPCODE_INDIVIDUAL_TONE,
    channel - 1,
    FORMAT_TYPE,
    level & 0x7F,
    group & 0x7F,
    paramIndex,
    value,
    SYSEX_END,
  ];
}

export function hexString(data) {
  return Array.from(data, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
