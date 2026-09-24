// Strict command-line option parser shared by the runner, the formatter and
// the discovery tool.
//
// Values follow as the next argument or as --name=value. A next argument that
// starts with "--" is an option, never a value; use --name=value for such a
// value. An unknown option, a stray argument, an empty value, a value given to
// a flag and a repeated option all throw POE_ARGUMENT_INVALID, so a mistyped
// option never silently falls back to a default.

/**
 * Parse `args` against `spec` ({ values: [...names], flags: [...names] }).
 * `context` names the command in messages; `hint` is appended to them.
 * Returns { values: Map<name, string>, flags: Set<name> }.
 */
export function parseOptions(args, spec, { context = "this command", hint = "" } = {}) {
  const values = new Map();
  const flags = new Set();
  const invalid = (message) => Object.assign(new Error(`${message}${hint ? `. ${hint}` : ""}`), { code: "POE_ARGUMENT_INVALID" });
  for (let i = 0; i < args.length; i += 1) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(args[i]);
    if (!match) throw invalid(`unexpected argument ${JSON.stringify(args[i])} for ${context}`);
    const [, name, inline] = match;
    if (values.has(name) || flags.has(name)) throw invalid(`--${name} is given more than once`);
    if ((spec.flags || []).includes(name)) {
      if (inline !== undefined) throw invalid(`--${name} takes no value`);
      flags.add(name);
    } else if ((spec.values || []).includes(name)) {
      let value = inline;
      if (value === undefined) {
        value = args[i + 1];
        if (value !== undefined && !value.startsWith("--")) i += 1;
        else value = undefined;
      }
      if (value === undefined || value.trim() === "") throw invalid(`--${name} needs a value`);
      values.set(name, value);
    } else {
      throw invalid(`unknown option --${name} for ${context}`);
    }
  }
  return { values, flags };
}
