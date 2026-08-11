// cc2juno for the browser: the UI, and the wiring between it and the router.
//
// Two modes share one knob grid. In Configure the knobs are a plan of the
// controller and clicking one edits it; in Perform the same grid is a live
// display and the mapping is actually running. Everything is kept in one config
// object of the same shape config.py builds, so exporting is a matter of
// rendering it and importing is a matter of parsing it.

import * as aj from './alpha_juno.js';
import * as cfgmod from './config.js';
import { MidiPorts, decode, describe } from './midi.js';
import { Router } from './router.js';
import { Knob } from './knob.js';
import { MoveDetector, LEARN_MOVE_THRESHOLD } from './learn.js';

const STORE_KEY = 'cc2juno.web.config';
const GRANTED_KEY = 'cc2juno.web.midi-granted';
const LOG_LIMIT = 400;

const $ = (id) => document.getElementById(id);

const state = {
  cfg: cfgmod.makeConfig(),
  mode: 'config',
  editLayer: 0,           // the layer being edited, which Perform ignores
  selected: null,         // index into layout.ccs, or null
  learning: null,         // index of the cell being learned, or null
  verbose: false,
  inputName: null,        // remembered separately from the config's port names,
  outputName: null,       // since the browser may not have the port yet
};

const ports = new MidiPorts();
const detector = new MoveDetector(LEARN_MOVE_THRESHOLD);
const router = new Router(state.cfg, {
  send: (bytes) => ports.send(bytes),
  log: (entry) => logEntry(entry),
  onKnob: (event) => onKnobActivity(event),
  onSent: () => { if (state.mode === 'perform') refreshKnobs(); },
  onLayer: () => { refresh(); },
});

let knobs = [];
const seenUnmapped = new Set();   // `${layer}:${cc}`, so each is reported once
const seenInactive = new Set();

// ------------------------------------------------------------- utilities ---

function activeLayerIndex() {
  return state.mode === 'perform' ? router.layer : state.editLayer;
}

function activeLayer() {
  return state.cfg.layers[activeLayerIndex()];
}

function cellOf(cc) {
  return state.cfg.layout.ccs.indexOf(cc);
}

function isLayerCc(cc) {
  return cfgmod.isLayered(state.cfg) && cc === state.cfg.layerCc;
}

/**
 * What the knob at `cc` should say.
 *
 * The number is only ever a value that was actually sent. It is tempting to work
 * one out from where the pot is sitting, and that is exactly wrong: after a layer
 * change every knob is physically pointing at a value that belonged to the
 * previous layer, and none of them mean anything until they are next moved. A
 * knob that showed a computed value there would be claiming the synth had been
 * told something it never was -- which reads as the previous layer's knob having
 * quietly changed this layer's parameter.
 *
 * `stale` is that state: the dial shows where the pot is, dimmed, and the value
 * is whatever the parameter was last actually set to, or nothing if it never was.
 */
function readingFor(cc, mapping) {
  const position = router.ccPositions.get(cc);
  const fraction = position === undefined ? 0 : position / 127;
  if (!mapping) return { text: '', fraction, stale: false };

  const param = cfgmod.paramFor(mapping);
  const live = router.sentOnLayer.has(cc);
  const sent = router.lastValue.get(param.index);
  const value = sent === undefined ? null : sent;

  return {
    text: value === null ? '' : String(value),
    option: value !== null && param.options.length ? param.options[value] : '',
    fraction,
    stale: !live,
  };
}

function banner(kind, text, { sticky = false } = {}) {
  const node = document.createElement('div');
  node.className = `banner banner-${kind}`;
  node.append(document.createTextNode(text));

  const close = document.createElement('button');
  close.className = 'quiet small';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => node.remove());
  node.append(close);

  $('banners').append(node);
  if (!sticky) setTimeout(() => node.remove(), 9000);
  return node;
}

function clearBanners() {
  $('banners').replaceChildren();
}

// ----------------------------------------------------------- persistence ---

let saveTimer = null;
function save() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        config: cfgmod.toJSON(state.cfg),
        inputName: state.inputName,
        outputName: state.outputName,
        mode: state.mode,
        editLayer: state.editLayer,
      }));
    } catch (exc) {
      // A full or blocked localStorage is not worth losing the session over.
      console.warn('could not save the configuration', exc);
    }
  }, 250);
}

function restore() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch (exc) {
    return false;
  }
  if (!stored || !stored.config) return false;
  try {
    state.cfg = cfgmod.fromJSON(stored.config);
    state.inputName = stored.inputName || null;
    state.outputName = stored.outputName || null;
    state.editLayer = Math.min(stored.editLayer || 0, state.cfg.layers.length - 1);
    state.mode = stored.mode === 'perform' ? 'perform' : 'config';
    router.setConfig(state.cfg);
    return true;
  } catch (exc) {
    console.warn('stored configuration could not be read; starting fresh', exc);
    return false;
  }
}

/** Push the config at the router and redraw everything that depends on it. */
function applyConfig({ keepSelection = true } = {}) {
  if (!keepSelection) state.selected = null;
  if (state.editLayer >= state.cfg.layers.length) state.editLayer = state.cfg.layers.length - 1;
  router.setConfig(state.cfg);
  seenUnmapped.clear();
  seenInactive.clear();
  save();
  refresh();
}

// ------------------------------------------------------------------ MIDI ---

async function enableMidi() {
  try {
    await ports.open();
    localStorage.setItem(GRANTED_KEY, '1');
    ports.onPortsChanged = () => { fillPortMenus(); refresh(); };
    ports.onMessage = (data) => onMidiMessage(data);
    $('midi-enable').hidden = true;
    fillPortMenus();
    autoSelectPorts();
    refresh();
  } catch (exc) {
    setStatus('bad', 'no access');
    banner('error', `Web MIDI is not available: ${exc.message}`, { sticky: true });
  }
}

function setStatus(kind, text) {
  const node = $('midi-status');
  node.className = `status status-${kind}`;
  node.textContent = text;
}

function fillPortMenus() {
  for (const [id, list, chosen] of [
    ['midi-in', ports.inputs(), ports.input],
    ['midi-out', ports.outputs(), ports.output],
  ]) {
    const select = $(id);
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = list.length ? '— choose —' : 'no ports';
    select.append(none);
    for (const port of list) {
      const option = document.createElement('option');
      option.value = port.id;
      option.textContent = port.name;
      select.append(option);
    }
    select.value = chosen ? chosen.id : '';
  }
}

/**
 * Pick up where we left off: the port chosen last time, or the one the config
 * names. Both are matched by name the way the CLI matches them, since a Web MIDI
 * id is not stable and the config is shared with builds that never saw one.
 */
function autoSelectPorts() {
  const wantIn = state.inputName || state.cfg.portInput;
  const wantOut = state.outputName || state.cfg.portOutput;
  const input = ports.find(ports.inputs(), wantIn);
  const output = ports.find(ports.outputs(), wantOut);
  if (input) chooseInput(input);
  if (output) chooseOutput(output);
  if (wantIn && !input) banner('warn', `MIDI input "${wantIn}" is not connected.`);
  if (wantOut && !output) banner('warn', `MIDI output "${wantOut}" is not connected.`);
  fillPortMenus();
}

function chooseInput(port) {
  ports.setInput(port);
  state.inputName = port ? port.name : null;
  state.cfg.portInput = state.inputName;
  save();
  updateStatus();
}

function chooseOutput(port) {
  ports.setOutput(port);
  state.outputName = port ? port.name : null;
  state.cfg.portOutput = state.outputName;
  save();
  updateStatus();
}

function updateStatus() {
  if (!ports.access) {
    setStatus('off', 'no access');
    return;
  }
  if (!ports.input && !ports.output) {
    setStatus('off', 'no ports chosen');
  } else if (!ports.output) {
    setStatus('bad', 'no output');
  } else if (!ports.input) {
    setStatus('bad', 'no input');
  } else if (state.mode === 'perform') {
    setStatus('on', 'running');
  } else {
    setStatus('on', 'ready');
  }
}

function onMidiMessage(data) {
  const message = decode(data);

  if (state.learning !== null) {
    if (message.type !== 'cc') return;
    const listen = state.cfg.listenChannel;
    if (listen !== null && message.channel !== listen) return;
    router.ccPositions.set(message.cc, message.value);
    if (detector.feed(message.cc, message.value)) finishLearn(message.cc);
    return;
  }

  if (state.mode === 'perform') {
    router.handle(data);
    return;
  }

  // Configure mode watches the controller without translating anything: the
  // knobs light up as they are moved, which is how you tell which cell is which,
  // but nothing is sent to the synth while the mapping is still being edited.
  if (message.type === 'cc') {
    router.ccPositions.set(message.cc, message.value);
    onKnobActivity({ cc: message.cc, ccValue: message.value, kind: 'watch' });
  }
}

// -------------------------------------------------------------- knob grid ---

function buildGrid() {
  const grid = $('grid');
  const cells = state.cfg.layout.rows * state.cfg.layout.cols;
  grid.style.setProperty('--cols', state.cfg.layout.cols);

  if (knobs.length !== cells) {
    grid.replaceChildren();
    knobs = [];
    for (let i = 0; i < cells; i += 1) {
      const knob = new Knob({
        onSelect: () => selectCell(i),
        onInput: (value) => onLocalKnob(i, value),
      });
      knobs.push(knob);
      grid.append(knob.el);
    }
  }
  $('grid-empty').hidden = cells > 0;
  grid.hidden = cells === 0;
}

function refreshKnobs() {
  const layerIndex = activeLayerIndex();
  const layer = state.cfg.layers[layerIndex];

  state.cfg.layout.ccs.forEach((cc, i) => {
    const knob = knobs[i];
    if (!knob) return;

    if (cc === null) {
      knob.update({
        kind: 'empty',
        name: 'empty',
        detail: state.mode === 'config' ? 'click to add' : '',
        selected: state.selected === i,
        learning: state.learning === i,
        draggable: false,
      });
      return;
    }

    if (isLayerCc(cc)) {
      const position = router.ccPositions.get(cc);
      const param = aj.makeLayerParam(state.cfg.layers.length);
      const [low, high] = aj.regionBounds(param, router.layer);
      knob.update({
        kind: 'layer',
        name: 'Layer select',
        detail: `CC${cc} · ${cfgmod.layerLabel(state.cfg.layers[router.layer])}`,
        reading: String(router.layer + 1),
        fraction: position === undefined ? ((low + high) / 2) / 127 : position / 127,
        selected: state.selected === i,
        learning: state.learning === i,
        draggable: state.mode === 'perform',
      });
      return;
    }

    const mapping = layer.byCc.get(cc);
    const reading = readingFor(cc, mapping);
    if (!mapping) {
      const elsewhere = state.cfg.layers
        .filter((other) => other.byCc.has(cc))
        .map((other) => other.number);
      knob.update({
        kind: 'idle',
        name: 'unassigned',
        detail: elsewhere.length ? `CC${cc} · layer ${elsewhere.join('/')}` : `CC${cc}`,
        reading: '',
        fraction: reading.fraction,
        selected: state.selected === i,
        learning: state.learning === i,
        draggable: false,
      });
      return;
    }

    const param = cfgmod.paramFor(mapping);
    const detail = [`CC${cc}`];
    if (reading.option) detail.push(reading.option);
    else if (mapping.mode === 'clamp') detail.push('clamp');
    // Only in Perform is there a live value to be stale about; in Configure the
    // grid is a plan of the controller, not a picture of the synth.
    const stale = state.mode === 'perform' && reading.stale;
    knob.update({
      kind: 'assigned',
      name: param.name,
      // Any value shown is one the synth was genuinely sent. When the knob has
      // not taken effect on this layer the value is whatever the parameter was
      // last set to -- which the pot is no longer pointing at, hence the mark.
      detail: detail.join(' · '),
      reading: reading.text,
      fraction: reading.fraction,
      stale,
      title: stale
        ? `${param.name} has not taken effect on this layer yet — move the knob and `
          + 'it will jump to wherever it is sitting'
        : '',
      selected: state.selected === i,
      learning: state.learning === i,
      draggable: state.mode === 'perform',
    });
  });
}

function onKnobActivity({ cc }) {
  const cell = cellOf(cc);
  if (cell !== -1 && knobs[cell]) knobs[cell].flash();
  // Only the numbers move, so the whole grid does not need rebuilding; but the
  // layer knob changes what every other knob says, and the summary names the
  // layer, so that one case redraws properly.
  if (isLayerCc(cc)) refresh();
  else refreshKnobs();
}

/** A knob dragged on screen behaves exactly like the same CC arriving. */
function onLocalKnob(cell, value) {
  const cc = state.cfg.layout.ccs[cell];
  if (cc === null || state.mode !== 'perform') return;
  router.handleLocalCc(cc, value);
}

// ------------------------------------------------------------------ layers ---

function renderLayerBar() {
  const bar = $('layer-bar');
  bar.replaceChildren();

  if (state.cfg.layers.length === 1) {
    const only = document.createElement('span');
    only.className = 'stage-note';
    only.textContent = state.mode === 'perform'
      ? 'One layer'
      : 'One layer — add more in the Layers panel';
    bar.append(only);
    return;
  }

  const active = activeLayerIndex();
  state.cfg.layers.forEach((layer, index) => {
    const chip = document.createElement('button');
    chip.className = 'layer-chip' + (index === active ? ' is-active' : '');
    if (state.mode === 'config') chip.classList.add('is-editing');

    const number = document.createElement('span');
    number.className = 'n';
    number.textContent = layer.number;
    chip.append(number, document.createTextNode(layer.name || 'unnamed'));

    const count = layer.byCc.size;
    chip.title = `${count} knob${count === 1 ? '' : 's'} mapped on this layer`;
    chip.addEventListener('click', () => {
      if (state.mode === 'perform') router.setLayer(index);
      else { state.editLayer = index; save(); refresh(); }
    });
    bar.append(chip);
  });
}

function renderStageNote() {
  const note = $('stage-note');
  note.replaceChildren();
  if (state.mode === 'perform') {
    if (!cfgmod.isLayered(state.cfg)) return;
    // Until the layer knob is touched its real position is unknowable, so say
    // out loud which layer is only being assumed. Being wrong about that is the
    // one way to turn a knob and get a parameter you were not expecting.
    if (!router.ccPositions.has(state.cfg.layerCc)) {
      const layer = state.cfg.layers[router.layer];
      note.innerHTML = `Assuming <b>layer ${cfgmod.layerLabel(layer)}</b> — `
                     + 'move the layer knob to be sure';
      return;
    }
    note.textContent = 'Switching layers sends nothing; each knob takes effect on '
                     + 'its next move.';
    return;
  }
  const mapped = state.cfg.layers[state.editLayer].byCc.size;
  note.innerHTML = `Editing <b>layer ${state.editLayer + 1}</b> — `
                 + `${mapped} of 36 parameters assigned`;
}

// -------------------------------------------------------------- inspector ---

function selectCell(index) {
  if (state.mode !== 'config') return;
  state.selected = state.selected === index ? null : index;
  if (state.learning !== null && state.learning !== index) stopLearn();
  refresh();
}

function renderInspector() {
  const panel = $('panel-inspector');
  if (state.mode !== 'config' || state.selected === null) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const index = state.selected;
  const { cols } = state.cfg.layout;
  const cc = state.cfg.layout.ccs[index];
  const row = Math.floor(index / cols) + 1;
  const col = (index % cols) + 1;

  $('inspector-title').textContent =
    `Knob at row ${row}, column ${col}` + (cc === null ? ' — empty' : ` — CC${cc}`);

  $('knob-cc').value = cc === null ? '' : cc;
  $('knob-learn').classList.toggle('is-armed', state.learning === index);
  $('knob-learn').textContent = state.learning === index ? 'Listening…' : 'Learn';
  $('knob-learn-hint').textContent = state.learning === index
    ? 'Move the control now. It must travel 6 counts, so brushing past a '
      + 'neighbour will not grab it.'
    : 'Press Learn, then move the control. It must travel 6 counts, so brushing '
      + 'past a neighbour will not grab it.';

  const layerKnob = cc !== null && isLayerCc(cc);
  $('knob-is-layer').checked = layerKnob;
  $('knob-is-layer').disabled = cc === null;
  $('knob-function-field').hidden = layerKnob;
  $('knob-mode-field').hidden = layerKnob;

  const mapping = cc === null ? null : activeLayer().byCc.get(cc);
  const select = $('knob-param');
  fillParamMenu(cc);
  select.disabled = cc === null;
  select.value = mapping ? String(mapping.paramIndex) : '';
  $('knob-mode').value = mapping ? mapping.mode : 'scale';
  $('knob-mode').disabled = !mapping;

  const range = $('knob-range');
  if (layerKnob) {
    range.textContent = '';
  } else if (mapping) {
    const param = cfgmod.paramFor(mapping);
    const { elsewhere } = paramUsage(param.index);
    range.textContent = `${aj.describeRange(param)}`
      + (param.note ? ` — ${param.note}` : '')
      + (elsewhere.length
        ? `. Also on layer ${elsewhere.join(', ')}, which is fine — the same `
          + 'parameter can be reached from more than one layer.'
        : '');
  } else {
    range.textContent = cc === null
      ? 'Learn a CC first, or type one in.'
      : `This knob does nothing on layer ${state.editLayer + 1}.`;
  }

  $('knob-clear').disabled = !mapping;
  $('knob-remove').disabled = cc === null;
}

const paramUsage = (paramIndex) => cfgmod.paramUsage(state.cfg, paramIndex, state.editLayer);

/**
 * Rebuild the function menu, marking what is already in use.
 *
 * Rebuilt on every render rather than once, because the annotations go stale the
 * moment anything is assigned anywhere.
 */
function fillParamMenu(currentCc) {
  const select = $('knob-param');
  const previous = select.value;
  select.replaceChildren();

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— nothing on this layer —';
  select.append(none);

  for (const param of aj.PARAMETERS) {
    const { here, elsewhere } = paramUsage(param.index);
    const takenHere = here !== null && here !== currentCc;
    const notes = [];
    // This knob's own function is not "taken": it is what the menu is showing.
    if (takenHere) notes.push(`on CC${here} here`);
    if (elsewhere.length) notes.push(`layer ${elsewhere.join(', ')}`);

    const option = document.createElement('option');
    option.value = String(param.index);
    option.textContent = `${notes.length ? '•' : ' '} `
      + `${String(param.index).padStart(2, '0')}  ${param.name}`
      + (notes.length ? `  — ${notes.join(', ')}` : '');
    // Taking it from a knob on this layer costs that knob its assignment, which
    // is a different thing from the same parameter appearing on another layer.
    if (takenHere) option.style.color = 'var(--accent)';
    select.append(option);
  }
  select.value = previous;
}

// ---------------------------------------------------------------- learning ---

function startLearn(index) {
  if (!ports.input) {
    banner('warn', 'Choose a MIDI input first, or type the CC number in by hand.');
    return;
  }
  state.learning = index;
  detector.reset();
  refresh();
}

function stopLearn() {
  state.learning = null;
  detector.reset();
}

function finishLearn(cc) {
  const cell = state.learning;
  stopLearn();
  assignCc(cell, cc);
  refresh();
}

/**
 * Put CC `cc` in cell `cell`, moving it if it was somewhere else on the grid.
 *
 * A knob is a physical object: learning the same control into a second cell
 * means the first cell was wrong, so it is vacated rather than leaving the same
 * CC in two places, which the config format forbids anyway.
 */
function assignCc(cell, cc) {
  const previous = state.cfg.layout.ccs[cell];
  const elsewhere = cellOf(cc);
  if (elsewhere !== -1 && elsewhere !== cell) {
    state.cfg.layout.ccs[elsewhere] = null;
    banner('warn', `CC${cc} was already the knob at cell ${elsewhere + 1}; moved it here.`);
  }
  state.cfg.layout.ccs[cell] = cc;

  // Carry any assignments the cell already had over to the new CC number, so
  // correcting a mistyped CC does not mean assigning all the functions again.
  if (previous !== null && previous !== cc) {
    for (const layer of state.cfg.layers) {
      const mapping = layer.byCc.get(previous);
      if (!mapping) continue;
      layer.byCc.delete(previous);
      if (!layer.byCc.has(cc)) layer.byCc.set(cc, { ...mapping, cc });
    }
    if (state.cfg.layerCc === previous) state.cfg.layerCc = cc;
  }
  applyConfig();
}

// ------------------------------------------------------------- assignment ---

function setFunction(cc, paramIndex) {
  const layer = activeLayer();
  if (paramIndex === null) {
    layer.byCc.delete(cc);
    applyConfig();
    return;
  }
  // The same parameter twice on one layer is not a thing the config can express,
  // so assigning it here takes it away from wherever it was, the way learn mode
  // does on the command line. Silently would be unkind: that other knob has just
  // stopped doing anything on this layer.
  for (const [otherCc, mapping] of [...layer.byCc]) {
    if (mapping.paramIndex === paramIndex && otherCc !== cc) {
      layer.byCc.delete(otherCc);
      banner('warn', `${aj.PARAMETERS[paramIndex].name} moved here from CC${otherCc}, `
                     + `which now does nothing on layer ${layer.number}.`);
    }
  }
  const existing = layer.byCc.get(cc);
  layer.byCc.set(cc, { cc, paramIndex, mode: existing ? existing.mode : 'scale' });
  applyConfig();
}

function setLayerKnob(cc, on) {
  if (!on) {
    state.cfg.layerCc = null;
    applyConfig();
    return;
  }
  // The layer knob means the same thing on every layer, so it cannot also be a
  // parameter anywhere.
  let dropped = 0;
  for (const layer of state.cfg.layers) {
    if (layer.byCc.delete(cc)) dropped += 1;
  }
  state.cfg.layerCc = cc;
  if (state.cfg.layers.length === 1) {
    cfgmod.resizeLayers(state.cfg, 2);
    banner('ok', 'Added a second layer — a layer knob with one layer to pick from '
                 + 'would have nothing to do.');
  }
  if (dropped) {
    banner('warn', `CC${cc} was mapped to a parameter on ${dropped} layer(s); `
                   + 'those assignments are gone.');
  }
  applyConfig();
}

function removeKnob(cell) {
  const cc = state.cfg.layout.ccs[cell];
  if (cc === null) return;
  for (const layer of state.cfg.layers) layer.byCc.delete(cc);
  if (state.cfg.layerCc === cc) state.cfg.layerCc = null;
  state.cfg.layout.ccs[cell] = null;
  applyConfig();
}

// ----------------------------------------------------------------- forms ---

function fillStaticMenus() {
  const channel = $('synth-channel');
  for (let n = 1; n <= 16; n += 1) {
    channel.append(new Option(String(n), String(n)));
  }
  const listen = $('listen-channel');
  listen.append(new Option('any channel', 'any'));
  for (let n = 1; n <= 16; n += 1) listen.append(new Option(`channel ${n}`, String(n)));

  const count = $('layer-count');
  for (let n = 1; n <= cfgmod.MAX_LAYERS; n += 1) {
    count.append(new Option(n === 1 ? '1 (no layering)' : String(n), String(n)));
  }
  // The function menu is not filled here: its labels say what is already in use,
  // so it is rebuilt each time the inspector is drawn.
}

function renderForm() {
  const cfg = state.cfg;
  $('grid-rows').value = cfg.layout.rows;
  $('grid-cols').value = cfg.layout.cols;

  $('layer-count').value = String(cfg.layers.length);
  const startup = $('layer-startup');
  startup.replaceChildren();
  cfg.layers.forEach((layer) => {
    startup.append(new Option(cfgmod.layerLabel(layer), String(layer.number)));
  });
  startup.value = String(cfg.startupLayer);
  startup.disabled = cfg.layers.length === 1;
  $('layer-hysteresis').value = cfg.layerHysteresis === null ? '' : cfg.layerHysteresis;

  const names = $('layer-names');
  names.replaceChildren();
  cfg.layers.forEach((layer, index) => {
    const row = document.createElement('div');
    row.className = 'row';
    const number = document.createElement('span');
    number.className = 'n';
    number.textContent = layer.number;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = layer.name;
    input.placeholder = `layer ${layer.number}`;
    input.maxLength = 24;
    input.addEventListener('input', () => {
      // Commas separate the names in the file, so one inside a name would split
      // it in two the next time the config was read back.
      layer.name = input.value.replace(/,/g, ' ').trimStart();
      if (input.value !== layer.name) input.value = layer.name;
      save();
      renderLayerBar();
    });
    row.append(number, input);
    names.append(row);
  });
  names.hidden = cfg.layers.length === 1;

  const note = $('layer-knob-note');
  if (cfg.layers.length === 1) {
    note.textContent = 'With one layer every knob is always live. Add layers to reach '
                     + 'all 36 parameters from a small controller.';
  } else if (!cfgmod.isLayered(cfg)) {
    note.textContent = 'No knob selects the layer yet. Pick a knob and tick "Use this '
                     + 'knob to select the layer", or switch layers with the chips above '
                     + 'the grid. A config with layers but no layer knob cannot be '
                     + 'exported, since the command-line version would reject it.';
  } else {
    const cell = cellOf(cfg.layerCc);
    note.textContent = `CC${cfg.layerCc} selects the layer`
      + (cell === -1 ? '.' : ` (cell ${cell + 1} in the grid).`);
  }

  $('synth-channel').value = String(cfg.synthChannel);
  $('listen-channel').value = cfg.listenChannel === null ? 'any' : String(cfg.listenChannel);
  $('level-byte').value = `0x${cfg.levelByte.toString(16).toUpperCase().padStart(2, '0')}`;
  $('group-byte').value = `0x${cfg.groupByte.toString(16).toUpperCase().padStart(2, '0')}`;
  $('max-rate').value = cfg.maxMsgsPerSec;
  $('hysteresis').value = cfg.hysteresis;
  $('thru').checked = cfg.thru;
}

function renderSummary() {
  const cfg = state.cfg;
  const list = $('perform-summary');
  list.replaceChildren();

  const mapped = cfgmod.allMappedCcs(cfg).size;
  const rows = [
    ['Input', ports.input ? ports.input.name : 'none'],
    ['Output', ports.output ? ports.output.name : 'none'],
    ['Listening', cfg.listenChannel === null ? 'any channel' : `channel ${cfg.listenChannel}`],
    ['Synth channel', String(cfg.synthChannel)],
    ['Knobs', cfgmod.isLayered(cfg)
      ? `${mapped} mapped across ${cfg.layers.length} layers`
      : `${cfg.layers[0].byCc.size} of 36 parameters`],
    ['Rate limit', `${cfg.maxMsgsPerSec} msg/s`],
    ['Thru', cfg.thru ? 'on' : 'off'],
  ];
  if (cfgmod.isLayered(cfg)) {
    const param = aj.makeLayerParam(cfg.layers.length);
    const [low, high] = aj.regionBounds(param, router.layer);
    rows.push(['Layer', `${cfgmod.layerLabel(cfg.layers[router.layer])}  `
                        + `(CC${cfg.layerCc} ${low}-${high})`]);
  }

  for (const [term, description] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = description;
    list.append(dt, dd);
  }
}

// ------------------------------------------------------------------- log ---

function logLine(text, kind) {
  const log = $('log');
  const line = document.createElement('div');
  line.className = `l-${kind}`;
  line.textContent = text;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  log.append(line);
  while (log.childElementCount > LOG_LIMIT) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

const pad = (value, width) => String(value).padEnd(width);

function logEntry(entry) {
  if (state.mode !== 'perform') return;
  const cfg = state.cfg;

  switch (entry.kind) {
    case 'mapped': {
      const param = cfgmod.paramFor(entry.mapping);
      logLine(`CC${pad(entry.cc, 4)}val ${pad(entry.ccValue, 4)}-> sending `
              + `${param.name} = ${aj.label(param, entry.value)}`, 'mapped');
      break;
    }
    case 'unchanged': {
      if (!state.verbose) break;
      const param = cfgmod.paramFor(entry.mapping);
      logLine(`CC${pad(entry.cc, 4)}val ${pad(entry.ccValue, 4)}-> ${param.name} `
              + `= ${aj.label(param, entry.value)} (unchanged)`, 'unchanged');
      break;
    }
    case 'layer': {
      if (!entry.changed) break;
      const layer = cfg.layers[entry.layer];
      logLine(`CC${pad(entry.cc, 4)}val ${pad(entry.ccValue, 4)}-> layer `
              + `${cfgmod.layerLabel(layer)}, ${layer.byCc.size} knob(s) mapped`, 'layer');
      break;
    }
    case 'inactive': {
      const key = `${router.layer}:${entry.cc}`;
      if (seenInactive.has(key)) break;
      seenInactive.add(key);
      const others = cfg.layers.filter((l) => l.byCc.has(entry.cc))
                               .map((l) => l.number).join('/');
      logLine(`CC${pad(entry.cc, 4)}val ${pad(entry.ccValue, 4)}-> nothing on layer `
              + `${cfgmod.layerLabel(cfg.layers[router.layer])} (mapped on layer ${others}), `
              + 'ignored', 'inactive');
      break;
    }
    case 'unmapped': {
      const key = `${router.layer}:${entry.cc}`;
      if (seenUnmapped.has(key)) break;
      seenUnmapped.add(key);
      const fate = cfg.thru ? 'not mapped, passed through' : 'not mapped';
      const scope = cfgmod.isLayered(cfg) ? ' on this layer' : '';
      logLine(`CC${pad(entry.cc, 4)}val ${pad(entry.ccValue, 4)}-> ${fate} `
              + `(further CC${entry.cc} messages${scope} will be silent)`, 'unmapped');
      break;
    }
    case 'sysex': {
      if (!state.verbose) break;
      const param = cfgmod.paramFor(entry.mapping);
      logLine(`    sent: ${entry.hex}   (${param.name} = ${entry.value})`, 'sysex');
      break;
    }
    case 'thru': {
      if (!state.verbose) break;
      logLine(`    passed through: ${describe(entry.message)}`, 'thru');
      break;
    }
    default:
      break;
  }
}

/**
 * The banner the CLI prints when it starts running, in the log.
 *
 * The layer table is the part that earns its place: the layer knob's real
 * position cannot be read, so which layer is live at the moment translation
 * starts is an assumption, and one worth stating rather than leaving to be
 * inferred from a highlighted chip.
 */
function logStartup() {
  const cfg = state.cfg;
  const listen = cfg.listenChannel === null ? 'any channel' : `channel ${cfg.listenChannel}`;
  logLine(`Input:   ${ports.input ? ports.input.name : 'none'}`, 'layer');
  logLine(`Output:  ${ports.output ? ports.output.name : 'none'}`, 'layer');
  logLine(`Listening on ${listen}, sending to synth channel ${cfg.synthChannel}`, 'layer');

  const mapped = cfgmod.allMappedCcs(cfg).size;
  const summary = cfgmod.isLayered(cfg)
    ? `${mapped} knob(s) mapped across ${cfg.layers.length} layers`
    : `${cfg.layers[0].byCc.size} of 36 parameters mapped`;
  logLine(`${summary}, rate limit ${cfg.maxMsgsPerSec} msg/s`, 'layer');

  if (cfgmod.isLayered(cfg)) {
    const param = aj.makeLayerParam(cfg.layers.length);
    const width = Math.max(...cfg.layers.map((l) => cfgmod.layerLabel(l).length));
    logLine(`Layer knob: CC${cfg.layerCc}, ${cfg.layers.length} layers`, 'layer');
    cfg.layers.forEach((layer, index) => {
      const [low, high] = aj.regionBounds(param, index);
      const marker = index === router.layer ? '->' : '  ';
      logLine(` ${marker} layer ${cfgmod.layerLabel(layer).padEnd(width)}  `
              + `CC ${String(low).padStart(3)}-${String(high).padEnd(3)}  `
              + `${layer.byCc.size} knob(s)`, 'layer');
    });
    logLine(`    Assuming layer ${cfgmod.layerLabel(cfg.layers[router.layer])} until the `
            + 'layer knob is moved; its real position cannot be read.', 'layer');
  }
  if (cfg.thru) logLine('Thru is ON: notes and unmapped CCs are forwarded', 'thru');
}

// -------------------------------------------------------- import / export ---

function importText(text, name) {
  let result;
  try {
    result = cfgmod.parseText(text, name);
  } catch (exc) {
    banner('error', exc.message, { sticky: true });
    return;
  }
  clearBanners();
  state.cfg = result.cfg;
  state.editLayer = 0;
  state.selected = null;
  for (const warning of result.warnings) banner('warn', `${name}: ${warning}`, { sticky: true });

  const knobCount = cfgmod.knobCcs(state.cfg).size;
  banner('ok', `Loaded ${name}: ${knobCount} knob(s) in a `
               + `${state.cfg.layout.rows}×${state.cfg.layout.cols} grid, `
               + `${state.cfg.layers.length} layer(s).`);

  // The imported file's idea of which ports to use beats the one left over from
  // the previous session, since choosing it is the whole reason it was imported.
  state.inputName = null;
  state.outputName = null;
  if (ports.access) autoSelectPorts();
  applyConfig({ keepSelection: false });
}

/** Problems the CLI would reject the exported file for. */
function exportProblems(cfg) {
  const problems = [];
  if (cfg.layers.length > 1 && !cfgmod.isLayered(cfg)) {
    problems.push('There is more than one layer but no knob selects between them. '
                  + 'Assign a layer knob, or set the layer count back to 1.');
  }
  if (!cfg.layers.some((layer) => layer.byCc.size)) {
    problems.push('Nothing is mapped yet, and the command-line version refuses a config '
                  + 'with nothing to do.');
  }
  return problems;
}

function exportConfig() {
  const problems = exportProblems(state.cfg);
  if (problems.length) {
    banner('error', `Not exported.\n${problems.join('\n')}`, { sticky: true });
    return;
  }
  const text = cfgmod.render(state.cfg);
  const blob = new Blob([text], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = cfgmod.DEFAULT_CONFIG_NAME;
  link.click();
  // Revoking straight away can cancel the download before the browser has read
  // the blob, which shows up as an empty file on slower machines.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  banner('ok', `Wrote ${cfgmod.DEFAULT_CONFIG_NAME}. The same file works with the `
               + 'command-line and Tulip versions.');
}

// ----------------------------------------------------------------- about ---

/**
 * The About box, whose text lives in about.html.
 *
 * It is kept in its own file, and in HTML rather than in a string in here, so it
 * can be edited by someone who does not want to read JavaScript to find the
 * words. It is fetched once, on first use, rather than being part of the page:
 * nobody should pay for it on load, and it is the one part of this that is
 * allowed to be slow.
 */
let aboutLoaded = false;

async function openAbout() {
  const dialog = $('about');
  if (!aboutLoaded) {
    try {
      const response = await fetch('about.html', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      // Our own file from our own origin, so this is not the usual injection
      // hazard -- and it has to be markup, or the links in it would not work.
      $('about-body').innerHTML = await response.text();
      for (const link of $('about-body').querySelectorAll('a[href]')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      aboutLoaded = true;
    } catch (exc) {
      // Opening index.html straight off the disk rather than through a server
      // is the usual reason; fetch is not allowed to read file:// URLs.
      $('about-body').innerHTML = '<h2>cc2juno</h2>';
      const note = document.createElement('p');
      note.textContent = `about.html could not be loaded (${exc.message}). `
        + 'The page needs to be served over http or https, which is also what '
        + 'Web MIDI requires.';
      $('about-body').append(note);
    }
  }
  dialog.showModal();
}

// ------------------------------------------------------------- other tabs ---

// Web MIDI hands the same input to every page that asked for it, so a second
// copy of this app left open in another tab keeps translating too -- on whatever
// layer *it* is showing. The synth then gets two parameters for one knob, and
// the tab you are looking at is innocent of half of them. That is impossible to
// diagnose from the front, so the tabs tell each other.
const TAB_ID = Math.random().toString(36).slice(2);
const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('cc2juno') : null;
let otherTabWarned = false;

function warnOtherTab() {
  if (otherTabWarned) return;
  otherTabWarned = true;
  banner('error', 'Another cc2juno tab is open and also translating. Both are sending '
                  + 'to the synth, each on whatever layer it happens to be showing, so '
                  + 'one knob will appear to change two parameters. Close the other tab, '
                  + 'or put it back into Configure.', { sticky: true });
}

function announcePerforming() {
  if (tabChannel) tabChannel.postMessage({ type: 'performing', id: TAB_ID });
}

if (tabChannel) {
  tabChannel.onmessage = ({ data }) => {
    if (!data || data.id === TAB_ID || state.mode !== 'perform') return;
    if (data.type === 'performing') {
      warnOtherTab();
      // Answer, so the tab that just started knows about this one as well.
      tabChannel.postMessage({ type: 'also-performing', id: TAB_ID });
    } else if (data.type === 'also-performing') {
      warnOtherTab();
    }
  };
}

// ----------------------------------------------------------------- modes ---

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  stopLearn();
  state.selected = null;

  if (mode === 'perform') {
    if (!ports.output) {
      banner('warn', 'No MIDI output chosen, so nothing will reach the synth.');
    }
    if (ports.echoing && state.cfg.thru) {
      banner('warn', 'Input and output are the same port, so thru will echo messages '
                     + 'straight back.');
    }
    router.reset();
    seenUnmapped.clear();
    seenInactive.clear();
    logLine('', 'layer');
    logStartup();
    announcePerforming();
  } else {
    router.stop();
    otherTabWarned = false;
  }

  $('mode-config').classList.toggle('is-active', mode === 'config');
  $('mode-perform').classList.toggle('is-active', mode === 'perform');
  $('panel-config').hidden = mode !== 'config';
  $('panel-perform').hidden = mode !== 'perform';
  save();
  refresh();
}

function refresh() {
  buildGrid();
  refreshKnobs();
  renderLayerBar();
  renderStageNote();
  renderInspector();
  if (state.mode === 'config') renderForm();
  else renderSummary();
  updateStatus();
}

// ------------------------------------------------------------------ wiring ---

function numberField(id, apply, { min, max, allowBlank = false, blankValue = null }) {
  $(id).addEventListener('change', () => {
    const raw = $(id).value.trim();
    if (raw === '' && allowBlank) {
      apply(blankValue);
      applyConfig();
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      banner('warn', `${id.replace(/-/g, ' ')}: must be a whole number ${min}-${max}.`);
      renderForm();
      return;
    }
    apply(value);
    applyConfig();
  });
}

function wire() {
  $('about-open').addEventListener('click', openAbout);
  $('about-close').addEventListener('click', () => $('about').close());
  // Clicking the backdrop closes it. The dialog element itself fills the whole
  // viewport as far as the event is concerned, so the check is whether the click
  // landed outside the box the user can actually see.
  $('about').addEventListener('click', (event) => {
    const box = $('about').getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right
                 || event.clientY < box.top || event.clientY > box.bottom;
    if (outside) $('about').close();
  });

  $('midi-enable').addEventListener('click', enableMidi);
  $('midi-in').addEventListener('change', (event) => {
    chooseInput(ports.inputs().find((port) => port.id === event.target.value) || null);
  });
  $('midi-out').addEventListener('change', (event) => {
    chooseOutput(ports.outputs().find((port) => port.id === event.target.value) || null);
  });

  $('mode-config').addEventListener('click', () => setMode('config'));
  $('mode-perform').addEventListener('click', () => setMode('perform'));

  $('do-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    importText(await file.text(), file.name);
    event.target.value = '';       // so the same file can be picked again
  });
  $('do-export').addEventListener('click', exportConfig);
  $('do-reset').addEventListener('click', () => {
    if (!confirm('Throw away the current configuration and start again?')) return;
    state.cfg = cfgmod.makeConfig();
    state.editLayer = 0;
    state.selected = null;
    clearBanners();
    applyConfig({ keepSelection: false });
  });

  // ---- inspector
  $('knob-learn').addEventListener('click', () => {
    if (state.selected === null) return;
    if (state.learning === state.selected) { stopLearn(); refresh(); return; }
    startLearn(state.selected);
  });
  $('knob-cc').addEventListener('change', () => {
    if (state.selected === null) return;
    const raw = $('knob-cc').value.trim();
    if (raw === '') { removeKnob(state.selected); return; }
    const cc = Number(raw);
    if (!Number.isInteger(cc) || cc < 0 || cc > 127) {
      banner('warn', 'A CC number is 0-127.');
      renderInspector();
      return;
    }
    assignCc(state.selected, cc);
  });
  // Every one of these acts on the selected cell, which is only ever set in
  // Configure mode and can be cleared out from under them by a reshape.
  const selectedCc = () => (state.selected === null
    ? null
    : state.cfg.layout.ccs[state.selected] ?? null);

  $('knob-param').addEventListener('change', () => {
    const cc = selectedCc();
    if (cc === null) return;
    const raw = $('knob-param').value;
    setFunction(cc, raw === '' ? null : Number(raw));
  });
  $('knob-mode').addEventListener('change', () => {
    const cc = selectedCc();
    const mapping = cc === null ? null : activeLayer().byCc.get(cc);
    if (!mapping) return;
    mapping.mode = $('knob-mode').value;
    applyConfig();
  });
  $('knob-is-layer').addEventListener('change', () => {
    const cc = selectedCc();
    if (cc === null) return;
    setLayerKnob(cc, $('knob-is-layer').checked);
  });
  $('knob-clear').addEventListener('click', () => {
    const cc = selectedCc();
    if (cc !== null) setFunction(cc, null);
  });
  $('knob-remove').addEventListener('click', () => {
    if (state.selected !== null) removeKnob(state.selected);
  });

  // ---- grid
  for (const id of ['grid-rows', 'grid-cols']) {
    $(id).addEventListener('change', () => {
      const rows = Number($('grid-rows').value);
      const cols = Number($('grid-cols').value);
      if (![rows, cols].every((n) => Number.isInteger(n) && n >= 1 && n <= cfgmod.MAX_GRID)) {
        banner('warn', `Rows and columns are whole numbers 1-${cfgmod.MAX_GRID}.`);
        renderForm();
        return;
      }
      const before = cfgmod.knobCcs(state.cfg).size;
      state.cfg.layout = cfgmod.reshapeLayout(state.cfg.layout, rows, cols);
      const after = cfgmod.knobCcs(state.cfg).size;
      if (after < before) {
        banner('warn', `${before - after} knob(s) did not fit and were taken off the grid. `
                       + 'Their assignments are still in the config.');
      }
      state.selected = null;
      applyConfig({ keepSelection: false });
    });
  }

  // ---- layers
  $('layer-count').addEventListener('change', () => {
    const count = Number($('layer-count').value);
    const dropping = state.cfg.layers.slice(count).filter((layer) => layer.byCc.size).length;
    if (dropping && !confirm(`${dropping} layer(s) with assignments will be discarded. `
                             + 'Continue?')) {
      renderForm();
      return;
    }
    cfgmod.resizeLayers(state.cfg, count);
    if (count === 1) state.cfg.layerCc = null;
    state.editLayer = Math.min(state.editLayer, count - 1);
    applyConfig();
  });
  $('layer-startup').addEventListener('change', () => {
    state.cfg.startupLayer = Number($('layer-startup').value);
    applyConfig();
  });
  // Blank here does not mean zero: it means "whatever midi.hysteresis is".
  numberField('layer-hysteresis', (v) => { state.cfg.layerHysteresis = v; },
              { min: 0, max: 16, allowBlank: true, blankValue: null });

  // ---- MIDI settings
  $('synth-channel').addEventListener('change', () => {
    state.cfg.synthChannel = Number($('synth-channel').value);
    applyConfig();
  });
  $('listen-channel').addEventListener('change', () => {
    const raw = $('listen-channel').value;
    state.cfg.listenChannel = raw === 'any' ? null : Number(raw);
    applyConfig();
  });
  for (const [id, field] of [['level-byte', 'levelByte'], ['group-byte', 'groupByte']]) {
    $(id).addEventListener('change', () => {
      const text = $(id).value.trim();
      const value = /^0x/i.test(text) ? parseInt(text, 16) : Number(text);
      if (!Number.isInteger(value) || value < 0 || value > 127) {
        banner('warn', 'A sysex header byte is 0-127, written as 0x20 or 32.');
        renderForm();
        return;
      }
      state.cfg[field] = value;
      applyConfig();
    });
  }
  numberField('max-rate', (v) => { state.cfg.maxMsgsPerSec = v; }, { min: 1, max: 1000 });
  numberField('hysteresis', (v) => { state.cfg.hysteresis = v; }, { min: 0, max: 16 });
  $('thru').addEventListener('change', () => {
    state.cfg.thru = $('thru').checked;
    applyConfig();
  });

  // ---- log
  $('log-clear').addEventListener('click', () => {
    $('log').replaceChildren();
    seenUnmapped.clear();
    seenInactive.clear();
  });
  $('log-verbose').addEventListener('change', () => { state.verbose = $('log-verbose').checked; });

  // Number keys jump between layers while performing, so a layer change does not
  // need the mouse when the controller has no spare knob for it.
  document.addEventListener('keydown', (event) => {
    if (state.mode !== 'perform') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // The target is whatever has focus, which is the document itself when
    // nothing does -- and that has no matches().
    if (event.target instanceof Element && event.target.matches('input, select, textarea')) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < state.cfg.layers.length) {
      router.setLayer(index);
    }
  });
}

// ------------------------------------------------------------------- start ---

function start() {
  fillStaticMenus();
  wire();

  const restored = restore();
  if (!restored) state.cfg = cfgmod.makeConfig();
  router.setConfig(state.cfg);

  // Perform mode with no MIDI access yet would look broken, so a restored
  // session always comes back in Configure and is switched over deliberately.
  state.mode = 'config';
  $('panel-config').hidden = false;
  $('panel-perform').hidden = true;

  refresh();

  if (!ports.supported) {
    banner('error', 'This browser has no Web MIDI, so nothing can be sent or received. '
                    + 'Chrome, Chromium, Edge and Opera have it. The editor still works '
                    + 'for building a config to export.', { sticky: true });
    $('midi-enable').disabled = true;
    return;
  }
  // Only ask again unprompted if permission was granted here before; a first
  // visit gets the button instead of an immediate permission dialog.
  if (localStorage.getItem(GRANTED_KEY)) enableMidi();
}

start();
