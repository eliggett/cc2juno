# cc2juno on the web

The same CC-to-sysex translation as the command-line build, running in a browser
over Web MIDI, with the knobs drawn on screen so the mapping can be built by
clicking rather than by editing YAML.

It reads and writes exactly the same `cc2juno.yaml` the other builds use, plus
one new optional section describing where the knobs physically sit. Nothing is
installed, nothing is built, and nothing is uploaded anywhere: it is a handful of
ES modules served as static files, and the config lives in the browser until you
export it.

## Running it

    cd web
    python3 server/server.py          # https on port 4443

Then open <https://localhost:4443/>, or the LAN address of the machine, and press
**Enable MIDI**. Web MIDI needs a secure context, which is the only reason the
plain `python3 -m http.server` will not do.

The certificate is self-signed, so the browser will complain the first time.
Accept it for the site and MIDI works; in Firefox that means going through the
padlock and allowing it for this site specifically. Chrome, Chromium, Edge and
Opera all support Web MIDI. Safari does not, and says so on load.

Sysex permission is requested up front, because sysex is the entire point of this
program — the browser will ask once and then remember.

## Configure mode

The grid is the controller. Set **rows** and **columns** to match it — 16 knobs
in a row is 1 × 16, three rows of four is 3 × 4 — then click a cell:

- **Learn** and move the control you want in that cell. It has to travel 6 CC
  counts before it counts, so brushing past a neighbour on the way does not grab
  it. Typing the CC number in by hand does the same thing.
- **Function on this layer** is the parameter that knob sends, out of the 36 in
  the Alpha Juno tone table. Anything already in use is marked with a bullet and
  says where: `• 22 VCA Level — on CC13 here, layer 2`. The two halves of that
  mean different things. *Here* means another knob on this layer has it, and the
  file has nowhere to write it twice, so choosing it **moves** it and that knob
  stops doing anything — the same rule `--learn` follows, and it says so when it
  happens. A *layer* note is only for information: reaching the same parameter
  from several layers is normal and allowed.
- **Value scaling** chooses between splitting the knob's travel into equal
  regions (the default) and taking the CC value literally.
- **Use this knob to select the layer** gives that one knob up to switching
  between layers. It then means the same thing on every layer and can never also
  be a parameter.

Incoming CCs light their knob up in this mode too, without translating anything,
which is a quick way to find out which cell a given control is.

## Perform mode

The mapping runs: CCs become sysex, at the configured rate limit, with the same
boundary dead zone and the same newest-value-wins queue as the CLI. Knobs light
as they move and show what they are sending, the layer name is shown above the
grid, and the log on the right prints the same lines the terminal build prints.

Knobs can also be turned on screen, which goes through exactly the same path as a
real CC — useful for testing without reaching for the controller, and for the
parameters there were not enough knobs for. Drag up and down, roll the scroll
wheel over a knob, or use the arrow keys when one has focus. Hold **shift** for
fine control: a wheel click is four counts normally and one with shift. The wheel
only takes over the page's scrolling where it is actually turning something, so
Configure mode scrolls as usual.

Layers can be changed with the layer knob, by clicking a layer chip, or with the
number keys. As on the other builds, **switching layers sends nothing**: the
knobs are pointing at values that belonged to the previous layer, and each one
takes effect on its next move.

The display says so rather than leaving you to remember it. Straight after a
layer change every knob is marked **not live**, drawn dim, with the dial showing
where the pot is sitting and no value claimed for it — because the synth has not
been told anything. Move the knob and it goes bright, jumping to wherever the pot
happens to be. A number on a knob is only ever a value that was really sent.

Two things worth knowing, both of which look like the program mapping a knob to
the wrong thing:

- **Entering Perform starts on the layer named by `layers.startup`,** not the one
  you were last editing, because the layer knob's real position cannot be read.
  The log says which layer it assumed, and the note above the grid keeps saying
  so until the layer knob is moved.
- **A second tab of this page keeps translating too.** Web MIDI gives every page
  the same input, so two open copies both send to the synth, each on whatever
  layer *it* is showing — one knob then appears to change two parameters, one of
  which belongs to a layer you are not on. The tabs notice each other and say so.

## Import and export

**Export** writes `cc2juno.yaml`, the same fully commented file `--init-config`
produces, and it works unchanged with the command-line and Tulip builds. The
`ports:` block gets the names the browser uses for the chosen devices; the CLI
matches on any distinctive part of a port name, so those usually suit both.

**Import** reads any config the other builds accept. A file with no `layout:`
section still works — a grid is built from the CCs in use and it says so — as
does one whose mappings mention a CC the grid does not have, which is added to
the end.

Everything is autosaved to the browser's local storage as you go, so a reload
picks up where you left off. **Reset** clears it.

## The layout section

    layout:
      rows: 3
      cols: 4
      # Row-major, one entry per cell, 'off' for a gap.
      ccs: "15, 2, 9, 6, 3, 11, 13, 10, 7, 4, 12, off"

The CC list is one comma-separated string rather than a YAML list for the same
reason `layers.names` is: the Tulip build's reader has no lists and all three
builds read this file. The layer knob is not called out separately; it is
whichever cell holds `layers.cc`.

The other builds keep the section rather than drawing it. The desktop build reads
it, validates it and writes it back out, so a `--learn --save` from the terminal
does not throw the grid away; the Tulip build skips it.

## Files

| File | Role |
| --- | --- |
| `index.html` | The page: top bar, knob grid, and the two side panels |
| `css/app.css` | The whole dark theme |
| `js/app.js` | Modes, panels, import/export, autosave, and the wiring between them |
| `js/alpha_juno.js` | The 36-parameter table, value scaling, sysex framing |
| `js/config.js` | Config load / validate / render, and the knob grid |
| `js/yaml.js` | The small YAML reader, matching the Tulip build's dialect |
| `js/router.js` | Mapping state, layer state, rate limiter, thru |
| `js/midi.js` | Web MIDI access, port selection, message decoding |
| `js/knob.js` | One knob: the SVG dial and its pointer handling |
| `js/learn.js` | Deciding when a control has really been moved |
| `test_web.mjs` | Tests — run `node test_web.mjs` |
| `server/` | The development HTTPS server |
| `package.json` | Nothing to install; it only tells `node` these are ES modules |

## Tests

    node test_web.mjs

The interesting question is not whether these functions work but whether they
still agree with `alpha_juno.py` and `config.py`, since both read the same file
and drive the same synth. So where `python3` is available the tests run the
Python implementation and compare: every `scale()` and `convert()` answer for
every parameter across all 128 CC values and both modes, the shipped config read
both ways, and a file written here parsed back by `config.py`. Without `python3`
those sections are skipped and the rest still runs.
