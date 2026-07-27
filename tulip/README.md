# cc2juno for the Tulip Creative Computer

The same CC-to-Alpha-Juno-sysex translator as the desktop version, running on a
Tulip CC instead of a laptop. Tulip has MIDI in and MIDI out on its own, so it
can sit between a controller and an Alpha Juno 1/2 or MKS-50 as a standalone box.

Reads the same `cc2juno.yaml` as the desktop version. Build and test a config on
a PC, copy it to `/user`, and it works unchanged.

## Installing

Copy these four files plus your config into `/user` on the Tulip:

    alpha_juno.py     36-parameter table, value scaling, sysex framing
    miniyaml.py       a small YAML reader (there is no PyYAML for MicroPython)
    config.py         config load and validation
    cc2juno.py        the program
    cc2juno.yaml      your mapping

`test_tulip.py` stays on the PC — see [Testing](#testing).

## Running

    execfile('/user/cc2juno.py')

That loads `cc2juno.yaml` and starts. There are no prompts and no arguments: it
runs off the config file and nothing else.

To keep hold of it from the REPL:

    import cc2juno
    cc2juno.start()          # or start(thru=True), start(log='verbose')
    cc2juno.status()         # counters
    cc2juno.params()         # the 36 parameter names and ranges
    cc2juno.stop()           # flush what is queued, then unhook

`start()` hooks the callbacks and returns, so the REPL stays usable while it
runs. To start it at boot, put the `execfile` line in `boot.py`.

Output looks like:

    CC16 val 100 -> VCF Cutoff = 100
    CC2 val 70 -> VCA Env. Mode = 2 (Normal-Dynamic)
    Received CC99 val 64 -> not mapped (further CC99 messages will be silent)

## Two things to set on the synth first

1. **Sysex receive must be ON.** On the Alpha Juno it is under the MIDI button.
   Nothing here works until it is enabled.
2. **The synth's basic channel must match `midi.synth_channel`** in the config
   (default 1). The channel is baked into every sysex message.

## Wiring

Tulip's MIDI jacks are 3.5mm **Type A TRS**; the Alpha Juno has 5-pin DIN, so
you need a TRS-A-to-DIN adapter at each end.

MIDI in can arrive on either TRS or USB, and both are merged into one stream.
MIDI out always goes to **both** the TRS jack and USB — there is no way to aim
it at one, so anything translated or passed through reaches both.

## Config

Identical to the desktop file. See the main [README](../README.md) for the full
description of mappings, `off`, scaling modes and hysteresis. Two differences:

- **`ports:` is read and ignored.** Tulip has nothing to select, so the section
  is harmless if your file has one.
- **`midi.log`** sets how much is printed. The desktop version ignores this key,
  so one file still serves both.

      midi:
        log: normal      # off | quiet | normal | verbose

  `normal` prints one line per sysex sent plus the first sighting of each
  unmapped CC. `verbose` adds the raw bytes and every passed-through message.
  `quiet` prints only the banner and errors. `off` prints nothing at all.

`start()` arguments override the file: `start(thru=True)`, `start(log='off')`,
`start('/user/other.yaml')`.

## What is different from the desktop version

**No port selection, no learn mode, no command line.** Tulip has one merged MIDI
input and no prompts to give, so all three are gone. Configuration is your job:
edit the file on a PC, or on screen with `edit('/user/cc2juno.yaml')`.

**Logging happens on the frame callback, not when MIDI arrives.** The MIDI
callback maps, queues and forwards, but never prints — printing to the
framebuffer terminal is slow enough to cost incoming MIDI bytes if it happened
there. Lines are queued and drained a few per frame. If they pile up faster than
they can be drawn they are dropped and counted, and `status()` reports the count.
This is why log lines can lag the knob slightly; the sysex does not.

**Log lines say `CC16 val 100 -> VCF Cutoff = 100` when the sysex is actually
sent**, not when the CC arrives. The desktop version logs on arrival. Logging at
send time means the line count matches what went down the wire, instead of the
128 lines a coalesced sweep would otherwise print.

**Sysex leaves from the frame callback**, about 34 times a second, up to
`MAX_PER_FRAME` (8) messages each time. One per frame would have capped the rate
at 34/s no matter what `max_msgs_per_sec` said. The rate limiter still holds the
long-run average to `max_msgs_per_sec`, and it will not bank up credit while
idle — an untouched knob cannot buy a burst big enough to swamp the synth the
moment it is touched.

**Tulip's own synth keeps playing.** Tulip boots into AMY's live MIDI mode, so
incoming notes sound on its internal synth as well as being passed through. That
is left alone deliberately. If it is in the way, unplug Tulip's audio out, or
remap the channel yourself with `midi.config`.

**Thru does not forward sysex.** Tulip delivers sysex to a separate callback,
which this program does not hook, so incoming sysex is not passed along. Notes,
bend, aftertouch, program change, clock and unmapped CCs all are.

## Why a hand-written YAML reader

There is no PyYAML for MicroPython, and `cc2juno.yaml` only uses a small corner
of YAML: comments, one level of nesting, scalars, and the odd `{cc: 90, mode:
clamp}`. `miniyaml.py` parses exactly that and rejects everything else with a
line number, rather than guessing at syntax it does not really support.

It is slightly stricter than PyYAML in one useful way: a duplicate key is an
error. PyYAML silently keeps the last one, which would throw away a mapping
without telling you.

Verified against PyYAML by parsing the same files with both and comparing the
resulting configs — the generated default, a hand-mangled version using every
`off` spelling and a flow mapping, and a set of files that should be rejected.
All agree.

## Testing

`test_tulip.py` runs **on a PC**, not on Tulip:

    cd tulip && ./test_tulip.py

It stubs the `tulip` and `midi` modules and fakes the clock, so it can check the
mapping, scaling, region splitting, hysteresis, coalescing, rate limiting, thru
and config validation without hardware — 92 checks. What it cannot check is
Tulip itself: the real callback signatures, the MIDI jacks, and whether the synth
likes the bytes. That part needs the actual machine.

Tulip Desktop would have been the obvious way to test the rest, but its MIDI is
currently broken on Linux.

## Files

| File | Role |
| --- | --- |
| `cc2juno.py` | Callbacks, router, rate limiter, log queue |
| `alpha_juno.py` | 36-parameter table, value scaling, sysex framing |
| `config.py` | Config load and validation |
| `miniyaml.py` | The YAML subset reader |
| `test_tulip.py` | Tests — run on a PC |
