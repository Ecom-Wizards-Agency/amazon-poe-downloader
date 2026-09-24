// Redaction helpers for anything this tool prints or writes to disk.
//
// A Seller Central sign-in URL carries single-use sign-in parameters in its
// query string, and the page's own requests and responses can carry session
// and anti-forgery values. Diagnostics print only the origin and path of a
// URL, and discovery captures replace the values of sensitive keys.

export const REDACTED = "[redacted]";

/**
 * Keys whose values are never printed or stored. The words match as
 * case-insensitive substrings, so a harmless key that contains one of them
 * (tokenCount, sessionCount) is redacted as well; that errs on the safe side.
 * "sso" matches only at the start of a word (ssoResponse, x-sso, userSso), so
 * ordinary words such as grossOrder or assortment keep their values. The
 * sign-in parameters code, state, nonce and arb match only as whole keys, so
 * ordinary fields such as currencyCode keep their values.
 */
const SENSITIVE_SUBSTRING = /csrf|token|session|customerid|cookie|authorization|password|secret|openid|signature|credential|^(?:code|state|nonce|arb)$/i;
const SSO_WORD = /(?:^|[^A-Za-z])sso|Sso|SSO/;

/** True when the values of this key are never printed or stored. */
export function isSensitiveKey(key) {
  const text = String(key);
  return SENSITIVE_SUBSTRING.test(text) || SSO_WORD.test(text);
}

/**
 * URL for diagnostics: origin and path only, never the query string or the
 * fragment. Unparseable input is cut at the first "?" or "#".
 */
export function displayUrl(url) {
  if (url == null) return "";
  const text = String(url);
  try {
    const u = new URL(text);
    if (u.origin === "null") return `${u.protocol}${u.pathname}`;
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return text.split(/[?#]/)[0];
  }
}

// Sign-in and authentication paths carry one-time values under many names
// (siteState, openid.*, pageId and others), so all of their query values go.
const SIGN_IN_PATH = /(?:^|\/)(?:ap|auth|oauth|sso)(?:\/|$)|signin|sign-in|login/i;

/**
 * Full URL with the values of sensitive query parameters replaced and the
 * fragment dropped. On a sign-in or authentication path every query value is
 * replaced.
 */
export function redactUrl(url) {
  if (url == null) return url;
  const text = String(url);
  try {
    const u = new URL(text);
    const everything = SIGN_IN_PATH.test(u.pathname);
    for (const key of [...new Set(u.searchParams.keys())]) {
      if (everything || isSensitiveKey(key)) u.searchParams.set(key, REDACTED);
    }
    u.hash = "";
    return u.toString();
  } catch (_) {
    return text.split(/[?#]/)[0];
  }
}

// The last dotted segment names the value: window.csrfToken -> csrfToken.
const sensitiveName = (key) => isSensitiveKey(String(key).split(".").pop());

/**
 * Markup and script forms of a sensitive value inside any text:
 * <meta name="anti-csrftoken-a2z" content="..."> and <input name="..." value="...">
 * whose name or id is sensitive, and unquoted assignments such as
 * csrfToken: "..." or window.csrfToken = "...".
 */
function redactInline(text) {
  return String(text)
    .replace(/<(?:meta|input)\b[^>]*>/gi, (tag) => {
      const named = /\b(?:name|id|property)\s*=\s*(["']?)([^"'\s>]+)\1/i.exec(tag);
      if (!named || !sensitiveName(named[2])) return tag;
      return tag.replace(/(\b(?:content|value)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, `$1"${REDACTED}"`);
    })
    .replace(/(^|[^\w$.-])([A-Za-z_$][\w$.-]*)(\s*[:=]\s*)(["'`])((?:\\.|(?!\4)[^\\])*)\4/g,
      (whole, lead, key, sep, quote) => (sensitiveName(key) ? `${lead}${key}${sep}${quote}${REDACTED}${quote}` : whole));
}

// Fields that carry the value of a { name, value } or { key, value } pair.
const PAIR_VALUE_KEYS = new Set(["value", "content", "v"]);

/**
 * Deep copy of a JSON value with the values of sensitive keys replaced. Also
 * covers name/value pair objects such as { name: "anti-csrftoken-a2z", value }
 * and JSON objects or arrays stored as string values, which are redacted and
 * serialized again (compactly, so their original whitespace is not kept).
 */
export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const pairName = [value.name, value.key].find((n) => typeof n === "string" && isSensitiveKey(n));
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) || (pairName && PAIR_VALUE_KEYS.has(key)) ? REDACTED : redactValue(inner);
    }
    return out;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") return JSON.stringify(redactValue(parsed));
      } catch (_) { /* not JSON; fall through to the text patterns */ }
    }
    return redactInline(value);
  }
  return value;
}

/**
 * Redact a request or response body. JSON is parsed, redacted at any depth
 * (string values included) and serialized again. Anything else gets pattern
 * passes over sensitive meta and input tags, unquoted script assignments,
 * `"key": "value"` pairs and `key=value` pairs. Redact before truncating, so
 * a cut never hides a value from the parser.
 */
export function redactText(text) {
  if (text == null) return text;
  const raw = String(text);
  try {
    return JSON.stringify(redactValue(JSON.parse(raw)));
  } catch (_) {
    return redactInline(raw)
      .replace(/("([^"\\]*)"\s*:\s*)("(?:[^"\\]|\\.)*"|"[^"]*$|[^,{}[\]\s:"]+)/g,
        (whole, prefix, key) => (isSensitiveKey(key) ? `${prefix}"${REDACTED}"` : whole))
      .replace(/([?&;\s]|^)([A-Za-z0-9_.-]+)=([^&;\s"]*)/g,
        (whole, lead, key) => (isSensitiveKey(key) ? `${lead}${key}=${REDACTED}` : whole));
  }
}
