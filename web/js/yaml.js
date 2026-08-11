// A very small YAML reader - just enough for cc2juno.yaml.
//
// Pulling a full YAML library in would mean vendoring a few hundred KB to read a
// file that only ever uses one nesting level and five kinds of scalar. This is a
// port of the Tulip build's miniyaml.py, so the browser and the microcontroller
// accept exactly the same dialect and reject the same mistakes with a line
// number rather than guessing.
//
// Supported:
//
//     # comments, whole-line or trailing
//     top_key: value
//     section:
//       key: value
//       "Quoted Key": value
//       key: {cc: 90, mode: clamp}      # one-line flow mapping
//
// Scalars follow YAML 1.1, which is what PyYAML does for these files:
//
//     12  0x20            -> number     (hex included, since level_byte uses it)
//     true yes on         -> true
//     false no off        -> false
//     null ~ none (empty) -> null
//     "text" 'text' text  -> string
//
// Not supported, and each throws YamlError: lists, nesting deeper than one
// level, multi-line strings, anchors, multiple documents. Duplicate keys in one
// section are an error too - a silent last-one-wins would throw away a whole set
// of mappings without telling anybody.

export class YamlError extends Error {}

const TRUE_WORDS = ['true', 'yes', 'on'];
const FALSE_WORDS = ['false', 'no', 'off'];
const NULL_WORDS = ['', '~', 'null', 'none'];

function err(lineno, text) {
  return new YamlError(`line ${lineno}: ${text}`);
}

/** Drop a trailing # comment, ignoring one inside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split 'key: value' at the first colon outside quotes. */
function splitKey(text, lineno) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':') {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  throw err(lineno, `expected 'key: value', got: ${text}`);
}

function unquote(text, lineno) {
  const quote = text[0];
  if (text.length < 2 || text[text.length - 1] !== quote) {
    throw err(lineno, `unterminated quoted string: ${text}`);
  }
  const body = text.slice(1, -1);
  return quote === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body;
}

function readKey(text, lineno) {
  if (!text) throw err(lineno, 'empty key');
  if (text[0] === '"' || text[0] === "'") return unquote(text, lineno);
  return text;
}

/** Split a flow mapping body on commas that are outside quotes. */
function splitCommas(text, lineno) {
  const parts = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      throw err(lineno, 'nested flow collections are not supported');
    } else if (ch === ',') {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function flowMap(text, lineno) {
  if (text[text.length - 1] !== '}') {
    throw err(lineno, `unterminated flow mapping: ${text}`);
  }
  const body = text.slice(1, -1).trim();
  const out = {};
  if (!body) return out;
  for (const raw of splitCommas(body, lineno)) {
    const part = raw.trim();
    if (!part) throw err(lineno, 'empty entry in flow mapping');
    const [rawKey, value] = splitKey(part, lineno);
    const key = readKey(rawKey, lineno);
    if (key in out) throw err(lineno, `'${key}' appears twice in the same mapping`);
    out[key] = scalar(value, lineno);
  }
  return out;
}

function scalar(raw, lineno) {
  const text = raw.trim();
  if (!text) return null;
  if (text[0] === '"' || text[0] === "'") return unquote(text, lineno);
  if (text[0] === '{') return flowMap(text, lineno);
  if (text[0] === '[') throw err(lineno, 'lists are not supported');

  const low = text.toLowerCase();
  if (NULL_WORDS.includes(low)) return null;
  if (TRUE_WORDS.includes(low)) return true;
  if (FALSE_WORDS.includes(low)) return false;

  if (/^-?0x[0-9a-f]+$/.test(low)) return parseInt(text, 16);
  if (/^[+-]?\d+$/.test(text)) return parseInt(text, 10);
  return text;
}

/** Parse a YAML string into a plain object of objects. */
export function parse(text) {
  const root = {};
  let section = null;        // the object currently being filled, or null at top level
  let sectionName = null;
  let childIndent = null;    // indent of the first child, so the rest must match

  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lineno = i + 1;
    const line = stripComment(lines[i]).replace(/\s+$/, '');
    const stripped = line.trim();
    if (!stripped) continue;
    if (stripped.startsWith('---') || stripped.startsWith('...')) {
      throw err(lineno, 'multiple documents are not supported');
    }
    if (stripped[0] === '-') throw err(lineno, 'lists are not supported');

    const indent = line.length - line.replace(/^\s+/, '').length;
    if (line.slice(0, indent).includes('\t')) {
      throw err(lineno, 'tabs cannot be used for indentation in YAML');
    }

    const [rawKey, value] = splitKey(stripped, lineno);
    const key = readKey(rawKey, lineno);

    if (indent === 0) {
      if (key in root) throw err(lineno, `'${key}' appears twice at the top level`);
      if (value === '') {
        section = {};
        sectionName = key;
        childIndent = null;
        root[key] = section;
      } else {
        root[key] = scalar(value, lineno);
        section = null;
        sectionName = null;
      }
      continue;
    }

    if (section === null) {
      throw err(lineno, `'${key}' is indented but is not inside a section`);
    }
    if (childIndent === null) {
      childIndent = indent;
    } else if (indent !== childIndent) {
      throw err(lineno, `inconsistent indentation under '${sectionName}' `
                        + `(expected ${childIndent} spaces, got ${indent})`);
    }
    // An empty nested value is null, the way `ports: input:` means "unset".
    // A genuine second level of nesting is caught by the indent check above.
    if (key in section) throw err(lineno, `'${key}' appears twice under '${sectionName}'`);
    section[key] = scalar(value, lineno);
  }

  return root;
}
