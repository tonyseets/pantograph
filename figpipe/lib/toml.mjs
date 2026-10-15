// A strict TOML subset parser for figpipe config files. Covers what the config schema uses:
// tables, arrays of tables, dotted keys, basic and literal strings, integers, floats,
// booleans, arrays (multi-line, trailing commas, comments) and inline tables.
// Anything outside the subset (dates, multi-line strings) is an error with a line number,
// never a silent misread.

export class TomlError extends Error {
  constructor(msg, line) {
    super(`line ${line}: ${msg}`);
    this.line = line;
  }
}

export function parseToml(src) {
  const s = src.replace(/\r\n?/g, "\n");
  let i = 0;
  let line = 1;
  const root = {};
  let table = root;
  const defined = new Set(); // explicitly defined table paths
  const fail = (m) => {
    throw new TomlError(m, line);
  };
  const peek = (n = 0) => s[i + n];
  const next = () => {
    const c = s[i++];
    if (c === "\n") line++;
    return c;
  };
  const skipWs = () => {
    while (peek() === " " || peek() === "\t") i++;
  };
  const skipComment = () => {
    if (peek() === "#") while (i < s.length && peek() !== "\n") i++;
  };
  // Whitespace, newlines and comments (inside arrays).
  const skipAll = () => {
    for (;;) {
      skipWs();
      if (peek() === "#") skipComment();
      else if (peek() === "\n") next();
      else return;
    }
  };
  const endOfLine = () => {
    skipWs();
    skipComment();
    if (i < s.length && peek() !== "\n") fail(`unexpected "${peek()}" after value`);
  };

  const parseKeyPart = () => {
    skipWs();
    const c = peek();
    if (c === '"') return parseBasic();
    if (c === "'") return parseLiteral();
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i, i + 256));
    if (!m) fail(`expected a key, found "${c ?? "end of file"}"`);
    i += m[0].length;
    return m[0];
  };
  const parseKey = () => {
    const parts = [parseKeyPart()];
    for (;;) {
      skipWs();
      if (peek() !== ".") return parts;
      i++;
      parts.push(parseKeyPart());
    }
  };

  const parseBasic = () => {
    if (s.startsWith('"""', i)) fail("multi-line strings are not supported in figpipe config");
    i++;
    let out = "";
    for (;;) {
      const c = s[i++];
      if (c === undefined || c === "\n") fail("unterminated string");
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = s[i++];
      const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (e in simple) out += simple[e];
      else if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = s.slice(i, i + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail("bad unicode escape");
        out += String.fromCodePoint(parseInt(hex, 16));
        i += len;
      } else fail(`bad escape "\\${e}"`);
    }
  };
  const parseLiteral = () => {
    if (s.startsWith("'''", i)) fail("multi-line strings are not supported in figpipe config");
    i++;
    const end = s.indexOf("'", i);
    const nl = s.indexOf("\n", i);
    if (end < 0 || (nl >= 0 && nl < end)) fail("unterminated string");
    const out = s.slice(i, end);
    i = end + 1;
    return out;
  };

  const parseValue = () => {
    skipWs();
    const c = peek();
    if (c === '"') return parseBasic();
    if (c === "'") return parseLiteral();
    if (c === "[") return parseArray();
    if (c === "{") return parseInline();
    const m = /^[^\s,\]}#]+/.exec(s.slice(i, i + 64));
    if (!m) fail("expected a value");
    const tok = m[0];
    if (tok === "true" || tok === "false") {
      i += tok.length;
      return tok === "true";
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(tok)) fail("dates are not supported in figpipe config; quote it as a string");
    if (/^[+-]?(\d[\d_]*)$/.test(tok)) {
      i += tok.length;
      return Number(tok.replace(/_/g, ""));
    }
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) {
      i += tok.length;
      return Number(tok.replace(/_/g, ""));
    }
    fail(`cannot read value "${tok}" (strings need quotes)`);
  };
  const parseArray = () => {
    i++;
    const out = [];
    for (;;) {
      skipAll();
      if (peek() === "]") {
        i++;
        return out;
      }
      out.push(parseValue());
      skipAll();
      if (peek() === ",") {
        i++;
        continue;
      }
      if (peek() === "]") {
        i++;
        return out;
      }
      fail("expected , or ] in array");
    }
  };
  const parseInline = () => {
    i++;
    const out = {};
    skipWs();
    if (peek() === "}") {
      i++;
      return out;
    }
    for (;;) {
      const key = parseKey();
      skipWs();
      if (next() !== "=") fail("expected = in inline table");
      assign(out, key, parseValue());
      skipWs();
      const c = next();
      if (c === "}") return out;
      if (c !== ",") fail("expected , or } in inline table");
    }
  };

  const assign = (obj, keyParts, value) => {
    let o = obj;
    for (const k of keyParts.slice(0, -1)) {
      if (o[k] === undefined) o[k] = {};
      else if (typeof o[k] !== "object" || Array.isArray(o[k])) fail(`key "${k}" is already a value`);
      o = o[k];
    }
    const last = keyParts[keyParts.length - 1];
    if (Object.prototype.hasOwnProperty.call(o, last)) fail(`duplicate key "${keyParts.join(".")}"`);
    o[last] = value;
  };

  const openTable = (parts, isArray) => {
    let o = root;
    parts.forEach((k, idx) => {
      const lastPart = idx === parts.length - 1;
      if (lastPart && isArray) {
        if (o[k] === undefined) o[k] = [];
        if (!Array.isArray(o[k])) fail(`"${parts.join(".")}" is not an array of tables`);
        const t = {};
        o[k].push(t);
        o = t;
        return;
      }
      if (o[k] === undefined) o[k] = {};
      let v = o[k];
      if (Array.isArray(v)) v = v[v.length - 1]; // [[a]] then [a.b] extends the latest a
      if (typeof v !== "object" || v === null) fail(`"${k}" is already a value`);
      o = v;
    });
    if (!isArray) {
      const p = parts.join(".");
      if (defined.has(p)) fail(`table [${p}] is defined twice`);
      defined.add(p);
    }
    return o;
  };

  while (i < s.length) {
    skipWs();
    const c = peek();
    if (c === undefined) break;
    if (c === "\n") {
      next();
      continue;
    }
    if (c === "#") {
      skipComment();
      continue;
    }
    if (c === "[") {
      const isArray = s[i + 1] === "[";
      i += isArray ? 2 : 1;
      const parts = parseKey();
      skipWs();
      if (isArray ? !s.startsWith("]]", i) : peek() !== "]") fail("unclosed table header");
      i += isArray ? 2 : 1;
      table = openTable(parts, isArray);
      endOfLine();
      continue;
    }
    const key = parseKey();
    skipWs();
    if (next() !== "=") fail(`expected = after key "${key.join(".")}"`);
    const startLine = line;
    const v = parseValue();
    if (line !== startLine && typeof v !== "object") fail("value spans lines");
    assign(table, key, v);
    endOfLine();
  }
  return root;
}
