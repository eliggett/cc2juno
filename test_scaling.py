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
