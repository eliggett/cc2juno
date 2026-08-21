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

Three lamps in the Activity heading show the traffic itself: green for MIDI
arriving from the controller and from the synth, red for MIDI going out to the
synth. They answer a question the log cannot, because they light on *any* message
— unmapped, wrong channel, or something this program has no use for. A dark
**Ctrl** lamp while you are turning a knob means the cable or the port menu is
wrong, and it says so before a single knob has been mapped. Clock and active
sensing are the one exception: an Alpha Juno sends active sensing the whole time
it is powered up, so counting it would just hold the lamp on.

The **Status** checkbox in the top bar puts that right-hand panel away and gives
the whole window to whatever the mode is drawing. Configure keeps the panel
whatever the box says, because in that mode it is the editor — hiding it would
leave a screen with nothing to press — so the box goes dead there rather than
disappearing.

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
happens to be. A number on a knob is only ever a value that was really sent — or,
if the synth is telling you what patch it is on, one the synth really has.

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

## The PG-300 view

Perform and Live Patch have two views of the same running mapping, switched above
the grid.

The **knob grid** is a picture of your controller: the knobs you own, where you
put them, saying what each one does. The **PG-300** is a picture of the synth:
all 36 parameters, always, laid out the way Roland laid them out on the hardware
programmer, down to which sliders are short because the parameter only has four
positions. Nothing on it is assignable — that is the point of it.

Sliders light up as the CCs mapped to them arrive. Which ones are lit says what
your hands can reach:

- **Bright, with an amber cap line** — a knob on the current layer moves this.
- **Mid grey** — mapped, but on one of the other layers.
- **Dim** — nothing on the controller reaches it.

A slider with a **faded cap parked at the bottom** has not been set this session.
That is not the same as being at zero: with nothing heard from the synth its
settings are unknown, so the panel says so rather than drawing a value nobody
sent. It fills in as the parameter is used — or all at once, if the synth is
telling you what patch it is on.

Every slider can be moved on screen, mapped or not — drag it, roll the wheel over
it, or use the arrow keys, **Home** and **End** when one has focus, with
**shift** for fine control. Where a knob on this layer reaches the same
parameter, the move is fed in as that knob's CC so the two views cannot disagree
about it; the other thirty-odd sliders are sent directly. Either way it goes into
the same rate-limited queue, and the log names it.

The empty area at the top right is the one Roland put their logo in. Ours is a
placeholder: replace the contents of `#pg300-logo` in `js/pg300.js`. The display
below it is a separate group and stays where it is.

## Patch Manager

`.syx` bank files, and the synth's own memory. Both panes list patches the way
the front panel numbers them — `11` to `88`, eight banks of eight, no zero and no
bank 9.

**The right-hand pane is a file.** Open a `.syx` — the ordinary bulk dump any
Alpha Juno or MKS-50 librarian writes — and it lists what is actually in it, so a
file holding sixteen patches shows sixteen rows rather than sixteen followed by
48 blanks. Click one and the synth plays it immediately; see **Auditioning**
below.

A `.mid` holding the same dump works too — see **MIDI files** below. Which of the
two a file is gets decided by reading it, not by its name, since plenty of banks
are saved as `.mid` and plenty of MIDI files end up called `.syx`.

**The left-hand pane is the synth's 64 memories.** It starts empty. Fill it by
receiving a dump, by opening a file straight into it, by dragging patches over
from the right, or with **◀ Copy All**, which takes the whole file and lays it in
from slot 11 — the "make this file my set" button. Then rename (double-click),
reorder (drag, or **Move ▲ ▼**), clear slots, and write the lot back.

**◀ Copy** places just the patches selected on the right, starting at whichever
slot is selected on the left. **◀ Copy All** always starts at 11, because a
button that emptied a file into the middle of the memory because a row happened
to be selected — dropping whatever ran off the end — would be a poor surprise. It
asks first if there is anything there to overwrite.

Selection works as a list does: click, shift-click for a range, ctrl-click to add
one. A drag carries the whole selection. Dropping onto a slot in the left pane
**replaces** that slot and the ones after it — the synth has exactly 64 addresses
and no notion of making room — while dragging *within* the left pane moves the
patches and slides everything else along, which is how a set is put into the
order it should be written in.

### Auditioning

Clicking a patch in either pane sends its 36 parameters to the synth's edit
buffer, through the same rate-limited queue everything else uses. The knob grid
and the PG-300 jump to match, so hopping over to Perform shows the sound you just
picked already on the controls.

Nothing is written to the synth's memory, and **the name and slot number do not
travel** — they can be sent, and the synth ignores them. To keep an auditioned
sound, press **WRITE** on the synth while it is playing. To keep a whole set, use
a bulk load.

The display therefore reads `T32   SpaceyWoW`: `T` for temporary, `32` the
patch's slot in the file, and the name out of the file. None of that is anything
the instrument knows.

### MIDI files

**Beta.** Banks are often circulated as `.mid` rather than `.syx`, because that is
what a sequencer saves when you record a dump off the synth. cc2juno reads those:
if the file starts with a MIDI file header its tracks are unwrapped, every
complete system-exclusive message is pulled out in playing order, and the result
is handed to the same reader a `.syx` goes through.

This is worth spelling out because it cannot be done by scanning for `F0`, which
is what a raw dump allows. In a MIDI file every event carries a delta time, sysex
carries a length, and channel events may leave their status byte out altogether —
so a pitch-bend value of `F0` would be read as the start of a message and swallow
whatever followed. Every event has to be stepped over properly instead. Handled:
format 0 and format 1, running status, meta events, chunks of unknown type,
messages split across `F0` and `F7` continuation packets, whole messages inside
an `F7` escape, and `RMID` (a MIDI file in a RIFF wrapper). An incomplete message
is dropped rather than handed on, since a tone built from a truncated dump is a
patch with rubbish in it — worse than one patch fewer, and much harder to notice.

It is marked beta because it has been tested against files this project generated
and against files written by [mido](https://mido.readthedocs.io/), not against
the ones a 1990s sequencer or an old librarian wrote. Loading one puts up a note
saying so, once per session. **Check the patch names look right before writing
anything to the synth** — and if they do not, that file would be very welcome as
a bug report.

A MIDI file with no sysex in it, and one whose sysex belongs to another
instrument, are told apart and reported differently; so is one full of Alpha Juno
messages that are not bulk dumps, which is what a recording of somebody editing
looks like and which no librarian can turn back into a bank.

### Receiving a dump

Press **Receive**, then on the synth:

> **DATA TRANSFER** + **WRITE** + **1 BULK DUMP**

The transfer starts as soon as you press them and takes five to ten seconds. A
progress bar counts the sixteen messages, the display counts along with it, and
**Cancel** gives up. What arrives replaces the left-hand pane.

A dump arrives on the synth's own MIDI out, so the **From Synth** port has to be
chosen first. If you press the buttons before pressing Receive, the log says so
rather than the dump vanishing silently.

### Writing a bank

Press **Send all 64**. On the synth, set the rear-panel **Memory Protect** switch
to off, then:

> **DATA TRANSFER** + **WRITE** + **2 BULK LOAD**

The synth then waits. Press **Continue** and the sixteen messages go out with a
200 ms gap between them — about four seconds. The gap is not decoration: the
synth has to write each block of four patches to memory before it can take the
next, and it drops whatever arrives while it is busy, silently, so too small a
gap looks like a transfer that worked and lost patches.

This replaces **all 64** patches. Empty slots go in as silence and cannot be left
out, because a bulk load commits the whole set at once; the dialog says how many
there are before you commit.

An Alpha Juno-2 will not commit a single slot from a bulk message — armed for
BULK LOAD it waits for all sixteen — so there is deliberately no "write this one
patch" button anywhere.

While either transfer runs, cc2juno transmits nothing else. Knobs on the
controller are still tracked and still drawn, but a parameter message landing in
the middle of a bulk stream is the sort of thing a 1986 instrument answers by
abandoning the transfer.

## Live Patch

The same panes, put beside the performance controls instead of beside each other:
patches on the right, knob grid or PG-300 on the left. Click a patch and it loads
and the controls jump.

It is for playing a file rather than filing it — 64 sounds on tap without ever
touching the synth's memory or its patch buttons. The list stays put while the
panel scrolls, and the display reads `T` plus the slot in the list, as above.

Once the synth-memory pane holds something, a **Patch file / Synth memory** switch
appears above the list and either can be played from. Until then there is no
switch, because an empty set is 64 blank rows and nothing to hear — receive a dump
in Patch Manager, or copy a file in, and it turns up.

These are the same two pane elements Patch Manager uses, moved rather than
copied, so a file opened in either mode is already open in the other, scrolled to
the same place with the same patch selected. The organising buttons — Receive,
Send all 64, Open, Save, New set — are hidden here: writing all 64 patches to the
instrument is not something to have within reach of a browse-by-ear list.

## Listening to the synth

An Alpha Juno announces itself. Choose a patch on the synth and it sends its
whole edit buffer — all 36 parameters and the tone name — as one sysex message;
move a slider on its own panel, or on a real PG-300, and it sends that one
parameter. Give cc2juno somewhere to hear that and the display stops guessing:
every knob and every slider jumps to what the synth actually has.

Connect the synth's **MIDI out** to an input on your interface and pick it in the
**From synth** menu. It is optional, and everything else works without it. If the
interface presents its in and out under the same name — most do — the menu is
filled in for you the moment you choose the synth, and picking one by hand
overrides that from then on.

What arrives is acted on, never passed on. It has just come *from* the synth, so
sending it back would be a loop; this holds even when one bidirectional port is
serving as both the controller input and the synth input.

Then:

- **A patch change** moves every knob on the current layer and every slider on
  the PG-300, and names the patch in the log and in the **Running** panel.
- **The display** shows what the synth's own screen shows: the slot, then the
  tone name. `M-11` to `M-88` are the 64 writable memories, `P-11` to `P-88` the
  64 presets, numbered by bank and by position in the bank the way the synth
  numbers them — so the second digit runs 1-8 and never reaches 9. There is one
  above the knob grid and one on the PG-300, under the wordmark where Roland left
  the panel blank. The two halves arrive separately, the tone data first and the
  program number just behind it, so a screen reading `----   PolySynth1` for a
  moment is it waiting for the second half rather than anything being wrong.

  The face is Matrix Sans Screen, the variant with separate square dots. The
  other five variants of the family ship alongside it; to use one, change
  `--lcd-face` in `css/app.css` and the `@font-face` above it. Nothing else is
  measured against the face.
- **Anything still queued is dropped.** Those messages were aimed at the patch
  that has just been replaced, and letting them out would edit the new one a
  moment after it loaded.
- **The knobs on screen move; the ones on your desk do not.** The dials are drawn
  where the synth's values put them, so dragging one on screen carries on from
  the right place, but the physical pots are still wherever you left them. The
  first one you turn jumps its parameter, the same as after a layer change.
- **Tone data on another channel is ignored**, and says so once in the log — a
  synth left on the wrong channel looks exactly like one that is not connected,
  which is worth being told about rather than having to work out.

Five parameters — the two aftertouch depths, VCF and envelope key follow, and DCO
aftertouch — are stored by the synth in four bits, though they are sent and
received as 0–127. Values read back from a patch are therefore always multiples
of 8, and a slider will visibly settle onto one after you move it.

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

The one thing a reload does not restore is where you were looking: the page
always opens in Perform on the PG-300, whatever was on screen when it was last
closed. Nothing is sent until a knob moves, so opening live costs nothing.

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
| `index.html` | The page: top bar, stage, and the two side panels |
| `about.html` | The words in the About box, and where a logo goes. Plain HTML, meant to be edited |
| `css/app.css` | The whole dark theme |
| `js/app.js` | Modes, panels, import/export, autosave, and the wiring between them |
| `js/alpha_juno.js` | The 36-parameter table, value scaling, sysex framing |
| `js/config.js` | Config load / validate / render, and the knob grid |
| `js/yaml.js` | The small YAML reader, matching the Tulip build's dialect |
| `js/router.js` | Mapping state, layer state, rate limiter, thru |
| `js/midi.js` | Web MIDI access, port selection, message decoding |
| `js/tone_in.js` | Reading the patch data the synth broadcasts back |
| `js/lcd.js` | The display, and the M-11/P-88 slot numbering it shows |
| `js/bank.js` | The 32-byte packed tone format, and a bank of 64 slots |
| `js/bulk.js` | Bulk dump and bulk load: collecting one, pacing the other |
| `js/library.js` | One patch pane: its list, its selection, and the dragging |
| `js/smf.js` | Unwrapping sysex from a Standard MIDI File |
| `fonts/MatrixSans/` | Matrix Sans by FriedOrange, SIL OFL 1.1 — the display face |
| `js/knob.js` | One knob: the SVG dial and its pointer handling |
| `js/pg300.js` | The PG-300 panel: its geometry, and one slider's behaviour |
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


## TODO / Ideas: 

1. "Test" button to play middle-C (one second, half velocity) from the browser. Location: right of "running" indicator
3. Printable template art to go around generic midi CC hardware box. Will need knob spacing information. 
6. Drop down menu to select that all controller UI elements are vertical sliders, horizontal sliders, or knobs. Does not alter PG-300 appearance at all. 
7. Support for CC buttons and delta-encoders. Maybe buttons for layers? 