"""cc2juno for the Tulip Creative Computer - MIDI CC to Roland Alpha Juno sysex.

Turns a generic CC controller into a PG-300 for an Alpha Juno 1/2 or MKS-50,
running on Tulip instead of a laptop.  MIDI in (TRS or USB) is translated and
sent back out to both MIDI outs.

    execfile('/user/cc2juno.py')     # loads /user/cc2juno.yaml and starts

or, to keep control of it from the REPL:

    import cc2juno
    cc2juno.start()
    cc2juno.status()
    cc2juno.stop()

Everything is configured in cc2juno.yaml - the same file the desktop version
uses.  There is no learn mode and no prompting here: build and test the config
on a PC, copy it to /user, or edit it on screen with edit('/user/cc2juno.yaml').

Structurally this differs from the desktop version in one way that matters.
There, a loop polls the input port.  Here, MIDI arrives in a callback and sysex
leaves from a frame callback, so the callback does as little as possible: it
maps, queues, and forwards, but never prints.  All printing happens on the frame
side where a slow terminal cannot cost us incoming MIDI bytes.
"""

import alpha_juno
import config as config_mod
from alpha_juno import PARAMETERS
from config import LOG_OFF, LOG_QUIET, LOG_NORMAL, LOG_VERBOSE

try:
    import tulip
    import midi
except ImportError:      # importable off-device so the pure logic can be checked
    tulip = None
    midi = None

try:
    from time import ticks_ms, ticks_diff, ticks_add, sleep_ms
except ImportError:      # CPython, for off-device checking only
    import time as _time

    def ticks_ms():
        return int(_time.monotonic() * 1000)

    def ticks_diff(a, b):
        return a - b

    def ticks_add(t, delta):
        return t + delta

    def sleep_ms(ms):
        _time.sleep(ms / 1000.0)


# Sysex messages to send in a single frame callback.  Tulip runs about 34 fps,
# so one per frame would cap the rate at 34/s regardless of max_msgs_per_sec.
MAX_PER_FRAME = 8

# Lines to print per frame.  Printing to the framebuffer terminal is not free,
# and a knob sweep can generate them faster than they can be drawn.
LOG_PER_FRAME = 4
LOG_QUEUE_MAX = 32

# Forwarded like everything else, but far too repetitive to log.
QUIET_STATUS = (0xF8, 0xFE, 0xF1, 0xF2)

_TYPE_NAMES = {
    0x80: "note off", 0x90: "note on", 0xA0: "poly aftertouch",
    0xB0: "control change", 0xC0: "program change", 0xD0: "aftertouch",
    0xE0: "pitch bend",
}


def _describe(m):
    status = m[0]
    if status >= 0xF0:
        return "system {:02X}".format(status)
    name = _TYPE_NAMES.get(status & 0xF0, "status {:02X}".format(status))
    return "{} ch{} {}".format(name, (status & 0x0F) + 1, list(m[1:]))


class Router:
    """Holds the mapping state, the outgoing rate limiter and the log queue."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.thru = cfg.thru
        self.log = cfg.log

        self.pending = {}          # param index -> (value, mapping), newest wins
        self.last_value = {}       # param index -> last value actually sent
        self.interval = max(1, 1000 // cfg.max_msgs_per_sec)
        self.next_send = ticks_ms()

        self.unmapped_seen = set()
        self.logq = []
        self.stats = {"cc": 0, "unmapped": 0, "sent": 0, "coalesced": 0,
                      "unchanged": 0, "thru": 0, "logs_dropped": 0}

    # ---- logging ----------------------------------------------------------
    # Called from the MIDI callback, so it must not print. Lines are queued and
    # drained a few at a time by the frame callback.

    def note(self, level, text):
        if level > self.log:
            return
        if len(self.logq) >= LOG_QUEUE_MAX:
            self.stats["logs_dropped"] += 1
            return
        self.logq.append(text)

    def pump_log(self, limit=LOG_PER_FRAME):
        count = 0
        while self.logq and count < limit:
            print(self.logq.pop(0))
            count += 1

    # ---- input ------------------------------------------------------------

    def on_midi(self, m):
        """Translate a mapped CC; forward anything else when thru is on."""
        if not m:
            return
        status = m[0]

        if status & 0xF0 == 0xB0 and len(m) >= 3:
            listen = self.cfg.listen_channel
            if listen is None or (status & 0x0F) + 1 == listen:
                self.stats["cc"] += 1
                mapping = self.cfg.lookup_cc(m[1])
                if mapping is not None:
                    self.handle_cc(m[1], m[2], mapping)
                    return
                self.log_unmapped(m[1], m[2])

        if self.thru:
            self.forward(m)

    def forward(self, m):
        """Send an untranslated message straight out, ahead of the sysex queue.

        Deliberately not rate limited: delaying note messages to make room for
        parameter edits would be far worse than the extra bytes on the wire.
        """
        tulip.midi_out(m)
        self.stats["thru"] += 1
        if self.log >= LOG_VERBOSE and m[0] not in QUIET_STATUS:
            self.note(LOG_VERBOSE, "    passed through: " + _describe(m))

    def log_unmapped(self, cc, cc_value):
        self.stats["unmapped"] += 1
        if cc in self.unmapped_seen:
            return
        self.unmapped_seen.add(cc)
        fate = "not mapped, passed through" if self.thru else "not mapped"
        self.note(LOG_NORMAL,
                  "Received CC{} val {} -> {} (further CC{} messages will be silent)".format(
                      cc, cc_value, fate, cc))

    def handle_cc(self, cc, cc_value, mapping):
        param = mapping.param
        previous = self.last_value.get(param.index)
        value = alpha_juno.convert(param, cc_value, mapping.mode,
                                   previous, self.cfg.hysteresis)

        if value == previous:
            self.stats["unchanged"] += 1
            self.note(LOG_VERBOSE, "Received CC{} val {} -> {} = {} (unchanged)".format(
                cc, cc_value, param.name, param.label(value)))
            return

        if param.index in self.pending:
            self.stats["coalesced"] += 1
        self.pending[param.index] = (value, mapping, cc, cc_value)

    # ---- output -----------------------------------------------------------

    def flush(self):
        """Send whatever the rate limit allows, newest value per parameter."""
        if not self.pending:
            return
        now = ticks_ms()

        # Do not bank up credit while idle: an untouched knob should not buy a
        # burst big enough to swamp the synth the moment it is touched.
        if ticks_diff(now, self.next_send) > self.interval * MAX_PER_FRAME:
            self.next_send = now

        count = 0
        while self.pending and count < MAX_PER_FRAME and ticks_diff(now, self.next_send) >= 0:
            self.send_one()
            self.next_send = ticks_add(self.next_send, self.interval)
            count += 1

    def send_one(self):
        index = next(iter(self.pending))
        value, mapping, cc, cc_value = self.pending.pop(index)
        frame = alpha_juno.build_sysex(index, value,
                                       self.cfg.synth_channel,
                                       self.cfg.level_byte,
                                       self.cfg.group_byte)
        tulip.midi_out(frame)
        self.last_value[index] = value
        self.stats["sent"] += 1

        param = mapping.param
        self.note(LOG_NORMAL, "CC{} val {} -> {} = {}".format(
            cc, cc_value, param.name, param.label(value)))
        self.note(LOG_VERBOSE, "    sent: " + alpha_juno.hex_string(frame))

    def drain(self, timeout_ms=3000):
        """Push out anything still queued, honouring the rate limit."""
        deadline = ticks_add(ticks_ms(), timeout_ms)
        while self.pending and ticks_diff(deadline, ticks_ms()) > 0:
            self.flush()
            sleep_ms(self.interval)
        self.pump_log(LOG_QUEUE_MAX)


# ---- module-level plumbing ------------------------------------------------
# Plain functions rather than bound methods, so the object handed to
# add_callback is the identical object handed to remove_callback later.

_router = None


def _on_midi(m):
    if _router is not None:
        _router.on_midi(m)


def _on_frame(data=None):
    if _router is not None:
        _router.flush()
        _router.pump_log()


def params():
    """Print the 36 Alpha Juno parameters and their ranges."""
    for p in PARAMETERS:
        line = "{:2d}  {}  ({})".format(p.index, p.name, p.describe_range())
        if p.note:
            line += "  - " + p.note
        print(line)


def status():
    """Print the running counters."""
    if _router is None:
        print("cc2juno is not running.")
        return
    s = _router.stats
    print("CC received: {}  (unmapped {}, unchanged {})".format(
        s["cc"], s["unmapped"], s["unchanged"]))
    print("Sysex sent:  {}  (coalesced away {})".format(s["sent"], s["coalesced"]))
    if _router.thru:
        print("Passed thru: {}".format(s["thru"]))
    if s["logs_dropped"]:
        print("Log lines dropped to keep up: {}".format(s["logs_dropped"]))


def start(path=None, thru=None, log=None):
    """Load the config, hook the callbacks, and return to the REPL.

    `thru` and `log` override midi.thru and midi.log in the config.  Returns
    True once running, False if the config could not be loaded.
    """
    global _router

    if tulip is None or midi is None:
        print("cc2juno: this build has no tulip/midi modules - run it on Tulip.")
        return False

    try:
        cfg = config_mod.load(path)
    except config_mod.ConfigError as exc:
        print("Config error: {}".format(exc))
        return False

    if thru is not None:
        cfg.thru = bool(thru)
    if log is not None:
        try:
            cfg.log = config_mod.log_level(log)
        except config_mod.ConfigError as exc:
            print("{}".format(exc))
            return False

    if _router is not None:
        stop()

    _router = Router(cfg)
    midi.add_callback(_on_midi)
    tulip.frame_callback(_on_frame)

    listen = "any channel" if cfg.listen_channel is None else "channel {}".format(
        cfg.listen_channel)
    print()
    print("cc2juno - CC to Alpha Juno sysex")
    print("Config:  {}".format(cfg.path))
    summary = "{} of 36 parameters mapped".format(len(cfg.by_cc))
    if cfg.disabled:
        summary += " ({} switched off)".format(len(cfg.disabled))
    print("{}, rate limit {} msg/s".format(summary, cfg.max_msgs_per_sec))
    print("Listening on {}, sending to synth channel {}".format(listen, cfg.synth_channel))
    if cfg.thru:
        print("Thru is ON: notes and unmapped CCs are forwarded to the output")
    print("Running. cc2juno.status() for counters, cc2juno.stop() to stop.")
    print()
    return True


def stop():
    """Unhook the callbacks after flushing anything still queued."""
    global _router

    if _router is None:
        print("cc2juno is not running.")
        return

    try:
        midi.remove_callback(_on_midi)
    except (ValueError, KeyError, AttributeError):
        pass
    _router.drain()
    try:
        tulip.frame_callback()
    except TypeError:
        pass

    status()
    _router = None
    print("Stopped.")


if __name__ == "__main__":
    start()
