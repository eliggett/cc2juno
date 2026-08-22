// The mapping state and the outgoing rate limiter: a port of Router in cc2juno.py.
//
// The one structural difference is how the queue is drained. The CLI sits in a
// polling loop and calls flush() every time round; a browser tab has no such
// loop, so the queue schedules its own wake-up with setTimeout, and only while
// something is actually waiting to go out. The rule it enforces is the same one:
// at most one message per `1 / max_msgs_per_sec` seconds, newest value per
// parameter wins, and a value equal to the last one sent is not sent again.

import * as aj from './alpha_juno.js';
import { isLayered, layerEdgeHysteresis, allMappedCcs, paramFor } from './config.js';
import { decode } from './midi.js';

export class Router {
  /**
   * @param cfg     the validated config
   * @param hooks   {send, log, onKnob, onLayer, onStats}
   */
  constructor(cfg, hooks = {}) {
    this.hooks = hooks;
    this.pending = new Map();     // param index -> {value, mapping}, newest wins
    this.lastValue = new Map();   // param index -> last value actually sent
    this.lastSend = 0;
    this.timer = null;
    this.dryRun = false;

    // Every knob's last seen CC position, so the UI can draw the controller as
    // it stands rather than starting every knob at zero. Keyed by CC, since that
    // is the physical thing; the sent values are keyed by parameter.
    this.ccPositions = new Map();

    // What the synth has told us about itself: the parameters whose value came
    // from the synth rather than from something we sent, and the tone it named
    // when it did. Cleared per parameter as soon as we send that parameter, at
    // which point our value is the newer of the two.
    this.fromSynth = new Set();
    this.toneName = '';
    this.patch = null;            // program number from a program change, or null

    // The preset slot whose sound is loaded, if it got there from here rather
    // than from the instrument: {slot, name}, or null for the ordinary case
    // where the synth is on one of its own patches. Cleared the moment the synth
    // says otherwise, since from then on it is the synth's patch that is loaded
    // and ours that has been replaced.
    this.recalled = null;

    // Whether the sound has been altered since it was loaded -- the star the
    // instrument puts beside the patch number. Set by anything that changes one
    // parameter, from either side; cleared by anything that loads a whole sound,
    // which is what makes the edit buffer agree with a stored patch again.
    //
    // Deliberately a flag rather than a comparison against the loaded values.
    // There is nothing here to compare against for most of the ways a sound
    // arrives -- the synth announces a patch but not what that patch is stored
    // as, and a knob moved and moved back has still been through the edit buffer
    // -- so this says what the instrument's own star says: something was touched.
    this.edited = false;

    // Which knobs have actually taken effect since the layer last changed.
    // Straight after a switch this is empty: every knob is physically pointing
    // at a value that belonged to the previous layer and none of them mean
    // anything yet. The display needs to know, so that it can say so instead of
    // showing a number the synth was never sent.
    this.sentOnLayer = new Set();

    this.setConfig(cfg);
  }

  setConfig(cfg) {
    this.cfg = cfg;
    this.interval = 1000 / cfg.maxMsgsPerSec;
    this.layerParam = aj.makeLayerParam(cfg.layers.length);
    this.layerHysteresis = layerEdgeHysteresis(cfg);
    this.mappedCcs = allMappedCcs(cfg);
    if (this.layer === undefined || this.layer >= cfg.layers.length) {
      this.layer = cfg.startupLayer - 1;
    }
  }

  reset() {
    this.pending.clear();
    this.lastValue.clear();
    this.sentOnLayer.clear();
    this.fromSynth.clear();
    this.toneName = '';
    this.patch = null;
    this.recalled = null;
    this.edited = false;
    this.layer = this.cfg.startupLayer - 1;
  }

  /** Route one incoming message. Anything untranslated goes thru, if thru is on. */
  handle(data) {
    const message = decode(data);

    if (message.type === 'cc') {
      const listen = this.cfg.listenChannel;
      if (listen === null || message.channel === listen) {
        this.ccPositions.set(message.cc, message.value);
        if (isLayered(this.cfg) && message.cc === this.cfg.layerCc) {
          this.handleLayer(message.value);
          return;
        }
        const mapping = this.cfg.layers[this.layer].byCc.get(message.cc);
        if (mapping) {
          this.handleCc(message.cc, message.value, mapping);
          return;
        }
        // A knob mapped on some other layer is still one of this controller's
        // knobs. It is consumed and stays silent rather than reaching the synth
        // as a raw CC that would mean something else.
        if (this.mappedCcs.has(message.cc)) {
          this.report(message.cc, message.value, 'inactive');
          return;
        }
        this.report(message.cc, message.value, 'unmapped');
      }
    }

    if (this.cfg.thru) this.forward(message);
  }

  /**
   * Pick the active layer from the layer knob's position.
   *
   * Nothing is sent to the synth: the knobs now point at values that belonged to
   * the previous layer, and resending from those stale positions would overwrite
   * the patch. Each knob takes effect on its next move.
   */
  handleLayer(ccValue) {
    const layer = aj.convert(this.layerParam, ccValue,
                             { previous: this.layer, hysteresis: this.layerHysteresis });
    // The knob is reported however it lands, so the dial on screen tracks it even
    // while it is still inside the dead zone; only a real change is worth a line
    // in the log, which is what `changed` is for.
    this.report(this.cfg.layerCc, ccValue, 'layer', { layer, changed: layer !== this.layer });
    this.setLayer(layer);
  }

  /** Switch layers from the UI. Same silence about it as the knob. */
  setLayer(index) {
    if (index === this.layer) return;
    this.layer = index;
    this.sentOnLayer.clear();
    if (this.hooks.onLayer) this.hooks.onLayer(index);
  }

  handleCc(cc, ccValue, mapping) {
    const param = paramFor(mapping);
    const previous = this.lastValue.has(param.index) ? this.lastValue.get(param.index) : null;
    const value = aj.convert(param, ccValue, {
      mode: mapping.mode,
      previous,
      hysteresis: this.cfg.hysteresis,
    });

    if (value === previous) {
      this.report(cc, ccValue, 'unchanged', { mapping, value });
      return;
    }

    this.pending.set(param.index, { value, mapping, param });
    this.edited = true;
    this.sentOnLayer.add(cc);
    this.report(cc, ccValue, 'mapped', { mapping, value });
    this.schedule();
  }

  /**
   * Set a parameter with no CC behind it, as the on-screen panel does.
   *
   * Every other route into the queue starts with a knob, so it can name the
   * mapping that got it there; this one cannot, and carries the parameter
   * instead. It joins the same queue under the same rate limit and the same
   * don't-resend-an-unchanged-value rule, so a slider swept with the mouse costs
   * the synth no more than a knob swept with a hand.
   */
  sendParam(paramIndex, value) {
    const param = aj.PARAMETERS[paramIndex];
    if (!param) throw new Error(`no such parameter: ${paramIndex}`);
    const bounded = Math.max(0, Math.min(param.maxValue, Math.trunc(value)));
    const previous = this.lastValue.has(paramIndex) ? this.lastValue.get(paramIndex) : null;
    if (bounded === previous) return false;

    this.pending.set(paramIndex, { value: bounded, mapping: null, param });
    this.edited = true;
    if (this.hooks.log) this.hooks.log({ kind: 'panel', param, value: bounded });
    this.schedule();
    return true;
  }

  /**
   * What every parameter is currently set to: 36 entries, null where unknown.
   *
   * A value still in the queue counts, and outranks the one already sent. The
   * only thing that can stop a queued value going out is a newer value for the
   * same parameter, which is what would be reported instead -- so reading
   * lastValue alone would report the old value for the few milliseconds the rate
   * limiter holds a move, and anything building on that answer would flicker
   * backwards during a sweep.
   *
   * Null is not zero. Until the synth announces a patch, the only parameters
   * cc2juno knows are the ones it has itself sent; the rest are whatever the
   * instrument was already holding, which is unknowable from here. Callers are
   * expected to say so rather than draw a slider at the bottom of its travel or
   * store a preset with invented values in it.
   */
  knownValues() {
    return aj.PARAMETERS.map((param) => {
      const queued = this.pending.get(param.index);
      if (queued) return queued.value;
      const sent = this.lastValue.get(param.index);
      return sent === undefined ? null : sent;
    });
  }

  /**
   * Send a whole tone: every parameter at once, as recalling a preset does.
   *
   * The 36 messages go through the same queue as everything else and leave under
   * the same rate limit. Handing them to the synth in one burst would be quicker
   * and worse -- an Alpha Juno is not fast at receiving individual tone
   * parameters, and the limit is set where it is because that is what the
   * instrument was found to keep up with. A recall therefore takes 36 times the
   * message interval to land, which at the default rate is a fraction of a
   * second, and every slider reaches its new position immediately regardless:
   * knownValues() reads the queue, so the screen is redrawn from where the tone
   * is going rather than from how much of it has gone.
   *
   * Parameters already at the requested value are skipped, which is the same
   * don't-resend-an-unchanged-value rule the rest of the queue follows. Recalling
   * the preset that is already loaded therefore sends nothing at all.
   */
  sendTone(values, { slot = null, name = '' } = {}) {
    let queued = 0;
    values.forEach((value, index) => {
      const param = aj.PARAMETERS[index];
      if (!param || value === null || value === undefined) return;
      const bounded = Math.max(0, Math.min(param.maxValue, Math.trunc(value)));
      if (this.lastValue.get(index) === bounded) return;
      this.pending.set(index, { value: bounded, mapping: null, param });
      queued += 1;
    });

    // Set even when nothing needed sending. Recalling the slot the synth is
    // already holding sends no messages and still means that slot is what is
    // loaded, which is what the display is being asked to report.
    this.recalled = slot ? { slot, name } : null;
    // A whole sound has just been put in the edit buffer, so it is that sound
    // again rather than an edited version of the last one -- even where every
    // parameter was already at the right value and nothing was sent.
    this.edited = false;

    if (this.hooks.log) {
      this.hooks.log({ kind: 'recall', slot, name, queued, total: aj.PARAMETERS.length });
    }
    this.schedule();
    return queued;
  }

  // --- what the synth tells us -----------------------------------------------

  /**
   * Adopt a whole patch the synth has just announced.
   *
   * This is the one place where a value on screen comes from somewhere other than
   * a message we sent, and it outranks everything we know: the synth has just
   * loaded 36 parameters and ours is at best a record of what it used to have.
   *
   * Anything still queued is dropped. Those messages were aimed at the patch that
   * has just been replaced, and letting them go out would edit the new one a few
   * milliseconds after it arrived -- the classic "my patch changes itself when I
   * load it" fault, and a miserable one to diagnose from the outside.
   *
   * Note what is *not* touched: ccPositions, which is where the pots are. The
   * pots have not moved. Drawing the knobs where the synth's values put them is
   * the display's business and it is done from these values; writing invented
   * positions in here would lose the one record of where the controller really
   * is, and every layer change afterwards would draw from the invention.
   */
  applyTone(values, { name = '' } = {}) {
    this.pending.clear();
    this.toneName = name;
    this.edited = false;
    // Whatever preset was recalled has just been replaced wholesale by the one
    // the synth loaded, so the display goes back to reporting the instrument.
    this.recalled = null;
    values.forEach((value, index) => this.remember(index, value));
  }

  /**
   * Adopt one parameter, as sent when the synth's own panel is edited.
   *
   * A recalled preset survives this. Editing one parameter does not make the
   * sound a different patch -- the instrument goes on showing the name of the
   * patch being edited, and so does this. What it does do is star it: the synth
   * is showing its own star for the same edit, and the two screens should agree.
   */
  applyParam(index, value) {
    if (!aj.PARAMETERS[index]) throw new Error(`no such parameter: ${index}`);
    this.pending.delete(index);
    this.edited = true;
    this.remember(index, value);
  }

  remember(index, value) {
    const param = aj.PARAMETERS[index];
    if (!param) return;
    this.lastValue.set(index, Math.max(0, Math.min(param.maxValue, value)));
    this.fromSynth.add(index);
  }

  /**
   * The program number the synth last reported switching to.
   *
   * This ends a recall as surely as a tone dump does: the instrument has been
   * turned to one of its own patches, so a slot number of ours is no longer what
   * is loaded, whichever of the two messages a patch change happens to send
   * first.
   */
  setPatch(program) {
    this.patch = program;
    this.recalled = null;
    this.edited = false;
  }

  /**
   * Send an untranslated message straight out, ahead of the sysex queue.
   *
   * Deliberately not rate limited: delaying note messages to make room for
   * parameter edits would be far worse than the extra bytes on the wire.
   */
  forward(message) {
    if (!this.dryRun && this.hooks.send) this.hooks.send(message.data);
    if (!message.quiet && this.hooks.log) {
      this.hooks.log({ kind: 'thru', message });
    }
  }

  /** Wake up when the rate limiter will next allow a message out. */
  schedule() {
    if (this.timer !== null || !this.pending.size) return;
    const wait = Math.max(0, this.interval - (performance.now() - this.lastSend));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** Send at most one queued parameter, respecting the rate limit. */
  flush() {
    if (!this.pending.size) return;
    const now = performance.now();
    if (now - this.lastSend < this.interval) {
      this.schedule();
      return;
    }

    const [index, { value, mapping, param }] = this.pending.entries().next().value;
    this.pending.delete(index);

    const frame = aj.buildSysex(index, value, this.cfg.synthChannel,
                                this.cfg.levelByte, this.cfg.groupByte);
    if (!this.dryRun && this.hooks.send) this.hooks.send(frame);
    this.lastValue.set(index, value);
    this.fromSynth.delete(index);
    this.lastSend = now;

    if (this.hooks.log) {
      this.hooks.log({ kind: 'sysex', frame, mapping, param, value, hex: aj.hexString(frame) });
    }
    // The value on screen is the value that was actually sent, and that is only
    // known here -- a message can sit in the queue for a while, and the last one
    // of a sweep would otherwise never be drawn at all.
    if (this.hooks.onSent) this.hooks.onSent({ mapping, param, value });
    this.schedule();
  }

  /**
   * A knob turned on screen instead of on the controller.
   *
   * It goes through exactly the same path as a real CC so the two cannot drift
   * apart -- including being ignored when the knob does nothing on this layer.
   */
  handleLocalCc(cc, ccValue) {
    const channel = this.cfg.listenChannel === null ? 1 : this.cfg.listenChannel;
    this.handle(new Uint8Array([0xB0 | (channel - 1), cc & 0x7F, ccValue & 0x7F]));
  }

  report(cc, ccValue, kind, extra = {}) {
    if (this.hooks.onKnob) this.hooks.onKnob({ cc, ccValue, kind, ...extra });
    if (this.hooks.log) this.hooks.log({ kind, cc, ccValue, ...extra });
  }

  /**
   * Throw away everything queued and stop the timer.
   *
   * The values are not lost in any meaningful sense: they were on their way to an
   * edit buffer, and the only thing that calls this is about to replace what the
   * edit buffer means.
   */
  dropPending() {
    this.pending.clear();
    this.stop();
  }

  /**
   * Go quiet for the duration of a bulk transfer.
   *
   * A bulk transfer takes five to ten seconds with the synth in DATA TRANSFER
   * mode, and one parameter message landing in the middle of that stream is the
   * sort of thing a 1986 instrument answers by abandoning the transfer. The
   * modal dialog stops anyone clicking a slider, but it cannot stop a physical
   * knob on the controller, and that is exactly the hand that reaches out while
   * something is happening.
   *
   * So the router goes on routing -- knob positions are still tracked, the log
   * still fills in, the screen still follows -- and simply transmits nothing.
   * Anything queued is dropped rather than saved up, because releasing a held
   * sweep the instant the transfer ends would be its own kind of surprise.
   */
  holdTransmission(held) {
    this.dryRun = Boolean(held);
    if (held) this.dropPending();
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
