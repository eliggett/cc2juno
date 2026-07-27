"""A very small YAML reader - just enough for cc2juno.yaml.

There is no PyYAML for MicroPython, and the config file only ever uses a tiny
corner of YAML, so this parses that corner exactly and rejects everything else
with a line number rather than guessing.

Supported:

    # comments, whole-line or trailing
    top_key: value
    section:
      key: value
      "Quoted Key": value
      key: {cc: 90, mode: clamp}      # one-line flow mapping

Scalars follow YAML 1.1, which is what PyYAML does for these files:

    12  0x20            -> int          (hex included, since level_byte uses it)
    true yes on         -> True
    false no off        -> True's opposite
    null ~ none (empty) -> None
    "text" 'text' text  -> str

Not supported, and each raises YamlError: lists, nesting deeper than one level,
multi-line strings, anchors, multiple documents.  Duplicate keys in one section
are an error too - PyYAML silently keeps the last one, which would throw away a
mapping without telling anybody.
"""


class YamlError(Exception):
    pass


_TRUE = ("true", "yes", "on")
_FALSE = ("false", "no", "off")
_NULL = ("", "~", "null", "none")


def _err(lineno, text):
    return YamlError("line {}: {}".format(lineno, text))


def _strip_comment(line):
    """Drop a trailing # comment, ignoring one inside quotes."""
    quote = None
    for i in range(len(line)):
        ch = line[i]
        if quote is not None:
            if ch == quote:
                quote = None
        elif ch == '"' or ch == "'":
            quote = ch
        elif ch == "#":
            return line[:i]
    return line


def _split_key(text, lineno):
    """Split 'key: value' at the first colon outside quotes."""
    quote = None
    for i in range(len(text)):
        ch = text[i]
        if quote is not None:
            if ch == quote:
                quote = None
        elif ch == '"' or ch == "'":
            quote = ch
        elif ch == ":":
            return text[:i].strip(), text[i + 1:].strip()
    raise _err(lineno, "expected 'key: value', got: {}".format(text))


def _unquote(text, lineno):
    quote = text[0]
    if len(text) < 2 or text[-1] != quote:
        raise _err(lineno, "unterminated quoted string: {}".format(text))
    body = text[1:-1]
    if quote == '"':
        body = body.replace('\\"', '"').replace("\\\\", "\\")
    return body


def _key(text, lineno):
    if not text:
        raise _err(lineno, "empty key")
    if text[0] == '"' or text[0] == "'":
        return _unquote(text, lineno)
    return text


def _split_commas(text, lineno):
    """Split a flow mapping body on commas that are outside quotes."""
    parts = []
    quote = None
    start = 0
    for i in range(len(text)):
        ch = text[i]
        if quote is not None:
            if ch == quote:
                quote = None
        elif ch == '"' or ch == "'":
            quote = ch
        elif ch == "{" or ch == "[":
            raise _err(lineno, "nested flow collections are not supported")
        elif ch == ",":
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return parts


def _flow_map(text, lineno):
    if text[-1] != "}":
        raise _err(lineno, "unterminated flow mapping: {}".format(text))
    body = text[1:-1].strip()
    out = {}
    if not body:
        return out
    for part in _split_commas(body, lineno):
        part = part.strip()
        if not part:
            raise _err(lineno, "empty entry in flow mapping")
        key, value = _split_key(part, lineno)
        key = _key(key, lineno)
        if key in out:
            raise _err(lineno, "'{}' appears twice in the same mapping".format(key))
        out[key] = _scalar(value, lineno)
    return out


def _scalar(text, lineno):
    text = text.strip()
    if not text:
        return None
    if text[0] == '"' or text[0] == "'":
        return _unquote(text, lineno)
    if text[0] == "{":
        return _flow_map(text, lineno)
    if text[0] == "[":
        raise _err(lineno, "lists are not supported")

    low = text.lower()
    if low in _NULL:
        return None
    if low in _TRUE:
        return True
    if low in _FALSE:
        return False

    if low.startswith("0x"):
        try:
            return int(text, 16)
        except ValueError:
            raise _err(lineno, "bad hex number: {}".format(text))
    try:
        return int(text)
    except ValueError:
        pass
    return text


def loads(text):
    """Parse a YAML string into a dict of dicts."""
    root = {}
    section = None          # the dict currently being filled, or None at top level
    section_name = None
    child_indent = None     # indent of the first child, so the rest must match

    lineno = 0
    for raw in text.split("\n"):
        lineno += 1
        line = _strip_comment(raw).rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("---") or stripped.startswith("..."):
            raise _err(lineno, "multiple documents are not supported")
        if stripped[0] == "-":
            raise _err(lineno, "lists are not supported")
        if "\t" in line[:len(line) - len(line.lstrip())]:
            raise _err(lineno, "tabs cannot be used for indentation in YAML")

        indent = len(line) - len(line.lstrip())
        key, value = _split_key(stripped, lineno)
        key = _key(key, lineno)

        if indent == 0:
            if key in root:
                raise _err(lineno, "'{}' appears twice at the top level".format(key))
            if value == "":
                section = {}
                section_name = key
                child_indent = None
                root[key] = section
            else:
                root[key] = _scalar(value, lineno)
                section = None
                section_name = None
            continue

        if section is None:
            raise _err(lineno, "'{}' is indented but is not inside a section".format(key))
        if child_indent is None:
            child_indent = indent
        elif indent != child_indent:
            raise _err(lineno, "inconsistent indentation under '{}' "
                               "(expected {} spaces, got {})".format(
                                   section_name, child_indent, indent))
        # An empty nested value is null, the way `ports: input:` means "unset".
        # A genuine second level of nesting is caught by the indent check above.
        if key in section:
            raise _err(lineno, "'{}' appears twice under '{}'".format(key, section_name))
        section[key] = _scalar(value, lineno)

    return root


def load(path):
    """Parse a YAML file. Raises OSError if it cannot be opened."""
    handle = open(path)
    try:
        text = handle.read()
    finally:
        handle.close()
    return loads(text)
