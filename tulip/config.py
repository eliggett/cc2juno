"""Load and validate the CC -> Alpha Juno parameter mapping config, on Tulip.

Reads the same cc2juno.yaml as the desktop version, so a config tested on a PC
can be copied to /user and used unchanged.  Differences, all because Tulip has
no ports to choose and no interactive setup:

  * a `ports:` section is accepted and ignored - Tulip merges TRS and USB MIDI
    into one input and sends to both outputs, so there is nothing to select
  * `midi.log` is read here and ignored by the desktop version
  * there is no writer: configs are edited on screen or copied in
"""

import alpha_juno
import miniyaml
from alpha_juno import PARAMETERS

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
        self.by_cc = {}                     # CC number -> Mapping
        self.disabled = set()               # parameter indexes explicitly switched off
        self.path = None                    # filled in by load()

    def lookup_cc(self, cc):
        return self.by_cc.get(cc)


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

    mappings = raw.get("mappings")
    if mappings is None:
        raise ConfigError("{}: no 'mappings' section found".format(source))
    if not isinstance(mappings, dict):
        raise ConfigError(
            "{}: 'mappings' must be a mapping of parameter name -> CC".format(source))

    seen_params = {}
    for key in mappings:
        entry = mappings[key]
        param = alpha_juno.lookup(key)
        if param is None:
            raise ConfigError(
                "{}: unknown parameter name {}. "
                "See cc2juno.params() for the 36 valid names.".format(source, _quote(key)))

        mode = "scale"
        if isinstance(entry, dict):
            if "cc" not in entry:
                raise ConfigError("{}: mapping for {} has no 'cc' value "
                                  "(use 'off' to disable it)".format(source, _quote(key)))
            cc_raw = entry["cc"]
            mode = str(entry.get("mode", "scale")).lower()
            if mode not in ("scale", "clamp"):
                raise ConfigError("{}: mapping for {} has unknown mode {} "
                                  "(expected 'scale' or 'clamp')".format(
                                      source, _quote(key), _quote(mode)))
        else:
            cc_raw = entry

        # A parameter named twice is a typo worth reporting even if one is disabled.
        if param.index in seen_params:
            raise ConfigError("{}: {} is mapped twice (as {} and {})".format(
                source, param.name, _quote(seen_params[param.index]), _quote(key)))
        seen_params[param.index] = key

        if is_disabled(cc_raw):
            cfg.disabled.add(param.index)
            continue

        if isinstance(cc_raw, bool):   # a bare `on`/`yes`, which is never a CC number
            raise ConfigError("{}: CC for {}: expected a number 0-127 or 'off', "
                              "got 'on'".format(source, _quote(key)))
        cc = _require_int(cc_raw, "{}: CC for {}".format(source, _quote(key)), 0, 127)

        if cc in cfg.by_cc:
            raise ConfigError("{}: CC{} is assigned to both {} and {}".format(
                source, cc, _quote(cfg.by_cc[cc].param.name), _quote(param.name)))
        cfg.by_cc[cc] = Mapping(cc, param, mode)

    if not cfg.by_cc:
        if cfg.disabled:
            raise ConfigError("{}: every parameter in 'mappings' is switched off, "
                              "nothing to do".format(source))
        raise ConfigError("{}: 'mappings' is empty, nothing to do".format(source))
    return cfg


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
