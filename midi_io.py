"""MIDI port discovery and selection."""

import re
import sys

import mido

# ALSA appends "client:port" numbers that change between reboots and reconnects.
_ALSA_SUFFIX = re.compile(r"\s+\d+:\d+$")


class PortError(Exception):
    pass


def dedupe(names):
    """Drop repeated port names, keeping the first of each.

    Some ALSA/rtmidi setups enumerate every port twice (once per compiled-in API),
    so the same device shows up at two indexes. The copies are indistinguishable:
    mido opens a port by looking its name up with list.index(), which always
    returns the first occurrence, so only the first is ever reachable anyway.
    """
    seen = set()
    unique = []
    for name in names:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return unique


def input_names():
    return dedupe(mido.get_input_names())


def output_names():
    return dedupe(mido.get_output_names())


def print_ports() -> None:
    for label, names in (("input", input_names()), ("output", output_names())):
        print(f"Available MIDI {label} ports:")
        if not names:
            print("  (none)")
        for i, name in enumerate(names):
            print(f"  [{i}] {name}")
        print()


def resolve(names, wanted: str, kind: str, list_available: bool = True) -> str:
    """Resolve a port from an index or a case-insensitive substring of its name.

    `list_available` appends the available ports to any error; turn it off when
    the caller is about to print the list anyway.
    """
    if not names:
        raise PortError(f"no MIDI {kind} ports found")

    try:
        index = int(wanted)
    except ValueError:
        pass
    else:
        if not 0 <= index < len(names):
            raise PortError(f"{kind} port index {index} out of range (0-{len(names) - 1})")
        return names[index]

    matches = [n for n in names if wanted.lower() in n.lower()]
    if not matches:
        message = f"no {kind} port matching {wanted!r}"
        if list_available:
            message += ". Available: " + ", ".join(names)
        raise PortError(message)
    if len(matches) > 1:
        print(f"Note: {wanted!r} matches {len(matches)} {kind} ports, using the first "
              f"({matches[0]}). Others: " + ", ".join(matches[1:]), file=sys.stderr)
    return matches[0]


def choose(names, kind: str) -> str:
    """Prompt the user to pick a port. Auto-selects when there is only one."""
    if not names:
        raise PortError(
            f"No MIDI {kind} ports found. Connect a device, or start a virtual port."
        )
    if len(names) == 1:
        print(f"Only one MIDI {kind} port, using it: {names[0]}")
        return names[0]

    print(f"Available MIDI {kind} ports:")
    for i, name in enumerate(names):
        print(f"  [{i}] {name}")

    while True:
        try:
            choice = input(f"\nSelect {kind} port [0-{len(names) - 1}]: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExited.")
            sys.exit(1)
        if not choice:
            continue
        try:
            index = int(choice)
        except ValueError:
            print("Please enter a number.")
            continue
        if 0 <= index < len(names):
            return names[index]
        print(f"Please enter a number between 0 and {len(names) - 1}.")


def storable_name(name: str, names) -> str:
    """The shortest form of a port name that still resolves to it uniquely.

    Prefers the name without ALSA's volatile client:port numbers, so a config
    written today still finds the device after a reboot. Only shortens when the
    shorter form still resolves back to this same port, since resolution now
    takes the first match rather than demanding a unique one.
    """
    short = _ALSA_SUFFIX.sub("", name).strip()
    if short and short != name:
        matches = [n for n in names if short.lower() in n.lower()]
        if matches and matches[0] == name:
            return short
    return name
