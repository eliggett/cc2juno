"""Roland Alpha Juno 1/2 & MKS-50 tone parameter table, value scaling, sysex framing.

The real-time "Individual Tone Parameter" message is:

    F0 41 36 0n 23 20 01 pp vv F7
    |  |  |  |  |  |  |  |  |  +- end of sysex
    |  |  |  |  |  |  |  |  +---- parameter value
    |  |  |  |  |  |  |  +------- parameter index (0..35)
    |  |  |  |  |  |  +---------- group
    |  |  |  |  |  +------------- level
    |  |  |  |  +---------------- format type (Alpha Juno / MKS-50)
    |  |  |  +------------------- 0n = synth basic channel, 0-15
    |  |  +---------------------- opcode: individual tone parameter
    |  +------------------------- Roland
    +---------------------------- start of sysex

Note on the level/group bytes: the Roland/PG-300 charts give 20 01, which is what
this module defaults to.  A widely-circulated 1995 usenet transcription gives
01 01 instead.  Both bytes are configurable so either can be used without a code
change.  The synth must have sysex receive enabled to respond at all.
"""

from dataclasses import dataclass
from typing import Optional, Tuple

SYSEX_START = 0xF0
SYSEX_END = 0xF7
ROLAND_ID = 0x41
OPCODE_INDIVIDUAL_TONE = 0x36
FORMAT_TYPE = 0x23
DEFAULT_LEVEL = 0x20
DEFAULT_GROUP = 0x01

CC_RANGE = 128


@dataclass(frozen=True)
class Parameter:
    """One entry of the 36-parameter Alpha Juno tone table."""

    index: int
    name: str
    max_value: int
    options: Tuple[str, ...] = ()
    aliases: Tuple[str, ...] = ()
    note: str = ""

    @property
    def is_continuous(self) -> bool:
        """True when the parameter accepts the full 0..127 CC range unchanged."""
        return self.max_value >= 127

    @property
    def region_count(self) -> int:
        return self.max_value + 1

    def describe_range(self) -> str:
        if self.options:
            return ", ".join(f"{i}={o}" for i, o in enumerate(self.options))
        return f"0..{self.max_value}"

    def label(self, value: int) -> str:
        """Render a parameter value for logging, naming the enum option if there is one."""
        if self.options and 0 <= value < len(self.options):
            return f"{value} ({self.options[value]})"
        return str(value)


PARAMETERS: Tuple[Parameter, ...] = (
    Parameter(0, "DCO Env. Mode", 3,
              ("Normal", "Inverted", "Normal-Dynamic", "Inverted-Dynamic"),
              ("DCO ENV mode",)),
    Parameter(1, "VCF Env. Mode", 3,
              ("Normal", "Inverted", "Normal-Dynamic", "Dynamic"),
              ("VCF ENV mode",)),
    Parameter(2, "VCA Env. Mode", 3,
              ("Normal", "Gate", "Normal-Dynamic", "Gate-Dynamic"),
              ("VCA ENV mode",)),
    Parameter(3, "DCO Wave Pulse", 3, aliases=("DCO waveform pulse",)),
    Parameter(4, "DCO Wave Saw", 5, aliases=("DCO waveform sawtooth", "DCO Wave Sawtooth")),
    Parameter(5, "DCO Wave Sub", 5, aliases=("DCO waveform sub",)),
    Parameter(6, "DCO Range", 3, ("4'", "8'", "16'", "32'")),
    Parameter(7, "DCO Sub Level", 3),
    Parameter(8, "DCO Noise", 3, aliases=("DCO noise level",)),
    Parameter(9, "HPF Cutoff", 3, aliases=("HPF cutoff frequency",)),
    Parameter(10, "Chorus Switch", 1, ("Off", "On"), ("Chorus",)),
    Parameter(11, "DCO LFO Mod.", 127, aliases=("DCO LFO modulation depth",)),
    Parameter(12, "DCO ENV Mod.", 127, aliases=("DCO ENV modulation depth",)),
    Parameter(13, "DCO After Mod.", 127, aliases=("DCO aftertouch depth",)),
    Parameter(14, "DCO PWM Depth", 127, aliases=("DCO PW/PWM depth",)),
    Parameter(15, "DCO PWM Rate", 127, note="0 = pulse width manual, 1..127 = PW LFO rate"),
    Parameter(16, "VCF Cutoff", 127, aliases=("VCF cutoff frequency",)),
    Parameter(17, "VCF Resonance", 127),
    Parameter(18, "VCF LFO Mod.", 127, aliases=("VCF LFO modulation depth",)),
    Parameter(19, "VCF ENV Mod.", 127, aliases=("VCF ENV modulation depth",)),
    Parameter(20, "VCF Key Follow", 127),
    Parameter(21, "VCF Aftertouch", 127, aliases=("VCF aftertouch depth",)),
    Parameter(22, "VCA Level", 127),
    Parameter(23, "VCA Aftertouch", 127, aliases=("VCA aftertouch depth",)),
    Parameter(24, "LFO Rate", 127),
    Parameter(25, "LFO Delay", 127, aliases=("LFO delay time",)),
    Parameter(26, "ENV T1", 127, aliases=("Attack Time",), note="attack time"),
    Parameter(27, "ENV L1", 127, aliases=("Attack Level",), note="attack level"),
    Parameter(28, "ENV T2", 127, aliases=("Break Time",), note="break time"),
    Parameter(29, "ENV L2", 127, aliases=("Break Level",), note="break level"),
    Parameter(30, "ENV T3", 127, aliases=("Decay Time",), note="decay time"),
    Parameter(31, "ENV L3", 127, aliases=("Sustain Level",), note="sustain level"),
    Parameter(32, "ENV T4", 127, aliases=("Release Time",), note="release time"),
    Parameter(33, "ENV Key Follow", 127),
    Parameter(34, "Chorus Rate", 127),
    Parameter(35, "Bender Range", 12, aliases=("BENDER range", "Bend Range")),
)

assert len(PARAMETERS) == 36
assert all(p.index == i for i, p in enumerate(PARAMETERS))


def normalize(name: str) -> str:
    """Fold a parameter name so 'VCF Cutoff', 'vcf_cutoff' and 'VCF cutoff' all match."""
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


_BY_NORMALIZED = {}
for _p in PARAMETERS:
    for _n in (_p.name,) + _p.aliases:
        _BY_NORMALIZED[normalize(_n)] = _p
    _BY_NORMALIZED[str(_p.index)] = _p


def lookup(name) -> Optional[Parameter]:
    """Find a parameter by name, alias, or numeric index. Returns None if unknown."""
    if isinstance(name, int):
        return PARAMETERS[name] if 0 <= name < len(PARAMETERS) else None
    return _BY_NORMALIZED.get(normalize(name))


def region_start(param: Parameter, value: int) -> int:
    """Lowest CC value that maps into the region for `value` (ceil division)."""
    return (value * CC_RANGE + param.max_value) // param.region_count


def scale(param: Parameter, cc_value: int) -> int:
    """Map a 0..127 CC value onto 0..max_value by splitting 128 into equal regions.

    For a 4-option parameter this gives 0-31 -> 0, 32-63 -> 1, 64-95 -> 2, 96-127 -> 3.
    For a full-range parameter it is a pass-through.
    """
    cc_value = max(0, min(CC_RANGE - 1, int(cc_value)))
    if param.is_continuous:
        return cc_value
    return min(param.max_value, (cc_value * param.region_count) // CC_RANGE)


def clamp(param: Parameter, cc_value: int) -> int:
    """Take the CC value literally, clipping anything above the parameter's maximum."""
    return max(0, min(param.max_value, int(cc_value)))


def convert(param: Parameter, cc_value: int, mode: str = "scale",
            previous: Optional[int] = None, hysteresis: int = 2) -> int:
    """Convert a CC value to a parameter value, with a dead zone at region boundaries.

    The dead zone stops a jittery pot sitting on a boundary from machine-gunning the
    synth between two adjacent enum values.  It only applies to quantized parameters
    and only to single-region moves, so a fast sweep is never held back.
    """
    if mode == "clamp":
        value = clamp(param, cc_value)
    else:
        value = scale(param, cc_value)

    if previous is None or param.is_continuous or hysteresis <= 0:
        return value
    if abs(value - previous) != 1:
        return value

    if mode == "clamp":
        boundary = value if value > previous else previous
    else:
        boundary = region_start(param, max(value, previous))

    if value > previous:
        # Moving up: cc_value >= boundary already. Require it to have cleared the edge.
        if cc_value - boundary < hysteresis:
            return previous
    else:
        # Moving down: cc_value <= boundary - 1. Require it to have cleared the edge.
        if boundary - 1 - cc_value < hysteresis:
            return previous
    return value


def build_sysex(param_index: int, value: int, channel: int = 1,
                level: int = DEFAULT_LEVEL, group: int = DEFAULT_GROUP):
    """Build the complete 10-byte tone parameter message, F0 through F7.

    `channel` is the synth's basic channel, 1-16.
    """
    if not 1 <= channel <= 16:
        raise ValueError(f"MIDI channel must be 1-16, got {channel}")
    if not 0 <= param_index <= 35:
        raise ValueError(f"parameter index must be 0-35, got {param_index}")
    if not 0 <= value <= 127:
        raise ValueError(f"parameter value must be 0-127, got {value}")
    return [
        SYSEX_START,
        ROLAND_ID,
        OPCODE_INDIVIDUAL_TONE,
        channel - 1,
        FORMAT_TYPE,
        level & 0x7F,
        group & 0x7F,
        param_index,
        value,
        SYSEX_END,
    ]


def hex_string(data) -> str:
    return " ".join(f"{b:02X}" for b in data)
