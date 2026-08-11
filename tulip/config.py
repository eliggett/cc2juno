"""Load and validate the CC -> Alpha Juno parameter mapping config, on Tulip.

Reads the same cc2juno.yaml as the desktop version, so a config tested on a PC
can be copied to /user and used unchanged.  Differences, all because Tulip has
no ports to choose and no interactive setup:

  * a `ports:` section is accepted and ignored - Tulip merges TRS and USB MIDI
    into one input and sends to both outputs, so there is nothing to select
  * `midi.log` is read here and ignored by the desktop version
  * there is no writer: configs are edited on screen or copied in

Layering (a `layers:` section plus `layer1:` ... `layer10:`) works the same on
both, which is why the layer names are one comma-separated string rather than a
YAML list: miniyaml has no lists.
"""

import alpha_juno
import miniyaml
from alpha_juno import MAX_LAYERS, PARAMETERS

DEFAULT_CONFIG_NAME = "cc2juno.yaml"

# Tried in order when no explicit path is given, so `import cc2juno` works from
# either the REPL's working directory or a config parked in /user.
CONFIG_SEARCH = ("cc2juno.yaml", "/user/cc2juno.yaml")

# Spellings that turn an entry off without deleting it.
DISABLED_WORDS = ("off", "none", "null", "no", "false", "disable", "disabled", "-", "")

LOG_OFF = 0
LOG_QUIET = 1
LOG_NORMAL = 2
LOG_VERBOSE = 3

LOG_NAMES = {"off": LOG_OFF, "quiet": LOG_QUIET, "normal": LOG_NORMAL,
             "verbose": LOG_VERBOSE, "on": LOG_NORMAL, "true": LOG_NORMAL}


class ConfigError(Exception):
    """Raised for anything that would make the mapping ambiguous or unusable."""


class Mapping:
    def __init__(self, cc, param, mode="scale"):
        self.cc = cc
        self.param = param
        self.mode = mode


class LayerMap:
    """One layer: a complete set of knob assignments, selected by the layer knob."""

    def __init__(self, number=1, name=""):
        self.number = number                # 1-based, as written in the config
        self.name = name
        self.by_cc = {}                     # CC number -> Mapping
        self.disabled = set()               # parameter indexes explicitly switched off

    @property
    def label(self):
        if self.name:
            return "{} ({})".format(self.number, self.name)
        return str(self.number)


class Config:
    def __init__(self):
        self.synth_channel = 1
        self.listen_channel = None          # None = accept every channel
        self.level_byte = alpha_juno.DEFAULT_LEVEL
        self.group_byte = alpha_juno.DEFAULT_GROUP
        self.max_msgs_per_sec = 100
        self.hysteresis = 2
        self.thru = False                   # forward untranslated traffic to the output
        self.log = LOG_NORMAL
        self.layer_cc = None                # None = no layering, one fixed layer
        self.startup_layer = 1              # 1-based; the knob's position is unknowable
        self.layer_hysteresis = None        # None = use `hysteresis`
        self.layers = [LayerMap(1)]
        self.path = None                    # filled in by load()

    # An unlayered config is just a layered one with a single layer, so the
    # single-layer accessors stay pointed at layer 1 rather than growing an
    # `if self.layering` at every call site.
    @property
    def by_cc(self):
        return self.layers[0].by_cc

    @property
    def disabled(self):
        return self.layers[0].disabled

    @property
    def layering(self):
        return self.layer_cc is not None

    @property
    def layer_count(self):
        return len(self.layers)

    def lookup_cc(self, cc, layer=0):
        return self.layers[layer].by_cc.get(cc)

    def all_mapped_ccs(self):
        """Every CC assigned on any layer.

        The controller sends the same CCs whatever layer is selected, so this is
        the set that must never reach the synth as raw CC data.
        """
        out = set()
        for layer in self.layers:
            for cc in layer.by_cc:
                out.add(cc)
        return out

    def layer_edge_hysteresis(self):
        if self.layer_hysteresis is None:
            return self.hysteresis
        return self.layer_hysteresis


def _quote(value):
    """Stand-in for {!r}, which MicroPython's format does not support."""
    if isinstance(value, str):
        return "'" + value + "'"
    return str(value)


def _require_int(value, label, low, high):
    # bool is a subclass of int here too, so YAML's on/off/yes/no would silently
    # become 1/0 without this guard.
    if isinstance(value, bool):
        raise ConfigError("{}: expected a number, got {}".format(
            label, "on" if value else "off"))
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ConfigError("{}: expected a number, got {}".format(label, _quote(value)))
    if not low <= number <= high:
        raise ConfigError("{}: must be {}-{}, got {}".format(label, low, high, number))
    return number


def _require_bool(value, label):
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
    raise ConfigError("{}: expected true or false, got {}".format(label, _quote(value)))


def _require_log(value, label):
    if value is None:
        return LOG_NORMAL
    if value is False:
        return LOG_OFF
    if value is True:
        return LOG_NORMAL
    if isinstance(value, str):
        level = LOG_NAMES.get(value.strip().lower())
        if level is not None:
            return level
    raise ConfigError("{}: expected off, quiet, normal or verbose, got {}".format(
        label, _quote(value)))


def log_level(value):
    """Turn 'off'/'quiet'/'normal'/'verbose' into a LOG_* constant."""
    return _require_log(value, "log")


def is_disabled(value):
    """True for the ways a config entry can say 'ignore this one'.

    YAML turns a bare `off`, `no` and `false` into False, and an empty value or
    `null` into None; the quoted spellings arrive as strings.
    """
    if value is None:
        return True
    if isinstance(value, bool):
        return value is False
    if isinstance(value, str):
        return value.strip().lower() in DISABLED_WORDS
    return False


def parse(raw, source="config"):
    """Turn parsed YAML into a validated Config, or raise ConfigError."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError("{}: top level must be a mapping".format(source))

    midi = raw.get("midi") or {}
    if not isinstance(midi, dict):
        raise ConfigError("{}: 'midi' must be a mapping".format(source))

    cfg = Config()
    cfg.synth_channel = _require_int(midi.get("synth_channel", 1),
                                     "midi.synth_channel", 1, 16)

    listen = midi.get("listen_channel", "any")
    if listen is None or listen in ("any", "all", "*"):
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
    cfg.log = _require_log(midi.get("log"), "midi.log")

    sections = _layer_sections(raw, source)
    _parse_layers_block(cfg, raw.get("layers"), sections, source)

    for layer in cfg.layers:
        entry = sections.get(layer.number)
        if entry is not None:
            _fill_layer(layer, entry[1], entry[0], source)

    if cfg.layering:
        for layer in cfg.layers:
            clash = layer.by_cc.get(cfg.layer_cc)
            if clash is not None:
                raise ConfigError(
                    "{}: CC{} selects the layer, so it cannot also be mapped to {} "
                    "on layer {}".format(source, cfg.layer_cc,
                                         _quote(clash.param.name), layer.number))

    for layer in cfg.layers:
        if layer.by_cc:
            return cfg

    where = "every layer" if cfg.layering else "'mappings'"
    for layer in cfg.layers:
        if layer.disabled:
            raise ConfigError("{}: every parameter in {} is switched off, "
                              "nothing to do".format(source, where))
    raise ConfigError("{}: {} is empty, nothing to do".format(source, where))


def _layer_number(key):
    """1 for 'mappings', N for 'layerN', None for anything else."""
    if key == "mappings":
        return 1
    if not isinstance(key, str) or not key.startswith("layer") or key == "layers":
        return None
    digits = key[5:]
    if not digits or not digits.isdigit():
        return None
    return int(digits)


def _layer_sections(raw, source):
    """Find the per-layer mapping sections, keyed by 1-based layer number.

    Anything else at the top level is an error rather than something quietly
    skipped: a mistyped 'mapings' or 'layar2' would otherwise throw away a whole
    set of assignments and leave the knobs doing nothing for no visible reason.
    """
    sections = {}
    for key in raw:
        # 'layout' describes where the knobs physically sit, which only the web
        # front-end draws. It is skipped rather than rejected so one config file
        # still serves every build; the Tulip has no screen to lay them out on.
        if key in ("ports", "midi", "layers", "layout"):
            continue
        number = _layer_number(key)
        if number is None:
            raise ConfigError(
                "{}: unknown top-level section {}. Expected 'ports', 'midi', 'layers', "
                "'layout', 'mappings', or 'layer1' ... 'layer{}'.".format(
                    source, _quote(key), MAX_LAYERS))
        if not 1 <= number <= MAX_LAYERS:
            raise ConfigError("{}: section {}: layers are numbered 1-{}".format(
                source, _quote(key), MAX_LAYERS))
        if number in sections:
            raise ConfigError("{}: layer {} is defined twice (as {} and {})".format(
                source, number, _quote(sections[number][0]), _quote(key)))
        entries = raw[key]
        if not isinstance(entries, dict):
            raise ConfigError("{}: {} must be a mapping of parameter name -> CC".format(
                source, _quote(key)))
        sections[number] = (key, entries)

    if not sections:
        raise ConfigError("{}: no 'mappings' section found".format(source))
    return sections


def _layer_names(value, count, source):
    """Split the optional comma-separated layer names."""
    if value is None:
        return [""] * count
    names = []
    for part in str(value).split(","):
        names.append(part.strip())
    while names and not names[-1]:
        names.pop()
    if len(names) > count:
        raise ConfigError("{}: layers.names lists {} names but there are only "
                          "{} layers".format(source, len(names), count))
    return names + [""] * (count - len(names))


def _parse_layers_block(cfg, block, sections, source):
    """Read the `layers:` section and size cfg.layers to match."""
    highest = max(sections)

    if block is None:
        if highest > 1:
            raise ConfigError(
                "{}: layer sections are defined but there is no 'layers:' section "
                "saying which CC selects between them. Add:\n"
                "  layers:\n    cc: 41".format(source))
        cfg.layers = [LayerMap(1)]
        return

    if not isinstance(block, dict):
        raise ConfigError("{}: 'layers' must be a mapping with a 'cc' value".format(source))
    if "cc" not in block or is_disabled(block.get("cc")):
        raise ConfigError("{}: 'layers' needs a 'cc' value naming the knob that selects "
                          "the layer (or delete the section to switch layering "
                          "off)".format(source))

    cfg.layer_cc = _require_int(block["cc"], "layers.cc", 0, 127)
    count = _require_int(block.get("count", highest), "layers.count", 1, MAX_LAYERS)
    if count < highest:
        raise ConfigError("{}: layers.count is {} but 'layer{}' is defined; raise the "
                          "count or delete the section".format(source, count, highest))

    cfg.startup_layer = _require_int(block.get("startup", 1), "layers.startup", 1, count)
    if "hysteresis" in block:
        cfg.layer_hysteresis = _require_int(block["hysteresis"], "layers.hysteresis", 0, 16)

    names = _layer_names(block.get("names"), count, source)
    cfg.layers = []
    for n in range(count):
        cfg.layers.append(LayerMap(n + 1, names[n]))


def _fill_layer(layer, mappings, section, source):
    """Read one layer's parameter -> CC assignments into `layer`."""
    seen_params = {}
    for key in mappings:
        entry = mappings[key]
        param = alpha_juno.lookup(key)
        if param is None:
            raise ConfigError(
                "{}: {}: unknown parameter name {}. "
                "See cc2juno.params() for the 36 valid names.".format(
                    source, section, _quote(key)))

        mode = "scale"
        if isinstance(entry, dict):
            if "cc" not in entry:
                raise ConfigError("{}: {}: mapping for {} has no 'cc' value "
                                  "(use 'off' to disable it)".format(
                                      source, section, _quote(key)))
            cc_raw = entry["cc"]
            mode = str(entry.get("mode", "scale")).lower()
            if mode not in ("scale", "clamp"):
                raise ConfigError("{}: {}: mapping for {} has unknown mode {} "
                                  "(expected 'scale' or 'clamp')".format(
                                      source, section, _quote(key), _quote(mode)))
        else:
            cc_raw = entry

        # A parameter named twice is a typo worth reporting even if one is disabled.
        if param.index in seen_params:
            raise ConfigError("{}: {}: {} is mapped twice (as {} and {})".format(
                source, section, param.name,
                _quote(seen_params[param.index]), _quote(key)))
        seen_params[param.index] = key

        if is_disabled(cc_raw):
            layer.disabled.add(param.index)
            continue

        if isinstance(cc_raw, bool):   # a bare `on`/`yes`, which is never a CC number
            raise ConfigError("{}: {}: CC for {}: expected a number 0-127 or 'off', "
                              "got 'on'".format(source, section, _quote(key)))
        cc = _require_int(cc_raw, "{}: {}: CC for {}".format(
            source, section, _quote(key)), 0, 127)

        if cc in layer.by_cc:
            raise ConfigError("{}: {}: CC{} is assigned to both {} and {}".format(
                source, section, cc,
                _quote(layer.by_cc[cc].param.name), _quote(param.name)))
        layer.by_cc[cc] = Mapping(cc, param, mode)


def find(path=None):
    """Return the first config path that can be opened, or raise ConfigError."""
    candidates = (path,) if path else CONFIG_SEARCH
    for candidate in candidates:
        try:
            handle = open(candidate)
        except OSError:
            continue
        handle.close()
        return candidate
    raise ConfigError("config file not found: {}\nCopy {} to /user and try again.".format(
        ", ".join(candidates), DEFAULT_CONFIG_NAME))


def load(path=None):
    path = find(path)
    try:
        raw = miniyaml.load(path)
    except miniyaml.YamlError as exc:
        raise ConfigError("{}: could not parse YAML:\n  {}".format(path, exc))
    except OSError as exc:
        raise ConfigError("{}: could not read: {}".format(path, exc))
    cfg = parse(raw, path)
    cfg.path = path
    return cfg
