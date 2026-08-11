"""Load, validate and generate the CC -> Alpha Juno parameter mapping config."""

import os
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

import yaml

import alpha_juno
from alpha_juno import MAX_LAYERS, PARAMETERS, Parameter

DEFAULT_CONFIG_NAME = "cc2juno.yaml"

# Per-layer mapping sections are 'layer1' ... 'layer10'; 'mappings' is layer 1,
# so every config written before layering existed is still a valid one-layer file.
LAYER_SECTION_RE = re.compile(r"^layer(\d+)$")
LAYER_ONE_KEYS = ("mappings", "layer1")

# Spellings that turn an entry off without deleting it.
DISABLED_WORDS = {"off", "none", "null", "no", "false", "disable", "disabled", "-", ""}

# Spellings that mean "prompt me for this port".
ASK_WORDS = {"ask", "prompt", "choose", "select"} | DISABLED_WORDS

# Well-known uses of the low CC numbers, so the generated default config can flag
# which of its own assignments are likely to collide with a controller's own habits.
STANDARD_CC_USES = {
    0: "Bank Select MSB",
    1: "Modulation Wheel",
    2: "Breath Controller",
    4: "Foot Controller",
    5: "Portamento Time",
    6: "Data Entry MSB",
    7: "Channel Volume",
    8: "Balance",
    10: "Pan",
    11: "Expression",
    12: "Effect Control 1",
    13: "Effect Control 2",
    16: "General Purpose 1",
    17: "General Purpose 2",
    18: "General Purpose 3",
    19: "General Purpose 4",
}
for _cc in range(32, 64):
    STANDARD_CC_USES[_cc] = f"LSB for CC{_cc - 32}"


class ConfigError(Exception):
    """Raised for anything that would make the mapping ambiguous or unusable."""


@dataclass
class Mapping:
    cc: int
    param: Parameter
    mode: str = "scale"


@dataclass
class Layout:
    """Where each knob physically sits on the controller, as an rows x cols grid.

    Only the web front-end draws anything, but the grid lives in the shared config
    so one file describes the whole setup.  It is read, validated and written back
    out unchanged by the builds that have no screen, rather than being dropped the
    first time one of them saves the file.

    `ccs` is row-major and always rows*cols long, with None for an empty cell.
    """

    rows: int = 1
    cols: int = 1
    ccs: List[Optional[int]] = None

    def __post_init__(self):
        if self.ccs is None:
            self.ccs = [None] * (self.rows * self.cols)

    @property
    def cc_text(self) -> str:
        return ", ".join("off" if cc is None else str(cc) for cc in self.ccs)


@dataclass
class LayerMap:
    """One layer: a complete set of knob assignments, selected by the layer knob."""

    number: int = 1                       # 1-based, the way it is written in the config
    name: str = ""
    by_cc: Dict[int, Mapping] = None
    disabled: set = None                  # parameter indexes explicitly switched off

    def __post_init__(self):
        if self.by_cc is None:
            self.by_cc = {}
        if self.disabled is None:
            self.disabled = set()

    @property
    def label(self) -> str:
        return f"{self.number} ({self.name})" if self.name else str(self.number)


@dataclass
class Config:
    synth_channel: int = 1
    listen_channel: Optional[int] = None      # None = accept every channel
    level_byte: int = alpha_juno.DEFAULT_LEVEL
    group_byte: int = alpha_juno.DEFAULT_GROUP
    max_msgs_per_sec: int = 100
    hysteresis: int = 2
    thru: bool = False                    # forward untranslated traffic to the output
    port_input: Optional[str] = None      # None = ask at startup
    port_output: Optional[str] = None
    layer_cc: Optional[int] = None        # None = no layering, one fixed layer
    startup_layer: int = 1                # 1-based; the knob's real position is unknowable
    layer_hysteresis: Optional[int] = None    # None = use `hysteresis`
    layers: List[LayerMap] = None
    layout: Optional[Layout] = None       # None = no grid described, web build asks

    def __post_init__(self):
        if self.layers is None:
            self.layers = [LayerMap(1)]

    # An unlayered config is just a layered one with a single layer, so the
    # single-layer accessors stay pointed at layer 1 rather than growing an
    # `if self.layering` at every call site.
    @property
    def by_cc(self) -> Dict[int, Mapping]:
        return self.layers[0].by_cc

    @property
    def disabled(self) -> set:
        return self.layers[0].disabled

    @property
    def layering(self) -> bool:
        return self.layer_cc is not None

    @property
    def layer_count(self) -> int:
        return len(self.layers)

    def lookup_cc(self, cc: int, layer: int = 0) -> Optional[Mapping]:
        return self.layers[layer].by_cc.get(cc)

    def all_mapped_ccs(self) -> set:
        """Every CC assigned on any layer.

        The controller sends the same CCs whatever layer is selected, so this is
        the set that must never reach the synth as raw CC data.
        """
        out = set()
        for layer in self.layers:
            out.update(layer.by_cc)
        return out

    def layer_edge_hysteresis(self) -> int:
        return self.hysteresis if self.layer_hysteresis is None else self.layer_hysteresis

    def as_name_to_cc(self, layer: int = 0) -> Dict[str, int]:
        """Mapping in config order: parameter name -> CC number."""
        out = {}
        for m in sorted(self.layers[layer].by_cc.values(), key=lambda m: m.param.index):
            out[m.param.name] = m.cc
        return out


def _require_int(value, label, low, high):
    # bool is a subclass of int, so YAML's on/off/yes/no would silently become 1/0.
    if isinstance(value, bool):
        raise ConfigError(f"{label}: expected a number, got {'on' if value else 'off'}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ConfigError(f"{label}: expected a number, got {value!r}")
    if not low <= number <= high:
        raise ConfigError(f"{label}: must be {low}-{high}, got {number}")
    return number


def _require_bool(value, label) -> bool:
    """Accept YAML's booleans plus the quoted spellings of them."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("on", "yes", "true", "1"):
            return True
        if text in DISABLED_WORDS:
            return False
    raise ConfigError(f"{label}: expected true or false, got {value!r}")


def is_disabled(value) -> bool:
    """True for the ways a config entry can say 'ignore this one'.

    YAML turns a bare `off`, `no` and `false` into Python False, and an empty
    value or `null` into None; the quoted spellings arrive as strings.
    """
    if value is None:
        return True
    if isinstance(value, bool):
        return value is False
    if isinstance(value, str):
        return value.strip().lower() in DISABLED_WORDS
    return False


def parse(raw: dict, source: str = "config") -> Config:
    """Turn parsed YAML into a validated Config, or raise ConfigError."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError(f"{source}: top level must be a mapping")

    midi = raw.get("midi") or {}
    if not isinstance(midi, dict):
        raise ConfigError(f"{source}: 'midi' must be a mapping")

    cfg = Config()
    cfg.synth_channel = _require_int(midi.get("synth_channel", 1), "midi.synth_channel", 1, 16)

    listen = midi.get("listen_channel", "any")
    if listen in (None, "any", "all", "*"):
        cfg.listen_channel = None
    else:
        cfg.listen_channel = _require_int(listen, "midi.listen_channel", 1, 16)

    cfg.level_byte = _require_int(midi.get("level_byte", alpha_juno.DEFAULT_LEVEL),
                                  "midi.level_byte", 0, 127)
    cfg.group_byte = _require_int(midi.get("group_byte", alpha_juno.DEFAULT_GROUP),
                                  "midi.group_byte", 0, 127)
    cfg.max_msgs_per_sec = _require_int(midi.get("max_msgs_per_sec", 100),
                                        "midi.max_msgs_per_sec", 1, 1000)
    cfg.hysteresis = _require_int(midi.get("hysteresis", 2), "midi.hysteresis", 0, 16)
    cfg.thru = _require_bool(midi.get("thru", False), "midi.thru")

    ports = raw.get("ports") or {}
    if not isinstance(ports, dict):
        raise ConfigError(f"{source}: 'ports' must be a mapping with 'input' and 'output'")
    for field, attr in (("input", "port_input"), ("output", "port_output")):
        value = ports.get(field)
        if isinstance(value, bool):
            raise ConfigError(f"{source}: ports.{field}: expected a port name, index, "
                              f"or 'ask'; got {'on' if value else 'off'}")
        if value is None or (isinstance(value, str) and value.strip().lower() in ASK_WORDS):
            continue
        setattr(cfg, attr, str(value).strip())

    sections = _layer_sections(raw, source)
    _parse_layers_block(cfg, raw.get("layers"), sections, source)
    cfg.layout = _parse_layout(raw.get("layout"), source)

    for layer in cfg.layers:
        key, entries = sections.get(layer.number, (None, None))
        if entries is not None:
            _fill_layer(layer, entries, key, source)

    if cfg.layering:
        for layer in cfg.layers:
            clash = layer.by_cc.get(cfg.layer_cc)
            if clash is not None:
                raise ConfigError(
                    f"{source}: CC{cfg.layer_cc} selects the layer, so it cannot also be "
                    f"mapped to {clash.param.name!r} on layer {layer.number}"
                )

    if not any(layer.by_cc for layer in cfg.layers):
        where = "every layer" if cfg.layering else "'mappings'"
        if any(layer.disabled for layer in cfg.layers):
            raise ConfigError(f"{source}: every parameter in {where} is switched off, "
                              f"nothing to do")
        raise ConfigError(f"{source}: {where} is empty, nothing to do")
    return cfg


def _layer_sections(raw: dict, source: str) -> Dict[int, tuple]:
    """Find the per-layer mapping sections, keyed by 1-based layer number.

    Anything else at the top level is an error rather than something quietly
    skipped: a mistyped 'mapings' or 'layar2' would otherwise throw away a whole
    set of assignments and leave the knobs doing nothing for no visible reason.
    """
    sections = {}
    for key in raw:
        if key in ("ports", "midi", "layers", "layout"):
            continue
        number = None
        if key == "mappings":
            number = 1
        elif isinstance(key, str):
            match = LAYER_SECTION_RE.match(key)
            if match:
                number = int(match.group(1))
                if not 1 <= number <= MAX_LAYERS:
                    raise ConfigError(f"{source}: section {key!r}: layers are numbered "
                                      f"1-{MAX_LAYERS}")
        if number is None:
            raise ConfigError(
                f"{source}: unknown top-level section {key!r}. Expected 'ports', 'midi', "
                f"'layers', 'layout', 'mappings', or 'layer1' ... 'layer{MAX_LAYERS}'."
            )

        if number in sections:
            raise ConfigError(f"{source}: layer {number} is defined twice "
                              f"(as {sections[number][0]!r} and {key!r})")
        entries = raw[key]
        if not isinstance(entries, dict):
            raise ConfigError(f"{source}: {key!r} must be a mapping of "
                              f"parameter name -> CC")
        sections[number] = (key, entries)

    if not sections:
        raise ConfigError(f"{source}: no 'mappings' section found")
    return sections


def _layer_names(value, count: int, source: str) -> List[str]:
    """Split the optional comma-separated layer names.

    A YAML list would be the obvious spelling, but the Tulip build's YAML reader
    does not support lists and the two platforms share this file, so the names
    are one string.
    """
    if value is None:
        return [""] * count
    if isinstance(value, (list, tuple)):
        raise ConfigError(f"{source}: layers.names must be one comma-separated string, "
                          f"not a list (a list cannot be read by the Tulip version)")
    names = [part.strip() for part in str(value).split(",")]
    while names and not names[-1]:
        names.pop()
    if len(names) > count:
        raise ConfigError(f"{source}: layers.names lists {len(names)} names but there "
                          f"are only {count} layers")
    return names + [""] * (count - len(names))


def _parse_layers_block(cfg: Config, block, sections: Dict[int, tuple], source: str) -> None:
    """Read the `layers:` section and size cfg.layers to match."""
    highest = max(sections)

    if block is None:
        if highest > 1:
            raise ConfigError(
                f"{source}: layer sections are defined but there is no 'layers:' section "
                f"saying which CC selects between them. Add:\n"
                f"  layers:\n    cc: 41"
            )
        cfg.layers = [LayerMap(1)]
        return

    if not isinstance(block, dict):
        raise ConfigError(f"{source}: 'layers' must be a mapping with a 'cc' value")
    if "cc" not in block or is_disabled(block.get("cc")):
        raise ConfigError(f"{source}: 'layers' needs a 'cc' value naming the knob that "
                          f"selects the layer (or delete the section to switch layering off)")

    cfg.layer_cc = _require_int(block["cc"], "layers.cc", 0, 127)
    count = _require_int(block.get("count", highest), "layers.count", 1, MAX_LAYERS)
    if count < highest:
        raise ConfigError(f"{source}: layers.count is {count} but 'layer{highest}' is "
                          f"defined; raise the count or delete the section")

    cfg.startup_layer = _require_int(block.get("startup", 1), "layers.startup", 1, count)
    if "hysteresis" in block:
        cfg.layer_hysteresis = _require_int(block["hysteresis"], "layers.hysteresis", 0, 16)

    names = _layer_names(block.get("names"), count, source)
    cfg.layers = [LayerMap(number=n + 1, name=names[n]) for n in range(count)]


def _parse_layout(block, source: str) -> Optional[Layout]:
    """Read the optional `layout:` section describing the physical knob grid.

    The CC list is one comma-separated string rather than a YAML list for the same
    reason `layers.names` is: the Tulip build's reader has no lists and all the
    builds share this file.  A short list is padded with empty cells, since typing
    a run of trailing `off`s by hand is a chore; too long is an error, because it
    means the grid is not the shape it says it is.
    """
    if block is None:
        return None
    if not isinstance(block, dict):
        raise ConfigError(f"{source}: 'layout' must be a mapping with 'rows', 'cols' "
                          f"and 'ccs'")

    rows = _require_int(block.get("rows", 1), "layout.rows", 1, 32)
    cols = _require_int(block.get("cols", 1), "layout.cols", 1, 32)
    cells = rows * cols

    raw_ccs = block.get("ccs")
    if isinstance(raw_ccs, (list, tuple)):
        raise ConfigError(f"{source}: layout.ccs must be one comma-separated string, "
                          f"not a list (a list cannot be read by the Tulip version)")

    text = "" if raw_ccs is None else str(raw_ccs)
    parts = [part.strip() for part in text.split(",")] if text.strip() else []
    while parts and not parts[-1]:
        parts.pop()
    if len(parts) > cells:
        raise ConfigError(f"{source}: layout.ccs lists {len(parts)} cells but the grid is "
                          f"{rows}x{cols} = {cells}")

    ccs: List[Optional[int]] = []
    seen: Dict[int, int] = {}
    for position, part in enumerate(parts):
        if is_disabled(part):
            ccs.append(None)
            continue
        cc = _require_int(part, f"layout.ccs cell {position + 1}", 0, 127)
        if cc in seen:
            raise ConfigError(f"{source}: layout.ccs has CC{cc} in cell {seen[cc] + 1} and "
                              f"again in cell {position + 1}; one knob sits in one place")
        seen[cc] = position
        ccs.append(cc)

    ccs += [None] * (cells - len(ccs))
    return Layout(rows=rows, cols=cols, ccs=ccs)


def _fill_layer(layer: LayerMap, mappings: dict, section: str, source: str) -> None:
    """Read one layer's parameter -> CC assignments into `layer`."""
    seen_params = {}
    for key, entry in mappings.items():
        param = alpha_juno.lookup(key)
        if param is None:
            raise ConfigError(
                f"{source}: {section}: unknown parameter name {key!r}. "
                f"Run with --list-params to see the 36 valid names."
            )

        mode = "scale"
        if isinstance(entry, dict):
            if "cc" not in entry:
                raise ConfigError(f"{source}: {section}: mapping for {key!r} has no 'cc' "
                                  f"value (use 'off' to disable it)")
            cc_raw = entry["cc"]
            mode = str(entry.get("mode", "scale")).lower()
            if mode not in ("scale", "clamp"):
                raise ConfigError(f"{source}: {section}: mapping for {key!r} has unknown "
                                  f"mode {mode!r} (expected 'scale' or 'clamp')")
        else:
            cc_raw = entry

        # A parameter named twice is a typo worth reporting even if one is disabled.
        if param.index in seen_params:
            raise ConfigError(
                f"{source}: {section}: {param.name} is mapped twice "
                f"(as {seen_params[param.index]!r} and {key!r})"
            )
        seen_params[param.index] = key

        if is_disabled(cc_raw):
            layer.disabled.add(param.index)
            continue

        if isinstance(cc_raw, bool):   # a bare `on`/`yes`, which is never a CC number
            raise ConfigError(f"{source}: {section}: CC for {key!r}: expected a number "
                              f"0-127 or 'off', got 'on'")
        cc = _require_int(cc_raw, f"{source}: {section}: CC for {key!r}", 0, 127)

        if cc in layer.by_cc:
            raise ConfigError(
                f"{source}: {section}: CC{cc} is assigned to both "
                f"{layer.by_cc[cc].param.name!r} and {param.name!r}"
            )
        layer.by_cc[cc] = Mapping(cc=cc, param=param, mode=mode)


def load(path: str) -> Config:
    if not os.path.exists(path):
        raise ConfigError(
            f"config file not found: {path}\n"
            f"Create a starting point with:  ./cc2juno.py --init-config {path}"
        )
    with open(path, "r", encoding="utf-8") as handle:
        try:
            raw = yaml.safe_load(handle)
        except yaml.YAMLError as exc:
            raise ConfigError(f"{path}: could not parse YAML:\n{exc}")
    return parse(raw, source=path)


def default_mappings() -> Dict[int, int]:
    """The shipped starting point: parameter 0->CC0, 1->CC1 ... 35->CC35."""
    return {p.index: p.index for p in PARAMETERS}


def _yaml_quote(text: str) -> str:
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _port_value(name: Optional[str]) -> str:
    return "ask" if name is None else _yaml_quote(name)


def update_ports(path: str, input_name: Optional[str], output_name: Optional[str]) -> None:
    """Rewrite just the ports block of an existing config, leaving the rest untouched.

    A targeted edit rather than a re-render, so hand-written comments and any
    formatting the user prefers survive.
    """
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    wanted = {}
    if input_name is not None:
        wanted["input"] = _port_value(input_name)
    if output_name is not None:
        wanted["output"] = _port_value(output_name)
    if not wanted:
        return

    start = next((i for i, line in enumerate(lines)
                  if re.match(r"^ports:\s*(#.*)?$", line)), None)

    if start is None:
        block = ["ports:"] + [f"  {k}: {v}" for k, v in wanted.items()] + [""]
        anchor = next((i for i, line in enumerate(lines)
                       if re.match(r"^(midi|mappings):", line)), len(lines))
        lines[anchor:anchor] = block
    else:
        end = start + 1
        while end < len(lines) and (not lines[end].strip() or lines[end].startswith((" ", "\t"))):
            end += 1
        block = lines[start + 1:end]
        for field, value in wanted.items():
            pattern = re.compile(rf"^(\s*){field}:\s*(.*?)(\s*#.*)?$")
            for i, line in enumerate(block):
                match = pattern.match(line)
                if match:
                    block[i] = f"{match.group(1)}{field}: {value}{match.group(3) or ''}"
                    break
            else:
                block.insert(0, f"  {field}: {value}")
        lines[start + 1:end] = block

    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def render(mappings, cfg: Optional[Config] = None) -> str:
    """Render a fully commented YAML config.

    `mappings` is parameter index -> CC number, or a list of those, one per layer.
    An index mapped to None is written out as `off`, so the file always lists all
    36 parameters and any of them can be switched back on by typing a number over
    the `off`.
    """
    cfg = cfg or Config()
    listen = "any" if cfg.listen_channel is None else cfg.listen_channel
    layers = [mappings] if isinstance(mappings, dict) else list(mappings)
    layered = cfg.layering
    section_word = "a layer section" if layered else "'mappings'"

    lines = [
        "# cc2juno - MIDI CC to Roland Alpha Juno sysex mapping",
        "#",
        f"# Each entry under {section_word} assigns one incoming CC number to one of the",
        "# 36 Alpha Juno tone parameters. Names are matched case- and",
        "# punctuation-insensitively, so 'VCF Cutoff', 'vcf_cutoff' and 'VCF cutoff'",
        "# are all the same parameter. A bare parameter index (0-35) also works.",
        "#",
        "# Write 'off' instead of a CC number to disable an entry without deleting it:",
        "#",
        "#   \"VCF Cutoff\": off",
        "#",
        "# Incoming CC values are 0-127. Parameters that accept fewer values get the",
        "# 128 CC steps split into equal regions - a 4-option parameter reads",
        "# 0-31 as option 0, 32-63 as 1, 64-95 as 2, 96-127 as 3. To take the CC",
        "# value literally instead (clipping above the maximum), write:",
        "#",
        "#   \"Bender Range\": {cc: 90, mode: clamp}",
        "#",
        "# The synth must have sysex receive switched ON (under the MIDI button) and",
        "# its basic channel must match midi.synth_channel below.",
        "",
        "# Default MIDI ports, so the program can start without prompting. Each may be",
        "# a port name, any distinctive part of one, or a port index. Use 'ask' to be",
        "# prompted. --in/--out override these; --ask-ports ignores them.",
        "# Tip: after picking ports interactively, run with --save-ports to store them.",
        "ports:",
        f"  input: {_port_value(cfg.port_input)}",
        f"  output: {_port_value(cfg.port_output)}",
        "",
        "midi:",
        f"  synth_channel: {cfg.synth_channel}        # Alpha Juno basic channel, 1-16",
        f"  listen_channel: {listen}     # 1-16 to accept CCs on one channel only, or 'any'",
        "",
        "  # Sysex header bytes. The Roland/PG-300 charts give level 0x20, group 0x01.",
        "  # A 1995 usenet transcription gives 0x01 / 0x01 instead; if your unit ignores",
        "  # everything this program sends, try level_byte: 0x01.",
        f"  level_byte: 0x{cfg.level_byte:02X}",
        f"  group_byte: 0x{cfg.group_byte:02X}",
        "",
        "  # Each sysex message is 10 bytes, about 3.2 ms on a 31250 baud DIN cable.",
        "  # A fast knob sweep can easily outrun the synth's input buffer, so outgoing",
        "  # messages are rate limited and only the newest value per parameter is kept.",
        f"  max_msgs_per_sec: {cfg.max_msgs_per_sec}",
        "",
        "  # Dead zone in CC counts at the edges of a quantized parameter's regions,",
        "  # so a jittery pot does not flip back and forth between two options. 0 = off.",
        f"  hysteresis: {cfg.hysteresis}",
        "",
        "  # Pass everything this program does not translate - notes, pitch bend,",
        "  # aftertouch, unmapped CCs - straight from the input to the output, so one",
        "  # keyboard with knobs can both play the synth and edit it. Mapped CCs are",
        "  # consumed and never forwarded. --thru / --no-thru override this.",
        f"  thru: {'true' if cfg.thru else 'false'}",
        "",
    ]

    if cfg.layout is not None:
        lines += [
            "# Physical arrangement of the knobs, for the web front-end. Row-major,",
            "# one entry per cell, 'off' where there is no knob. The other builds do not",
            "# draw anything but do keep this section intact when they rewrite the file.",
            "layout:",
            f"  rows: {cfg.layout.rows}",
            f"  cols: {cfg.layout.cols}",
            f"  ccs: \"{cfg.layout.cc_text}\"",
            "",
        ]

    if layered:
        names = ", ".join(layer.name for layer in cfg.layers).rstrip(", ")
        lines += [
            "# Layering. One knob picks which set of assignments the other knobs use,",
            "# by cutting its 0-127 travel into one region per layer. The layer knob",
            "# itself means the same thing on every layer and can never be mapped to a",
            f"# parameter. Each layer's assignments live in its own section below,",
            f"# 'layer1' to 'layer{cfg.layer_count}'. A layer with nothing mapped is a valid",
            "# parked position where no knob does anything.",
            "layers:",
            f"  cc: {cfg.layer_cc}",
            f"  count: {cfg.layer_count}",
        ]
        if names:
            lines.append(f"  names: \"{names}\"    # comma separated, for the log only")
        lines += [
            f"  startup: {cfg.startup_layer}      # layer to assume until the knob is moved",
            "",
        ]
    else:
        lines.append("mappings:")

    width = max(len(p.name) for p in PARAMETERS) + 3
    for number, layer_mappings in enumerate(layers, start=1):
        if layered:
            title = cfg.layers[number - 1].name if number <= cfg.layer_count else ""
            lines.append(f"layer{number}:" + (f"    # {title}" if title else ""))

        for param in PARAMETERS:
            cc = layer_mappings.get(param.index)
            comment_bits = [f"#{param.index}", param.describe_range()]
            if param.note:
                comment_bits.append(param.note)
            if cc is not None and cc in STANDARD_CC_USES:
                comment_bits.append(f"NB: CC{cc} is normally {STANDARD_CC_USES[cc]}")
            comment = "  # " + " | ".join(comment_bits)

            key = f'"{param.name}":'
            value = "off" if cc is None else str(cc)
            lines.append(f"  {key:<{width}} {value:<3}{comment}")

        if layered and number < len(layers):
            lines.append("")

    lines.append("")
    return "\n".join(lines)


def write_default(path: str, mappings=None, cfg: Optional[Config] = None) -> None:
    if mappings is None:
        mappings = default_mappings()
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(render(mappings, cfg))
