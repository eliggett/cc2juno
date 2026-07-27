#!/usr/bin/env python3
"""Tests for the Tulip build of cc2juno. Run on a PC with python3, not on Tulip.

    cd tulip && ./test_tulip.py

Tulip's `tulip` and `midi` modules are stubbed and the clock is faked, so the
mapping, scaling, rate limiting, coalescing and thru logic can all be checked
without hardware.  What this cannot check is Tulip itself: the real callback
signatures, MIDI jack wiring, and whether the synth likes the bytes.
"""

import sys
import types

sys.path.insert(0, ".")

# ---- stub out the two Tulip modules before importing cc2juno ---------------

sent = []
hooks = {"midi": [], "frame": []}

_tulip = types.ModuleType("tulip")
_tulip.midi_out = lambda m: sent.append(list(m))


def _frame_cb(fn=None, data=None):
    hooks["frame"] = [fn] if fn else []


_tulip.frame_callback = _frame_cb
sys.modules["tulip"] = _tulip

_midi = types.ModuleType("midi")
_midi.add_callback = lambda f: hooks["midi"].append(f)
_midi.remove_callback = lambda f: hooks["midi"].remove(f)
sys.modules["midi"] = _midi

import alpha_juno            # noqa: E402
import cc2juno               # noqa: E402
import config as config_mod  # noqa: E402
import miniyaml              # noqa: E402

# ---- fake clock, so rate limiting is testable without sleeping -------------

NOW = [0]
cc2juno.ticks_ms = lambda: NOW[0]
cc2juno.sleep_ms = lambda ms: NOW.__setitem__(0, NOW[0] + ms)

CONFIG_TEXT = """\
# a config exercising every syntax the mini reader has to handle
ports:
  input: "ignored on tulip"
  output:

midi:
  synth_channel: 1
  listen_channel: any
  level_byte: 0x20
  group_byte: 0x01
  max_msgs_per_sec: 100
  hysteresis: 2
  thru: false
  log: normal

mappings:
  "VCA Env. Mode":  2      # 4 options, quantized into regions
  "VCF Cutoff":     16     # full range
  "VCF Resonance":  17
  "Chorus Switch":  10     # 2 options
  "Bender Range":   {cc: 90, mode: clamp}
  "LFO Rate":       off    # switched off, releases CC24
  "LFO Delay":      "no"
  "ENV T1":         null
  "ENV T2":         ~
"""

CONFIG_PATH = "/tmp/cc2juno_test.yaml"

FAILS = []


def check(name, cond, extra=""):
    if cond:
        print("  ok   " + name)
    else:
        print("  FAIL " + name + ("   " + str(extra) if extra != "" else ""))
        FAILS.append(name)


def section(title):
    print("\n-- " + title + " --")


def frames(n=1, ms=30):
    """Advance time and run the frame callback, as Tulip would at ~34 fps."""
    for _ in range(n):
        NOW[0] += ms
        cc2juno._on_frame()


def reset(**kw):
    del sent[:]
    cc2juno._router = None
    hooks["midi"] = []
    NOW[0] = 0
    quiet = kw.pop("quiet", True)
    if quiet:
        kw.setdefault("log", "off")
    out = sys.stdout
    sys.stdout = open("/dev/null", "w") if quiet else out
    try:
        started = cc2juno.start(CONFIG_PATH, **kw)
    finally:
        if quiet:
            sys.stdout.close()
        sys.stdout = out
    assert started, "start() failed"
    del sent[:]


def raises(fn, exc):
    try:
        fn()
    except exc as e:
        return str(e)
    except Exception as e:          # noqa: BLE001 - wrong type is a failure
        return "WRONG EXCEPTION: " + repr(e)
    return None


# ---------------------------------------------------------------------------

handle = open(CONFIG_PATH, "w")
handle.write(CONFIG_TEXT)
handle.close()

section("mini yaml reader")
raw = miniyaml.loads(CONFIG_TEXT)
check("sections found", sorted(raw.keys()) == ["mappings", "midi", "ports"], sorted(raw))
check("hex parsed as int", raw["midi"]["level_byte"] == 0x20, raw["midi"]["level_byte"])
check("bare false is a bool", raw["midi"]["thru"] is False, raw["midi"]["thru"])
check("bare off is a bool", raw["mappings"]["LFO Rate"] is False)
check("quoted no stays a string", raw["mappings"]["LFO Delay"] == "no")
check("null is None", raw["mappings"]["ENV T1"] is None)
check("tilde is None", raw["mappings"]["ENV T2"] is None)
check("empty value is None", raw["ports"]["output"] is None)
check("flow map parsed", raw["mappings"]["Bender Range"] == {"cc": 90, "mode": "clamp"},
      raw["mappings"]["Bender Range"])
check("trailing comment stripped", raw["mappings"]["VCA Env. Mode"] == 2)
check("quoted key keeps its spaces", "VCF Cutoff" in raw["mappings"])
check("apostrophes inside a comment survive",
      miniyaml.loads('a: 1   # 0=4\', 1=8\', 2=16\'')["a"] == 1)
check("hash inside a quoted value is kept",
      miniyaml.loads('a: "port #2"')["a"] == "port #2")

section("mini yaml rejects what it cannot do")
for text, why in (
    ("a:\n  - one\n", "lists"),
    ("a:\n  b:\n    c: 1\n", "deep nesting"),
    ("a: 1\na: 2\n", "duplicate top-level key"),
    ("a:\n  b: 1\n  b: 2\n", "duplicate key in a section"),
    ("  b: 1\n", "indented with no section"),
    ("a: 'unterminated\n", "unterminated quote"),
    ("a: 0xZZ\n", "bad hex"),
    ("nocolon\n", "missing colon"),
    ("a:\n\tb: 1\n", "tab indent"),
):
    msg = raises(lambda t=text: miniyaml.loads(t), miniyaml.YamlError)
    check("rejects " + why, msg is not None and "line" in str(msg), msg)

section("config validation")
cfg = config_mod.load(CONFIG_PATH)
check("mapped count", len(cfg.by_cc) == 5, len(cfg.by_cc))
check("all four off spellings disabled", len(cfg.disabled) == 4, sorted(cfg.disabled))
check("off releases its CC", cfg.lookup_cc(24) is None)
check("clamp mode kept", cfg.by_cc[90].mode == "clamp", cfg.by_cc[90].mode)
check("hex level byte", cfg.level_byte == 0x20)
check("listen_channel any is None", cfg.listen_channel is None)
check("ports section ignored, not rejected", True)

for text, why in (
    ('mappings:\n  "Nope": 1\n', "unknown parameter"),
    ('mappings:\n  "VCF Cutoff": 200\n', "CC out of range"),
    ('mappings:\n  "VCF Cutoff": 1\n  "LFO Rate": 1\n', "CC used twice"),
    ('mappings:\n  "VCF Cutoff": 1\n  "vcf_cutoff_frequency": 2\n', "parameter twice"),
    ('mappings:\n  "VCF Cutoff": on\n', "bare on as a CC"),
    ('mappings:\n  "VCF Cutoff": {mode: clamp}\n', "flow map with no cc"),
    ('mappings:\n  "VCF Cutoff": {cc: 1, mode: wobble}\n', "unknown mode"),
    ('mappings:\n  "VCF Cutoff": off\n', "everything off"),
    ('midi:\n  synth_channel: yes\nmappings:\n  "VCF Cutoff": 1\n', "yes as a channel"),
    ('midi:\n  thru: maybe\nmappings:\n  "VCF Cutoff": 1\n', "non-boolean thru"),
    ('midi:\n  log: loud\nmappings:\n  "VCF Cutoff": 1\n', "unknown log level"),
    ("mappings:\n", "empty mappings"),
    ("midi:\n  synth_channel: 1\n", "no mappings section"),
):
    msg = raises(lambda t=text: config_mod.parse(miniyaml.loads(t), "test"),
                 config_mod.ConfigError)
    check("rejects " + why, msg is not None, msg)

section("start and stop wiring")
reset()
check("midi callback registered", hooks["midi"] == [cc2juno._on_midi])
check("frame callback registered", hooks["frame"] == [cc2juno._on_frame])

section("a mapped CC becomes sysex")
reset()
cc2juno._on_midi([0xB0, 16, 99])
check("the MIDI callback itself sends nothing", sent == [], sent)
frames()
check("one sysex after a frame", len(sent) == 1, sent)
check("correct 10 bytes, F0 to F7",
      sent[0] == [0xF0, 0x41, 0x36, 0x00, 0x23, 0x20, 0x01, 16, 99, 0xF7], sent)

section("synth channel is baked into the frame")
reset()
cc2juno._router.cfg.synth_channel = 16
cc2juno._on_midi([0xB0, 16, 1])
frames()
check("channel 16 -> 0x0F", sent[0][3] == 0x0F, sent[0])

section("quantized regions")
reset()
for value, want in ((0, 0), (31, 0), (32, 1), (63, 1), (64, 2), (95, 2), (96, 3), (127, 3)):
    del sent[:]
    cc2juno._router.last_value.clear()
    cc2juno._on_midi([0xB0, 2, value])
    frames()
    check("CC2 val %d -> option %d" % (value, want),
          len(sent) == 1 and sent[0][8] == want, sent)

section("clamp mode takes the value literally")
reset()
cc2juno._on_midi([0xB0, 90, 100])       # Bender Range, max 12, mode: clamp
frames()
check("100 clipped to 12", sent[0][8] == 12, sent)

section("unchanged values are not resent")
reset()
cc2juno._on_midi([0xB0, 2, 0])
frames()
cc2juno._on_midi([0xB0, 2, 10])         # same region, same parameter value
frames()
check("second message suppressed", len(sent) == 1, sent)
check("counted as unchanged", cc2juno._router.stats["unchanged"] == 1)

section("thru off")
reset(thru=False)
cc2juno._on_midi([0xB0, 99, 64])        # unmapped
cc2juno._on_midi([0x90, 60, 100])       # note on
frames()
check("nothing forwarded", sent == [], sent)
check("unmapped still counted", cc2juno._router.stats["unmapped"] == 1)

section("thru on")
reset(thru=True)
cc2juno._on_midi([0x90, 60, 100])       # note on
cc2juno._on_midi([0xB0, 99, 64])        # unmapped CC
cc2juno._on_midi([0xE0, 0, 64])         # pitch bend
cc2juno._on_midi([0xD0, 40])            # channel aftertouch
cc2juno._on_midi([0xC0, 5])             # program change
cc2juno._on_midi([0xF8])                # clock
check("forwarded immediately, not queued", len(sent) == 6, sent)
check("note first, unaltered", sent[0] == [0x90, 60, 100], sent[0])
cc2juno._on_midi([0xB0, 16, 99])        # mapped CC
check("a mapped CC is never forwarded raw", len(sent) == 6, sent)
frames()
check("mapped CC arrives as sysex instead",
      sent[-1][0] == 0xF0 and sent[-1][7] == 16, sent[-1])

section("listen_channel filtering")
reset()
cc2juno._router.cfg.listen_channel = 5
cc2juno._on_midi([0xB0 | 0, 16, 99])    # channel 1
frames()
check("CC on another channel ignored", sent == [], sent)
cc2juno._on_midi([0xB0 | 4, 16, 99])    # channel 5
frames()
check("CC on the listen channel translated", len(sent) == 1, sent)

section("coalescing")
reset()
for value in range(128):
    cc2juno._on_midi([0xB0, 16, value])
frames()
check("an instant burst collapses to one message", len(sent) == 1, len(sent))
check("and keeps the final value", sent[0][8] == 127, sent[0])
check("the other 127 counted as coalesced", cc2juno._router.stats["coalesced"] == 127,
      cc2juno._router.stats["coalesced"])

section("different parameters queue independently")
reset()
cc2juno._on_midi([0xB0, 16, 10])
cc2juno._on_midi([0xB0, 17, 20])
frames(4)
check("both got through", sorted(m[7] for m in sent) == [16, 17], sent)

section("a 384 ms knob sweep")
reset()
for value in range(128):
    NOW[0] += 3                          # ~3 ms per CC, a fast but real knob move
    cc2juno._on_midi([0xB0, 16, value])
    cc2juno._on_frame()
during = len(sent)
elapsed = NOW[0]
frames(20)                               # let the queue drain
values = [m[8] for m in sent]
gaps = [b - a for a, b in zip(values, values[1:])]
check("many messages, not one", 25 <= len(values) <= 45, len(values))
check("monotonic", all(g > 0 for g in gaps), gaps)
# The last gap is the drain flushing whatever was still pending, so it is short
# by nature; the sweep proper should step evenly.
check("evenly spaced", max(gaps[:-1]) - min(gaps[:-1]) <= 1, gaps)
check("ends exactly on 127", values[-1] == 127, values[-1])
check("stays under max_msgs_per_sec",
      during <= elapsed // cc2juno._router.interval + 1, (during, elapsed))

section("the rate limiter does not bank credit while idle")
reset()
NOW[0] += 10000                          # ten idle seconds
for cc in (2, 10, 16, 17, 90):
    cc2juno._on_midi([0xB0, cc, 100])
frames(1)
check("burst capped per frame", len(sent) <= cc2juno.MAX_PER_FRAME, len(sent))

section("logging is bounded")
reset(thru=True, log="verbose", quiet=False)
out = sys.stdout
sys.stdout = open("/dev/null", "w")
try:
    for i in range(300):
        cc2juno._on_midi([0x90, 60, i % 128])
    capped = len(cc2juno._router.logq) <= cc2juno.LOG_QUEUE_MAX
    dropped = cc2juno._router.stats["logs_dropped"] > 0
finally:
    sys.stdout.close()
    sys.stdout = out
check("queue capped", capped)
check("overflow counted rather than blocking", dropped)
check("thru still forwarded every message", len(sent) == 300, len(sent))

reset(log="off")
cc2juno._on_midi([0xB0, 16, 99])
frames()
check("log off queues nothing", cc2juno._router.logq == [], cc2juno._router.logq)

section("bad config is reported, not raised")
cc2juno._router = None
check("missing config returns False", cc2juno.start("/nonexistent/nope.yaml") is False)

section("stop drains and unhooks")
reset()
cc2juno._on_midi([0xB0, 16, 99])
cc2juno._on_midi([0xB0, 17, 50])
out = sys.stdout
sys.stdout = open("/dev/null", "w")
try:
    cc2juno.stop()
finally:
    sys.stdout.close()
    sys.stdout = out
check("queued sysex flushed", len(sent) == 2, sent)
check("midi callback removed", hooks["midi"] == [], hooks["midi"])
check("frame callback removed", hooks["frame"] == [], hooks["frame"])

section("the parameter table survived the port")
check("36 parameters", len(alpha_juno.PARAMETERS) == 36)
check("indexes in order", all(p.index == i for i, p in enumerate(alpha_juno.PARAMETERS)))
check("name lookup is forgiving",
      alpha_juno.lookup("vcf_cutoff") is alpha_juno.lookup("VCF Cutoff")
      is alpha_juno.lookup(16) is alpha_juno.lookup("16"))
check("unknown name is None", alpha_juno.lookup("nope") is None)
check("every scale() result is in range",
      all(0 <= alpha_juno.scale(p, v) <= p.max_value
          for p in alpha_juno.PARAMETERS for v in range(128)))
check("every value of every parameter is reachable",
      all(set(alpha_juno.scale(p, v) for v in range(128)) == set(range(p.max_value + 1))
          for p in alpha_juno.PARAMETERS))
check("sysex rejects a bad channel",
      raises(lambda: alpha_juno.build_sysex(0, 0, 17), ValueError) is not None)

print("\n%d test(s) failed" % len(FAILS) if FAILS else "\nAll tests passed.")
sys.exit(1 if FAILS else 0)
