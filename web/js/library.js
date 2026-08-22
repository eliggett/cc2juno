// The patch list: one pane over one bank of 64, and the dragging between two of
// them.
//
// This is a view and nothing more. It never touches MIDI and never decides what
// a click means beyond "this row" -- auditioning, transferring and logging all
// belong to app.js, which owns the router and the ports. What the pane does own
// is the fiddly part of a librarian's screen: a selection that survives being
// re-rendered, a drag that can carry several patches at once, and a rename that
// only offers characters the synth can actually store.
//
// Two panes are built from this, and the difference between them is one flag:
//
//   Synth memory   editable, all 64 slots shown, accepts drops. It is a picture
//                  of the instrument's memory, and the instrument has exactly 64
//                  addresses -- so a drop *replaces* a slot rather than inserting
//                  one, and an empty slot is still a slot and still listed.
//   Source         read-only, lists only what the file actually held. Sixteen
//                  patches should read as sixteen rows, not sixteen followed by
//                  48 blanks.

import { Bank, TONE_COUNT, PER_BANK, Tone, slotLabel, sanitizeName, NAME_LENGTH } from './bank.js';

export const DRAG_MIME = 'application/x-alphajuno-tone';

// How long a selection must settle before it is auditioned. Long enough that
// arrowing down the list does not fire a burst of auditions on the way past,
// short enough that a single click still feels immediate.
const AUDITION_SETTLE_MS = 140;

let paneSerial = 0;

export class PatchPane {
  constructor({
    title,
    editable = false,
    showEmpty = false,
    emptyHint = '',
    // What the filename line says when there is no file. It is not left blank,
    // because an empty line collapses and the two panes of the manager then start
    // their lists at different heights.
    emptySource = '',
    onAudition = null,       // (index, tone) -- the selection came to rest
    onChange = null,         // (description) -- the bank was edited here
    onSelect = null,         // (indices) -- immediately, on every change
  } = {}) {
    this.id = `pane${paneSerial += 1}`;
    this.title = title;
    this.editable = editable;
    this.showEmpty = showEmpty;
    this.emptyHint = emptyHint;
    this.emptySource = emptySource;
    this.onAudition = onAudition;
    this.onChange = onChange;
    this.onSelect = onSelect;

    // A file may hold several banks; the synth's memory is always exactly one.
    // Both are the same shape here -- an array and an index into it -- so nothing
    // below has to care which kind of pane it is in.
    this.banks = [new Bank()];
    this.bankIndex = 0;
    this.sourceName = '';
    this.selection = new Set();
    this.anchor = null;        // where a shift-click measures its range from
    this.editing = null;       // slot index whose name is being typed
    this.dropTarget = null;
    this.pendingClick = null;
    this.auditionTimer = null;
    this.rows = new Map();     // slot index -> row element, for in-place updates

    this.build();
  }

  // ------------------------------------------------------------- building ---
  build() {
    this.el = document.createElement('section');
    this.el.className = 'patch-pane';

    const head = document.createElement('div');
    head.className = 'patch-pane-head';

    this.titleEl = document.createElement('h2');
    this.titleEl.textContent = this.title;

    this.countEl = document.createElement('span');
    this.countEl.className = 'patch-pane-count';

    // Filled by whoever built the pane: the buttons differ per pane and are the
    // one part of it that knows about MIDI.
    this.actions = document.createElement('div');
    this.actions.className = 'patch-pane-actions';

    head.append(this.titleEl, this.countEl, this.actions);

    this.subtitle = document.createElement('p');
    this.subtitle.className = 'patch-pane-source';

    // Only ever on screen for a file holding more than one bank, which is why it
    // is a row of its own: in Live Patch the pane is a third of the width, and a
    // control that appears inside the heading would reflow it as files change.
    this.bankBar = document.createElement('div');
    this.bankBar.className = 'patch-banks is-single';
    this.bankPrev = document.createElement('button');
    this.bankPrev.className = 'small';
    this.bankPrev.textContent = '◀';
    this.bankPrev.title = 'The bank before this one in the file';
    this.bankPrev.addEventListener('click', () => this.showBank(this.bankIndex - 1));
    this.bankLabel = document.createElement('span');
    this.bankLabel.className = 'patch-banks-label';
    this.bankNext = document.createElement('button');
    this.bankNext.className = 'small';
    this.bankNext.textContent = '▶';
    this.bankNext.title = 'The next bank in the file';
    this.bankNext.addEventListener('click', () => this.showBank(this.bankIndex + 1));
    this.bankBar.append(this.bankPrev, this.bankLabel, this.bankNext);

    this.list = document.createElement('div');
    this.list.className = 'patch-list';
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', this.title);
    this.list.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.empty = document.createElement('p');
    this.empty.className = 'patch-empty';
    this.empty.textContent = this.emptyHint;

    if (this.editable) {
      // The list itself takes the drop as well as the rows, so releasing in the
      // gap under the last row does something sensible instead of nothing.
      this.list.addEventListener('dragover', (event) => this.onDragOver(event, null));
      this.list.addEventListener('drop', (event) => this.onDrop(event, null));
      this.list.addEventListener('dragleave', (event) => {
        if (event.target === this.list) this.markDrop(null);
      });
    }

    this.el.append(head, this.subtitle, this.bankBar, this.list, this.empty);
    this.render();
  }

  // ---------------------------------------------------------------- state ---
  /** The bank on show. Everything that edits a pane edits this one. */
  get bank() {
    return this.banks[this.bankIndex];
  }

  setBank(bank, sourceName = '') {
    this.setBanks([bank], sourceName);
  }

  setBanks(banks, sourceName = '') {
    this.banks = banks.length ? banks : [new Bank()];
    this.bankIndex = 0;
    this.sourceName = sourceName;
    this.selection.clear();
    this.anchor = null;
    this.editing = null;
    this.rows.clear();
    this.cancelAudition();
    this.render();
  }

  /**
   * Show another bank of the same file.
   *
   * The selection is dropped rather than carried over. Slot 32 of bank 2 is a
   * different patch from slot 32 of bank 1, and a selection that survived the
   * change would mean the next Copy took something nobody had looked at.
   */
  showBank(index) {
    if (index === this.bankIndex || index < 0 || index >= this.banks.length) return;
    this.bankIndex = index;
    this.selection.clear();
    this.anchor = null;
    this.editing = null;
    this.cancelAudition();
    this.render();
    if (this.onSelect) this.onSelect([]);
  }

  get selected() {
    return [...this.selection].sort((a, b) => a - b);
  }

  /** The one selected patch, or null when it is none or several. */
  get current() {
    return this.selection.size === 1 ? this.selected[0] : null;
  }

  /** Slots this pane lists, in order. */
  slots() {
    return this.showEmpty ? [...Array(TONE_COUNT).keys()] : this.bank.occupied();
  }

  touched(description) {
    this.render();
    if (this.onChange) this.onChange(description);
  }

  // -------------------------------------------------------------- drawing ---
  render() {
    const slots = this.slots();
    this.rows.clear();
    this.list.replaceChildren();

    for (const index of slots) {
      const row = this.buildRow(index);
      this.rows.set(index, row);
      this.list.append(row);
    }

    this.list.hidden = slots.length === 0;
    this.empty.hidden = slots.length !== 0 || !this.emptyHint;

    // Nothing listed yet. Live Patch uses this to put the weight on the one
    // button worth pressing; see .live-pane .patch-pane.is-empty in the
    // stylesheet. Set here rather than in whoever opened the file, so that it
    // stays true through every route into the pane -- a file, a dump, a drag.
    this.el.classList.toggle('is-empty', slots.length === 0);

    const total = this.bank.count();
    this.countEl.textContent = total ? `${total} patch${total === 1 ? '' : 'es'}` : '';
    // The bank on show names its own source when it has one, because several
    // files can be open at once and each bank came from one of them.
    const label = this.bank.source || this.sourceName || this.emptySource;
    this.subtitle.textContent = label;
    this.subtitle.hidden = !label;

    // A class rather than the hidden attribute: the stylesheet makes [hidden]
    // display:none !important, and the manager needs to be able to keep this
    // row's height in one pane while the other is the one using it.
    this.bankBar.classList.toggle('is-single', this.banks.length < 2);
    this.bankLabel.textContent = `Bank ${this.bankIndex + 1} of ${this.banks.length}`;
    this.bankPrev.disabled = this.bankIndex === 0;
    this.bankNext.disabled = this.bankIndex >= this.banks.length - 1;
  }

  /**
   * Repaint what selecting changes, without rebuilding the rows.
   *
   * A row replaced between mousedown and mouseup never fires dragstart, so
   * selecting one may not cost it its element -- which rules out render() for
   * every path a mouse can take through this pane.
   */
  paint() {
    for (const [slot, row] of this.rows) {
      const selected = this.selection.has(slot);
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-selected', String(selected));
      row.classList.toggle('is-drop-target', this.dropTarget === slot);
    }
  }

  buildRow(index) {
    const tone = this.bank.get(index);
    const row = document.createElement('div');
    row.className = 'patch-row';
    row.dataset.slot = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(this.selection.has(index)));
    if (this.selection.has(index)) row.classList.add('is-selected');
    if (tone.isEmpty) row.classList.add('is-empty');
    // A hairline every eight rows, because the synth's own numbering steps there:
    // 18 is the end of bank 1 and 21 is the start of bank 2.
    if (index % PER_BANK === 0 && index > 0) row.classList.add('is-bank-start');
    if (this.dropTarget === index) row.classList.add('is-drop-target');

    const slot = document.createElement('span');
    slot.className = 'patch-slot';
    slot.textContent = slotLabel(index);

    const name = document.createElement('span');
    name.className = 'patch-name';
    name.textContent = tone.isEmpty ? '—' : (tone.displayName || '(unnamed)');

    row.append(slot, name);
    row.title = this.describe(index);

    row.draggable = !tone.isEmpty;
    // Selection happens on mousedown so that a drag started from an unselected
    // row carries that row rather than whatever was selected a moment ago. The
    // exception is a plain click on a row that is *already* selected: acting on
    // that at mousedown would collapse a multi-row selection to the one row
    // grabbed, and there would be nothing left to drag. That case waits for the
    // click, by which time a drag has either started or plainly has not.
    row.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      this.pendingClick = null;
      if (event.shiftKey || event.ctrlKey || event.metaKey || !this.selection.has(index)) {
        this.click(index, event);
      } else {
        this.pendingClick = index;
      }
    });
    row.addEventListener('click', (event) => {
      if (this.pendingClick !== index) return;
      this.pendingClick = null;
      // Re-clicking the one selected row is a request to hear it again.
      if (this.selection.size === 1) this.queueAudition(index);
      else this.click(index, event);
    });
    row.addEventListener('dragstart', (event) => {
      this.pendingClick = null;
      this.onDragStart(event, index);
    });
    row.addEventListener('dragend', () => this.markDrop(null));

    if (this.editable) {
      row.addEventListener('dragover', (event) => this.onDragOver(event, index));
      row.addEventListener('drop', (event) => this.onDrop(event, index));
      row.addEventListener('dblclick', () => this.startRename(index));
    }
    if (this.editing === index) this.mountEditor(row, name, index);
    return row;
  }

  /** The tooltip: enough of the sound to tell two pads apart without playing them. */
  describe(index) {
    const tone = this.bank.get(index);
    if (tone.isEmpty) return `${slotLabel(index)} — empty`;
    const ranges = ["4'", "8'", "16'", "32'"];
    return `${slotLabel(index)}  ${tone.displayName}\n`
         + `DCO ${ranges[tone.params[6]] || '?'}  `
         + `cutoff ${tone.params[16]}  resonance ${tone.params[17]}  `
         + `chorus ${tone.params[10] ? 'on' : 'off'}`
         + (this.editable ? '\nDouble-click to rename' : '');
  }

  // ------------------------------------------------------------ selection ---
  click(index, event) {
    if (event.shiftKey && this.anchor !== null) {
      const slots = this.slots();
      const from = slots.indexOf(this.anchor);
      const to = slots.indexOf(index);
      if (from !== -1 && to !== -1) {
        this.selection.clear();
        const [low, high] = from <= to ? [from, to] : [to, from];
        for (let i = low; i <= high; i += 1) this.selection.add(slots[i]);
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selection.has(index)) this.selection.delete(index);
      else this.selection.add(index);
      this.anchor = index;
    } else {
      this.selection.clear();
      this.selection.add(index);
      this.anchor = index;
    }
    this.paint();
    if (this.onSelect) this.onSelect(this.selected);
    // Only a settled single selection is worth playing. A range is a copy or a
    // reorder about to happen, not a request to listen to sixteen patches.
    if (this.selection.size === 1) this.queueAudition(this.selected[0]);
    else this.cancelAudition();
  }

  select(indices, { audition = false } = {}) {
    this.selection = new Set(indices.filter((i) => i >= 0 && i < TONE_COUNT));
    this.anchor = this.selected[0] ?? null;
    this.paint();
    if (this.onSelect) this.onSelect(this.selected);
    if (audition && this.selection.size === 1) this.queueAudition(this.selected[0]);
  }

  queueAudition(index) {
    this.cancelAudition();
    if (!this.onAudition) return;
    const tone = this.bank.get(index);
    if (tone.isEmpty) return;
    this.auditionTimer = setTimeout(() => {
      this.auditionTimer = null;
      this.onAudition(index, tone);
    }, AUDITION_SETTLE_MS);
  }

  cancelAudition() {
    if (this.auditionTimer !== null) clearTimeout(this.auditionTimer);
    this.auditionTimer = null;
  }

  onKeyDown(event) {
    if (this.editing !== null) return;
    const slots = this.slots();
    if (!slots.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const at = this.current === null ? -1 : slots.indexOf(this.current);
      const next = at === -1
        ? (step > 0 ? 0 : slots.length - 1)
        : Math.max(0, Math.min(slots.length - 1, at + step));
      this.select([slots[next]], { audition: true });
      this.scrollTo(slots[next]);
      return;
    }
    if (event.key === 'Enter' && this.current !== null) {
      event.preventDefault();
      if (this.editable) this.startRename(this.current);
      else this.queueAudition(this.current);
    }
  }

  scrollTo(index) {
    const row = this.rows.get(index);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // --------------------------------------------------------------- naming ---
  startRename(index) {
    if (!this.editable) return;
    this.editing = index;
    this.render();
    const input = this.list.querySelector('.patch-name-input');
    if (input) { input.focus(); input.select(); }
  }

  mountEditor(row, nameEl, index) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'patch-name-input';
    input.value = this.bank.get(index).displayName;
    // The synth stores ten characters and no more, so the field stops there
    // rather than letting a name be typed that would be silently cut on write.
    input.maxLength = NAME_LENGTH;
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { this.editing = null; this.render(); }
    });
    input.addEventListener('blur', () => this.commitRename(index, input.value));
    row.replaceChild(input, nameEl);
  }

  commitRename(index, text) {
    if (this.editing !== index) return;
    this.editing = null;
    const tone = this.bank.get(index);
    const name = sanitizeName(text);
    if (name === tone.name) { this.render(); return; }
    tone.name = name;
    this.bank.filled.add(index);
    this.touched(`renamed ${slotLabel(index)} to "${name.trim()}"`);
  }

  // ------------------------------------------------------------- dragging ---
  onDragStart(event, index) {
    const indices = this.selection.has(index) ? this.selected : [index];
    const carried = indices.filter((i) => !this.bank.get(i).isEmpty);
    if (!carried.length) { event.preventDefault(); return; }

    const payload = {
      pane: this.id,
      slots: carried,
      tones: carried.map((i) => this.bank.get(i).toJSON()),
    };
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    // A plain-text copy so that dropping into a text editor gives something
    // readable rather than nothing, and so the drag is not refused by anything
    // that only understands text.
    event.dataTransfer.setData('text/plain',
                               carried.map((i) => this.bank.get(i).displayName).join(', '));
    event.dataTransfer.effectAllowed = this.editable ? 'copyMove' : 'copy';
  }

  onDragOver(event, index) {
    if (!this.editable) return;
    if (![...event.dataTransfer.types].includes(DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.markDrop(index === null ? null : index);
  }

  markDrop(index) {
    if (this.dropTarget === index) return;
    for (const [slot, row] of this.rows) {
      row.classList.toggle('is-drop-target', slot === index);
    }
    this.dropTarget = index;
  }

  onDrop(event, index) {
    if (!this.editable) return;
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    event.stopPropagation();
    this.markDrop(null);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (exc) {
      return;
    }
    if (!payload || !Array.isArray(payload.tones) || !payload.tones.length) return;

    // Dropping past the last row means the end of the list, which is the natural
    // reading of letting go in the space below it.
    const target = index === null ? TONE_COUNT - payload.tones.length : index;

    if (payload.pane === this.id && Array.isArray(payload.slots)) {
      // A drag inside one pane is a reorder: the patches keep their identity and
      // everything between them slides along, which is how a set is put in the
      // order it should be written in.
      const at = this.bank.moveMany(payload.slots, target);
      const landed = payload.slots.map((_, offset) => at + offset);
      this.selection = new Set(landed);
      this.anchor = at;
      this.touched(`moved ${payload.tones.length} patch(es) to ${slotLabel(at)}`);
      return;
    }

    // From the other pane: the synth has 64 fixed addresses and no way to make
    // room, so a drop replaces the slots it lands on and stops at 88 rather than
    // pushing patches off the end.
    const placed = [];
    payload.tones.forEach((data, offset) => {
      const slot = target + offset;
      if (slot >= TONE_COUNT) return;
      this.bank.set(slot, Tone.fromJSON(data));
      placed.push(slot);
    });
    if (!placed.length) return;
    this.selection = new Set(placed);
    this.anchor = placed[0];
    this.touched(`copied ${placed.length} patch(es) into ${slotLabel(placed[0])}`
                 + (placed.length < payload.tones.length
                   ? `, ${payload.tones.length - placed.length} did not fit` : ''));
  }

  // -------------------------------------------------------------- editing ---
  /** Put the given tones in at the current position, as the Copy button does. */
  place(tones, at = null) {
    const target = at === null ? (this.current ?? 0) : at;
    const placed = [];
    tones.forEach((tone, offset) => {
      const slot = target + offset;
      if (slot >= TONE_COUNT) return;
      this.bank.set(slot, tone.copy());
      placed.push(slot);
    });
    if (!placed.length) return 0;
    this.selection = new Set(placed);
    this.anchor = placed[0];
    this.touched(`copied ${placed.length} patch(es) into ${slotLabel(placed[0])}`);
    return placed.length;
  }

  /** Empty the selected slots. The set keeps its 64 addresses either way. */
  clearSelected() {
    const slots = this.selected;
    if (!slots.length) return 0;
    for (const slot of slots) {
      this.bank.tones[slot] = new Tone();
      this.bank.filled.add(slot);
    }
    this.touched(`cleared ${slots.length} slot(s)`);
    return slots.length;
  }

  /** Shuffle the selection one place up or down, keeping it selected. */
  nudge(delta) {
    const slots = this.selected;
    if (slots.length !== 1) return false;
    const from = slots[0];
    const to = from + delta;
    if (to < 0 || to >= TONE_COUNT) return false;
    this.bank.swap(from, to);
    this.selection = new Set([to]);
    this.anchor = to;
    this.touched(`moved ${slotLabel(from)} to ${slotLabel(to)}`);
    this.scrollTo(to);
    return true;
  }
}
