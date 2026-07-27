# cc2juno

Translate MIDI CC messages into Roland Alpha Juno 1/2 (and MKS-50) tone parameter sysex, so a modern CC-based controller can drive a synth that only accepts real-time edits over system exclusive.

In effect, an inexpensive generic MIDI CC box can become a PG-300. 

cc2juno converts any knob on your midi controller to the correct sysex for the Roland Alpha Juno to interpret per your configuration within the cc2juno.yaml file. Parameters which have only a few selections (such as DCO Range) are handled by dividing CC knob into ranges for each sysex value. 

The `--thru` argument may be passed to permit notes to travel from midi in to midi out -- great for controller-keyboard combos. 

## Tulip: 

Within the "tulip" directory is a separate and experimental version which may be loaded onto the Tulip Creative Computer. This version expects the config in the same format and it is generally best to work out the config on a computer first. The Tulip version lacks interactive assistance in the config. Once configured, your Tulip can be the bridge between a generic hardware CC box and the Alpha Juno. 

## Linux PC basic requirements: 

Requires Python 3 with `mido`, `python-rtmidi` and `PyYAML`:

    sudo apt install python3-mido python3-rtmidi python3-yaml
    # or: pip install mido python-rtmidi pyyaml

## Two things to set on the synth first

1. **Sysex receive must be ON.** On the Alpha Juno it lives under the MIDI button.
   Nothing here works until it is enabled.
2. **The synth's basic channel must match `midi.synth_channel`** in the config
   (default 1). The channel is baked into every sysex message.

## Usage

    ./cc2juno.py --init-config      # write a starting-point cc2juno.yaml
    ./cc2juno.py                    # pick ports interactively, then run
    ./cc2juno.py --learn            # assign CCs by moving your controls

    ./cc2juno.py --list-ports       # show MIDI inputs and outputs
    ./cc2juno.py --list-params      # show the 36 Alpha Juno parameters
    ./cc2juno.py --in 2 --out "Juno"   # skip the prompts (index or name substring)
    ./cc2juno.py --save-ports       # remember the chosen ports in the config (just use once)
    ./cc2juno.py --ask-ports        # prompt even though the config names ports
    ./cc2juno.py --thru             # also forward notes and unmapped CCs to the synth
    ./cc2juno.py --dry-run -v       # log the sysex bytes without sending them

Running output looks like this:

    Received CC16  val 100 -> sending VCF Cutoff = 100
    Received CC2   val 70  -> sending VCA Env. Mode = 2 (Normal-Dynamic)
    Received CC99  val 64  -> not mapped (further CC99 messages will be silent)

`-v` adds the raw bytes of everything sent, `-q` prints only errors.

## Config

`cc2juno.yaml` maps parameter names to CC numbers:

    ports:
      input: "nanoKONTROL2"
      output: "AudioBox"

    midi:
      synth_channel: 1
      listen_channel: any
      level_byte: 0x20
      group_byte: 0x01
      max_msgs_per_sec: 100
      hysteresis: 2
      thru: false

    mappings:
      "VCF Cutoff":    16
      "VCF Resonance": 17
      "LFO Rate":      24
      "Bender Range":  off

Names are matched case- and punctuation-insensitively, so `VCF Cutoff`,
`vcf_cutoff` and `VCF cutoff frequency` are the same parameter; a bare index
(`0`-`35`) also works. Unknown names, out-of-range CCs, and a CC assigned to two
parameters are all rejected at startup rather than silently ignored.

### Switching an entry off

Write `off` in place of a CC number to disable an entry without deleting it:

    "Bender Range": off

`no`, `false`, `none` and an empty value all work the same way, in the dict form
too (`{cc: off, mode: clamp}`). A disabled entry releases its CC number, so
another parameter can take it over. The startup banner reports how many are off.

Generated configs list all 36 parameters, using `off` for anything unassigned, so
turning one on is a matter of typing a number over the `off`.

Note that YAML reads a bare `on` or `yes` as a boolean, not as CC 1 — those are
rejected with a clear message rather than quietly becoming CC1.

### Default ports

With a `ports:` section the program starts without prompting:

    ports:
      input: "nanoKONTROL2"     # name, any distinctive part of one, or an index
      output: 5
      # or 'ask' / blank to be prompted

The easiest way to fill it in is to pick the ports once and pass `--save-ports`,
which edits just those two lines and leaves the rest of the file, comments
included, untouched. Saved names have ALSA's trailing `client:port` numbers
stripped, since those change between reboots — but only when the shorter name
still matches one port unambiguously.

Precedence is `--in`/`--out`, then the config, then prompting. `--ask-ports`
skips straight to the prompt. A port named on the command line that cannot be
found is an error; one from the config that has gone missing only prints a
warning and falls back to the prompt, since the device may just be unplugged.

When a name matches more than one port, the **first match wins** and a note names
the runners-up. This makes a short name like `AudioBox` a perfectly good thing to
put in the config.

Some systems enumerate every port twice, once per compiled-in rtmidi API, so the
same device appears at two indexes. The repeats are dropped from the listings:
mido opens a port by looking its name up with `list.index()`, which always
returns the first occurrence, so the second copy was never reachable to begin
with. Nothing openable is hidden by this.

The shipped default maps parameter *n* to CC *n*, i.e. CC0-CC35 in table order.
That is a starting point, not a recommendation — the generated file flags inline
which of those CC numbers collide with standard MIDI assignments (CC1 is the mod
wheel, CC7 is volume, CC32-63 are LSBs). CC20-31 and CC102-119 are officially
undefined if you want a conflict-free block.

### Value scaling

Most parameters take the full 0-127 range and pass through unchanged. The rest
have the 128 CC steps split into equal regions, so a 4-option parameter like
`VCA Env. Mode` reads CC 0-31 as option 0, 32-63 as 1, 64-95 as 2, 96-127 as 3.
The 6-option waveform parameters get six regions, `Chorus Switch` gets two, and
`Bender Range` gets thirteen.

To take the CC value literally instead, clipping anything above the maximum:

    "Bender Range": {cc: 90, mode: clamp}

`hysteresis` puts a small dead zone (in CC counts) at each region edge so a noisy
pot resting on a boundary does not flip back and forth between two options. It
only applies to quantized parameters and only to single-region moves, so a fast
sweep is never held back. Set it to `0` to disable.

## Thru

`--thru` (or `thru: true` under `midi:` in the config) forwards everything this
program does not translate — notes, pitch bend, aftertouch, program change, clock
and any unmapped CC — straight from the input to the output. One keyboard with
built-in knobs can then both play an MKS-50 and edit it, with no merge box.

    ./cc2juno.py --thru

Mapped CCs are **consumed**, never forwarded: they leave as sysex only, so a knob
assigned to `VCA Level` cannot also arrive as a raw CC and do something else.
Unmapped CCs pass through untouched, which is what makes the mod wheel and
sustain pedal keep working. `--no-thru` overrides `thru: true` in the config.

Forwarded messages are sent immediately and are **not** rate limited. Delaying
notes to make room for parameter edits would be far worse than the extra bytes,
so thru traffic jumps the sysex queue. Note that a busy MIDI stream and a fast
knob sweep do compete for the same 3125 bytes/sec on a DIN cable; if you are
also sending clock, consider lowering `max_msgs_per_sec`.

Under `-v` each forwarded message is logged, except clock, active sensing and
song position, which would drown the log. They are still forwarded.

If the input and output are the same port, thru echoes messages straight back;
the program warns when it notices this.

## Rate limiting

Each sysex message is 10 bytes, roughly 3.2 ms on a 31250 baud DIN cable. A fast
knob sweep emits 128 CCs and will outrun the synth's input buffer, so outgoing
messages are rate limited (`max_msgs_per_sec`, default 100) and only the newest
pending value per parameter is kept. Different parameters queue independently, so
moving several knobs at once still works, and the final value of a sweep always
gets through. A redundant value — common on quantized parameters, where 32 CC
steps all mean the same thing — is never sent twice in a row.

## Learn mode

`--learn` walks the parameter list in order and waits for you to move a control:

    [ 1/36] DCO Env. Mode  (0=Normal, 1=Inverted, ...)  [unassigned]
             move a control... got CC70

At each prompt: **Enter** keeps the current assignment and moves on, **x**
unassigns it, **b** goes back one, **q** finishes early. Assigning a CC that is
already in use moves it, leaving the old parameter unassigned. Nothing is written
until you confirm at the end. Learn starts from your existing config, so it can
be used to fix up a few entries rather than starting over.

## Sysex format

    F0 41 36 0n 23 20 01 pp vv F7

`0n` is the synth basic channel (0-15), `pp` the parameter index (0-35), `vv` the
value. The `20 01` level/group bytes follow the Roland/PG-300 charts; a
widely-circulated 1995 usenet transcription gives `01 01` instead. If the synth
ignores everything this program sends, set `level_byte: 0x01` in the config and
try again.

## Files

| File | Role |
| --- | --- |
| `cc2juno.py` | CLI, main loop, learn mode |
| `alpha_juno.py` | 36-parameter table, value scaling, sysex framing |
| `config.py` | Config load / validate / generate |
| `midi_io.py` | Port discovery and selection |
| `test_scaling.py` | Boundary tests — run `./test_scaling.py` |
