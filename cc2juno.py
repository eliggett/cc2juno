#!/usr/bin/env python3
"""cc2juno - translate MIDI CC messages into Roland Alpha Juno tone parameter sysex.

Lets a modern CC-based controller drive an Alpha Juno 1/2 or MKS-50, which only
accepts real-time edits over system exclusive.

    ./cc2juno.py                       # pick ports interactively, use ./cc2juno.yaml
    ./cc2juno.py --learn               # build a config by wiggling your controls
    ./cc2juno.py --init-config         # write a starting-point config
    ./cc2juno.py --list-ports
"""

import argparse
import os
import select
import signal
import sys
import time

import mido

import alpha_juno
import config as config_mod
import midi_io
from alpha_juno import PARAMETERS

# Passed through like everything else, but too repetitive to log even under -v.
QUIET_TYPES = {"clock", "active_sensing", "songpos", "quarter_frame"}

# How far a control must travel during one learn prompt before it is taken as the
# answer. A knob brushed in passing moves a count or two; a deliberate turn moves
# far more.
LEARN_MOVE_THRESHOLD = 6


def log_params() -> None:
    print(f"{'#':>2}  {'Parameter':<16} {'Range':<12} Notes")
    print("-" * 72)
    for p in PARAMETERS:
        rng = f"0..{p.max_value}"
        notes = []
        if p.options:
            notes.append(p.describe_range())
        if p.note:
            notes.append(p.note)
        print(f"{p.index:>2}  {p.name:<16} {rng:<12} {'; '.join(notes)}")


class Router:
    """Holds the mapping state and the outgoing rate limiter."""

    def __init__(self, cfg, outport, dry_run=False, quiet=False, verbose=False):
        self.cfg = cfg
        self.outport = outport
        self.dry_run = dry_run
        self.quiet = quiet
        self.verbose = verbose
        self.thru = cfg.thru

        self.pending = {}          # param index -> (value, mapping), newest wins
        self.last_value = {}       # param index -> last value actually sent
        self.interval = 1.0 / cfg.max_msgs_per_sec
        self.last_send = 0.0

        # Layer state. `pending` and `last_value` are keyed by parameter, not by
        # CC, so they stay correct across a layer change: a parameter is the same
        # parameter whichever layer's knob reached it.
        self.layer = cfg.startup_layer - 1
        self.layer_param = alpha_juno.make_layer_param(cfg.layer_count)
        self.layer_hysteresis = cfg.layer_edge_hysteresis()
        self.mapped_ccs = cfg.all_mapped_ccs()

        self.unmapped_seen = set()   # (layer, cc)
        self.inactive_seen = set()   # (layer, cc)
        self.stats = {"cc": 0, "unmapped": 0, "sent": 0, "coalesced": 0,
                      "unchanged": 0, "thru": 0, "layer": 0, "inactive": 0}

    def handle(self, msg) -> None:
        """Convert a mapped CC to sysex; pass anything else through if --thru is on."""
        if msg.type == "control_change":
            listen = self.cfg.listen_channel
            if listen is None or msg.channel + 1 == listen:
                self.stats["cc"] += 1
                if msg.control == self.cfg.layer_cc:
                    self.handle_layer(msg.value)
                    return
                mapping = self.cfg.lookup_cc(msg.control, self.layer)
                if mapping is not None:
                    self.handle_cc(msg.control, msg.value, mapping)
                    return
                # A knob mapped on some other layer is still one of this
                # controller's knobs. It is consumed and stays silent rather than
                # reaching the synth as a raw CC that would mean something else.
                if msg.control in self.mapped_ccs:
                    self.log_inactive(msg.control, msg.value)
                    return
                self.log_unmapped(msg.control, msg.value)

        if self.thru:
            self.forward(msg)

    def handle_layer(self, cc_value: int) -> None:
        """Pick the active layer from the layer knob's position.

        The same region split and boundary dead zone as any other quantized
        parameter, so a pot resting on an edge cannot flip between two layers.
        Nothing is sent to the synth: the knobs now point at the wrong values for
        the new layer, and resending from their stale positions would overwrite
        the patch. Each knob takes effect on its next move.
        """
        layer = alpha_juno.convert(self.layer_param, cc_value, previous=self.layer,
                                   hysteresis=self.layer_hysteresis)
        if layer == self.layer:
            return

        self.layer = layer
        self.stats["layer"] += 1
        if not self.quiet:
            active = self.cfg.layers[layer]
            print(f"Received CC{self.cfg.layer_cc:<3} val {cc_value:<3} -> layer "
                  f"{active.label}, {len(active.by_cc)} knob(s) mapped")

    def log_inactive(self, cc: int, cc_value: int) -> None:
        """Report, once per layer, a knob that does nothing on the current layer."""
        self.stats["inactive"] += 1
        if self.quiet or (self.layer, cc) in self.inactive_seen:
            return
        self.inactive_seen.add((self.layer, cc))
        others = "/".join(str(l.number) for l in self.cfg.layers if cc in l.by_cc)
        print(f"Received CC{cc:<3} val {cc_value:<3} -> nothing on layer "
              f"{self.cfg.layers[self.layer].label} (mapped on layer {others}), ignored")

    def forward(self, msg) -> None:
        """Send an untranslated message straight out, ahead of the sysex queue.

        Deliberately not rate limited: delaying note messages to make room for
        parameter edits would be far worse than the extra bytes on the wire.
        """
        if not self.dry_run:
            self.outport.send(msg)
        self.stats["thru"] += 1
        if self.verbose and msg.type not in QUIET_TYPES:
            print(f"    {'would pass' if self.dry_run else 'passed'} through: {msg}")

    def log_unmapped(self, cc: int, cc_value: int) -> None:
        self.stats["unmapped"] += 1
        if self.quiet or (self.layer, cc) in self.unmapped_seen:
            return
        self.unmapped_seen.add((self.layer, cc))
        fate = "not mapped, passed through" if self.thru else "not mapped"
        scope = " on this layer" if self.cfg.layering else ""
        print(f"Received CC{cc:<3} val {cc_value:<3} -> {fate} "
              f"(further CC{cc} messages{scope} will be silent)")

    def handle_cc(self, cc: int, cc_value: int, mapping) -> None:
        param = mapping.param
        previous = self.last_value.get(param.index)
        value = alpha_juno.convert(param, cc_value, mode=mapping.mode,
                                   previous=previous, hysteresis=self.cfg.hysteresis)

        if value == previous:
            self.stats["unchanged"] += 1
            if self.verbose:
                print(f"Received CC{cc:<3} val {cc_value:<3} -> {param.name} "
                      f"= {param.label(value)} (unchanged)")
            return

        if param.index in self.pending:
            self.stats["coalesced"] += 1
        self.pending[param.index] = (value, mapping)

        if not self.quiet:
            print(f"Received CC{cc:<3} val {cc_value:<3} -> sending {param.name} "
                  f"= {param.label(value)}")

    def flush(self, now: float) -> None:
        """Send at most one queued parameter, respecting the rate limit."""
        if not self.pending or now - self.last_send < self.interval:
            return

        index = next(iter(self.pending))
        value, mapping = self.pending.pop(index)
        frame = alpha_juno.build_sysex(
            index, value,
            channel=self.cfg.synth_channel,
            level=self.cfg.level_byte,
            group=self.cfg.group_byte,
        )

        if not self.dry_run:
            self.outport.send(mido.Message("sysex", data=frame[1:-1]))
        self.last_value[index] = value
        self.last_send = now
        self.stats["sent"] += 1

        if self.verbose:
            prefix = "would send" if self.dry_run else "sent"
            print(f"    {prefix}: {alpha_juno.hex_string(frame)}"
                  f"   ({mapping.param.name} = {value})")

    def drain(self) -> None:
        """Push out anything still queued at shutdown, honouring the rate limit."""
        while self.pending:
            self.flush(time.monotonic())
            time.sleep(self.interval)


def layer_report(cfg):
    """Describe each layer and the slice of the layer knob's travel that selects it."""
    param = alpha_juno.make_layer_param(cfg.layer_count)
    lines = [f"Layer knob: CC{cfg.layer_cc}, {cfg.layer_count} layers"]
    width = max(len(layer.label) for layer in cfg.layers)
    for index, layer in enumerate(cfg.layers):
        low, high = alpha_juno.region_bounds(param, index)
        marker = "->" if index == cfg.startup_layer - 1 else "  "
        lines.append(f" {marker} layer {layer.label:<{width}}  CC {low:>3}-{high:<3}  "
                     f"{len(layer.by_cc)} knob(s)")
    lines.append(f"    Assuming layer {cfg.layers[cfg.startup_layer - 1].label} until the "
                 f"knob is moved; its real position cannot be read.")
    return lines


def run(cfg, in_name, out_name, dry_run=False, quiet=False, verbose=False) -> int:
    listen = "any channel" if cfg.listen_channel is None else f"channel {cfg.listen_channel}"
    print()
    print(f"Input:   {in_name}")
    print(f"Output:  {out_name}" + ("   (DRY RUN - nothing will be sent)" if dry_run else ""))
    print(f"Listening on {listen}, sending to synth channel {cfg.synth_channel}")
    mapped = len(cfg.all_mapped_ccs())
    if cfg.layering:
        summary = f"{mapped} knob(s) mapped across {cfg.layer_count} layers"
    else:
        summary = f"{len(cfg.by_cc)} of 36 parameters mapped"
        if cfg.disabled:
            summary += f" ({len(cfg.disabled)} switched off)"
    print(f"{summary}, rate limit {cfg.max_msgs_per_sec} msg/s")
    if cfg.layering:
        for line in layer_report(cfg):
            print(line)
    if cfg.thru:
        print("Thru is ON: notes and unmapped CCs are forwarded to the output")
        if in_name == out_name:
            print("Warning: input and output are the same port, so thru will echo "
                  "messages straight back", file=sys.stderr)
    print("Press Ctrl+C to exit.\n")

    with mido.open_input(in_name) as inport, mido.open_output(out_name) as outport:
        router = Router(cfg, outport, dry_run=dry_run, quiet=quiet, verbose=verbose)
        try:
            while True:
                idle = True
                for msg in inport.iter_pending():
                    idle = False
                    router.handle(msg)
                router.flush(time.monotonic())
                if idle:
                    time.sleep(0.001)
        except KeyboardInterrupt:
            print("\n\nShutting down...")
            router.drain()
            s = router.stats
            print(f"CC received: {s['cc']}  (unmapped {s['unmapped']}, "
                  f"unchanged {s['unchanged']})")
            print(f"Sysex sent:  {s['sent']}  (coalesced away {s['coalesced']})")
            if cfg.layering:
                print(f"Layer:       {router.layer + 1} at exit, "
                      f"{s['layer']} change(s), {s['inactive']} CC(s) idle on their layer")
            if cfg.thru:
                print(f"Passed thru: {s['thru']}")
    return 0


def _drain_input(inport, seconds=0.25) -> None:
    """Swallow whatever is already queued, plus the tail of a knob sweep."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for _ in inport.iter_pending():
            pass
        time.sleep(0.01)


class MoveDetector:
    """Decides when a control has been moved deliberately rather than brushed.

    A CC has to travel `threshold` counts within one prompt before it counts as
    the answer, so catching a neighbouring knob on the way past no longer assigns
    it. The span tracked per CC is the widest excursion seen, so a sweep up and
    back down still registers. A switch that sends one value per press registers
    on the second press, when it sends the other value.
    """

    def __init__(self, threshold=LEARN_MOVE_THRESHOLD):
        self.threshold = max(0, threshold)
        self.spans = {}          # cc -> [lowest, highest] seen during this prompt

    def reset(self) -> None:
        self.spans.clear()

    def feed(self, cc: int, value: int) -> bool:
        """Record one CC message. True once that CC has moved far enough."""
        span = self.spans.get(cc)
        if span is None:
            self.spans[cc] = [value, value]
            span = self.spans[cc]
        elif value < span[0]:
            span[0] = value
        elif value > span[1]:
            span[1] = value
        return span[1] - span[0] >= self.threshold


def _wait_for_move(inport, listen_channel, detector):
    """Block until a control is moved far enough, or the user types a line.

    Returns ('cc', n) or ('line', s).
    """
    detector.reset()
    while True:
        for msg in inport.iter_pending():
            if msg.type != "control_change":
                continue
            if listen_channel is not None and msg.channel + 1 != listen_channel:
                continue
            if detector.feed(msg.control, msg.value):
                return ("cc", msg.control)
        try:
            ready, _, _ = select.select([sys.stdin], [], [], 0.05)
        except (KeyboardInterrupt, OSError):
            return ("line", "q")
        if ready:
            line = sys.stdin.readline()
            if line == "":
                return ("line", "q")
            return ("line", line.strip().lower())


def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip().lower()
    except (KeyboardInterrupt, EOFError):
        return "q"


def _resize_layers(cfg, count: int) -> None:
    """Grow or shrink cfg.layers to `count`, keeping what the layers already hold."""
    dropped = sum(len(layer.by_cc) for layer in cfg.layers[count:])
    if dropped:
        print(f"  dropping {dropped} assignment(s) from layer(s) beyond {count}.")
    cfg.layers = cfg.layers[:count]
    while len(cfg.layers) < count:
        cfg.layers.append(config_mod.LayerMap(number=len(cfg.layers) + 1))


def setup_layers(cfg, inport, detector) -> bool:
    """Ask whether to use layers, how many, and which knob selects them.

    Returns False if the user backed out, in which case nothing is written.
    """
    print("A layer is a complete set of knob assignments. One knob selects between")
    print("them, so a controller with fewer knobs than the Juno has parameters can")
    print("still reach all 36 - ten knobs over four layers is forty assignments.")

    if cfg.layering:
        print(f"\nThis config already has {cfg.layer_count} layer(s), selected by "
              f"CC{cfg.layer_cc}.")
        if _ask("Keep that arrangement? [Y/n] ") in ("", "y", "yes"):
            return True
    elif _ask("\nUse layers? [y/N] ") not in ("y", "yes"):
        cfg.layer_cc = None
        _resize_layers(cfg, 1)
        return True

    while True:
        answer = _ask(f"How many layers? [1-{alpha_juno.MAX_LAYERS}] ")
        if answer in ("q", "quit"):
            return False
        try:
            count = int(answer)
        except ValueError:
            print(f"  a number 1-{alpha_juno.MAX_LAYERS}, or q to give up.")
            continue
        if 1 <= count <= alpha_juno.MAX_LAYERS:
            break
        print(f"  1-{alpha_juno.MAX_LAYERS}, please.")

    if count == 1:
        cfg.layer_cc = None
        _resize_layers(cfg, 1)
        print("One layer, so no layer knob is needed.")
        return True

    print("\nFirst, the layer knob itself. It means the same thing on every layer,")
    print("so it can never be one of the parameter assignments.")
    print("  move the knob that will select the layer... ", end="", flush=True)
    _drain_input(inport, 0.25)
    kind, payload = _wait_for_move(inport, cfg.listen_channel, detector)
    if kind == "line":
        print("cancelled.")
        return False

    cfg.layer_cc = payload
    print(f"got CC{payload}")
    _drain_input(inport, 0.4)

    # An existing assignment on that CC would make the written config invalid.
    for layer in cfg.layers:
        stolen = layer.by_cc.pop(cfg.layer_cc, None)
        if stolen is not None:
            print(f"  (CC{cfg.layer_cc} was {stolen.param.name} on layer "
                  f"{layer.number}; that parameter is now unassigned there)")
    _resize_layers(cfg, count)
    return True


def learn_layer(inport, cfg, assigned, detector, skip=()) -> str:
    """Walk the parameter list once, capturing a CC for each one the user touches.

    Parameters in `skip` are left out: they were assigned on an earlier layer, and
    the point of a later layer is to reach what the earlier ones could not.

    Returns 'done' at the end of the list, 'next' to move on to the next layer, or
    'quit' to stop learning altogether.
    """
    params = [p for p in PARAMETERS if p.index not in skip]
    # Repeated on every prompt rather than only in the header, which scrolls out
    # of sight long before the end of a 36-parameter walk.
    keys = "Enter skip, x clear, b back, " + ("n next layer, " if cfg.layering else "")
    i = 0
    while i < len(params):
        param = params[i]
        current = assigned.get(param.index)
        current_text = f"currently CC{current}" if current is not None else "unassigned"

        print(f"[{i + 1:>2}/{len(params)}] {param.name}  "
              f"({param.describe_range()})  [{current_text}]")
        print(f"         move a control  ({keys}q finish)... ", end="", flush=True)

        _drain_input(inport, 0.15)
        kind, payload = _wait_for_move(inport, cfg.listen_channel, detector)

        if kind == "line":
            if payload == "q":
                print("finishing.")
                return "quit"
            if payload == "n" and cfg.layering:
                print("next layer.")
                return "next"
            if payload == "b":
                print("back.")
                i = max(0, i - 1)
                continue
            if payload == "x":
                assigned.pop(param.index, None)
                print("unassigned.")
                i += 1
                continue
            print("skipped." if current is None else f"kept CC{current}.")
            i += 1
            continue

        cc = payload
        # The layer knob means the same thing on every layer, so it can never be
        # one of the assignments a layer is made of.
        if cc == cfg.layer_cc:
            print(f"that is the layer knob (CC{cc}) - move a different control.")
            continue

        stolen = next((idx for idx, c in assigned.items()
                       if c == cc and idx != param.index), None)
        assigned[param.index] = cc
        if stolen is not None:
            del assigned[stolen]
            print(f"got CC{cc}  (taken from {PARAMETERS[stolen].name}, "
                  f"which is now unassigned)")
        else:
            print(f"got CC{cc}")

        # Let the rest of the knob sweep go by before prompting again.
        _drain_input(inport, 0.4)
        i += 1
    return "done"


def learn(cfg, in_name, path, only_layer=None, threshold=LEARN_MOVE_THRESHOLD) -> int:
    """Capture knob assignments for one layer or for each layer in turn."""
    print()
    print(f"Input:  {in_name}")

    try:
        inport = mido.open_input(in_name)
    except (IOError, OSError) as exc:
        print(f"Could not open input port: {exc}")
        return 1

    detector = MoveDetector(threshold)
    quit_early = False

    with inport:
        # Layers first: how many there are decides how much walking follows, and
        # the layer knob has to be known before any parameter can claim a CC.
        if only_layer is None:
            print()
            if not setup_layers(cfg, inport, detector):
                print("\nNothing was changed.")
                return 0

        targets = [only_layer - 1] if only_layer else list(range(cfg.layer_count))

        # A layer being walked starts empty: what is already in the config is not
        # something this session assigned, and counting it would both inflate the
        # summary and make later layers believe every parameter was taken. Layers
        # NOT being walked keep their contents, so --layer N edits one layer
        # without destroying the rest of the file.
        assigned = []
        for index, layer in enumerate(cfg.layers):
            if index in targets:
                assigned.append({})
            else:
                assigned.append({m.param.index: m.cc for m in layer.by_cc.values()})

        # What the walked layers already held, purely so the save prompt can warn
        # that saving replaces it rather than adding to it.
        existing = sum(len(cfg.layers[index].by_cc) for index in targets)

        print("\nFor each parameter, move the control you want to assign to it.")
        print("Starting from a clean sheet: only what you assign now is counted, and")
        print(f"only that is written to {path} at the end.")
        print(f"  a control counts once it has moved {detector.threshold} CC counts, so "
              f"brushing past one does not assign it")
        print("  Enter  leave this parameter unassigned and move on")
        print("  x      unassign this parameter, then move on")
        print("  b      go back one parameter")
        if cfg.layering:
            print("  n      skip the rest of this layer")
        print("  q      stop here and save what you have so far")
        if cfg.layering:
            print(f"\nCC{cfg.layer_cc} selects the layer and cannot be assigned to a "
                  f"parameter.")
            if only_layer:
                print(f"Learning layer {cfg.layers[only_layer - 1].label} only; "
                      f"the other layers are left as they are.")
            else:
                print("Each layer offers only the parameters the earlier layers did not "
                      "take.")
        print()

        # Only what this session has assigned, so the walk never skips a parameter
        # on the strength of something already in the config file.
        done = set()

        for position, index in enumerate(targets):
            if cfg.layering:
                print(f"=== Layer {cfg.layers[index].label} "
                      f"({position + 1} of {len(targets)}) ===")
            if len(done) >= len(PARAMETERS):
                print("Every parameter is already assigned on an earlier layer - "
                      "nothing left to do.")
                break

            outcome = learn_layer(inport, cfg, assigned[index], detector, skip=done)
            if outcome == "quit":
                quit_early = True
                break
            done |= set(assigned[index])

            if position + 1 < len(targets):
                nxt = cfg.layers[targets[position + 1]].label
                answer = _ask(f"\nLayer {cfg.layers[index].label} done, "
                              f"{len(assigned[index])} assigned, "
                              f"{len(PARAMETERS) - len(done)} parameter(s) still free.\n"
                              f"  [Enter] to go on to layer {nxt}, q to finish: ")
                if answer in ("q", "quit"):
                    quit_early = True
                    break

    print()
    if not any(assigned):
        print("Nothing was assigned, leaving the config alone.")
        return 0

    total = sum(len(assigned[index]) for index in targets)
    print(f"{total} parameter(s) assigned"
          + (" (learn ended early)" if quit_early else "") + ":")
    for index, layer_assigned in enumerate(assigned):
        if cfg.layering:
            kept = "" if index in targets else "   (kept from the config, not walked)"
            print(f"  layer {cfg.layers[index].label}:{kept}")
        for param in PARAMETERS:
            if param.index in layer_assigned:
                print(f"  {'  ' if cfg.layering else ''}CC{layer_assigned[param.index]:<4} "
                      f"{param.name}")

    mappings = [{p.index: a.get(p.index) for p in PARAMETERS} for a in assigned]
    if not cfg.layering:
        mappings = mappings[0]
    try:
        prompt = ""
        if existing and os.path.exists(path):
            what = (f"layer {cfg.layers[only_layer - 1].label} of {path}"
                    if only_layer else path)
            prompt = (f"\nSaving replaces {what}: {existing} assignment(s) it holds now "
                      f"are not in the list above and will be gone.")
        prompt += f"\nWrite this to {path}"
        prompt += " (overwriting it)? [y/N] " if os.path.exists(path) else "? [y/N] "
        answer = input(prompt).strip().lower()
    except (KeyboardInterrupt, EOFError):
        answer = ""

    if answer not in ("y", "yes"):
        print("Not written.")
        return 0

    config_mod.write_default(path, mappings, cfg)
    print(f"Wrote {path}")
    return 0


def init_layout(count, layer_cc):
    """Work out what --init-config should write: one layer, or a layered scaffold.

    Layer 1 gets the usual parameter n -> CC n starting point and the rest are
    left empty, ready to have numbers typed over their `off`s.
    """
    cfg = config_mod.Config()
    default = config_mod.default_mappings()
    if count is None and layer_cc is None:
        return default, cfg

    count = count if count is not None else 2
    if not 1 <= count <= alpha_juno.MAX_LAYERS:
        raise ValueError(f"--layers must be 1-{alpha_juno.MAX_LAYERS}")
    if layer_cc is None:
        raise ValueError("--layers needs --layer-cc too, naming the knob that selects "
                         "the layer")
    if not 0 <= layer_cc <= 127:
        raise ValueError("--layer-cc must be 0-127")
    if layer_cc in default.values():
        raise ValueError(f"CC{layer_cc} is already used by the default CC0-CC35 mapping; "
                         f"pick a layer knob outside that range (CC102-CC119 are "
                         f"officially undefined)")

    cfg.layer_cc = layer_cc
    cfg.layers = [config_mod.LayerMap(number=n + 1) for n in range(count)]
    return [default] + [{} for _ in range(count - 1)], cfg


def _sigterm(signum, frame):
    raise KeyboardInterrupt


def pick_port(names, kind, cli_value, cfg_value):
    """Resolve a port from --in/--out, else the config, else by asking.

    An explicit command line port that cannot be found is an error; a stale one
    from the config just falls back to the prompt, since the device may simply
    not be plugged in today.
    """
    if cli_value is not None:
        return midi_io.resolve(names, cli_value, kind)
    if cfg_value is not None:
        try:
            return midi_io.resolve(names, cfg_value, kind, list_available=False)
        except midi_io.PortError as exc:
            # choose() lists the ports next, so keep this to one line.
            print(f"Configured {kind} port unavailable ({exc}), asking instead.\n",
                  file=sys.stderr)
    return midi_io.choose(names, kind)


def save_ports(path, cfg, in_name, out_name, names_in, names_out) -> None:
    """Store the ports just chosen back into the config file."""
    stored_in = midi_io.storable_name(in_name, names_in)
    stored_out = midi_io.storable_name(out_name, names_out)
    if not os.path.exists(path):
        print(f"Cannot save ports: {path} does not exist "
              f"(create it with --init-config).", file=sys.stderr)
        return
    try:
        config_mod.update_ports(path, stored_in, stored_out)
    except OSError as exc:
        print(f"Could not save ports to {path}: {exc}", file=sys.stderr)
        return
    print(f"Saved ports to {path}:")
    print(f"  input:  {stored_in}")
    print(f"  output: {stored_out}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="cc2juno",
        description="Translate MIDI CC messages into Roland Alpha Juno tone parameter sysex.",
    )
    parser.add_argument("-c", "--config", default=config_mod.DEFAULT_CONFIG_NAME,
                        help="mapping file to use (default: %(default)s)")
    parser.add_argument("--init-config", nargs="?", const="", metavar="PATH",
                        help="write a starting-point config and exit")
    parser.add_argument("--learn", action="store_true",
                        help="interactively assign CCs by moving your controls")
    parser.add_argument("--layer", type=int, metavar="N",
                        help="start on layer N; with --learn, assign only that layer")
    parser.add_argument("--learn-threshold", type=int, metavar="N",
                        default=LEARN_MOVE_THRESHOLD,
                        help="CC counts a control must move in learn mode before it "
                             "counts (default: %(default)s, 0 to accept any message)")
    parser.add_argument("--layers", type=int, metavar="N",
                        help="with --init-config, scaffold N layers (1-%d)"
                             % alpha_juno.MAX_LAYERS)
    parser.add_argument("--layer-cc", type=int, metavar="CC",
                        help="with --init-config, the CC of the layer-select knob")
    parser.add_argument("-i", "--in", dest="in_port", metavar="PORT",
                        help="input port index or name substring (skips the prompt)")
    parser.add_argument("-o", "--out", dest="out_port", metavar="PORT",
                        help="output port index or name substring (skips the prompt)")
    parser.add_argument("--ask-ports", action="store_true",
                        help="always prompt for ports, ignoring the ones in the config")
    parser.add_argument("--save-ports", action="store_true",
                        help="write the chosen ports back to the config as the defaults")
    parser.add_argument("--list-ports", action="store_true", help="list MIDI ports and exit")
    parser.add_argument("--list-params", action="store_true",
                        help="list the 36 Alpha Juno parameters and exit")
    parser.add_argument("--channel", type=int, metavar="N",
                        help="override the synth basic channel (1-16)")
    parser.add_argument("--rate", type=int, metavar="N",
                        help="override the outgoing sysex rate limit, messages/second")
    parser.add_argument("--thru", action=argparse.BooleanOptionalAction, default=None,
                        help="forward notes and unmapped CCs from the input to the "
                             "output (overrides midi.thru in the config)")
    parser.add_argument("--dry-run", action="store_true",
                        help="log what would be sent without sending anything")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="only report errors, not each message")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="also show the raw sysex bytes of every message sent")
    args = parser.parse_args(argv)

    # Keep the log usable when stdout is a pipe or a log file rather than a terminal.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    # Treat a polite kill the same as Ctrl+C, so queued sysex still gets flushed.
    signal.signal(signal.SIGTERM, _sigterm)

    if args.list_params:
        log_params()
        return 0

    if args.list_ports:
        midi_io.print_ports()
        return 0

    if not 0 <= args.learn_threshold <= 64:
        print("--learn-threshold must be 0-64", file=sys.stderr)
        return 1
    if args.layers is not None and args.init_config is None:
        print("--layers only applies to --init-config; to change the layer count of an "
              "existing config, edit the 'layers:' section.", file=sys.stderr)
        return 1
    if args.layer_cc is not None and args.init_config is None:
        print("--layer-cc only applies to --init-config; to change the layer knob of an "
              "existing config, edit the 'layers:' section.", file=sys.stderr)
        return 1

    if args.init_config is not None:
        path = args.init_config or args.config
        try:
            scaffold, cfg = init_layout(args.layers, args.layer_cc)
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 1
        if os.path.exists(path):
            try:
                answer = input(f"{path} already exists. Overwrite? [y/N] ").strip().lower()
            except (KeyboardInterrupt, EOFError):
                answer = ""
            if answer not in ("y", "yes"):
                print("Not written.")
                return 0
        config_mod.write_default(path, scaffold, cfg)
        if cfg.layering:
            print(f"Wrote {path}: layer 1 mapped to CC0-CC35, layers 2-{cfg.layer_count} "
                  f"empty, layer knob CC{cfg.layer_cc}.")
        else:
            print(f"Wrote {path} with all 36 parameters mapped to CC0-CC35.")
        return 0

    try:
        cfg = config_mod.load(args.config)
    except config_mod.ConfigError as exc:
        if args.learn and not os.path.exists(args.config):
            print(f"No config at {args.config} yet, starting from an empty mapping.\n")
            cfg = config_mod.Config()
        else:
            print(f"Config error: {exc}", file=sys.stderr)
            return 1

    if args.channel is not None:
        if not 1 <= args.channel <= 16:
            print("--channel must be 1-16", file=sys.stderr)
            return 1
        cfg.synth_channel = args.channel
    if args.rate is not None:
        if not 1 <= args.rate <= 1000:
            print("--rate must be 1-1000", file=sys.stderr)
            return 1
        cfg.max_msgs_per_sec = args.rate
    if args.thru is not None:
        cfg.thru = args.thru
    if args.layer is not None:
        if not cfg.layering:
            print("--layer needs a 'layers:' section in the config", file=sys.stderr)
            return 1
        if not 1 <= args.layer <= cfg.layer_count:
            print(f"--layer must be 1-{cfg.layer_count}", file=sys.stderr)
            return 1
        cfg.startup_layer = args.layer

    cfg_in = None if args.ask_ports else cfg.port_input
    cfg_out = None if args.ask_ports else cfg.port_output

    try:
        names_in = midi_io.input_names()
        if args.learn:
            in_name = pick_port(names_in, "input", args.in_port, cfg_in)
            return learn(cfg, in_name, args.config, only_layer=args.layer,
                         threshold=args.learn_threshold)

        in_name = pick_port(names_in, "input", args.in_port, cfg_in)
        if args.in_port is None and cfg_in is None:
            print()
        names_out = midi_io.output_names()
        out_name = pick_port(names_out, "output", args.out_port, cfg_out)
    except midi_io.PortError as exc:
        print(f"MIDI port error: {exc}", file=sys.stderr)
        return 1

    if args.save_ports:
        save_ports(args.config, cfg, in_name, out_name, names_in, names_out)

    try:
        return run(cfg, in_name, out_name,
                   dry_run=args.dry_run, quiet=args.quiet, verbose=args.verbose)
    except (IOError, OSError) as exc:
        print(f"MIDI error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Piped into head/less and the reader went away. Exit quietly.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)
