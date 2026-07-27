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

        self.unmapped_seen = set()
        self.stats = {"cc": 0, "unmapped": 0, "sent": 0, "coalesced": 0,
                      "unchanged": 0, "thru": 0}

    def handle(self, msg) -> None:
        """Convert a mapped CC to sysex; pass anything else through if --thru is on."""
        if msg.type == "control_change":
            listen = self.cfg.listen_channel
            if listen is None or msg.channel + 1 == listen:
                self.stats["cc"] += 1
                mapping = self.cfg.lookup_cc(msg.control)
                if mapping is not None:
                    self.handle_cc(msg.control, msg.value, mapping)
                    return
                self.log_unmapped(msg.control, msg.value)

        if self.thru:
            self.forward(msg)

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
        if self.quiet or cc in self.unmapped_seen:
            return
        self.unmapped_seen.add(cc)
        fate = "not mapped, passed through" if self.thru else "not mapped"
        print(f"Received CC{cc:<3} val {cc_value:<3} -> {fate} "
              f"(further CC{cc} messages will be silent)")

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


def run(cfg, in_name, out_name, dry_run=False, quiet=False, verbose=False) -> int:
    listen = "any channel" if cfg.listen_channel is None else f"channel {cfg.listen_channel}"
    print()
    print(f"Input:   {in_name}")
    print(f"Output:  {out_name}" + ("   (DRY RUN - nothing will be sent)" if dry_run else ""))
    print(f"Listening on {listen}, sending to synth channel {cfg.synth_channel}")
    summary = f"{len(cfg.by_cc)} of 36 parameters mapped"
    if cfg.disabled:
        summary += f" ({len(cfg.disabled)} switched off)"
    print(f"{summary}, rate limit {cfg.max_msgs_per_sec} msg/s")
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


def _wait_for_cc_or_line(inport, listen_channel):
    """Block until a CC arrives or the user presses Enter. Returns ('cc', n) or ('line', s)."""
    while True:
        for msg in inport.iter_pending():
            if msg.type != "control_change":
                continue
            if listen_channel is not None and msg.channel + 1 != listen_channel:
                continue
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


def learn(cfg, in_name, path) -> int:
    """Walk the parameter list, capturing a CC number for each one the user touches."""
    assigned = {m.param.index: m.cc for m in cfg.by_cc.values()}

    print()
    print(f"Input:  {in_name}")
    print("\nLearn mode. For each parameter, move the control you want to assign to it.")
    print("  Enter  keep the current assignment and move on")
    print("  x      unassign this parameter, then move on")
    print("  b      go back one parameter")
    print("  q      finish and save what you have so far")
    print()

    try:
        inport = mido.open_input(in_name)
    except (IOError, OSError) as exc:
        print(f"Could not open input port: {exc}")
        return 1

    quit_early = False
    with inport:
        i = 0
        while i < len(PARAMETERS):
            param = PARAMETERS[i]
            current = assigned.get(param.index)
            current_text = f"currently CC{current}" if current is not None else "unassigned"

            print(f"[{i + 1:>2}/{len(PARAMETERS)}] {param.name}  "
                  f"({param.describe_range()})  [{current_text}]")
            print("         move a control... ", end="", flush=True)

            _drain_input(inport, 0.15)
            kind, payload = _wait_for_cc_or_line(inport, cfg.listen_channel)

            if kind == "line":
                if payload == "q":
                    print("finishing.")
                    quit_early = True
                    break
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

    print()
    if not assigned:
        print("Nothing was assigned, leaving the config alone.")
        return 0

    print(f"{len(assigned)} parameter(s) assigned"
          + (" (learn ended early)" if quit_early else "") + ":")
    for param in PARAMETERS:
        if param.index in assigned:
            print(f"  CC{assigned[param.index]:<4} {param.name}")

    mappings = {p.index: assigned.get(p.index) for p in PARAMETERS}
    try:
        prompt = f"\nWrite this to {path}"
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

    if args.init_config is not None:
        path = args.init_config or args.config
        if os.path.exists(path):
            try:
                answer = input(f"{path} already exists. Overwrite? [y/N] ").strip().lower()
            except (KeyboardInterrupt, EOFError):
                answer = ""
            if answer not in ("y", "yes"):
                print("Not written.")
                return 0
        config_mod.write_default(path)
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

    cfg_in = None if args.ask_ports else cfg.port_input
    cfg_out = None if args.ask_ports else cfg.port_output

    try:
        names_in = midi_io.input_names()
        if args.learn:
            in_name = pick_port(names_in, "input", args.in_port, cfg_in)
            return learn(cfg, in_name, args.config)

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
