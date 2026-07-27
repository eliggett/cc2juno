"""Load, validate and generate the CC -> Alpha Juno parameter mapping config."""

import os
import re
from dataclasses import dataclass
from typing import Dict, Optional

import yaml

import alpha_juno
from alpha_juno import PARAMETERS, Parameter

DEFAULT_CONFIG_NAME = "cc2juno.yaml"

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
    by_cc: Dict[int, Mapping] = None
    disabled: set = None                  # parameter indexes explicitly switched off

    def __post_init__(self):
        if self.by_cc is None:
            self.by_cc = {}
        if self.disabled is None:
            self.disabled = set()

    def lookup_cc(self, cc: int) -> Optional[Mapping]:
        return self.by_cc.get(cc)

    def as_name_to_cc(self) -> Dict[str, int]:
        """Mapping in config order: parameter name -> CC number."""
        out = {}
        for m in sorted(self.by_cc.values(), key=lambda m: m.param.index):
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

    mappings = raw.get("mappings")
    if mappings is None:
        raise ConfigError(f"{source}: no 'mappings' section found")
    if not isinstance(mappings, dict):
        raise ConfigError(f"{source}: 'mappings' must be a mapping of parameter name -> CC")

    seen_params = {}
    for key, entry in mappings.items():
        param = alpha_juno.lookup(key)
        if param is None:
            raise ConfigError(
                f"{source}: unknown parameter name {key!r}. "
                f"Run with --list-params to see the 36 valid names."
            )

        mode = "scale"
        if isinstance(entry, dict):
            if "cc" not in entry:
                raise ConfigError(f"{source}: mapping for {key!r} has no 'cc' value "
                                  f"(use 'off' to disable it)")
            cc_raw = entry["cc"]
            mode = str(entry.get("mode", "scale")).lower()
            if mode not in ("scale", "clamp"):
                raise ConfigError(f"{source}: mapping for {key!r} has unknown mode {mode!r} "
                                  f"(expected 'scale' or 'clamp')")
        else:
            cc_raw = entry

        # A parameter named twice is a typo worth reporting even if one is disabled.
        if param.index in seen_params:
            raise ConfigError(
                f"{source}: {param.name} is mapped twice "
                f"(as {seen_params[param.index]!r} and {key!r})"
            )
        seen_params[param.index] = key

        if is_disabled(cc_raw):
            cfg.disabled.add(param.index)
            continue

        if isinstance(cc_raw, bool):   # a bare `on`/`yes`, which is never a CC number
            raise ConfigError(f"{source}: CC for {key!r}: expected a number 0-127 "
                              f"or 'off', got 'on'")
        cc = _require_int(cc_raw, f"{source}: CC for {key!r}", 0, 127)

        if cc in cfg.by_cc:
            raise ConfigError(
                f"{source}: CC{cc} is assigned to both "
                f"{cfg.by_cc[cc].param.name!r} and {param.name!r}"
            )
        cfg.by_cc[cc] = Mapping(cc=cc, param=param, mode=mode)

    if not cfg.by_cc:
        if cfg.disabled:
            raise ConfigError(f"{source}: every parameter in 'mappings' is switched off, "
                              f"nothing to do")
        raise ConfigError(f"{source}: 'mappings' is empty, nothing to do")
    return cfg


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


def render(mappings: Dict[int, Optional[int]], cfg: Optional[Config] = None) -> str:
    """Render a fully commented YAML config.

    `mappings` is parameter index -> CC number; an index mapped to None is written
    out as `off`, so the file always lists all 36 parameters and any of them can be
    switched back on by typing a number over the `off`.
    """
    cfg = cfg or Config()
    listen = "any" if cfg.listen_channel is None else cfg.listen_channel

    lines = [
        "# cc2juno - MIDI CC to Roland Alpha Juno sysex mapping",
        "#",
        "# Each entry under 'mappings' assigns one incoming CC number to one of the",
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
        "mappings:",
    ]

    width = max(len(p.name) for p in PARAMETERS) + 3
    for param in PARAMETERS:
        cc = mappings.get(param.index)
        comment_bits = [f"#{param.index}", param.describe_range()]
        if param.note:
            comment_bits.append(param.note)
        if cc is not None and cc in STANDARD_CC_USES:
            comment_bits.append(f"NB: CC{cc} is normally {STANDARD_CC_USES[cc]}")
        comment = "  # " + " | ".join(comment_bits)

        key = f'"{param.name}":'
        value = "off" if cc is None else str(cc)
        lines.append(f"  {key:<{width}} {value:<3}{comment}")

    lines.append("")
    return "\n".join(lines)


def write_default(path: str, mappings: Optional[Dict[int, Optional[int]]] = None,
                  cfg: Optional[Config] = None) -> None:
    if mappings is None:
        mappings = default_mappings()
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(render(mappings, cfg))
