#!/usr/bin/env node
// Tests for the web build's translation core and config reader/writer.
//
//     node test_web.mjs          (from this directory)
//
// The interesting failures are not "does this function work" but "does this
// function still agree with config.py and alpha_juno.py", since the two read the
// same file and drive the same synth. So where python3 is available the parity
// sections run the Python implementation and compare the two answers directly.
// Without python3 those sections are skipped and say so; the rest still runs.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as aj from './js/alpha_juno.js';
import * as cfgmod from './js/config.js';
import { Router } from './js/router.js';
import * as pg from './js/pg300.js';
import * as tonein from './js/tone_in.js';
import * as lcd from './js/lcd.js';
import * as presets from './js/presets.js';
import * as bank from './js/bank.js';
import * as bulk from './js/bulk.js';
import * as smf from './js/smf.js';
import { parse as parseYaml, YamlError } from './js/yaml.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SAMPLE = join(ROOT, 'cc2juno.yaml');

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (exc) {
    failed += 1;
    console.log(`FAIL  ${name}\n        ${exc.message.split('\n').join('\n        ')}`);
  }
}

async function checkAsync(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (exc) {
    failed += 1;
    console.log(`FAIL  ${name}\n        ${exc.message.split('\n').join('\n        ')}`);
  }
}

function skip(name, why) {
  skipped += 1;
  console.log(`skip  ${name} (${why})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function equal(got, want, message = '') {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${message}\n        got:  ${a}\n        want: ${b}`);
}

function throwsWith(body, fragment) {
  try {
    body();
  } catch (exc) {
    assert(exc.message.includes(fragment),
           `wrong message: ${exc.message}\n        expected to contain: ${fragment}`);
    return;
  }
  throw new Error(`expected an error containing "${fragment}", nothing was raised`);
}

/** Run a snippet against the repo's Python modules. Null if python3 is missing. */
function python(code) {
  try {
    return JSON.parse(execFileSync('python3', ['-c', code], { cwd: ROOT, encoding: 'utf8' }));
  } catch (exc) {
    if (exc.code === 'ENOENT') return null;
    throw new Error(`python3 failed:\n${exc.stderr || exc.message}`);
  }
}

const havePython = python('import json; print(json.dumps(1))') === 1;

// --------------------------------------------------------- the tone table ---

check('the table has 36 parameters, indexed 0-35 in order', () => {
  equal(aj.PARAMETERS.length, 36);
  aj.PARAMETERS.forEach((p, i) => equal(p.index, i, `parameter ${i} out of order`));
});

check('names, aliases and indexes all resolve', () => {
  equal(aj.lookup('VCF Cutoff').index, 16);
  equal(aj.lookup('vcf_cutoff').index, 16);
  equal(aj.lookup('VCF cutoff frequency').index, 16);
  equal(aj.lookup(16).index, 16);
  equal(aj.lookup('16').index, 16);
  equal(aj.lookup('Attack Time').index, 26);
  equal(aj.lookup('no such thing'), null);
  equal(aj.lookup(36), null);
});

check('scale splits 128 steps into equal regions', () => {
  const mode = aj.lookup('VCA Env. Mode');       // four options
  equal([0, 31, 32, 63, 64, 95, 96, 127].map((cc) => aj.scale(mode, cc)),
        [0, 0, 1, 1, 2, 2, 3, 3]);
  const cutoff = aj.lookup('VCF Cutoff');        // full range, pass-through
  equal([0, 1, 64, 127].map((cc) => aj.scale(cutoff, cc)), [0, 1, 64, 127]);
  const bender = aj.lookup('Bender Range');      // thirteen regions
  equal(aj.scale(bender, 127), 12);
  equal(aj.scale(bender, 0), 0);
});

check('clamp takes the value literally, clipping at the maximum', () => {
  const bender = aj.lookup('Bender Range');
  equal([0, 5, 12, 13, 127].map((cc) => aj.clamp(bender, cc)), [0, 5, 12, 12, 12]);
});

check('hysteresis holds a value inside the dead zone at a region edge', () => {
  const range = aj.lookup('DCO Range');          // four regions, edges at 32/64/96
  // Sitting just past the boundary is not enough to move with hysteresis 2.
  equal(aj.convert(range, 32, { previous: 0, hysteresis: 2 }), 0);
  equal(aj.convert(range, 33, { previous: 0, hysteresis: 2 }), 0);
  equal(aj.convert(range, 34, { previous: 0, hysteresis: 2 }), 1);
  // Coming back down has the same dead zone on the other side of the edge.
  equal(aj.convert(range, 31, { previous: 1, hysteresis: 2 }), 1);
  equal(aj.convert(range, 29, { previous: 1, hysteresis: 2 }), 0);
  // A jump of more than one region is never held back.
  equal(aj.convert(range, 96, { previous: 0, hysteresis: 2 }), 3);
  // Continuous parameters ignore it entirely.
  equal(aj.convert(aj.lookup('VCF Cutoff'), 64, { previous: 63, hysteresis: 8 }), 64);
});

check('the layer knob is just another quantized parameter', () => {
  const param = aj.makeLayerParam(3);
  equal([0, 42, 43, 85, 86, 127].map((cc) => aj.scale(param, cc)), [0, 0, 1, 1, 2, 2]);
  equal(aj.regionBounds(param, 0), [0, 42]);
  equal(aj.regionBounds(param, 2), [86, 127]);
  throwsWith(() => aj.makeLayerParam(11), 'layer count must be 1-10');
});

check('sysex framing matches the documented message', () => {
  equal(aj.buildSysex(16, 100, 1), [0xF0, 0x41, 0x36, 0x00, 0x23, 0x20, 0x01, 16, 100, 0xF7]);
  equal(aj.buildSysex(0, 0, 16, 0x01, 0x01),
        [0xF0, 0x41, 0x36, 0x0F, 0x23, 0x01, 0x01, 0, 0, 0xF7]);
  equal(aj.hexString(aj.buildSysex(16, 100, 1)), 'F0 41 36 00 23 20 01 10 64 F7');
  throwsWith(() => aj.buildSysex(16, 100, 17), 'channel must be 1-16');
  throwsWith(() => aj.buildSysex(36, 100, 1), 'parameter index must be 0-35');
  throwsWith(() => aj.buildSysex(16, 128, 1), 'value must be 0-127');
});

if (havePython) {
  check('every scale() answer matches alpha_juno.py', () => {
    const want = python(`
import json, alpha_juno as aj
print(json.dumps([[aj.scale(p, cc) for cc in range(128)] for p in aj.PARAMETERS]))`);
    const got = aj.PARAMETERS.map((p) => Array.from({ length: 128 }, (_, cc) => aj.scale(p, cc)));
    equal(got, want, 'scale() disagrees with the Python build');
  });

  check('every convert() answer matches alpha_juno.py', () => {
    const previouses = [null, 0, 1, 2];
    const code = `
import json, alpha_juno as aj
out = []
for p in aj.PARAMETERS:
    for mode in ("scale", "clamp"):
        for previous in (None, 0, 1, 2):
            for h in (0, 2, 5):
                out.append([aj.convert(p, cc, mode, previous, h) for cc in range(128)])
print(json.dumps(out))`;
    const want = python(code);
    const got = [];
    for (const p of aj.PARAMETERS) {
      for (const mode of ['scale', 'clamp']) {
        for (const previous of previouses) {
          for (const hysteresis of [0, 2, 5]) {
            got.push(Array.from({ length: 128 },
                                (_, cc) => aj.convert(p, cc, { mode, previous, hysteresis })));
          }
        }
      }
    }
    equal(got.length, want.length, 'different number of cases');
    for (let i = 0; i < want.length; i += 1) equal(got[i], want[i], `case ${i}`);
  });

  check('the parameter table matches alpha_juno.py', () => {
    const want = python(`
import json, alpha_juno as aj
print(json.dumps([[p.index, p.name, p.max_value, list(p.options)] for p in aj.PARAMETERS]))`);
    equal(aj.PARAMETERS.map((p) => [p.index, p.name, p.maxValue, p.options]), want);
  });
} else {
  skip('parity with alpha_juno.py', 'python3 not found');
}

// ------------------------------------------------------------ YAML reader ---

check('the reader handles the dialect the config uses', () => {
  const raw = parseYaml([
    '# a comment',
    'top: 5',
    'section:',
    '  plain: text',
    '  "Quoted Key": 12    # trailing comment',
    '  hexy: 0x20',
    '  yes_please: on',
    '  nope: off',
    '  empty:',
    '  flow: {cc: 90, mode: clamp}',
  ].join('\n'));
  equal(raw.top, 5);
  equal(raw.section.plain, 'text');
  equal(raw.section['Quoted Key'], 12);
  equal(raw.section.hexy, 32);
  equal(raw.section.yes_please, true);
  equal(raw.section.nope, false);
  equal(raw.section.empty, null);
  equal(raw.section.flow, { cc: 90, mode: 'clamp' });
});

check('the reader refuses what the Tulip reader refuses', () => {
  throwsWith(() => parseYaml('a:\n  - one\n'), 'lists are not supported');
  throwsWith(() => parseYaml('a: [1, 2]\n'), 'lists are not supported');
  throwsWith(() => parseYaml('a:\n  b: 1\n   c: 2\n'), 'inconsistent indentation');
  throwsWith(() => parseYaml('a: 1\na: 2\n'), "'a' appears twice at the top level");
  throwsWith(() => parseYaml('s:\n  a: 1\n  a: 2\n'), "'a' appears twice under 's'");
  throwsWith(() => parseYaml('  a: 1\n'), 'not inside a section');
  throwsWith(() => parseYaml('a: "unterminated\n'), 'unterminated quoted string');
  assert(new YamlError('x') instanceof Error);
});

check('a # inside quotes is not a comment', () => {
  equal(parseYaml('ports:\n  input: "board #2"\n').ports.input, 'board #2');
});

// ----------------------------------------------------------------- config ---

const sampleText = readFileSync(SAMPLE, 'utf8');

/**
 * A three-layer controller of this suite's own, for the tests that have to know
 * exactly what is mapped where.
 *
 * Those tests used to read cc2juno.yaml and then hard-code the CC numbers it
 * happened to contain, which made remapping a knob in the shipped file report
 * itself as a broken build -- three failures that named the parser and the YAML
 * writer, neither of which had anything to do with it. What they are really
 * about is the writer and the duplicate-parameter check, and neither cares which
 * knob does what. So they bring their own controller and leave the user's alone.
 *
 * Deliberately small, and deliberately not exhaustive: CC1 and CC2 do different
 * jobs on different layers, one parameter is mapped nowhere at all, and CC5 is
 * the layer knob so no mapping may use it.
 */
const THREE_LAYERS = `
midi:
  synth_channel: 1
layers:
  cc: 5
  count: 3
layer1:
  "VCF Cutoff": 1
  "DCO Wave Pulse": 2
  "Bender Range": 3
layer2:
  "ENV T1": 1
  "ENV T2": 2
layer3:
  "LFO Rate": 4
`;

/**
 * The file this repo ships still parses, and still describes a coherent rig.
 *
 * Says nothing whatever about which knob does what. That is the user's to
 * change, and every assertion here has to survive them changing it -- the whole
 * point of a smoke test on a file that is meant to be edited. What must hold is
 * that it reads without error and that everything the parser hands back hangs
 * together: real parameters, CCs in range, no knob doing two jobs at once, and
 * every mapped CC given a place on the grid.
 */
check('the shipped config loads', () => {
  const { cfg, warnings } = cfgmod.parseText(sampleText, 'cc2juno.yaml');

  assert(cfg.layers.length >= 1 && cfg.layers.length <= aj.MAX_LAYERS,
         `${cfg.layers.length} layers is outside 1-${aj.MAX_LAYERS}`);
  assert(cfg.synthChannel >= 1 && cfg.synthChannel <= 16, 'synth channel out of range');
  assert(cfg.listenChannel === null
         || (cfg.listenChannel >= 1 && cfg.listenChannel <= 16), 'listen channel out of range');
  assert(cfg.maxMsgsPerSec > 0, 'a rate limit of zero would send nothing');
  for (const byte of [cfg.levelByte, cfg.groupByte]) {
    assert(Number.isInteger(byte) && byte >= 0 && byte <= 0x7F,
           `${byte} is not a sysex data byte`);
  }
  assert(Array.isArray(warnings) && warnings.every((w) => typeof w === 'string'),
         'warnings should be a list of strings');

  const grid = cfgmod.knobCcs(cfg);
  let mapped = 0;

  cfg.layers.forEach((layer, index) => {
    for (const [cc, mapping] of layer.byCc) {
      mapped += 1;
      equal(mapping.cc, cc, `layer ${index + 1} filed CC${cc} under the wrong key`);
      assert(cc >= 0 && cc <= 127, `CC${cc} is not a CC number`);
      assert(aj.PARAMETERS[mapping.paramIndex],
             `CC${cc} points at parameter ${mapping.paramIndex}, which does not exist`);
      assert(mapping.mode === 'scale' || mapping.mode === 'clamp',
             `CC${cc} has scaling mode "${mapping.mode}"`);
      assert(cc !== cfg.layerCc,
             `CC${cc} both selects the layer and sets a parameter`);
      assert(grid.has(cc), `CC${cc} is mapped but has no cell on the grid`);
    }
  });

  assert(mapped > 0, 'the shipped config maps nothing at all');
});

if (havePython) {
  check('the shipped config is read the same way by config.py', () => {
    const want = python(`
import json, config
c = config.load('cc2juno.yaml')
print(json.dumps({
    "channel": c.synth_channel,
    "listen": c.listen_channel,
    "level": c.level_byte,
    "group": c.group_byte,
    "rate": c.max_msgs_per_sec,
    "hyst": c.hysteresis,
    "thru": c.thru,
    "layer_cc": c.layer_cc,
    "startup": c.startup_layer,
    "layers": [sorted((cc, m.param.index, m.mode) for cc, m in l.by_cc.items())
               for l in c.layers],
}))`);
    const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
    equal({
      channel: cfg.synthChannel,
      listen: cfg.listenChannel,
      level: cfg.levelByte,
      group: cfg.groupByte,
      rate: cfg.maxMsgsPerSec,
      hyst: cfg.hysteresis,
      thru: cfg.thru,
      layer_cc: cfg.layerCc,
      startup: cfg.startupLayer,
      layers: cfg.layers.map((layer) => [...layer.byCc.values()]
        .map((m) => [m.cc, m.paramIndex, m.mode])
        .sort((a, b) => a[0] - b[0])),
    }, want);
  });

  check('what this build writes, config.py reads back unchanged', () => {
    // The suite's own controller, not the shipped one: this is about the writer,
    // and it needs a known CC to turn into a clamp entry. See THREE_LAYERS.
    const { cfg } = cfgmod.parseText(THREE_LAYERS, 'three layers');
    // Something for every corner of the writer: a clamp entry, layer names, a
    // layer dead zone, an empty grid cell and a non-default startup layer.
    cfg.layers[0].byCc.get(1).mode = 'clamp';
    cfg.layers[0].name = 'Filter';
    cfg.layers[1].name = 'Envelope';
    cfg.layerHysteresis = 4;
    cfg.startupLayer = 2;
    cfg.layout = cfgmod.reshapeLayout(cfg.layout, 4, 4);
    const text = cfgmod.render(cfg);

    const want = python(`
import json, sys, yaml, config
raw = yaml.safe_load(sys.stdin.read())
c = config.parse(raw, 'exported')
print(json.dumps({
    "layer_cc": c.layer_cc,
    "startup": c.startup_layer,
    "layer_hyst": c.layer_hysteresis,
    "names": [l.name for l in c.layers],
    "layout": [c.layout.rows, c.layout.cols, c.layout.ccs],
    "layers": [sorted((cc, m.param.index, m.mode) for cc, m in l.by_cc.items())
               for l in c.layers],
}))`.replace('sys.stdin.read()', JSON.stringify(text)));

    equal(want.layer_cc, 5);
    equal(want.startup, 2);
    equal(want.layer_hyst, 4);
    equal(want.names, ['Filter', 'Envelope', '']);
    equal(want.layout, [4, 4, [...cfg.layout.ccs]]);
    equal(want.layers, cfg.layers.map((layer) => [...layer.byCc.values()]
      .map((m) => [m.cc, m.paramIndex, m.mode])
      .sort((a, b) => a[0] - b[0])));
  });

  check('a config with a layout survives a trip through config.py', () => {
    const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
    const text = python(`
import json, config
raw = ${JSON.stringify(cfgmod.render(cfg))}
c = config.parse(__import__('yaml').safe_load(raw), 'exported')
maps = [{p.index: None for p in config.PARAMETERS} for _ in c.layers]
for i, l in enumerate(c.layers):
    for cc, m in l.by_cc.items():
        maps[i][m.param.index] = cc
print(json.dumps(config.render(maps, c)))`);
    const again = cfgmod.parseText(text, 'round trip');
    equal(again.cfg.layout, cfg.layout, 'the grid changed on the way round');
    equal(again.cfg.layers.map((l) => [...l.byCc.keys()].sort((a, b) => a - b)),
          cfg.layers.map((l) => [...l.byCc.keys()].sort((a, b) => a - b)));
  });
} else {
  skip('parity with config.py', 'python3 not found');
}

check('the writer emits clamp entries the reader understands', () => {
  const cfg = cfgmod.makeConfig();
  cfg.layers[0].byCc.set(90, { cc: 90, paramIndex: 35, mode: 'clamp' });
  cfg.layout = cfgmod.makeLayout(1, 1, [90]);
  const text = cfgmod.render(cfg);
  assert(text.includes('{cc: 90, mode: clamp}'), 'clamp mode was not written out');
  const { cfg: back } = cfgmod.parseText(text, 'round trip');
  equal(back.layers[0].byCc.get(90), { cc: 90, paramIndex: 35, mode: 'clamp' });
});

check('bad configs are rejected with a useful message', () => {
  const base = 'midi:\n  synth_channel: 1\nmappings:\n  "VCF Cutoff": 16\n';
  throwsWith(() => cfgmod.parseText('mappings:\n  "Nonsense": 4\n'),
             'unknown parameter name');
  throwsWith(() => cfgmod.parseText('mappings:\n  "VCF Cutoff": 16\n  "LFO Rate": 16\n'),
             'CC16 is assigned to both');
  throwsWith(() => cfgmod.parseText('mappings:\n  "VCF Cutoff": 200\n'), 'must be 0-127');
  throwsWith(() => cfgmod.parseText('mappings:\n  "VCF Cutoff": on\n'),
             "expected a number 0-127 or 'off'");
  throwsWith(() => cfgmod.parseText(`${base}nonsense:\n  a: 1\n`),
             'unknown top-level section');
  throwsWith(() => cfgmod.parseText('layer1:\n  "VCF Cutoff": 16\nlayer2:\n  "LFO Rate": 16\n'),
             "no 'layers:' section");
  throwsWith(() => cfgmod.parseText('layers:\n  cc: 5\n  count: 2\n'
                                    + 'layer1:\n  "VCF Cutoff": 5\n'),
             'CC5 selects the layer');
  throwsWith(() => cfgmod.parseText(`${base}layout:\n  rows: 2\n  cols: 2\n`
                                    + '  ccs: "1, 2, 3, 4, 5"\n'),
             'lists 5 cells but the grid is 2x2');
  throwsWith(() => cfgmod.parseText(`${base}layout:\n  rows: 1\n  cols: 3\n`
                                    + '  ccs: "7, 8, 7"\n'),
             'one knob sits in one place');
});

check('an empty config is a warning here, not an error', () => {
  // The CLI refuses this because it is about to sit doing nothing; the editor
  // has to be able to open it, because that is where a new config starts.
  const { cfg, warnings } = cfgmod.parseText('mappings:\n  "VCF Cutoff": off\n');
  equal(cfg.layers[0].byCc.size, 0);
  assert(warnings.length > 0, 'expected a warning');
});

// ----------------------------------------------------------------- layout ---

check('a layout is built from the CCs in use when the file has none', () => {
  equal(cfgmod.autoLayout([1, 2, 3, 4, 5, 6, 7, 8]), { rows: 1, cols: 8,
                                                       ccs: [1, 2, 3, 4, 5, 6, 7, 8] });
  equal(cfgmod.autoLayout([1, 2, 3, 4, 5, 6]).cols, 6);
  equal(cfgmod.autoLayout(Array.from({ length: 16 }, (_, i) => i)).cols, 8);
  equal(cfgmod.autoLayout(Array.from({ length: 16 }, (_, i) => i)).rows, 2);
  equal(cfgmod.autoLayout(Array.from({ length: 12 }, (_, i) => i)).cols, 6);
  equal(cfgmod.autoLayout([]).ccs.length, 8);
});

check('a knob missing from the grid is added rather than rejected', () => {
  const text = 'layout:\n  rows: 1\n  cols: 2\n  ccs: "16, 17"\n'
             + 'mappings:\n  "VCF Cutoff": 16\n  "LFO Rate": 24\n';
  const { cfg, warnings } = cfgmod.parseText(text);
  assert(cfgmod.knobCcs(cfg).has(24), 'CC24 should have been given a cell');
  equal(cfg.layout.rows, 2, 'the grid should have grown by a row');
  assert(warnings.some((w) => w.includes('24')), 'expected a warning naming CC24');
});

check('reshaping keeps the knobs in reading order', () => {
  const layout = cfgmod.makeLayout(2, 3, [1, 2, 3, 4, null, 6]);
  equal(cfgmod.reshapeLayout(layout, 5, 1).ccs, [1, 2, 3, 4, 6]);
  equal(cfgmod.reshapeLayout(layout, 1, 3).ccs, [1, 2, 3]);
  equal(cfgmod.reshapeLayout(layout, 3, 3).ccs, [1, 2, 3, 4, 6, null, null, null, null]);
});

check('a parameter already in use is reported per layer', () => {
  // In THREE_LAYERS, VCF Cutoff is CC1 on layer 1 and nowhere else.
  const { cfg } = cfgmod.parseText(THREE_LAYERS, 'three layers');
  const cutoff = aj.lookup('VCF Cutoff').index;
  equal(cfgmod.paramUsage(cfg, cutoff, 0), { here: 1, elsewhere: [] },
        'seen from its own layer it is here, not elsewhere');
  equal(cfgmod.paramUsage(cfg, cutoff, 1), { here: null, elsewhere: [1] },
        'seen from another layer it is elsewhere, not here');

  // Something mapped on two layers at once shows up on both.
  cfg.layers[2].byCc.set(40, { cc: 40, paramIndex: cutoff, mode: 'scale' });
  equal(cfgmod.paramUsage(cfg, cutoff, 2), { here: 40, elsewhere: [1] });
  equal(cfgmod.paramUsage(cfg, cutoff, 1), { here: null, elsewhere: [1, 3] });

  // And a parameter the fixture maps nowhere is free.
  equal(cfgmod.paramUsage(cfg, aj.lookup('Chorus Rate').index, 0),
        { here: null, elsewhere: [] });
});

check('the JSON round trip used by localStorage keeps everything', () => {
  const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
  // Every layer rather than the second one, so that this still has names to
  // carry when the shipped config is edited down to a single layer.
  cfg.layers.forEach((layer, index) => { layer.name = `Layer ${index + 1}`; });
  const back = cfgmod.fromJSON(JSON.parse(JSON.stringify(cfgmod.toJSON(cfg))));
  equal(cfgmod.render(back), cfgmod.render(cfg));
});

// ---------------------------------------------------------------- routing ---

// Two layers that share their knobs, which is the arrangement every layering
// bug hides in: the same CC means something different depending on the layer,
// and one CC means nothing at all on the first one.
const TWO_LAYERS = `
midi:
  hysteresis: 0
layers:
  cc: 5
  count: 2
  names: "Osc, Env"
layer1:
  "DCO Wave Pulse": 2
layer2:
  "ENV T2": 2
  "VCA Level": 4
`;

function makeRouter(overrides = {}) {
  const { cfg } = cfgmod.parseText(TWO_LAYERS, 'two layers');
  Object.assign(cfg, overrides);
  const sent = [];
  const router = new Router(cfg, {
    send: (frame) => sent.push(frame[0] === 0xF0
      ? `${aj.PARAMETERS[frame[7]].name}=${frame[8]}`
      : `raw ${aj.hexString(frame)}`),
  });
  const cc = (number, value) => router.handle(new Uint8Array([0xB0, number, value]));
  const drain = () => {
    // The rate limiter is a wall clock away from finishing; step it along.
    while (router.pending.size) { router.lastSend = 0; router.flush(); }
    return sent.splice(0);
  };
  return { cfg, router, cc, drain, sent };
}

check('a CC that is unassigned on this layer sends nothing at all', () => {
  const { cc, drain, router } = makeRouter();
  cc(4, 64);                       // VCA Level on layer 2, nothing on layer 1
  equal(drain(), [], 'a knob idle on this layer must stay silent');
  equal(router.lastValue.size, 0, 'and must not record a value for the parameter');
  equal([...router.sentOnLayer], [], 'and must not count as having taken effect');
});

check('a layer change sends nothing and leaves every knob not-yet-live', () => {
  const { cc, drain, router } = makeRouter();
  cc(2, 70);                       // DCO Wave Pulse on layer 1
  equal(drain(), ['DCO Wave Pulse=2']);
  equal([...router.sentOnLayer], [2]);

  cc(5, 127);                      // the layer knob, over to layer 2
  equal(router.layer, 1, 'should have switched layer');
  equal(drain(), [], 'switching layers must not send anything');
  // This is the bug this test exists for: the knobs are still sitting where the
  // previous layer left them, so nothing on this layer has taken effect yet and
  // the display must not pretend otherwise.
  equal([...router.sentOnLayer], [], 'no knob has taken effect on the new layer');
});

check('only the knob that moved becomes live, and only it is sent', () => {
  const { cc, drain, router } = makeRouter();
  cc(5, 127);
  cc(4, 100);
  equal(drain(), ['VCA Level=100']);
  equal([...router.sentOnLayer], [4], 'the untouched knobs must stay not-live');
  equal(router.cfg.layers[1].byCc.has(2), true, 'CC2 is mapped on layer 2');
  equal(router.sentOnLayer.has(2), false, 'but has not been moved, so is not live');
});

check('the same CC sends a different parameter on each layer, and never both', () => {
  const { cc, drain } = makeRouter();
  cc(2, 100);
  equal(drain(), ['DCO Wave Pulse=3']);
  cc(5, 127);
  cc(2, 100);
  equal(drain(), ['ENV T2=100'], 'layer 2 must send its own parameter, once');
});

check('a knob from another layer is consumed even with thru on', () => {
  const { cc, drain } = makeRouter({ thru: true });
  cc(4, 64);                       // mapped on layer 2, so not a raw CC to pass on
  equal(drain(), [], 'must not escape to the synth as a raw CC');
  cc(99, 64);                      // mapped nowhere, so it belongs to the keyboard
  equal(drain(), ['raw B0 63 40'], 'a genuinely unmapped CC still passes through');
});

check('a burst collapses to one message carrying the final value', () => {
  const { cc, drain } = makeRouter();
  cc(5, 127);
  for (let value = 0; value <= 127; value += 1) cc(4, value);
  equal(drain(), ['VCA Level=127'], 'only the newest value per parameter survives');
});

check('the layer knob is never sent to the synth as a parameter', () => {
  const { cc, drain, router } = makeRouter();
  for (const value of [0, 40, 80, 127]) cc(5, value);
  equal(drain(), []);
  equal(router.layer, 1);
});

check('a parameter set from the panel is sent with no CC behind it', () => {
  const { router, drain } = makeRouter();
  assert(router.sendParam(aj.lookup('VCF Cutoff').index, 90), 'should have queued');
  equal(drain(), ['VCF Cutoff=90']);
  assert(!router.sendParam(aj.lookup('VCF Cutoff').index, 90),
         'the same value again is not worth a message');
  equal(drain(), []);
});

check('a panel sweep collapses under the rate limit like a knob sweep', () => {
  const { router, drain } = makeRouter();
  const level = aj.lookup('VCA Level').index;
  for (let value = 0; value <= 127; value += 1) router.sendParam(level, value);
  equal(drain(), ['VCA Level=127'], 'only the newest value per parameter survives');
});

check('the panel cannot send a parameter past its range', () => {
  const { router, drain } = makeRouter();
  router.sendParam(aj.lookup('DCO Range').index, 99);
  equal(drain(), ['DCO Range=3'], 'a 4-position parameter tops out at 3');
  throwsWith(() => router.sendParam(36, 0), 'no such parameter');
});

// ------------------------------------------------------------- PG-300 view ---

check('every parameter is on the panel exactly once', () => {
  equal(pg.LAYOUT.length, aj.PARAMETERS.length);
  const seen = pg.LAYOUT.map((entry) => entry.param).sort((a, b) => a - b);
  equal(seen, aj.PARAMETERS.map((param) => param.index),
        'the panel must cover the tone table and nothing else');
});

check('the panel artwork agrees with the parameter table about granularity', () => {
  // Slider length is taken off the drawing, not worked out from the table, so
  // this is a real check: Roland gave the switch-like parameters short travel
  // and the 0..127 ones the full 63.78. If the two ever disagree, one of them
  // has been mistyped.
  for (const entry of pg.LAYOUT) {
    const param = aj.PARAMETERS[entry.param];
    const wants = param.maxValue >= 5 ? 'full' : (param.maxValue <= 1 ? 'stub' : 'half');
    const drawn = entry.len > 60 ? 'full' : (entry.len < 25 ? 'stub' : 'half');
    equal(drawn, wants, `${param.name}: a ${entry.len.toFixed(0)}-unit slider `
                        + `for a 0..${param.maxValue} parameter`);
  }
});

check('the panel stays inside its own frame', () => {
  // Room for the widest thing hung off a slider: the scale numerals down its
  // left, and the value readout under its bottom end.
  const { x, y, width, height } = pg.PANEL;
  for (const entry of pg.LAYOUT) {
    assert(entry.cx - 14 > x && entry.cx + 8 < x + width,
           `${entry.param}: x off the panel`);
    assert(entry.top - 8 > y && entry.top + entry.len + 10 < y + height,
           `${entry.param}: y off the panel`);
    if (entry.ticks === 'unit') continue;
    equal(entry.ticks.length, aj.PARAMETERS[entry.param].maxValue + 1,
          `${aj.PARAMETERS[entry.param].name}: one scale mark per step`);
  }
});

check('a slider draws where the value sits in its own range', () => {
  const cutoff = aj.lookup('VCF Cutoff');
  equal(pg.fractionOf(cutoff, 0), 0);
  equal(pg.fractionOf(cutoff, 127), 1);
  equal(pg.fractionOf(cutoff, null), 0, 'never sent has to be drawn somewhere');
  // A 4-position switch uses its whole travel, not the first 4/128 of it.
  equal(pg.fractionOf(aj.lookup('DCO Range'), 3), 1);
  equal(pg.fractionOf(aj.lookup('Chorus Switch'), 1), 1);
});

check('a slider moved on screen survives the trip through a knob', () => {
  // The panel feeds a move back in as the CC of any knob that reaches the same
  // parameter, so that the two views cannot disagree about where that knob is.
  // The value has to come back out unchanged, or dragging a slider would land
  // on a neighbouring value.
  for (const param of aj.PARAMETERS) {
    for (let value = 0; value <= param.maxValue; value += 1) {
      const cc = aj.ccForValue(param, value);
      equal(aj.convert(param, cc, { previous: value === 0 ? 1 : value - 1, hysteresis: 4 }),
            value, `${param.name} = ${value} came back as something else`);
    }
  }
});

// ------------------------------------------------- tone data from the synth ---

// Captured from an Alpha Juno announcing a patch change: APR, tone level, all 36
// parameters and the ten name bytes. Every test in this section is measured
// against this rather than against our own encoder, so that agreeing with
// ourselves cannot be mistaken for agreeing with the synth.
const APR_HEX = 'F0 41 35 00 23 20 01 00 02 02 03 03 00 02 00 00 01 01 00 00 18 6E 40 4D '
              + '00 00 62 50 60 47 00 57 2E 00 7F 00 7A 30 34 28 08 50 02 0F 28 25 32 12 '
              + '32 27 2D 21 35 F7';
const APR = Uint8Array.from(APR_HEX.split(' ').map((byte) => parseInt(byte, 16)));

const APR_VALUES = [0, 2, 2, 3, 3, 0, 2, 0, 0, 1, 1, 0, 0, 24, 110, 64, 77, 0, 0, 98, 80,
                    96, 71, 0, 87, 46, 0, 127, 0, 122, 48, 52, 40, 8, 80, 2];

check('a patch change from the synth reads as 36 parameters and a name', () => {
  const message = tonein.parseToneMessage(APR);
  equal(message.kind, 'tone');
  equal(message.channel, 1);
  equal(message.name, 'PolySynth1');
  equal(message.values, APR_VALUES);
});

check('the parameters land in the order the tone table uses', () => {
  // The bulk-dump format reorders them and stores six in four bits; APR does
  // neither, and reading one as though it were the other is the mistake this
  // catches. Spot-checked against the captured message by name.
  const { values } = tonein.parseToneMessage(APR);
  equal(values[aj.lookup('VCF Cutoff').index], 0x4D);
  equal(values[aj.lookup('DCO Range').index], 2);
  equal(values[aj.lookup('Chorus Switch').index], 1);
  equal(values[aj.lookup('ENV L1').index], 0x7F);
  equal(values[aj.lookup('Bender Range').index], 2);
  // A four-bit parameter on the wire is still a 0-127 number here.
  equal(values[aj.lookup('VCF Key Follow').index], 0x50);
});

check('an APR with no name is still a patch', () => {
  const bare = Uint8Array.from([...APR.slice(0, 43), 0xF7]);
  const message = tonein.parseToneMessage(bare);
  equal(message.kind, 'tone');
  equal(message.name, '');
  equal(message.values, APR_VALUES);
});

check('an individual parameter message reads as one parameter', () => {
  const message = tonein.parseToneMessage(
    Uint8Array.from(aj.buildSysex(aj.lookup('VCF Cutoff').index, 99, 3)));
  equal(message, { kind: 'param', channel: 3, index: 16, value: 99 });
});

check('messages that are not tone data are ignored', () => {
  const swap = (index, byte) => {
    const copy = Uint8Array.from(APR);
    copy[index] = byte;
    return copy;
  };
  equal(tonein.parseToneMessage(swap(1, 0x43)), null, 'another manufacturer');
  equal(tonein.parseToneMessage(swap(2, 0x37)), null, 'a bulk dump');
  equal(tonein.parseToneMessage(swap(4, 0x24)), null, 'another format type');
  // The MKS-50 sends patch and chord levels through the same opcode; their bytes
  // are not tone parameters and must not be read as any.
  equal(tonein.parseToneMessage(swap(5, 0x30)), null, 'patch level');
  equal(tonein.parseToneMessage(APR.slice(0, 20)), null, 'truncated');
});

check('a message split across events is gathered up', () => {
  const stream = new tonein.SysexStream();
  equal(stream.feed(APR.slice(0, 10)), [], 'a fragment is not a message');
  assert(stream.collecting, 'the stream should know it is mid-message');
  equal(stream.feed(APR.slice(10, 30)), []);
  const done = stream.feed(APR.slice(30));
  equal(done.length, 1);
  equal(tonein.parseToneMessage(done[0]).name, 'PolySynth1');
  assert(!stream.collecting, 'the stream should be idle again');
});

check('clock bytes inside a message do not break it', () => {
  const stream = new tonein.SysexStream();
  const noisy = [...APR.slice(0, 12), 0xF8, ...APR.slice(12, 40), 0xFE, ...APR.slice(40)];
  const found = stream.feed(Uint8Array.from(noisy));
  equal(found.length, 1);
  equal(tonein.parseToneMessage(found[0]).values, APR_VALUES);
});

check('a truncated message does not swallow the one after it', () => {
  const stream = new tonein.SysexStream();
  // The synth is unplugged mid-message; what arrives next is a whole one.
  const found = stream.feed(Uint8Array.from([...APR.slice(0, 20), ...APR]));
  equal(found.length, 1);
  equal(tonein.parseToneMessage(found[0]).name, 'PolySynth1');
});

check('a patch change moves every knob and empties the queue', () => {
  const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
  const router = new Router(cfg);
  router.dryRun = true;

  // A knob is moved, so there is something queued and something already sent.
  const [cc, mapping] = [...cfg.layers[router.layer].byCc][0];
  router.handleCc(cc, 64, mapping);
  assert(router.pending.size === 1, 'the move should be queued');

  router.applyTone(APR_VALUES, { name: 'PolySynth1' });

  equal(router.pending.size, 0, 'queued edits would have overwritten the new patch');
  equal(router.toneName, 'PolySynth1');
  for (const param of aj.PARAMETERS) {
    equal(router.lastValue.get(param.index), APR_VALUES[param.index], param.name);
    assert(router.fromSynth.has(param.index), `${param.name} should be the synth's value`);
  }
});

check('a patch change does not pretend the pots moved', () => {
  // Where the pots are is the one thing a patch change says nothing about, and it
  // is the only record of where the controller physically is. The display draws
  // the knobs from the values instead.
  const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
  const router = new Router(cfg);
  router.dryRun = true;

  // Whatever knob comes first, sent on whatever channel the file says to listen
  // on: naming either here would make editing cc2juno.yaml look like a bug.
  const [cc] = [...cfg.layers[router.layer].byCc][0];
  const channel = cfg.listenChannel === null ? 1 : cfg.listenChannel;
  router.handle(Uint8Array.from([0xB0 | (channel - 1), cc, 100]));
  router.applyTone(APR_VALUES);

  equal(router.ccPositions.get(cc), 100, 'the pot is still where it was left');
  equal(router.ccPositions.size, 1, 'no other pot has a position to report');
});

check("a knob drawn at the synth's value would send that value back", () => {
  // The dial is drawn at the CC position that produces the parameter's value, so
  // that dragging it on screen carries on from there instead of jumping. That
  // position has to convert back to the same value.
  const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
  for (const [, mapping] of cfg.layers[0].byCc) {
    const param = cfgmod.paramFor(mapping);
    const value = APR_VALUES[param.index];
    const position = mapping.mode === 'clamp'
      ? Math.min(aj.CC_RANGE - 1, value)
      : aj.ccForValue(param, value);
    equal(aj.convert(param, position, { mode: mapping.mode }), value,
          `${param.name} would be drawn somewhere that means something else`);
  }
});

check('our own send takes over from the value the synth reported', () => {
  const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
  const router = new Router(cfg);
  router.dryRun = true;
  router.applyTone(APR_VALUES);

  const cutoff = aj.lookup('VCF Cutoff');
  router.sendParam(cutoff.index, 12);
  router.flush();
  equal(router.lastValue.get(cutoff.index), 12);
  assert(!router.fromSynth.has(cutoff.index), 'the newer value is ours, not the synth\'s');
});

check('a single parameter from the synth moves only that knob', () => {
  const { cfg } = cfgmod.parseText(sampleText, 'cc2juno.yaml');
  const router = new Router(cfg);
  router.dryRun = true;
  router.applyTone(APR_VALUES);

  const cutoff = aj.lookup('VCF Cutoff');
  router.applyParam(cutoff.index, 5);
  equal(router.lastValue.get(cutoff.index), 5);
  for (const param of aj.PARAMETERS) {
    if (param === cutoff) continue;
    equal(router.lastValue.get(param.index), APR_VALUES[param.index], param.name);
  }
});

check('a value the tone table cannot hold is clipped, not passed on', () => {
  const wild = Uint8Array.from(APR);
  wild[7 + aj.lookup('Bender Range').index] = 0x7F;   // documented 0-12
  const { values } = tonein.parseToneMessage(wild);
  equal(values[aj.lookup('Bender Range').index], 12);
});

// ------------------------------------------------------------- presets ---

// The rule the whole feature rests on: a preset is 36 values or it is not a
// preset. Everything below is a way of getting that wrong.

// A second sound, for the tests that need two slots to hold different things.
// Every parameter is moved one step and wrapped inside its own range, so it
// differs from the captured patch everywhere while staying a tone the table says
// the synth could actually hold.
const OTHER_VALUES = APR_VALUES.map(
  (value, index) => (value + 1) % (aj.PARAMETERS[index].maxValue + 1));

check('a partial tone is not a preset, however much of it is known', () => {
  const { router, cc, drain } = makeRouter();
  equal(presets.isComplete(router.knownValues()), false, 'a fresh router knows nothing');
  equal(presets.knownCount(router.knownValues()), 0);

  cc(2, 70);                       // one knob moved, one parameter known
  drain();
  equal(presets.knownCount(router.knownValues()), 1);
  equal(presets.isComplete(router.knownValues()), false,
        'one known parameter must not be storable as a whole sound');

  throwsWith(() => presets.makePreset(router.knownValues()), 'all 36');
});

check('a patch from the synth is what makes recording possible', () => {
  const { router } = makeRouter();
  router.applyTone(APR_VALUES, { name: 'PolySynth1' });
  equal(presets.isComplete(router.knownValues()), true);
  equal(router.knownValues(), APR_VALUES);
});

check('a preset keeps the edits made since the patch arrived', () => {
  const { router, cc, drain } = makeRouter();
  router.applyTone(APR_VALUES);
  cc(2, 70);                       // DCO Wave Pulse on layer 1, to 2
  drain();

  const want = APR_VALUES.slice();
  want[aj.lookup('DCO Wave Pulse').index] = 2;
  equal(router.knownValues(), want, 'the stored sound is the patch plus what was changed');
});

check('a value still in the queue is the one that gets recorded', () => {
  // The rate limiter can hold a move for longer than it takes to hit a record
  // button. Storing what had happened to leave already would record a sound the
  // synth was about to stop making.
  const { router, cc } = makeRouter();
  router.applyTone(APR_VALUES);
  cc(2, 70);
  assert(router.pending.size === 1, 'the move should still be queued');
  equal(router.knownValues()[aj.lookup('DCO Wave Pulse').index], 2);
});

check('recalling a preset sends what differs and leaves the rest alone', () => {
  const { router, drain } = makeRouter();
  router.applyTone(APR_VALUES);

  const tweaked = APR_VALUES.slice();
  tweaked[aj.lookup('VCF Cutoff').index] = 100;
  tweaked[aj.lookup('VCA Level').index] = 10;
  tweaked[aj.lookup('LFO Rate').index] = 5;

  equal(router.sendTone(tweaked), 3, 'only the three that changed are worth sending');
  equal(drain().sort(), ['LFO Rate=5', 'VCA Level=10', 'VCF Cutoff=100']);
  equal(router.knownValues(), tweaked, 'and the recalled sound is now what is known');
});

check('recalling the preset already loaded sends nothing at all', () => {
  const { router, drain } = makeRouter();
  router.applyTone(APR_VALUES);
  equal(router.sendTone(APR_VALUES), 0);
  equal(drain(), []);
});

check('a recall leaves under the rate limit like every other message', () => {
  // 36 parameters at once is exactly the burst the limiter exists for: an Alpha
  // Juno will drop them if they arrive faster than it can take them.
  const { router, sent } = makeRouter();
  equal(router.sendTone(APR_VALUES), 36, 'nothing is known yet, so all 36 go');
  equal(router.pending.size, 36);

  router.lastSend = 0;
  router.flush();
  equal(sent.length, 1, 'one message per interval, not 36 in a burst');
  equal(router.pending.size, 35);
  // The panel does not wait for the queue: the sound is knowable in full from
  // the moment the recall is pressed.
  equal(presets.isComplete(router.knownValues()), true);
});

check('a recalled preset is unaffected by what the slot is later asked to hold', () => {
  const bank = new presets.PresetBank();
  const values = APR_VALUES.slice();
  bank.store(0, values, { name: 'PolySynth1' });

  values[0] = 3;                   // the caller's array moves on
  equal(bank.get(0).values[0], APR_VALUES[0], 'the slot kept its own copy');

  const taken = bank.get(0);
  taken.values[1] = 3;             // and so does everyone it hands one to
  equal(bank.get(0).values[1], APR_VALUES[1]);
});

check('slots survive the round trip through localStorage', () => {
  const bank = new presets.PresetBank();
  bank.store(0, APR_VALUES, { name: 'PolySynth1' });
  bank.store(4, OTHER_VALUES, { name: 'Memory' });

  const back = presets.PresetBank.fromJSON(JSON.parse(JSON.stringify(bank.toJSON())));
  equal(back.count(), 2);
  equal(back.get(0).values, APR_VALUES);
  equal(back.get(0).name, 'PolySynth1');
  equal(back.get(4).values, OTHER_VALUES);
  equal(back.get(1), null, 'an empty slot comes back empty');
  equal(back.get(0).savedAt, bank.get(0).savedAt, 'and knows when it was recorded');
});

check('one unreadable slot does not cost the other four', () => {
  const bank = new presets.PresetBank();
  bank.store(0, APR_VALUES, { name: 'Good' });
  bank.store(1, APR_VALUES, { name: 'Damaged' });
  bank.store(2, APR_VALUES, { name: 'Also good' });

  const stored = bank.toJSON();
  stored.slots[1].values = stored.slots[1].values.slice(0, 20);   // truncated on disk

  const back = presets.PresetBank.fromJSON(stored);
  equal(back.count(), 2, 'the survivors are kept');
  equal(back.get(0).name, 'Good');
  equal(back.get(1), null, 'and the bad one is simply gone');
  equal(back.get(2).name, 'Also good');
});

check('a value out of the parameter table is refused, not clipped', () => {
  // Clipping would be the wrong kindness here. A file this build cannot make
  // sense of should not be turned into a sound and sent to a synth.
  const wild = APR_VALUES.slice();
  wild[aj.lookup('Bender Range').index] = 100;      // documented 0-12
  equal(presets.isComplete(wild), false);
  throwsWith(() => presets.makePreset(wild), 'all 36');
});

check('a bank written by a build we do not know is left alone', () => {
  const bank = new presets.PresetBank();
  bank.store(0, APR_VALUES);
  const stored = bank.toJSON();
  stored.version = presets.STORE_VERSION + 1;

  equal(presets.PresetBank.fromJSON(stored).count(), 0,
        'values in an unknown order or unit must not reach the synth');
  equal(presets.PresetBank.fromJSON(null).count(), 0);
  equal(presets.PresetBank.fromJSON({ version: presets.STORE_VERSION }).count(), 0);
});

check('a recalled slot takes over the display', () => {
  // The synth has no numbering for a sound that came from here, and its own
  // screen goes on showing whatever patch it is sitting on. This is the only
  // place the two displays can disagree, and this is the side that is right.
  const { router } = makeRouter();
  router.applyTone(APR_VALUES, { name: 'PolySynth1' });
  router.setPatch(64);
  equal(router.recalled, null, 'nothing has been recalled yet');

  router.sendTone(OTHER_VALUES, { slot: presets.slotLabel(0), name: 'Fat Brass' });
  equal(router.recalled, { slot: 'T1', name: 'Fat Brass' });
  equal(lcd.displayText({ slot: router.recalled.slot, name: router.recalled.name }),
        'T1     Fat Brass ');
});

check('a slot label is T1 through T5, and fits where M-11 fits', () => {
  equal([0, 4].map(presets.slotLabel), ['T1', 'T5']);
  for (let i = 0; i < presets.SLOT_COUNT; i += 1) {
    const line = lcd.displayText({ slot: presets.slotLabel(i), name: 'Whatever' });
    equal(line.length, lcd.COLUMNS, `"${line}" is the wrong width`);
    // The tone name has to start in the column it always starts in, or it would
    // jump sideways every time a preset was recalled.
    equal(line.indexOf('Whatever'), lcd.displayText({ program: 0, name: 'x' }).indexOf('x'));
  }
});

check('a preset recorded before the synth named anything shows as half known', () => {
  equal(lcd.displayText({ slot: 'T3', name: '' }), 'T3     ----------');
});

check('the synth taking over ends the recall', () => {
  // Both halves of a patch change do it, since either can arrive first.
  const byTone = makeRouter().router;
  byTone.sendTone(APR_VALUES, { slot: 'T1', name: 'Fat Brass' });
  byTone.applyTone(OTHER_VALUES, { name: 'PolySynth1' });
  equal(byTone.recalled, null, 'a tone dump replaced the whole sound');

  const byProgram = makeRouter().router;
  byProgram.sendTone(APR_VALUES, { slot: 'T1', name: 'Fat Brass' });
  byProgram.setPatch(12);
  equal(byProgram.recalled, null, 'the instrument was turned to one of its own');
});

check('editing a parameter does not end the recall', () => {
  // The hardware keeps showing the patch name while the patch is being edited,
  // and a preset is no different: it is the same sound with a knob moved.
  const { router, cc, drain } = makeRouter();
  router.sendTone(APR_VALUES, { slot: 'T2', name: 'Fat Brass' });
  drain();

  cc(2, 70);                       // a knob here
  drain();
  equal(router.recalled, { slot: 'T2', name: 'Fat Brass' });

  router.applyParam(aj.lookup('VCF Cutoff').index, 99);   // and one on the synth
  equal(router.recalled, { slot: 'T2', name: 'Fat Brass' });
});

check('recalling the loaded preset still says so on the display', () => {
  // Nothing goes out, because the synth already has every value. The screen
  // still has to name the slot -- pressing it and seeing no change at all would
  // read as a dead button.
  const { router, drain } = makeRouter();
  router.applyTone(APR_VALUES, { name: 'PolySynth1' });
  equal(router.sendTone(APR_VALUES, { slot: 'T4', name: 'Same Sound' }), 0);
  equal(drain(), []);
  equal(router.recalled, { slot: 'T4', name: 'Same Sound' });
});

check('a slot can be emptied and re-recorded', () => {
  const bank = new presets.PresetBank();
  bank.store(2, APR_VALUES, { name: 'First' });
  equal(bank.filled(2), true);
  equal(bank.clear(2), true);
  equal(bank.filled(2), false);
  equal(bank.clear(2), false, 'clearing an empty slot changes nothing');

  bank.store(2, OTHER_VALUES, { name: 'Second' });
  equal(bank.get(2).name, 'Second');
  equal(bank.count(), 1);
});

check('there is no slot six', () => {
  const bank = new presets.PresetBank();
  equal(bank.size, presets.SLOT_COUNT);
  throwsWith(() => bank.store(presets.SLOT_COUNT, APR_VALUES), 'no such preset slot');
  equal(bank.get(-1), null);
  equal(bank.filled(99), false);
});

// ------------------------------------------------------------- the display ---

// The second captured patch: the first memory slot, sent with a program change
// of 0 where the preset above sent 64.
const MEMORY_HEX = 'F0 41 35 00 23 20 01 00 03 02 03 00 00 01 00 00 01 01 0A 00 10 3E 60 '
                 + '4E 00 01 3F 40 18 4A 28 59 46 35 33 46 7F 48 58 3A 18 4D 0C 09 2E 27 '
                 + '28 12 2D 2B 27 20 35 F7';
const MEMORY = Uint8Array.from(MEMORY_HEX.split(' ').map((byte) => parseInt(byte, 16)));

check('a program number reads as the slot the synth shows', () => {
  // Both ends of both halves. The second digit is a bank position, not a units
  // column, so it steps 8 -> 1 with the first digit rather than 9 -> 10.
  equal(lcd.patchLabel(0), 'M-11');
  equal(lcd.patchLabel(7), 'M-18');
  equal(lcd.patchLabel(8), 'M-21');
  equal(lcd.patchLabel(63), 'M-88');
  equal(lcd.patchLabel(64), 'P-11');
  equal(lcd.patchLabel(127), 'P-88');
  equal(lcd.patchLabel(128), null);
  equal(lcd.patchLabel(-1), null);
  equal(lcd.patchLabel(null), null);
});

check('every slot is a bank 1-8 and an instrument 1-8, and nothing else', () => {
  const labels = new Set();
  for (let program = 0; program < 128; program += 1) {
    const label = lcd.patchLabel(program);
    assert(/^[MP]-[1-8][1-8]$/.test(label), `program ${program} gave ${label}`);
    labels.add(label);
  }
  equal(labels.size, 128, 'two programs share a label');
});

check('the display shows the slot and the tone name, as the synth does', () => {
  const preset = tonein.parseToneMessage(APR);
  equal(lcd.displayText({ program: 64, name: preset.name }), 'P-11   PolySynth1');

  const memory = tonein.parseToneMessage(MEMORY);
  equal(memory.values.length, 36);
  equal(lcd.displayText({ program: 0, name: memory.name }), 'M-11   JunoStrng1');
});

check('a half-known patch is shown as half known', () => {
  // The tone data and the program change are two messages, so the screen really
  // does pass through each of these.
  equal(lcd.displayText({}), '----   ----------');
  equal(lcd.displayText({ program: 87 }), 'P-38   ----------');
  equal(lcd.displayText({ name: 'Moogie' }), '----   Moogie    ');
});

check('the display is always exactly one line of COLUMNS characters', () => {
  const lines = [
    lcd.displayText({}),
    lcd.displayText({ program: 0, name: 'JunoStrng1' }),
    lcd.displayText({ program: 127, name: 'A' }),
    // A name longer than the synth can send is cut rather than pushing the line
    // wide, since the display it is drawn in has a fixed number of characters.
    lcd.displayText({ program: 5, name: 'far too long to fit' }),
  ];
  for (const line of lines) equal(line.length, lcd.COLUMNS, `"${line}" is the wrong width`);
});

// ------------------------------------------------------- the packed format ---
//
// The bulk-dump form of a tone is the one place in this program where the bytes
// on the wire look nothing like the numbers the rest of it works in, so it is
// checked against real data rather than against itself. GOLDEN_BLD is the first
// message of MSF-HS80patches.syx, an ordinary bank file from the wild; the names
// and values under it were produced by the alphamanager librarian, which is the
// implementation that has been driving a real Alpha Juno-2 with them.

const GOLDEN_BLD = Uint8Array.from(Buffer.from(
  'f04137002320010000050000000c02000000080f0704010c0b0e010d0a00000f070a08000000000f'
  + '0f000b020b060802030d0206080b0a080a000b050a020301000a090c0a0c0200000f0000000c0500'
  + '0000080f070905010c0401020b00000f07060d0a0a00000f0f0609080e0e0b000000020c080e020c'
  + '0a0d0a0e090b0a0e030e070e030e070000020000000c0200000008020504050b0b01040c0b0e0204'
  + '06020900000f070f0f0e0e060d0a0d020304060b080802070a000a0f0006090c0409020a050d0500'
  + '00060000000c02020100080b060005010d0401020b05000f0f00030f0800000f0f0e09040e04090a'
  + '040c0303080a010b0a04020d00060a0e0e0c0a0d0e02030000f7', 'hex'));

// Slot 11 of that file, in APR units -- which is what Tone.params holds.
const GROWLYBASS = [0, 2, 2, 3, 3, 2, 3, 3, 2, 0, 1, 0, 0, 0, 127, 20, 60, 30, 0, 45,
                    40, 0, 127, 0, 10, 0, 0, 127, 48, 50, 6, 50, 45, 16, 40, 12];

check('a bulk message decodes to the tones the librarian reads out of it', () => {
  const parsed = bank.parseBulk(GOLDEN_BLD);
  assert(parsed !== null, 'not recognised as a bulk message');
  equal(parsed.level, bank.LEVEL_TONE);
  equal(parsed.firstTone, 0);
  equal(parsed.channel, 1);
  equal(parsed.tones.length, 4);
  equal(parsed.tones.map((tone) => tone.displayName),
        ['GrowlyBass', 'Muster', 'LongPWMpad', 'DarkNmusty']);
  equal(parsed.tones[0].params, GROWLYBASS);
});

check('a decoded tone re-encodes to the bytes it came from', () => {
  const parsed = bank.parseBulk(GOLDEN_BLD);
  const rebuilt = bank.buildBulk(parsed.tones, 0, 1);
  equal([...rebuilt], [...GOLDEN_BLD], 'the message did not survive the round trip');
});

check('the four-bit parameters are widened to APR units and narrowed back', () => {
  // VCF Key Follow is stored in four bits in bulk and as 0-127 over APR, so 5 in
  // the file has to read as 40 here -- and go back as 5. Getting this wrong is
  // silent: the patch simply sounds different after a round trip.
  const tone = bank.parseBulk(GOLDEN_BLD).tones[0];
  equal(tone.params[20], 40, 'VCF Key Follow was not widened');
  equal(tone.toPacked()[0] & 0x0F, 5, 'VCF Key Follow was not narrowed back');
  for (const index of bank.SCALED_PARAMS) {
    equal((tone.params[index] >> bank.APR_SCALE) << bank.APR_SCALE, tone.params[index],
          `parameter ${index} is not a multiple of ${1 << bank.APR_SCALE}`);
  }
});

check('bender range is four bits in both worlds and is never scaled', () => {
  // The trap: it is stored in four bits like the five above, but its APR range is
  // a documented 0-12, so scaling it would send 16 for a field that stops at 12.
  const tone = bank.parseBulk(GOLDEN_BLD).tones[0];
  equal(tone.params[35], 12, 'bender range came back wrong');
  equal(tone.toPacked()[2] & 0x0F, 12);
  assert(!bank.SCALED_PARAMS.has(35), 'bender range must not be in SCALED_PARAMS');
});

check('every parameter survives a round trip through the packed form', () => {
  // Sweep each parameter to its own maximum in turn, since the packed layout
  // gives them wildly different widths and a shared value would not exercise it.
  for (let index = 0; index < bank.PARAM_COUNT; index += 1) {
    const params = new Array(bank.PARAM_COUNT).fill(0);
    params[index] = aj.PARAMETERS[index].maxValue;
    const tone = new bank.Tone('Test-Tone1', params);
    const back = bank.Tone.fromPacked(tone.toPacked());
    // The scaled parameters keep four bits of resolution, which is what the
    // format has; everything else must come back exactly.
    const want = bank.SCALED_PARAMS.has(index)
      ? (params[index] >> bank.APR_SCALE) << bank.APR_SCALE
      : params[index];
    equal(back.params[index], want, `parameter ${index} (${aj.PARAMETERS[index].name})`);
    equal(back.name, 'Test-Tone1', `the name did not survive alongside parameter ${index}`);
  }
});

check('a name is held to the ten characters the synth can store', () => {
  equal(bank.sanitizeName('Fat Bass'), 'Fat Bass  ');
  equal(bank.sanitizeName('far too long to fit'), 'far too lo');
  // Anything unrepresentable becomes a space rather than an error: a librarian
  // should not refuse to keep a patch over one bad character.
  equal(bank.sanitizeName('Bass!!'), 'Bass      ');
  equal(bank.decodeName(bank.encodeName('Zz09 -')), 'Zz09 -    ');
});

check('slots are numbered the way the front panel is', () => {
  equal(bank.slotLabel(0), '11');
  equal(bank.slotLabel(7), '18');
  equal(bank.slotLabel(8), '21');
  equal(bank.slotLabel(63), '88');
  equal(bank.slotIndex('11'), 0);
  equal(bank.slotIndex('88'), 63);
  // There is no bank 0 and no bank 9; the digits never leave 1-8.
  throwsWith(() => bank.slotIndex('09'), 'slot must be 11-88');
  throwsWith(() => bank.slotIndex('91'), 'slot must be 11-88');
  throwsWith(() => bank.slotLabel(64), 'slot index out of range');
});

check('a bank round-trips through .syx unchanged', () => {
  const one = bank.Bank.fromSysex(GOLDEN_BLD);
  equal(one.count(), 4, 'a four-tone file should list four patches, not 64');
  const full = one.toSysex(1);
  equal(full.length, 16 * 266, 'a bank is always written as all sixteen messages');
  const two = bank.Bank.fromSysex(full);
  equal(two.tones.map((t) => t.name), one.tones.map((t) => t.name));
  equal(two.tones.map((t) => t.params), one.tones.map((t) => t.params));
});

check('stray bytes between messages do not stop a file loading', () => {
  // Files in the wild carry padding between messages, and skipping it is what
  // lets those banks load at all.
  const padded = Uint8Array.from([0x00, 0xF8, ...GOLDEN_BLD, 0x00, 0x00, ...GOLDEN_BLD]);
  equal(bank.splitMessages(padded).length, 2);
  equal(bank.Bank.fromSysex(padded).get(0).displayName, 'GrowlyBass');
});

check('a file with no Alpha Juno tone data is refused, not half read', () => {
  throwsWith(() => bank.Bank.fromSysex(Uint8Array.from([0xF0, 0x43, 0x00, 0xF7])),
             'no Alpha Juno tone bulk data');
});

check('an untouched slot is empty, and a named one is still empty', () => {
  const tone = new bank.Tone();
  assert(tone.isEmpty, 'a fresh tone should be empty');
  tone.name = bank.sanitizeName('Nothing');
  assert(tone.isEmpty, 'naming a slot does not give it a sound');
  tone.params[22] = 100;                       // VCA Level
  assert(!tone.isEmpty, 'a slot with a level in it is not empty');
});

check('moving a patch slides the others along and says where it landed', () => {
  const set = new bank.Bank();
  set.tones.forEach((tone, i) => { tone.name = bank.sanitizeName(`P${i}`); });
  equal(set.move(0, 3), undefined);
  equal(set.tones.slice(0, 4).map((t) => t.displayName), ['P1', 'P2', 'P3', 'P0']);

  const group = new bank.Bank();
  group.tones.forEach((tone, i) => { tone.name = bank.sanitizeName(`P${i}`); });
  // The group starts on the slot it was dropped on, whichever direction it came
  // from -- the same rule move() follows for one, and the same rule a drop from
  // the other pane follows.
  equal(group.moveMany([0, 1], 5), 5);
  equal(group.tones.slice(0, 8).map((t) => t.displayName),
        ['P2', 'P3', 'P4', 'P5', 'P6', 'P0', 'P1', 'P7']);
  equal(group.moveMany([5, 6], 2), 2, 'and the same going back up');
  equal(group.tones.slice(0, 8).map((t) => t.displayName),
        ['P2', 'P3', 'P0', 'P1', 'P4', 'P5', 'P6', 'P7']);
  equal(group.tones.length, bank.TONE_COUNT, 'a bank always has 64 slots');
});

// ----------------------------------------------------------- bulk transfer ---

function goldenBank() {
  const set = bank.Bank.fromSysex(GOLDEN_BLD);
  for (let i = 0; i < bank.TONE_COUNT; i += 1) {
    if (set.get(i).isEmpty) set.set(i, new bank.Tone(`Slot${i}`, GROWLYBASS));
  }
  return set;
}

await checkAsync('a dump of sixteen messages is collected into a bank', async () => {
  const set = goldenBank();
  const seen = [];
  const done = new Promise((resolve, reject) => {
    const receiver = new bulk.BulkReceiver({
      onProgress: (p) => seen.push(p.messages),
      onDone: resolve,
      onFail: (why) => reject(new Error(why)),
      // Short, so the test does not sit through the real two-second idle wait.
      idleTimeoutMs: 30,
    });
    receiver.start();
    for (const message of set.toMessages(1)) receiver.feed(message);
  });
  const received = await done;
  equal(received.tones.map((t) => t.name), set.tones.map((t) => t.name));
  equal(seen[seen.length - 1], 16, 'progress should end at sixteen messages');
});

await checkAsync('a dump that never starts fails saying so', async () => {
  const why = await new Promise((resolve) => {
    new bulk.BulkReceiver({ onFail: resolve, startTimeoutMs: 20 }).start();
  });
  assert(/nothing arrived/.test(why), `unhelpful message: ${why}`);
});

await checkAsync('a dump that stops half way says how far it got', async () => {
  const set = goldenBank();
  const why = await new Promise((resolve) => {
    const receiver = new bulk.BulkReceiver({ onFail: resolve, idleTimeoutMs: 20 });
    receiver.start();
    for (const message of set.toMessages(1).slice(0, 5)) receiver.feed(message);
  });
  assert(/5 of 16/.test(why), `unhelpful message: ${why}`);
});

check('anything that is not a bulk block is ignored by a listening receiver', () => {
  const receiver = new bulk.BulkReceiver({ startTimeoutMs: 10000 });
  receiver.start();
  // An APR message: legal, from the same synth, and not part of a dump.
  equal(receiver.feed(Uint8Array.from([0xF0, 0x41, 0x35, 0x00, 0x23, 0x20, 0x01, 0xF7])),
        false);
  equal(receiver.toneMessages, 0);
  receiver.stop();
});

await checkAsync('a bank is sent as sixteen messages, in order', async () => {
  const set = goldenBank();
  const sent = [];
  await new Promise((resolve, reject) => {
    const sender = new bulk.BulkSender({
      gapMs: bulk.MIN_GAP_MS,
      send: (bytes) => sent.push(bytes),
      onDone: resolve,
      onFail: (why) => reject(new Error(why)),
    });
    sender.start(set, 1);
  });
  equal(sent.length, 16);
  equal(sent.map((m) => m[8]), [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60],
        'the messages should address slots 0, 4, 8 ... 60');
  const rebuilt = bank.Bank.fromSysex(Uint8Array.from(sent.flatMap((m) => [...m])));
  equal(rebuilt.tones.map((t) => t.name), set.tones.map((t) => t.name));
});

await checkAsync('cancelling a send says the synth has been left half written', async () => {
  const set = goldenBank();
  const why = await new Promise((resolve) => {
    const sender = new bulk.BulkSender({
      gapMs: bulk.MIN_GAP_MS,
      send: () => {},
      onFail: resolve,
      onProgress: (p) => { if (p.messages === 3) sender.cancel(); },
    });
    sender.start(set, 1);
  });
  assert(/half-written/.test(why), `unhelpful message: ${why}`);
});

// --------------------------------------------------- MIDI files with sysex ---
//
// A bank saved as a .mid is the same dump wrapped in a container: delta times, a
// length before every sysex, and channel events that may leave their status byte
// out entirely. GOLDEN_MID below was written by mido -- an independent
// implementation of the format -- and holds the first BLD message of
// MSF-HS80patches.syx alongside notes that do use running status, which is the
// case that cannot be got right by scanning for F0.

const GOLDEN_MID = Uint8Array.from(Buffer.from(
  '4d546864000000060001000201e04d54726b0000001500ff03036f6e6500903c40303c00'
  + '00c00300ff2f004d54726b0000011100f082094137002320010000050000000c02000000'
  + '080f0704010c0b0e010d0a00000f070a08000000000f0f000b020b060802030d0206080b'
  + '0a080a000b050a020301000a090c0a0c0200000f0000000c05000000080f070905010c04'
  + '01020b00000f07060d0a0a00000f0f0609080e0e0b000000020c080e020c0a0d0a0e090b'
  + '0a0e030e070e030e070000020000000c0200000008020504050b0b01040c0b0e02040602'
  + '0900000f070f0f0e0e060d0a0d020304060b080802070a000a0f0006090c0409020a050d'
  + '050000060000000c02020100080b060005010d0401020b05000f0f00030f0800000f0f0e'
  + '09040e04090a040c0303080a010b0a04020d00060a0e0e0c0a0d0e02030000f700ff2f00', 'hex'));

// A small MIDI-file writer, so the awkward cases can be built rather than found.
function vlq(value) {
  const out = [value & 0x7F];
  let rest = value >>> 7;
  while (rest) { out.unshift((rest & 0x7F) | 0x80); rest >>>= 7; }
  return out;
}
function chunk(id, body) {
  const length = body.length;
  return [...id].map((c) => c.charCodeAt(0))
    .concat([(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255],
            body);
}
function smfFile(tracks, { format = 1, division = 480, extra = [] } = {}) {
  const header = chunk('MThd', [(format >> 8) & 255, format & 255,
                                (tracks.length >> 8) & 255, tracks.length & 255,
                                (division >> 8) & 255, division & 255]);
  return Uint8Array.from(header.concat(...extra, ...tracks.map((t) => chunk('MTrk', t))));
}
const END_OF_TRACK = [0x00, 0xFF, 0x2F, 0x00];
// An F0 event carries the bytes that follow F0; the F0 itself is the event type.
const sysexEvent = (bytes) => [0x00, 0xF0, ...vlq(bytes.length - 1), ...bytes.slice(1)];
// An F7 "escape" event carries its bytes verbatim.
const escapeEvent = (bytes) => [0x00, 0xF7, ...vlq(bytes.length), ...bytes];

check('a MIDI file is told apart from a raw dump by what is in it', () => {
  assert(smf.isSmf(GOLDEN_MID), 'the MThd header was not recognised');
  assert(!smf.isSmf(GOLDEN_BLD), 'a raw .syx must not be read as a MIDI file');
  assert(!smf.isSmf(Uint8Array.from([1, 2, 3])), 'three bytes are not a MIDI file');
});

check('sysex is unwrapped from a MIDI file written by something else', () => {
  const { messages, format, tracks } = smf.sysexFromSmf(GOLDEN_MID);
  equal(format, 1);
  equal(tracks, 2);
  equal(messages.length, 1, 'one sysex message should have come out');
  // Byte for byte the message that went in, F0 and F7 included -- the container
  // stores neither the same way it stores the rest.
  equal([...messages[0]], [...GOLDEN_BLD]);
});

check('a bank reads out of a MIDI file exactly as it does out of a .syx', () => {
  const { blob, count } = smf.sysexBlobFromSmf(GOLDEN_MID);
  equal(count, 1);
  const fromMid = bank.Bank.fromSysex(blob);
  const fromSyx = bank.Bank.fromSysex(GOLDEN_BLD);
  equal(fromMid.tones.map((t) => t.name), fromSyx.tones.map((t) => t.name));
  equal(fromMid.tones.map((t) => t.params), fromSyx.tones.map((t) => t.params));
});

check('running status is stepped over rather than scanned past', () => {
  // The trap this exists for: 0xF0 as a *data* byte of a running-status note.
  // A reader that looked for F0 would start a message here and swallow the
  // sysex that follows. Note numbers only go to 127, so the byte is put where
  // a value legitimately can be -- pitch bend, whose LSB may be anything.
  const track = [
    0x00, 0xE0, 0x70, 0x40,        // pitch bend, status present
    0x00, 0x70, 0x40,              //   ... and again, running
    0x00, 0x0F, 0x40,              //   ... a low data byte
    ...sysexEvent([...GOLDEN_BLD]),
    ...END_OF_TRACK,
  ];
  const { messages } = smf.sysexFromSmf(smfFile([track], { format: 0 }));
  equal(messages.length, 1);
  equal([...messages[0]], [...GOLDEN_BLD]);
});

check('a sysex split across several events is put back together', () => {
  // 266 bytes is more than some writers put in one event, so a dump arrives as
  // an F0 packet that does not end in F7 followed by F7 continuation packets.
  const whole = [...GOLDEN_BLD];
  const head = whole.slice(0, 100);
  const middle = whole.slice(100, 200);
  const tail = whole.slice(200);
  const track = [
    0x00, 0xF0, ...vlq(head.length - 1), ...head.slice(1),
    0x00, 0xF7, ...vlq(middle.length), ...middle,
    0x00, 0xF7, ...vlq(tail.length), ...tail,
    ...END_OF_TRACK,
  ];
  const { messages } = smf.sysexFromSmf(smfFile([track]));
  equal(messages.length, 1, 'the three packets should have made one message');
  equal([...messages[0]], whole);
});

check('a whole message inside an escape event is taken as well', () => {
  const track = [...escapeEvent([...GOLDEN_BLD]), ...END_OF_TRACK];
  const { messages } = smf.sysexFromSmf(smfFile([track]));
  equal(messages.length, 1);
  equal([...messages[0]], [...GOLDEN_BLD]);
});

check('a sysex that was cut off is dropped, not handed on half read', () => {
  // A tone built from a truncated message would be a patch with rubbish in it,
  // which is worse than one patch fewer and much harder to notice.
  const cut = [...GOLDEN_BLD].slice(0, 120);
  const track = [0x00, 0xF0, ...vlq(cut.length - 1), ...cut.slice(1), ...END_OF_TRACK];
  const { messages } = smf.sysexFromSmf(smfFile([track]));
  equal(messages.length, 0);
});

check('several tracks are read, and unknown chunks are skipped by their length', () => {
  const a = [...sysexEvent([...GOLDEN_BLD]), ...END_OF_TRACK];
  const b = [...sysexEvent([...GOLDEN_BLD]), ...END_OF_TRACK];
  // A chunk of a type nobody knows, carrying bytes that look like a sysex. The
  // format says to skip it by its length, and a reader that does not will find
  // patches that are not in the file.
  const junk = chunk('XFIH', [...GOLDEN_BLD]);
  const file = smfFile([a, b], { extra: [junk] });
  const { messages } = smf.sysexFromSmf(file);
  equal(messages.length, 2, 'the unknown chunk should have been stepped over');
});

check('a MIDI file with no sysex in it reports nothing, rather than failing', () => {
  const track = [0x00, 0x90, 0x3C, 0x40, 0x30, 0x3C, 0x00, ...END_OF_TRACK];
  const { messages, tracks } = smf.sysexFromSmf(smfFile([track], { format: 0 }));
  equal(messages.length, 0);
  equal(tracks, 1);
  // Which is a different problem from a file that is not a MIDI file at all, and
  // the librarian says so differently.
  throwsWith(() => smf.sysexFromSmf(Uint8Array.from([0x46, 0x4F, 0x52, 0x4D, 0, 0, 0, 0,
                                                     0, 0, 0, 0, 0, 0])),
             'does not start with a MIDI file header');
});

check('a MIDI file inside a RIFF wrapper is unwrapped first', () => {
  const inner = smfFile([[...sysexEvent([...GOLDEN_BLD]), ...END_OF_TRACK]]);
  const size = inner.length;
  const riff = Uint8Array.from([
    ...[...'RIFF'].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0,                                        // the RIFF size, unread
    ...[...'RMID'].map((c) => c.charCodeAt(0)),
    ...[...'data'].map((c) => c.charCodeAt(0)),
    size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255,
    ...inner,
  ]);
  assert(smf.isSmf(riff), 'an RMID file was not recognised');
  equal(smf.sysexFromSmf(riff).messages.length, 1);
});

// ------------------------------------------------------------------- done ---

console.log(`\n${passed}/${passed + failed} passed`
            + (skipped ? `, ${skipped} skipped` : ''));
process.exit(failed ? 1 : 0);
