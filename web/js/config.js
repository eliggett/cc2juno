// Load, validate and generate the CC -> Alpha Juno parameter mapping config.
//
// A port of config.py, reading and writing the same file. The validation rules
// and their wording are kept the same on purpose: a config rejected here should
// be rejected by the CLI for the same stated reason, and vice versa, so a file
// that loads in one place is not a mystery in another.
//
// One deliberate difference. The CLI refuses a config with nothing mapped
// ("nothing to do") because it is about to sit in a loop doing nothing. Here
// that same file is a perfectly reasonable thing to open -- an empty grid is
// where you start -- so it becomes a warning instead of an error.

import * as aj from './alpha_juno.js';
import { parse as parseYaml } from './yaml.js';

export class ConfigError extends Error {}

export const DEFAULT_CONFIG_NAME = 'cc2juno.yaml';
export const MAX_LAYERS = aj.MAX_LAYERS;
export const MAX_GRID = 32;

const LAYER_SECTION_RE = /^layer(\d+)$/;

// Spellings that turn an entry off without deleting it.
const DISABLED_WORDS = new Set(
  ['off', 'none', 'null', 'no', 'false', 'disable', 'disabled', '-', '']);

// Spellings that mean "prompt me for this port".
const ASK_WORDS = new Set(['ask', 'prompt', 'choose', 'select', ...DISABLED_WORDS]);

// Well-known uses of the low CC numbers, so a generated config can flag which of
// its own assignments are likely to collide with a controller's own habits.
export const STANDARD_CC_USES = {
  0: 'Bank Select MSB',
  1: 'Modulation Wheel',
  2: 'Breath Controller',
  4: 'Foot Controller',
  5: 'Portamento Time',
  6: 'Data Entry MSB',
  7: 'Channel Volume',
  8: 'Balance',
  10: 'Pan',
  11: 'Expression',
  12: 'Effect Control 1',
  13: 'Effect Control 2',
  16: 'General Purpose 1',
  17: 'General Purpose 2',
  18: 'General Purpose 3',
  19: 'General Purpose 4',
};
for (let cc = 32; cc < 64; cc += 1) STANDARD_CC_USES[cc] = `LSB for CC${cc - 32}`;

/** True for the ways a config entry can say 'ignore this one'. */
export function isDisabled(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'string') return DISABLED_WORDS.has(value.trim().toLowerCase());
  return false;
}

function requireInt(value, labelText, low, high) {
  // A bare `on`/`off` in YAML is a boolean, and would otherwise become 1/0.
  if (typeof value === 'boolean') {
    throw new ConfigError(`${labelText}: expected a number, got ${value ? 'on' : 'off'}`);
  }
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw new ConfigError(`${labelText}: expected a number, got '${value}'`);
  }
  if (number < low || number > high) {
    throw new ConfigError(`${labelText}: must be ${low}-${high}, got ${number}`);
  }
  return number;
}

function requireBool(value, labelText) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['on', 'yes', 'true', '1'].includes(text)) return true;
    if (DISABLED_WORDS.has(text)) return false;
  }
  throw new ConfigError(`${labelText}: expected true or false, got '${value}'`);
}

/** One layer: a complete set of knob assignments, selected by the layer knob. */
export function makeLayer(number = 1, name = '') {
  return {
    number,                 // 1-based, the way it is written in the config
    name,
    byCc: new Map(),        // CC number -> {cc, paramIndex, mode}
    disabled: new Set(),    // parameter indexes explicitly switched off
  };
}

export function layerLabel(layer) {
  return layer.name ? `${layer.number} (${layer.name})` : String(layer.number);
}

/**
 * Where each knob physically sits, as a rows x cols grid.
 * `ccs` is row-major and always rows*cols long, with null for an empty cell.
 */
export function makeLayout(rows = 2, cols = 4, ccs = null) {
  const cells = rows * cols;
  const list = (ccs || []).slice(0, cells);
  while (list.length < cells) list.push(null);
  return { rows, cols, ccs: list };
}

export function makeConfig(overrides = {}) {
  return {
    synthChannel: 1,
    listenChannel: null,          // null = accept every channel
    levelByte: aj.DEFAULT_LEVEL,
    groupByte: aj.DEFAULT_GROUP,
    maxMsgsPerSec: 100,
    hysteresis: 2,
    thru: false,                  // forward untranslated traffic to the output
    portInput: null,              // null = nothing remembered
    portOutput: null,
    layerCc: null,                // null = no layering, one fixed layer
    startupLayer: 1,              // 1-based; the knob's real position is unknowable
    layerHysteresis: null,        // null = use `hysteresis`
    layers: [makeLayer(1)],
    layout: makeLayout(),
    ...overrides,
  };
}

// An unlayered config is just a layered one with a single layer, so these stay
// pointed at layer 1 rather than growing an `if (layering)` at every call site.
export function isLayered(cfg) {
  return cfg.layerCc !== null && cfg.layerCc !== undefined;
}

export function layerEdgeHysteresis(cfg) {
  return cfg.layerHysteresis === null || cfg.layerHysteresis === undefined
    ? cfg.hysteresis
    : cfg.layerHysteresis;
}

/** Every CC assigned on any layer: the set that must never reach the synth raw. */
export function allMappedCcs(cfg) {
  const out = new Set();
  for (const layer of cfg.layers) for (const cc of layer.byCc.keys()) out.add(cc);
  return out;
}

/** Every CC the grid knows about, layer knob included. */
export function knobCcs(cfg) {
  const out = new Set();
  for (const cc of cfg.layout.ccs) if (cc !== null) out.add(cc);
  return out;
}

export function paramFor(mapping) {
  return mapping ? aj.PARAMETERS[mapping.paramIndex] : null;
}

/**
 * Where a parameter is already spoken for, from the point of view of one layer.
 *
 * A parameter can only be on one knob per layer -- the file maps parameter to
 * CC, so there is nowhere to write a second one -- but the same parameter on
 * several layers is normal and useful. The two cases are reported separately
 * because they mean different things to someone about to pick from a menu:
 * taking it from a knob on this layer costs that knob its assignment, while the
 * other layers are only worth knowing about.
 *
 * @returns {{here: number|null, elsewhere: number[]}} CC on this layer, and the
 *          1-based numbers of the other layers using it.
 */
export function paramUsage(cfg, paramIndex, layerIndex) {
  let here = null;
  const elsewhere = [];
  cfg.layers.forEach((layer, index) => {
    for (const mapping of layer.byCc.values()) {
      if (mapping.paramIndex !== paramIndex) continue;
      if (index === layerIndex) here = mapping.cc;
      else elsewhere.push(layer.number);
    }
  });
  return { here, elsewhere };
}

// ---------------------------------------------------------------- reading ---

/** Turn parsed YAML into a validated config. Throws ConfigError. */
export function parse(raw, source = 'config') {
  const warnings = [];
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${source}: top level must be a mapping`);
  }

  const midi = raw.midi || {};
  if (typeof midi !== 'object' || Array.isArray(midi)) {
    throw new ConfigError(`${source}: 'midi' must be a mapping`);
  }

  const cfg = makeConfig();
  cfg.synthChannel = requireInt(midi.synth_channel ?? 1, 'midi.synth_channel', 1, 16);

  const listen = midi.listen_channel === undefined ? 'any' : midi.listen_channel;
  if (listen === null || ['any', 'all', '*'].includes(listen)) {
    cfg.listenChannel = null;
  } else {
    cfg.listenChannel = requireInt(listen, 'midi.listen_channel', 1, 16);
  }

  cfg.levelByte = requireInt(midi.level_byte ?? aj.DEFAULT_LEVEL, 'midi.level_byte', 0, 127);
  cfg.groupByte = requireInt(midi.group_byte ?? aj.DEFAULT_GROUP, 'midi.group_byte', 0, 127);
  cfg.maxMsgsPerSec = requireInt(midi.max_msgs_per_sec ?? 100, 'midi.max_msgs_per_sec', 1, 1000);
  cfg.hysteresis = requireInt(midi.hysteresis ?? 2, 'midi.hysteresis', 0, 16);
  cfg.thru = requireBool(midi.thru ?? false, 'midi.thru');

  const ports = raw.ports || {};
  if (typeof ports !== 'object' || Array.isArray(ports)) {
    throw new ConfigError(`${source}: 'ports' must be a mapping with 'input' and 'output'`);
  }
  for (const [field, attr] of [['input', 'portInput'], ['output', 'portOutput']]) {
    const value = ports[field];
    if (typeof value === 'boolean') {
      throw new ConfigError(`${source}: ports.${field}: expected a port name, index, `
                            + `or 'ask'; got ${value ? 'on' : 'off'}`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && ASK_WORDS.has(value.trim().toLowerCase())) continue;
    cfg[attr] = String(value).trim();
  }

  const sections = layerSections(raw, source);
  parseLayersBlock(cfg, raw.layers, sections, source);
  cfg.layout = parseLayout(raw.layout, source) || makeLayout(0, 0, []);

  for (const layer of cfg.layers) {
    const entry = sections.get(layer.number);
    if (entry) fillLayer(layer, entry[1], entry[0], source);
  }

  if (isLayered(cfg)) {
    for (const layer of cfg.layers) {
      const clash = layer.byCc.get(cfg.layerCc);
      if (clash) {
        throw new ConfigError(
          `${source}: CC${cfg.layerCc} selects the layer, so it cannot also be mapped `
          + `to '${paramFor(clash).name}' on layer ${layer.number}`);
      }
    }
  }

  if (!cfg.layers.some((layer) => layer.byCc.size)) {
    const where = isLayered(cfg) ? 'every layer' : "'mappings'";
    warnings.push(cfg.layers.some((layer) => layer.disabled.size)
      ? `every parameter in ${where} is switched off; nothing will be sent until a knob `
        + 'is given a function'
      : `${where} is empty; assign a function to a knob to get started`);
  }

  // A file written before layouts existed has no grid at all, and one edited by
  // hand can easily gain a knob without gaining a cell. Either way the knobs
  // that exist are known, so the grid is filled in rather than reported as a
  // problem the user has to go and solve before anything will draw.
  const placed = knobCcs(cfg);
  const missing = [...allMappedCcs(cfg)].filter((cc) => !placed.has(cc));
  if (isLayered(cfg) && !placed.has(cfg.layerCc)) missing.push(cfg.layerCc);
  missing.sort((a, b) => a - b);

  if (!raw.layout) {
    cfg.layout = autoLayout(missing);
    if (missing.length) {
      warnings.push(`no 'layout:' section, so a ${cfg.layout.rows}x${cfg.layout.cols} grid `
                    + `was laid out from the ${missing.length} CC(s) in use`);
    }
  } else if (missing.length) {
    cfg.layout = growLayout(cfg.layout, missing);
    warnings.push(`CC ${missing.join(', ')} used in the mappings but missing from `
                  + `'layout:'; added to the end of the grid`);
  }

  return { cfg, warnings };
}

/** Find the per-layer mapping sections, keyed by 1-based layer number. */
function layerSections(raw, source) {
  const sections = new Map();
  for (const key of Object.keys(raw)) {
    if (['ports', 'midi', 'layers', 'layout'].includes(key)) continue;

    let number = null;
    if (key === 'mappings') {
      number = 1;
    } else {
      const match = LAYER_SECTION_RE.exec(key);
      if (match) {
        number = parseInt(match[1], 10);
        if (number < 1 || number > MAX_LAYERS) {
          throw new ConfigError(`${source}: section '${key}': layers are numbered `
                                + `1-${MAX_LAYERS}`);
        }
      }
    }
    if (number === null) {
      throw new ConfigError(
        `${source}: unknown top-level section '${key}'. Expected 'ports', 'midi', `
        + `'layers', 'layout', 'mappings', or 'layer1' ... 'layer${MAX_LAYERS}'.`);
    }
    if (sections.has(number)) {
      throw new ConfigError(`${source}: layer ${number} is defined twice `
                            + `(as '${sections.get(number)[0]}' and '${key}')`);
    }
    const entries = raw[key];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      throw new ConfigError(`${source}: '${key}' must be a mapping of parameter name -> CC`);
    }
    sections.set(number, [key, entries]);
  }

  if (!sections.size) throw new ConfigError(`${source}: no 'mappings' section found`);
  return sections;
}

/** Split the optional comma-separated layer names. */
function layerNames(value, count, source) {
  if (value === null || value === undefined) return new Array(count).fill('');
  if (Array.isArray(value)) {
    throw new ConfigError(`${source}: layers.names must be one comma-separated string, `
                          + 'not a list (a list cannot be read by the Tulip version)');
  }
  const names = String(value).split(',').map((part) => part.trim());
  while (names.length && !names[names.length - 1]) names.pop();
  if (names.length > count) {
    throw new ConfigError(`${source}: layers.names lists ${names.length} names but there `
                          + `are only ${count} layers`);
  }
  while (names.length < count) names.push('');
  return names;
}

/** Read the `layers:` section and size cfg.layers to match. */
function parseLayersBlock(cfg, block, sections, source) {
  const highest = Math.max(...sections.keys());

  if (block === null || block === undefined) {
    if (highest > 1) {
      throw new ConfigError(
        `${source}: layer sections are defined but there is no 'layers:' section saying `
        + 'which CC selects between them. Add:\n  layers:\n    cc: 41');
    }
    cfg.layers = [makeLayer(1)];
    return;
  }

  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new ConfigError(`${source}: 'layers' must be a mapping with a 'cc' value`);
  }
  if (!('cc' in block) || isDisabled(block.cc)) {
    throw new ConfigError(`${source}: 'layers' needs a 'cc' value naming the knob that `
                          + 'selects the layer (or delete the section to switch layering off)');
  }

  cfg.layerCc = requireInt(block.cc, 'layers.cc', 0, 127);
  const count = requireInt(block.count ?? highest, 'layers.count', 1, MAX_LAYERS);
  if (count < highest) {
    throw new ConfigError(`${source}: layers.count is ${count} but 'layer${highest}' is `
                          + 'defined; raise the count or delete the section');
  }

  cfg.startupLayer = requireInt(block.startup ?? 1, 'layers.startup', 1, count);
  if ('hysteresis' in block) {
    cfg.layerHysteresis = requireInt(block.hysteresis, 'layers.hysteresis', 0, 16);
  }

  const names = layerNames(block.names, count, source);
  cfg.layers = names.map((name, i) => makeLayer(i + 1, name));
}

/** Read the optional `layout:` section describing the physical knob grid. */
function parseLayout(block, source) {
  if (block === null || block === undefined) return null;
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new ConfigError(`${source}: 'layout' must be a mapping with 'rows', 'cols' and 'ccs'`);
  }

  const rows = requireInt(block.rows ?? 1, 'layout.rows', 1, MAX_GRID);
  const cols = requireInt(block.cols ?? 1, 'layout.cols', 1, MAX_GRID);
  const cells = rows * cols;

  if (Array.isArray(block.ccs)) {
    throw new ConfigError(`${source}: layout.ccs must be one comma-separated string, `
                          + 'not a list (a list cannot be read by the Tulip version)');
  }

  const text = block.ccs === null || block.ccs === undefined ? '' : String(block.ccs);
  const parts = text.trim() ? text.split(',').map((part) => part.trim()) : [];
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  if (parts.length > cells) {
    throw new ConfigError(`${source}: layout.ccs lists ${parts.length} cells but the grid `
                          + `is ${rows}x${cols} = ${cells}`);
  }

  const ccs = [];
  const seen = new Map();
  parts.forEach((part, position) => {
    if (isDisabled(part)) {
      ccs.push(null);
      return;
    }
    const cc = requireInt(part, `layout.ccs cell ${position + 1}`, 0, 127);
    if (seen.has(cc)) {
      throw new ConfigError(`${source}: layout.ccs has CC${cc} in cell ${seen.get(cc) + 1} `
                            + `and again in cell ${position + 1}; one knob sits in one place`);
    }
    seen.set(cc, position);
    ccs.push(cc);
  });

  while (ccs.length < cells) ccs.push(null);
  return { rows, cols, ccs };
}

/** Read one layer's parameter -> CC assignments. */
function fillLayer(layer, mappings, section, source) {
  const seenParams = new Map();
  for (const [key, entry] of Object.entries(mappings)) {
    const param = aj.lookup(key);
    if (!param) {
      throw new ConfigError(`${source}: ${section}: unknown parameter name '${key}'. `
                            + 'See the function menu for the 36 valid names.');
    }

    let mode = 'scale';
    let ccRaw = entry;
    if (entry !== null && typeof entry === 'object') {
      if (!('cc' in entry)) {
        throw new ConfigError(`${source}: ${section}: mapping for '${key}' has no 'cc' `
                              + "value (use 'off' to disable it)");
      }
      ccRaw = entry.cc;
      mode = String(entry.mode ?? 'scale').toLowerCase();
      if (!['scale', 'clamp'].includes(mode)) {
        throw new ConfigError(`${source}: ${section}: mapping for '${key}' has unknown `
                              + `mode '${mode}' (expected 'scale' or 'clamp')`);
      }
    }

    // A parameter named twice is a typo worth reporting even if one is disabled.
    if (seenParams.has(param.index)) {
      throw new ConfigError(`${source}: ${section}: ${param.name} is mapped twice `
                            + `(as '${seenParams.get(param.index)}' and '${key}')`);
    }
    seenParams.set(param.index, key);

    if (isDisabled(ccRaw)) {
      layer.disabled.add(param.index);
      continue;
    }
    if (typeof ccRaw === 'boolean') {   // a bare `on`/`yes`, never a CC number
      throw new ConfigError(`${source}: ${section}: CC for '${key}': expected a number `
                            + "0-127 or 'off', got 'on'");
    }
    const cc = requireInt(ccRaw, `${source}: ${section}: CC for '${key}'`, 0, 127);

    if (layer.byCc.has(cc)) {
      throw new ConfigError(`${source}: ${section}: CC${cc} is assigned to both `
                            + `'${paramFor(layer.byCc.get(cc)).name}' and '${param.name}'`);
    }
    layer.byCc.set(cc, { cc, paramIndex: param.index, mode });
  }
}

export function parseText(text, source = DEFAULT_CONFIG_NAME) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (exc) {
    throw new ConfigError(`${source}: could not parse YAML:\n${exc.message}`);
  }
  return parse(raw, source);
}

// ---------------------------------------------------------------- layout ---

/**
 * Lay a bare list of CCs out in the nearest sensible rectangle.
 *
 * Controllers come in rows, so the aim is the widest row that stays under about
 * eight knobs and divides the count evenly: 16 knobs become 2x8, 12 become 2x6,
 * 9 become 3x3. Anything prime and awkward falls back to one row per eight.
 */
export function autoLayout(ccs) {
  const list = [...ccs];
  if (!list.length) return makeLayout(2, 4, []);

  const n = list.length;
  let cols = Math.min(n, 8);
  for (let candidate = Math.min(n, 8); candidate >= 3; candidate -= 1) {
    if (n % candidate === 0) { cols = candidate; break; }
  }
  const rows = Math.ceil(n / cols);
  return makeLayout(rows, cols, list);
}

/** Add CCs the grid does not have yet, growing it by whole rows. */
export function growLayout(layout, ccs) {
  const cells = [...layout.ccs];
  let { rows, cols } = layout;
  for (const cc of ccs) {
    let slot = cells.indexOf(null);
    if (slot === -1) {
      rows += 1;
      for (let i = 0; i < cols; i += 1) cells.push(null);
      slot = cells.indexOf(null);
    }
    cells[slot] = cc;
  }
  return { rows, cols, ccs: cells };
}

/** Reshape the grid, keeping the knobs in reading order. */
export function reshapeLayout(layout, rows, cols) {
  const kept = layout.ccs.filter((cc) => cc !== null);
  const cells = new Array(rows * cols).fill(null);
  // Cells that no longer fit are dropped from the grid, not from the mappings,
  // so shrinking the grid by mistake and growing it back loses only positions.
  kept.slice(0, cells.length).forEach((cc, i) => { cells[i] = cc; });
  return { rows, cols, ccs: cells };
}

// ---------------------------------------------------------------- writing ---

function portValue(name) {
  return name ? `"${String(name).replace(/"/g, '\\"')}"` : 'ask';
}

/**
 * Render a fully commented YAML config, the same file config.py writes.
 *
 * Every parameter is listed on every layer, using `off` for anything unassigned,
 * so turning one on by hand is a matter of typing a number over the `off`.
 */
export function render(cfg) {
  const listen = cfg.listenChannel === null ? 'any' : cfg.listenChannel;
  const layered = isLayered(cfg);
  const sectionWord = layered ? 'a layer section' : "'mappings'";
  const hex = (byte) => `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;

  const lines = [
    '# cc2juno - MIDI CC to Roland Alpha Juno sysex mapping',
    '#',
    `# Each entry under ${sectionWord} assigns one incoming CC number to one of the`,
    '# 36 Alpha Juno tone parameters. Names are matched case- and',
    "# punctuation-insensitively, so 'VCF Cutoff', 'vcf_cutoff' and 'VCF cutoff'",
    '# are all the same parameter. A bare parameter index (0-35) also works.',
    '#',
    "# Write 'off' instead of a CC number to disable an entry without deleting it:",
    '#',
    '#   "VCF Cutoff": off',
    '#',
    '# Incoming CC values are 0-127. Parameters that accept fewer values get the',
    '# 128 CC steps split into equal regions - a 4-option parameter reads',
    '# 0-31 as option 0, 32-63 as 1, 64-95 as 2, 96-127 as 3. To take the CC',
    '# value literally instead (clipping above the maximum), write:',
    '#',
    '#   "Bender Range": {cc: 90, mode: clamp}',
    '#',
    '# The synth must have sysex receive switched ON (under the MIDI button) and',
    '# its basic channel must match midi.synth_channel below.',
    '',
    '# Default MIDI ports, so the program can start without prompting. Each may be',
    "# a port name, any distinctive part of one, or a port index. Use 'ask' to be",
    '# prompted. --in/--out override these; --ask-ports ignores them.',
    '# These were written by the web version, which names ports the way the browser',
    '# does; the CLI matches on any distinctive part, so they usually suit both.',
    'ports:',
    `  input: ${portValue(cfg.portInput)}`,
    `  output: ${portValue(cfg.portOutput)}`,
    '',
    'midi:',
    `  synth_channel: ${cfg.synthChannel}        # Alpha Juno basic channel, 1-16`,
    `  listen_channel: ${listen}     # 1-16 to accept CCs on one channel only, or 'any'`,
    '',
    '  # Sysex header bytes. The Roland/PG-300 charts give level 0x20, group 0x01.',
    '  # A 1995 usenet transcription gives 0x01 / 0x01 instead; if your unit ignores',
    '  # everything this program sends, try level_byte: 0x01.',
    `  level_byte: ${hex(cfg.levelByte)}`,
    `  group_byte: ${hex(cfg.groupByte)}`,
    '',
    '  # Each sysex message is 10 bytes, about 3.2 ms on a 31250 baud DIN cable.',
    '  # A fast knob sweep can easily outrun the synth\'s input buffer, so outgoing',
    '  # messages are rate limited and only the newest value per parameter is kept.',
    `  max_msgs_per_sec: ${cfg.maxMsgsPerSec}`,
    '',
    '  # Dead zone in CC counts at the edges of a quantized parameter\'s regions,',
    '  # so a jittery pot does not flip back and forth between two options. 0 = off.',
    `  hysteresis: ${cfg.hysteresis}`,
    '',
    '  # Pass everything this program does not translate - notes, pitch bend,',
    '  # aftertouch, unmapped CCs - straight from the input to the output, so one',
    '  # keyboard with knobs can both play the synth and edit it. Mapped CCs are',
    '  # consumed and never forwarded. --thru / --no-thru override this.',
    `  thru: ${cfg.thru ? 'true' : 'false'}`,
    '',
    '# Physical arrangement of the knobs, for the web front-end. Row-major,',
    "# one entry per cell, 'off' where there is no knob. The other builds do not",
    '# draw anything but do keep this section intact when they rewrite the file.',
    'layout:',
    `  rows: ${cfg.layout.rows}`,
    `  cols: ${cfg.layout.cols}`,
    `  ccs: "${cfg.layout.ccs.map((cc) => (cc === null ? 'off' : cc)).join(', ')}"`,
    '',
  ];

  if (layered) {
    const names = cfg.layers.map((layer) => layer.name).join(', ').replace(/[\s,]+$/, '');
    lines.push(
      '# Layering. One knob picks which set of assignments the other knobs use,',
      '# by cutting its 0-127 travel into one region per layer. The layer knob',
      '# itself means the same thing on every layer and can never be mapped to a',
      "# parameter. Each layer's assignments live in its own section below,",
      `# 'layer1' to 'layer${cfg.layers.length}'. A layer with nothing mapped is a valid`,
      '# parked position where no knob does anything.',
      'layers:',
      `  cc: ${cfg.layerCc}`,
      `  count: ${cfg.layers.length}`);
    if (names) lines.push(`  names: "${names}"    # comma separated, for the log only`);
    if (cfg.layerHysteresis !== null && cfg.layerHysteresis !== undefined) {
      lines.push(`  hysteresis: ${cfg.layerHysteresis}`);
    }
    lines.push(`  startup: ${cfg.startupLayer}      # layer to assume until the knob is moved`,
               '');
  } else {
    lines.push('mappings:');
  }

  const width = Math.max(...aj.PARAMETERS.map((p) => p.name.length)) + 3;
  cfg.layers.forEach((layer, index) => {
    if (layered) {
      lines.push(`layer${layer.number}:` + (layer.name ? `    # ${layer.name}` : ''));
    }

    const ccByParam = new Map();
    const modeByParam = new Map();
    for (const mapping of layer.byCc.values()) {
      ccByParam.set(mapping.paramIndex, mapping.cc);
      modeByParam.set(mapping.paramIndex, mapping.mode);
    }

    for (const p of aj.PARAMETERS) {
      const cc = ccByParam.has(p.index) ? ccByParam.get(p.index) : null;
      const bits = [`#${p.index}`, aj.describeRange(p)];
      if (p.note) bits.push(p.note);
      if (cc !== null && STANDARD_CC_USES[cc]) {
        bits.push(`NB: CC${cc} is normally ${STANDARD_CC_USES[cc]}`);
      }
      const comment = '  # ' + bits.join(' | ');

      const key = `"${p.name}":`;
      let value = cc === null ? 'off' : String(cc);
      if (cc !== null && modeByParam.get(p.index) === 'clamp') {
        value = `{cc: ${cc}, mode: clamp}`;
      }
      lines.push(`  ${key.padEnd(width)} ${value.padEnd(3)}${comment}`);
    }

    if (layered && index < cfg.layers.length - 1) lines.push('');
  });

  lines.push('');
  return lines.join('\n');
}

// ------------------------------------------------------------ persistence ---

/** Flatten to something JSON can hold, for localStorage. */
export function toJSON(cfg) {
  return {
    ...cfg,
    layers: cfg.layers.map((layer) => ({
      number: layer.number,
      name: layer.name,
      mappings: [...layer.byCc.values()],
      disabled: [...layer.disabled],
    })),
  };
}

export function fromJSON(data) {
  const cfg = makeConfig({ ...data });
  cfg.layout = makeLayout(data.layout.rows, data.layout.cols, data.layout.ccs);
  cfg.layers = data.layers.map((layer) => {
    const out = makeLayer(layer.number, layer.name);
    for (const mapping of layer.mappings) out.byCc.set(mapping.cc, { ...mapping });
    for (const index of layer.disabled) out.disabled.add(index);
    return out;
  });
  return cfg;
}

/** Resize the layer list, keeping the names and mappings that survive. */
export function resizeLayers(cfg, count) {
  while (cfg.layers.length > count) cfg.layers.pop();
  while (cfg.layers.length < count) cfg.layers.push(makeLayer(cfg.layers.length + 1));
  if (cfg.startupLayer > count) cfg.startupLayer = count;
}
