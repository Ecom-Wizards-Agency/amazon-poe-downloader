/** Exact seller identity and observable marketplace evidence are separate checks. */
export function accountProfileMatches(identity, {
  accountName, expectedPartnerAccountId, marketplace, marketplaceId, marketplaceLabel,
} = {}) {
  if (expectedPartnerAccountId && identity.partnerAccountId !== expectedPartnerAccountId) return false;
  const norm = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const display = norm(identity.displayName);
  const seller = norm(accountName);
  const label = norm(marketplaceLabel);
  const combined = seller && label && [" ", " / "].some(separator => display === seller + separator + label);
  if (seller && display !== seller && !combined) return false;
  if (!marketplace) return true;
  const observed = identity.marketplace;
  // GetUserContext sometimes omits marketplaceSelection. The exact header
  // suffix can prove it then; a bare seller name alone cannot.
  if (observed == null || observed === "") return Boolean(combined);
  if (typeof observed !== "string") return false;
  if (marketplaceId && observed === marketplaceId) return true;
  return [marketplace, marketplaceLabel].filter(Boolean).some(value => norm(value) === norm(observed));
}

/** Serialized into the browser. Read only labels/geometry in the account picker. */
export function inspectPickerSelection(profile, kind) {
  const selector = "button.full-page-account-switcher-account-details";
  const norm = value => String(value || "").replace(/\s*\((aktuell|current)\)\s*$/i, "")
    .replace(/\s+/g, " ").trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden"
      && style.display !== "none" && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const buttons = [...document.querySelectorAll(selector)].filter(visible);
  const wanted = kind === "parent" ? profile.parentAccountName : profile.accountName;
  const sellers = buttons.filter(element => norm(element.innerText) === norm(wanted));
  if (sellers.length !== 1) return { count: 0, accountCount: sellers.length, optionCount: 0 };
  const seller = sellers[0];
  const group = seller.closest("div.full-page-account-switcher-account");
  const children = group ? [...group.querySelectorAll(selector)].filter(element => element !== seller && visible(element)) : [];
  const expanded = seller.getAttribute("aria-expanded") === "true"
    || seller.querySelector("[class*=expanded]") !== null
    || seller.querySelector(".full-page-account-switcher-account-expander-icon")?.getAttribute("name") === "arrow_drop_up"
    || children.length > 0;
  const loading = Boolean(group && [...group.querySelectorAll('[aria-busy="true"], [role="progressbar"], kat-spinner')].some(visible));
  const matches = kind === "marketplace"
    ? children.filter(element => norm(element.innerText) === norm(profile.marketplaceLabel)) : sellers;
  const result = { count: matches.length, accountCount: 1, optionCount: children.length, expanded, loading };
  if (matches.length !== 1 || matches[0].disabled) return result;
  const element = matches[0];
  element.scrollIntoView({ block: "center" });
  const rect = element.getBoundingClientRect();
  return { ...result, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    current: /\((aktuell|current)\)/i.test(element.innerText || "") };
}

export function pickerSelectionExpression(profile, kind) {
  return `(${inspectPickerSelection.toString()})(${JSON.stringify(profile)},${JSON.stringify(kind)})`;
}

export function pickerSelectionError(kind, reason, label) {
  const code = `ACCOUNT_SWITCH_${kind.toUpperCase()}_${reason.toUpperCase()}`;
  return Object.assign(new Error(`ACCOUNT_SWITCH_BLOCKED: ${code}: ${label}`), { code });
}

export async function waitForMarketplaceSelection(read, label, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let hit;
  do {
    hit = await read();
    if (hit?.accountCount > 1) throw pickerSelectionError("account", "ambiguous", label);
    if (hit?.count > 1) throw pickerSelectionError("marketplace", "ambiguous", label);
    if (hit?.count === 1 && !hit.loading && Number.isFinite(hit.x) && Number.isFinite(hit.y)) return hit;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  } while (true);
  const reason = hit?.count === 0 && hit?.optionCount > 0 && !hit?.loading ? "missing" : "timeout";
  throw pickerSelectionError("marketplace", reason, label);
}
