#!/usr/bin/env python3
"""Boundary checks for CC -> parameter value scaling and sysex framing.

Run directly:  ./test_scaling.py
"""

import os
import sys

import alpha_juno
import config as config_mod
from alpha_juno import build_sysex, convert, lookup, scale


def test_four_option_regions():
    """A 4-option parameter splits 128 CC steps into 0-31 / 32-63 / 64-95 / 96-127."""
    p = lookup("VCA Env. Mode")
    assert p.max_value == 3
    for cc in range(0, 32):
        assert scale(p, cc) == 0, cc
    for cc in range(32, 64):
        assert scale(p, cc) == 1, cc
    for cc in range(64, 96):
        assert scale(p, cc) == 2, cc
    for cc in range(96, 128):
        assert scale(p, cc) == 3, cc


def test_all_ranges_are_covered_and_never_exceeded():
    """Every parameter reaches 0 and its maximum, and never overshoots."""
    for p in alpha_juno.PARAMETERS:
        values = [scale(p, cc) for cc in range(128)]
        assert min(values) == 0, p.name
        assert max(values) == p.max_value, (p.name, max(values))
        assert values == sorted(values), p.name
        assert set(values) == set(range(p.max_value + 1)), p.name


def test_region_sizes_are_even():
    """Region widths differ by at most one CC step."""
    for p in alpha_juno.PARAMETERS:
        if p.is_continuous:
            continue
        counts = {}
        for cc in range(128):
            counts[scale(p, cc)] = counts.get(scale(p, cc), 0) + 1
        assert max(counts.values()) - min(counts.values()) <= 1, (p.name, counts)


def test_region_start_matches_scale():
    for p in alpha_juno.PARAMETERS:
        for value in range(1, p.max_value + 1):
            start = alpha_juno.region_start(p, value)
            assert scale(p, start) == value, (p.name, value, start)
            assert scale(p, start - 1) == value - 1, (p.name, value, start)


def test_continuous_is_passthrough():
    p = lookup("VCF Cutoff")
    for cc in range(128):
        assert scale(p, cc) == cc
    assert convert(p, 100, previous=99) == 100


def test_clamp_mode():
    p = lookup("Bender Range")
    assert convert(p, 5, mode="clamp") == 5
    assert convert(p, 12, mode="clamp") == 12
    assert convert(p, 127, mode="clamp") == 12
    assert convert(p, 0, mode="clamp") == 0


def test_hysteresis_holds_at_a_boundary():
    """A pot dithering around CC 32 must not flip a 4-option parameter back and forth."""
    p = lookup("VCA Env. Mode")
    assert convert(p, 32, previous=0, hysteresis=2) == 0   # just over the edge, held
    assert convert(p, 33, previous=0, hysteresis=2) == 0
    assert convert(p, 34, previous=0, hysteresis=2) == 1   # cleared the dead zone
    assert convert(p, 31, previous=1, hysteresis=2) == 1   # just under the edge, held
    assert convert(p, 29, previous=1, hysteresis=2) == 0
    # A big jump is never held back.
    assert convert(p, 127, previous=0, hysteresis=2) == 3
    # Hysteresis off means the raw region wins.
    assert convert(p, 32, previous=0, hysteresis=0) == 1


def test_sysex_frame():
    frame = build_sysex(22, 100, channel=1)
    assert frame == [0xF0, 0x41, 0x36, 0x00, 0x23, 0x20, 0x01, 0x16, 0x64, 0xF7]
    assert alpha_juno.hex_string(frame) == "F0 41 36 00 23 20 01 16 64 F7"
    # Channel 16 lands in the low nibble as 0x0F.
    assert build_sysex(0, 0, channel=16)[3] == 0x0F
    # The legacy header bytes are reachable.
    assert build_sysex(0, 0, channel=1, level=0x01)[5] == 0x01


def test_sysex_rejects_bad_input():
    for bad in (lambda: build_sysex(36, 0), lambda: build_sysex(0, 128),
                lambda: build_sysex(0, 0, channel=0), lambda: build_sysex(0, 0, channel=17)):
        try:
            bad()
        except ValueError:
            continue
        raise AssertionError("expected ValueError")


def test_name_lookup_is_forgiving():
    assert lookup("VCF Cutoff").index == 16
    assert lookup("vcf_cutoff").index == 16
    assert lookup("VCF cutoff frequency").index == 16
    assert lookup("  VCF   CUTOFF  ").index == 16
    assert lookup("Attack Time").index == 26
    assert lookup(24).index == 24
    assert lookup("24").index == 24
    assert lookup("nonsense") is None


def test_config_round_trip():
    """The generated default config parses back to CC n -> parameter n."""
    import yaml
    text = config_mod.render(config_mod.default_mappings())
    cfg = config_mod.parse(yaml.safe_load(text), "generated")
    assert len(cfg.by_cc) == 36
    for i in range(36):
        assert cfg.by_cc[i].param.index == i
    assert cfg.synth_channel == 1
    assert cfg.listen_channel is None
    assert cfg.level_byte == 0x20


def test_config_rejects_duplicates_and_unknowns():
    import yaml
    for text, expect in (
        ("mappings:\n  VCF Cutoff: 10\n  LFO Rate: 10\n", "assigned to both"),
        ("mappings:\n  Nonsense: 10\n", "unknown parameter"),
        ("mappings:\n  VCF Cutoff: 200\n", "must be 0-127"),
        ("mappings:\n  VCF Cutoff: 10\n  vcf_cutoff: 11\n", "mapped twice"),
        ("mappings: {}\n", "empty"),
        ("midi:\n  synth_channel: 0\nmappings:\n  LFO Rate: 1\n", "must be 1-16"),
        ("mappings:\n  LFO Rate: {cc: 1, mode: bogus}\n", "unknown mode"),
    ):
        try:
            config_mod.parse(yaml.safe_load(text), "test")
        except config_mod.ConfigError as exc:
            assert expect in str(exc), (text, str(exc))
            continue
        raise AssertionError(f"expected ConfigError for: {text}")


def test_off_disables_an_entry():
    """Every spelling of 'off' switches a parameter off instead of mapping it."""
    import yaml
    for spelling in ("off", "Off", "OFF", "'off'", "no", "false", "none", "null", "~", ""):
        text = f"mappings:\n  VCF Cutoff: {spelling}\n  LFO Rate: 24\n"
        cfg = config_mod.parse(yaml.safe_load(text), "test")
        assert set(cfg.by_cc) == {24}, (spelling, cfg.by_cc)
        assert cfg.disabled == {16}, (spelling, cfg.disabled)
        assert cfg.lookup_cc(16) is None, spelling


def test_off_frees_the_cc_for_another_parameter():
    """A disabled entry must not reserve its old CC number."""
    import yaml
    cfg = config_mod.parse(yaml.safe_load(
        "mappings:\n  VCF Cutoff: off\n  LFO Rate: 16\n"), "test")
    assert cfg.by_cc[16].param.name == "LFO Rate"


def test_off_in_dict_form():
    import yaml
    cfg = config_mod.parse(yaml.safe_load(
        "mappings:\n  Bender Range: {cc: off, mode: clamp}\n  LFO Rate: 24\n"), "test")
    assert cfg.disabled == {35}


def test_yaml_booleans_are_not_silently_numbers():
    """`on` must not become CC1, and `off` must not become CC0."""
    import yaml
    try:
        config_mod.parse(yaml.safe_load("mappings:\n  VCF Cutoff: on\n"), "test")
    except config_mod.ConfigError as exc:
        assert "got 'on'" in str(exc), str(exc)
    else:
        raise AssertionError("expected ConfigError for 'on'")

    try:
        config_mod.parse(yaml.safe_load(
            "midi:\n  synth_channel: yes\nmappings:\n  LFO Rate: 1\n"), "test")
    except config_mod.ConfigError as exc:
        assert "got on" in str(exc), str(exc)
    else:
        raise AssertionError("expected ConfigError for a boolean channel")


def test_all_off_is_an_error():
    import yaml
    try:
        config_mod.parse(yaml.safe_load("mappings:\n  VCF Cutoff: off\n"), "test")
    except config_mod.ConfigError as exc:
        assert "switched off" in str(exc), str(exc)
    else:
        raise AssertionError("expected ConfigError when everything is off")


def test_thru_option():
    import yaml
    base = "mappings:\n  LFO Rate: 24\n"
    assert config_mod.parse(yaml.safe_load(base)).thru is False
    for spelling in ("true", "yes", "on", "'true'", "'on'"):
        cfg = config_mod.parse(yaml.safe_load(f"midi:\n  thru: {spelling}\n" + base))
        assert cfg.thru is True, spelling
    for spelling in ("false", "no", "off", "'off'", ""):
        cfg = config_mod.parse(yaml.safe_load(f"midi:\n  thru: {spelling}\n" + base))
        assert cfg.thru is False, spelling
    try:
        config_mod.parse(yaml.safe_load("midi:\n  thru: maybe\n" + base))
    except config_mod.ConfigError as exc:
        assert "expected true or false" in str(exc)
    else:
        raise AssertionError("expected ConfigError for a non-boolean thru")


def test_generated_config_documents_thru():
    import yaml
    text = config_mod.render(config_mod.default_mappings())
    assert "thru: false" in text
    assert config_mod.parse(yaml.safe_load(text)).thru is False


def test_ports_section():
    import yaml
    cfg = config_mod.parse(yaml.safe_load(
        'ports:\n  input: "nanoKONTROL"\n  output: 3\nmappings:\n  LFO Rate: 24\n'), "test")
    assert cfg.port_input == "nanoKONTROL"
    assert cfg.port_output == "3"

    for text in ("ports:\n  input: ask\n  output: ask\n",
                 "ports:\n  input:\n  output:\n",
                 ""):
        cfg = config_mod.parse(yaml.safe_load(text + "mappings:\n  LFO Rate: 24\n"), "test")
        assert cfg.port_input is None and cfg.port_output is None, text


def test_generated_config_has_ask_ports():
    import yaml
    cfg = config_mod.parse(yaml.safe_load(config_mod.render(config_mod.default_mappings())))
    assert cfg.port_input is None and cfg.port_output is None


def test_update_ports_preserves_the_rest_of_the_file():
    """Saving ports is a targeted edit, not a re-render: comments must survive."""
    import tempfile, yaml
    original = config_mod.render(config_mod.default_mappings())
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as handle:
        handle.write(original + "\n# a comment the user added by hand\n")
        path = handle.name

    config_mod.update_ports(path, 'My Controller', 'Juno "2"')
    cfg = config_mod.load(path)
    assert cfg.port_input == "My Controller"
    assert cfg.port_output == 'Juno "2"'
    assert len(cfg.by_cc) == 36

    with open(path) as handle:
        text = handle.read()
    assert "# a comment the user added by hand" in text
    assert "# Default MIDI ports" in text
    assert text.count("ports:") == 1
    assert "input: ask" not in text

    # Re-saving must not duplicate anything.
    config_mod.update_ports(path, "Second", "Third")
    with open(path) as handle:
        text = handle.read()
    assert text.count("  input:") == 1, text
    assert config_mod.load(path).port_input == "Second"
    os.unlink(path)


def test_update_ports_inserts_a_missing_block():
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as handle:
        handle.write("midi:\n  synth_channel: 4\nmappings:\n  LFO Rate: 24\n")
        path = handle.name
    config_mod.update_ports(path, "Ctrl", "Synth")
    cfg = config_mod.load(path)
    assert cfg.port_input == "Ctrl" and cfg.port_output == "Synth"
    assert cfg.synth_channel == 4 and len(cfg.by_cc) == 1
    os.unlink(path)


def test_storable_name_drops_alsa_numbers():
    import midi_io
    names = ["nanoKONTROL2 MIDI 1 28:0", "Juno MIDI 1 32:0"]
    assert midi_io.storable_name(names[0], names) == "nanoKONTROL2 MIDI 1"

    # Two devices sharing a trimmed name: shortening is only safe for the first,
    # because that is the one the short form would resolve back to.
    dupes = ["Thing MIDI 1 28:0", "Thing MIDI 1 29:0"]
    assert midi_io.storable_name(dupes[0], dupes) == "Thing MIDI 1"
    assert midi_io.storable_name(dupes[1], dupes) == dupes[1]


def test_duplicate_ports_are_collapsed():
    """Some setups enumerate every port twice; only the first is reachable."""
    import midi_io
    doubled = ["Midi Through:Midi Through Port-0 14:0",
               "AudioBox USB:AudioBox USB MIDI 1 28:0",
               "4ACBCC15:4ACBCC15 MIDI 1 32:0"] * 2
    unique = midi_io.dedupe(doubled)
    assert unique == doubled[:3], unique
    assert midi_io.dedupe([]) == []
    # Order is preserved, and non-adjacent repeats are caught too.
    assert midi_io.dedupe(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]


def test_resolve_takes_the_first_match():
    import midi_io
    names = ["AudioBox USB MIDI 1 28:0", "AudioBox USB MIDI 2 28:1", "Juno 32:0"]
    assert midi_io.resolve(names, "AudioBox", "input") == names[0]
    assert midi_io.resolve(names, "audiobox usb midi 2", "input") == names[1]
    assert midi_io.resolve(names, "Juno", "input") == names[2]
    # Index selection is unaffected.
    assert midi_io.resolve(names, "1", "input") == names[1]
    # A miss is still an error.
    try:
        midi_io.resolve(names, "Nope", "input")
    except midi_io.PortError:
        pass
    else:
        raise AssertionError("expected PortError for an unmatched port")


def test_config_clamp_mode_parses():
    import yaml
    cfg = config_mod.parse(yaml.safe_load("mappings:\n  Bender Range: {cc: 90, mode: clamp}\n"))
    assert cfg.by_cc[90].mode == "clamp"
    assert cfg.by_cc[90].param.index == 35


LAYERED = """
midi:
  thru: true
layers:
  cc: 41
  count: 3
  names: "Filter, Envelope"
layer1:
  "VCF Cutoff": 16
  "VCF Resonance": 17
layer2:
  "ENV T1": 16
  "DCO Range": 18
"""


def _layered_cfg(text=LAYERED):
    import yaml
    return config_mod.parse(yaml.safe_load(text))


class _FakeOut:
    """Stands in for a mido output port; records what would go out."""

    def __init__(self):
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)


class _FakeMsg:
    def __init__(self, **fields):
        self.__dict__.update(fields)


def _cc_msg(control, value, channel=0):
    return _FakeMsg(type="control_change", channel=channel,
                    control=control, value=value)


def _router(cfg):
    import cc2juno
    return cc2juno.Router(cfg, _FakeOut(), quiet=True)


def test_layer_regions_split_evenly_at_every_count():
    """Every layer count 1-10 reaches each layer, in order, over the full sweep."""
    for count in range(1, alpha_juno.MAX_LAYERS + 1):
        p = alpha_juno.make_layer_param(count)
        values = [alpha_juno.scale(p, cc) for cc in range(128)]
        assert set(values) == set(range(count)), (count, sorted(set(values)))
        assert values == sorted(values), count
        widths = {}
        for v in values:
            widths[v] = widths.get(v, 0) + 1
        assert max(widths.values()) - min(widths.values()) <= 1, (count, widths)


def test_layer_region_bounds_match_scale():
    for count in range(1, alpha_juno.MAX_LAYERS + 1):
        p = alpha_juno.make_layer_param(count)
        for layer in range(count):
            low, high = alpha_juno.region_bounds(p, layer)
            assert alpha_juno.scale(p, low) == layer, (count, layer, low)
            assert alpha_juno.scale(p, high) == layer, (count, layer, high)
            if low:
                assert alpha_juno.scale(p, low - 1) == layer - 1, (count, layer)
    assert alpha_juno.region_bounds(alpha_juno.make_layer_param(1), 0) == (0, 127)


def test_layer_param_is_never_sendable():
    """The synthetic layer parameter must not be mistakable for a real one."""
    p = alpha_juno.make_layer_param(4)
    assert p.index == -1
    assert lookup("Layer") is None
    try:
        alpha_juno.build_sysex(p.index, 0)
    except ValueError:
        pass
    else:
        raise AssertionError("build_sysex accepted the layer parameter")


def test_layered_config_parses():
    cfg = _layered_cfg()
    assert cfg.layering and cfg.layer_cc == 41
    assert cfg.layer_count == 3
    assert [l.name for l in cfg.layers] == ["Filter", "Envelope", ""]
    assert cfg.lookup_cc(16, 0).param.name == "VCF Cutoff"
    assert cfg.lookup_cc(16, 1).param.name == "ENV T1"
    assert cfg.lookup_cc(16, 2) is None          # an empty layer is legal
    assert cfg.all_mapped_ccs() == {16, 17, 18}


def test_unlayered_config_is_one_layer():
    """A config with no 'layers:' section keeps behaving exactly as before."""
    cfg = config_mod.parse({"mappings": {"VCF Cutoff": 16}})
    assert not cfg.layering
    assert cfg.layer_count == 1 and cfg.layer_cc is None
    assert cfg.by_cc[16].param.name == "VCF Cutoff"      # the layer-1 shortcut
    assert cfg.lookup_cc(16) is cfg.lookup_cc(16, 0)


def test_mappings_is_an_alias_for_layer1():
    cfg = _layered_cfg("layers: {cc: 41}\nmappings:\n  VCF Cutoff: 16\n")
    assert cfg.layer_count == 1
    assert cfg.layers[0].by_cc[16].param.name == "VCF Cutoff"


def test_naming_both_mappings_and_layer1_is_an_error():
    for text in ("layers: {cc: 41}\nmappings: {VCF Cutoff: 16}\nlayer1: {LFO Rate: 17}\n",):
        try:
            _layered_cfg(text)
        except config_mod.ConfigError as exc:
            assert "twice" in str(exc), exc
        else:
            raise AssertionError("expected an error for mappings + layer1")


def test_same_cc_on_different_layers_is_fine_but_not_within_one():
    cfg = _layered_cfg()
    assert cfg.lookup_cc(16, 0) is not None and cfg.lookup_cc(16, 1) is not None
    try:
        _layered_cfg("layers: {cc: 41}\nlayer1:\n  VCF Cutoff: 16\n  LFO Rate: 16\n")
    except config_mod.ConfigError as exc:
        assert "CC16" in str(exc), exc
    else:
        raise AssertionError("expected an error for a duplicate CC within one layer")


def test_layer_cc_cannot_be_mapped():
    try:
        _layered_cfg("layers: {cc: 41}\nlayer1: {VCF Cutoff: 41}\n")
    except config_mod.ConfigError as exc:
        assert "selects the layer" in str(exc), exc
    else:
        raise AssertionError("expected an error for mapping the layer knob")


def test_layers_section_needs_a_cc():
    for text in ("layers: {count: 2}\nlayer1: {VCF Cutoff: 16}\n",
                 "layers: {cc: off}\nlayer1: {VCF Cutoff: 16}\n"):
        try:
            _layered_cfg(text)
        except config_mod.ConfigError as exc:
            assert "cc" in str(exc), exc
        else:
            raise AssertionError("expected an error for a layers block with no cc")


def test_layer_sections_without_a_layers_block_are_rejected():
    """A bare layer2 with no layer knob would silently never be reachable."""
    try:
        _layered_cfg("layer1: {VCF Cutoff: 16}\nlayer2: {LFO Rate: 16}\n")
    except config_mod.ConfigError as exc:
        assert "layers:" in str(exc), exc
    else:
        raise AssertionError("expected an error for layer sections with no layers block")


def test_count_must_cover_the_defined_sections():
    try:
        _layered_cfg("layers: {cc: 41, count: 2}\nlayer1: {VCF Cutoff: 16}\n"
                     "layer3: {LFO Rate: 16}\n")
    except config_mod.ConfigError as exc:
        assert "count" in str(exc), exc
    else:
        raise AssertionError("expected an error for a count below the highest section")


def test_misspelled_section_is_not_ignored():
    """A silently dropped section would leave the knobs dead with nothing to show why."""
    for typo, text in (
        ("layar2", "layers: {cc: 41}\nlayer1: {VCF Cutoff: 16}\nlayar2: {LFO Rate: 16}\n"),
        ("mapings", "mapings: {VCF Cutoff: 16}\n"),
        ("layer0", "layers: {cc: 41}\nlayer0: {VCF Cutoff: 16}\n"),
    ):
        try:
            _layered_cfg(text)
        except config_mod.ConfigError as exc:
            assert typo in str(exc), (typo, exc)
        else:
            raise AssertionError(f"expected an error for {typo!r}")


def test_too_many_layers_rejected():
    try:
        _layered_cfg("layers: {cc: 41, count: 11}\nlayer1: {VCF Cutoff: 16}\n")
    except config_mod.ConfigError as exc:
        assert "1-10" in str(exc), exc
    else:
        raise AssertionError("expected an error for 11 layers")


def test_layer_names_must_not_be_a_list():
    """A YAML list parses on the desktop but not on Tulip, so it is refused here."""
    try:
        _layered_cfg("layers: {cc: 41, count: 2}\nlayer1: {VCF Cutoff: 16}\n"
                     "layer2: {LFO Rate: 16}\n")
    except config_mod.ConfigError:
        raise AssertionError("this config should be valid")
    try:
        config_mod.parse({"layers": {"cc": 41, "names": ["a", "b"]},
                          "layer1": {"VCF Cutoff": 16}})
    except config_mod.ConfigError as exc:
        assert "Tulip" in str(exc), exc
    else:
        raise AssertionError("expected an error for a list of names")


def test_all_layers_empty_is_an_error():
    try:
        _layered_cfg("layers: {cc: 41, count: 2}\nlayer1: {VCF Cutoff: off}\n")
    except config_mod.ConfigError as exc:
        assert "nothing to do" in str(exc), exc
    else:
        raise AssertionError("expected an error when no layer maps anything")


def test_router_switches_layer_and_reinterprets_the_same_cc():
    cfg = _layered_cfg()
    r = _router(cfg)
    r.handle(_cc_msg(16, 100))
    assert r.pending[16][0] == 100                  # VCF Cutoff on layer 1
    r.pending.clear()

    r.handle(_cc_msg(41, 60))                       # into layer 2's region
    assert r.layer == 1
    r.handle(_cc_msg(16, 100))
    assert r.pending[26][0] == 100                  # the same knob is now ENV T1
    assert r.stats["layer"] == 1


def test_layer_knob_holds_at_a_boundary():
    """A pot resting on a region edge must not flip between two layers."""
    cfg = _layered_cfg()
    r = _router(cfg)
    r.handle(_cc_msg(41, 60))                       # settle in layer 2
    assert r.layer == 1
    for value in (43, 42, 43, 44):                  # jitter around the 43 edge
        r.handle(_cc_msg(41, value))
        assert r.layer == 1, value
    r.handle(_cc_msg(41, 10))                       # a deliberate move does go through
    assert r.layer == 0


def test_a_knob_from_another_layer_is_consumed_not_forwarded():
    """The controller sends the same CCs on every layer, so they never leak as raw CC."""
    cfg = _layered_cfg()
    assert cfg.thru
    r = _router(cfg)
    r.handle(_cc_msg(18, 60))                       # mapped on layer 2 only
    assert r.stats["inactive"] == 1
    assert r.stats["thru"] == 0
    assert not r.pending

    r.handle(_cc_msg(1, 64))                        # the mod wheel still passes through
    assert r.stats["thru"] == 1


def test_layer_knob_is_never_forwarded():
    cfg = _layered_cfg()
    r = _router(cfg)
    r.handle(_cc_msg(41, 60))
    r.handle(_cc_msg(41, 61))
    assert r.stats["thru"] == 0


def test_last_value_survives_a_layer_change():
    """A parameter's send history is per parameter, so it stays right across layers."""
    cfg = _layered_cfg()
    r = _router(cfg)
    r.handle(_cc_msg(16, 100))                      # VCF Cutoff = 100
    r.flush(1e9)
    assert r.last_value[16] == 100
    r.handle(_cc_msg(41, 60))                       # layer 2
    r.handle(_cc_msg(16, 40))                       # same knob, now ENV T1
    r.flush(2e9)
    assert r.last_value[16] == 100 and r.last_value[26] == 40
    r.handle(_cc_msg(41, 10))                       # back to layer 1
    r.handle(_cc_msg(16, 100))                      # knob already there: nothing to send
    assert r.stats["unchanged"] == 1


def test_startup_layer_is_honoured():
    cfg = _layered_cfg(LAYERED.replace("count: 3", "count: 3\n  startup: 2"))
    assert cfg.startup_layer == 2
    assert _router(cfg).layer == 1


def test_layered_config_round_trip():
    import cc2juno
    import yaml
    scaffold, cfg = cc2juno.init_layout(3, 105)
    cfg.layers[0].name = "Filter"
    text = config_mod.render(scaffold, cfg)
    back = config_mod.parse(yaml.safe_load(text))
    assert back.layer_cc == 105 and back.layer_count == 3
    assert back.layers[0].name == "Filter"
    assert len(back.by_cc) == 36 and not back.layers[1].by_cc
    for i in range(36):
        assert back.by_cc[i].param.index == i


def test_unlayered_render_is_unchanged():
    """The generated one-layer file must stay exactly what it was before layering."""
    text = config_mod.render(config_mod.default_mappings())
    assert "\nmappings:\n" in text
    assert "layers:" not in text and "layer1:" not in text


def test_layout_is_read_and_written_back():
    """The web build's knob grid must survive a load and save by this build."""
    import yaml
    text = ("layout:\n"
            "  rows: 2\n"
            "  cols: 3\n"
            "  ccs: \"16, 17, off, 24, 25\"\n"
            "mappings:\n"
            "  \"VCF Cutoff\": 16\n")
    cfg = config_mod.parse(yaml.safe_load(text))
    assert cfg.layout.rows == 2 and cfg.layout.cols == 3
    # A short list is padded out to the full grid rather than being an error.
    assert cfg.layout.ccs == [16, 17, None, 24, 25, None]

    mappings = {p.index: (16 if p.index == 16 else None) for p in alpha_juno.PARAMETERS}
    again = config_mod.parse(yaml.safe_load(config_mod.render(mappings, cfg)))
    assert again.layout.ccs == cfg.layout.ccs
    assert again.layout.rows == 2 and again.layout.cols == 3


def test_a_config_without_a_layout_has_none():
    """No grid described is not the same as an empty grid, and must not invent one."""
    import yaml
    cfg = config_mod.parse(yaml.safe_load("mappings:\n  \"VCF Cutoff\": 16\n"))
    assert cfg.layout is None
    assert "layout:" not in config_mod.render(config_mod.default_mappings(), cfg)


def test_bad_layouts_are_rejected():
    import yaml
    base = "mappings:\n  \"VCF Cutoff\": 16\n"
    bad = {
        "  ccs: \"1, 2, 3, 4, 5\"\n": "lists 5 cells",       # more cells than the grid
        "  ccs: \"7, 8, 7\"\n": "one knob sits in one place",  # the same knob twice
        "  ccs: \"7, 200\"\n": "must be 0-127",
    }
    for tail, expected in bad.items():
        text = base + "layout:\n  rows: 2\n  cols: 2\n" + tail
        try:
            config_mod.parse(yaml.safe_load(text))
        except config_mod.ConfigError as exc:
            assert expected in str(exc), f"wrong message for {tail!r}: {exc}"
        else:
            raise AssertionError(f"expected a rejection for {tail!r}")


def test_layout_is_not_mistaken_for_a_layer_section():
    """'layout' must not trip the unknown-section guard, and must not become a layer."""
    import yaml
    cfg = config_mod.parse(yaml.safe_load(
        "layout:\n  rows: 1\n  cols: 1\n  ccs: \"16\"\nmappings:\n  \"VCF Cutoff\": 16\n"))
    assert cfg.layer_count == 1 and len(cfg.by_cc) == 1


def test_a_brushed_knob_does_not_count_as_a_move():
    """The whole point: catching a knob in passing must not assign it."""
    import cc2juno
    d = cc2juno.MoveDetector(6)
    for value in (64, 65, 66, 65, 64):          # a brush, five messages, span 2
        assert not d.feed(16, value), value


def test_a_deliberate_turn_counts():
    import cc2juno
    d = cc2juno.MoveDetector(6)
    moved = [d.feed(16, v) for v in range(64, 72)]
    assert not any(moved[:6]) and moved[6], moved   # counts as it clears the span


def test_a_move_counts_in_either_direction_and_back():
    import cc2juno
    d = cc2juno.MoveDetector(6)
    assert not d.feed(16, 64)
    assert not d.feed(16, 60)
    assert d.feed(16, 58)                       # downwards works too
    d.reset()
    assert not d.feed(16, 64)
    assert not d.feed(16, 67)
    assert d.feed(16, 61)                       # up then down: the widest span wins


def test_each_control_is_tracked_separately():
    """Brushing two knobs on the way to a third must not add up to a move."""
    import cc2juno
    d = cc2juno.MoveDetector(6)
    for cc in (16, 17):
        for value in (64, 66, 64):
            assert not d.feed(cc, value), (cc, value)
    assert not d.feed(18, 0)
    assert d.feed(18, 40)


def test_reset_forgets_the_previous_prompt():
    import cc2juno
    d = cc2juno.MoveDetector(6)
    assert not d.feed(16, 0)
    d.reset()
    assert not d.feed(16, 4), "the earlier span should not carry over"


def test_threshold_zero_accepts_the_first_message():
    """0 restores the old behaviour, for a controller that sends one value only."""
    import cc2juno
    assert cc2juno.MoveDetector(0).feed(16, 64)
    assert cc2juno.MoveDetector(-5).threshold == 0


def test_a_switch_registers_on_its_second_press():
    import cc2juno
    d = cc2juno.MoveDetector(6)
    assert not d.feed(64, 127)                  # press
    assert d.feed(64, 0)                        # release, or the next press


def test_resize_layers_keeps_what_fits():
    import cc2juno
    cfg = _layered_cfg()
    assert cfg.layer_count == 3
    cc2juno._resize_layers(cfg, 5)
    assert cfg.layer_count == 5
    assert [l.number for l in cfg.layers] == [1, 2, 3, 4, 5]
    assert cfg.layers[0].by_cc[16].param.name == "VCF Cutoff"   # untouched
    cc2juno._resize_layers(cfg, 1)
    assert cfg.layer_count == 1 and cfg.by_cc[16].param.name == "VCF Cutoff"


class _FakePort:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _run_learn(moves, answers, path, cfg=None, **kw):
    """Drive learn() with scripted knob moves and typed answers, silently.

    Stubs the MIDI port and the two places learn() blocks, so the walking,
    skipping and writing can be checked without hardware or a terminal.
    """
    import builtins
    import cc2juno
    import mido

    moves = list(moves)
    answers = list(answers)
    saved = (mido.open_input, cc2juno._drain_input, cc2juno._wait_for_move,
             cc2juno._ask, builtins.input, sys.stdout)
    mido.open_input = lambda name: _FakePort()
    cc2juno._drain_input = lambda port, seconds=0.25: None
    cc2juno._wait_for_move = lambda port, listen, detector: moves.pop(0)
    cc2juno._ask = lambda prompt: answers.pop(0)
    builtins.input = lambda prompt="": answers.pop(0)
    sys.stdout = open(os.devnull, "w")
    try:
        return cc2juno.learn(cfg or config_mod.Config(), "fake port", path, **kw)
    finally:
        sys.stdout.close()
        (mido.open_input, cc2juno._drain_input, cc2juno._wait_for_move,
         cc2juno._ask, builtins.input, sys.stdout) = saved


def test_learn_sets_up_layers_then_learns_the_layer_knob_first():
    import yaml
    path = "/tmp/cc2juno_learn_test.yaml"
    _run_learn(
        moves=[("cc", 105),                     # the layer knob, asked for first
               ("cc", 16), ("cc", 17), ("line", "n"),      # layer 1, then skip on
               ("cc", 16), ("line", "q")],                 # layer 2, then finish
        answers=["y", "2",                      # use layers, how many
                 "",                            # Enter at the layer-1 checkpoint
                 "y"],                          # yes, write the file
        path=path,
    )
    with open(path) as handle:
        cfg = config_mod.parse(yaml.safe_load(handle.read()), path)

    assert cfg.layer_cc == 105 and cfg.layer_count == 2
    assert cfg.layers[0].by_cc[16].param.index == 0
    assert cfg.layers[0].by_cc[17].param.index == 1
    # Layer 2 skipped the two parameters layer 1 took, so CC16 landed on the third.
    assert cfg.layers[1].by_cc[16].param.index == 2
    os.remove(path)


def test_learn_without_layers_is_the_old_walk():
    import yaml
    path = "/tmp/cc2juno_learn_flat.yaml"
    _run_learn(moves=[("cc", 16), ("line", "q")],
               answers=["n", "y"],              # no layers, then save
               path=path)
    with open(path) as handle:
        text = handle.read()
    assert "\nmappings:\n" in text and "layers:" not in text
    cfg = config_mod.parse(yaml.safe_load(text), path)
    assert not cfg.layering and cfg.by_cc[16].param.index == 0
    os.remove(path)


def test_learn_refuses_the_layer_knob_as_a_parameter():
    """Moving the layer knob at a parameter prompt re-asks rather than assigning it."""
    import yaml
    path = "/tmp/cc2juno_learn_guard.yaml"
    _run_learn(
        moves=[("cc", 105),                     # the layer knob
               ("cc", 105),                     # moved again at the first prompt
               ("cc", 16), ("line", "q")],
        answers=["y", "2", "y"],
        path=path,
    )
    with open(path) as handle:
        cfg = config_mod.parse(yaml.safe_load(handle.read()), path)
    assert cfg.layer_cc == 105
    assert 105 not in cfg.all_mapped_ccs()
    assert cfg.layers[0].by_cc[16].param.index == 0
    os.remove(path)


def test_learn_does_not_count_the_existing_config_as_assigned():
    """The reported bug: a full config made learn think everything was already done.

    Seeding the walk from the file inflated the summary and, worse, convinced
    every layer after the first that all 36 parameters were taken.
    """
    import yaml
    path = "/tmp/cc2juno_learn_fresh.yaml"
    full = config_mod.parse({"mappings": {p.name: p.index for p in alpha_juno.PARAMETERS}})
    assert len(full.by_cc) == 36, "this test needs a fully mapped config"

    _run_learn(
        moves=[("cc", 105),                     # the layer knob
               ("cc", 16), ("line", "n"),       # layer 1: exactly one assignment
               ("cc", 17), ("line", "q")],      # layer 2 must still be offered
        answers=["y", "2", "", "y"],
        path=path, cfg=full,
    )
    with open(path) as handle:
        back = config_mod.parse(yaml.safe_load(handle.read()), path)

    assert len(back.layers[0].by_cc) == 1, back.layers[0].by_cc
    assert back.layers[0].by_cc[16].param.index == 0
    # Layer 2 was walked, and skipped only the one parameter layer 1 just took.
    assert len(back.layers[1].by_cc) == 1, back.layers[1].by_cc
    assert back.layers[1].by_cc[17].param.index == 1
    os.remove(path)


def test_learn_one_layer_leaves_the_others_alone():
    """--layer N walks that layer from empty but must not disturb the rest."""
    import yaml
    path = "/tmp/cc2juno_learn_one.yaml"
    cfg = _layered_cfg()
    _run_learn(moves=[("cc", 20), ("line", "q")],
               answers=["y"], path=path, cfg=cfg, only_layer=2)
    with open(path) as handle:
        back = config_mod.parse(yaml.safe_load(handle.read()), path)
    assert back.layers[0].by_cc[16].param.name == "VCF Cutoff"      # untouched
    assert back.layers[1].by_cc[20].param.index == 0                # the new one
    assert 16 not in back.layers[1].by_cc                           # walked fresh
    os.remove(path)


def test_learn_keeps_an_existing_layer_setup():
    """Keeping the layer arrangement is not the same as keeping the assignments."""
    path = "/tmp/cc2juno_learn_keep.yaml"
    cfg = _layered_cfg()
    _run_learn(moves=[("line", "q")],
               answers=[""],                    # Enter = keep the 3-layer setup
               path=path, cfg=cfg)
    assert cfg.layer_cc == 41 and cfg.layer_count == 3
    # Nothing was assigned in the walk, so the file is left alone rather than
    # being overwritten with an empty config.
    assert not os.path.exists(path), "an empty walk must not write anything"


def test_init_layout_refuses_a_colliding_layer_knob():
    import cc2juno
    for bad in (dict(count=3, cc=16), dict(count=99, cc=105), dict(count=3, cc=None)):
        try:
            cc2juno.init_layout(bad["count"], bad["cc"])
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected a rejection for {bad}")
    scaffold, cfg = cc2juno.init_layout(None, None)
    assert not cfg.layering and isinstance(scaffold, dict)


def main():
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)]
    failures = 0
    for name, fn in tests:
        try:
            fn()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL  {name}: {exc}")
        else:
            print(f"ok    {name}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
