// Reading text in another site's embedded frame needs a host permission for
// that site (activeTab covers only the page's own site). This picks what to ask
// for: the frame's own origin, or, for sandbox domains that give every embed a
// random subdomain (a73e1373-….frame.claudeusercontent.com for a Claude
// artifact), that domain's subdomains, so one approval covers the next embed too.

export interface AccessRequest {
  /** Match pattern for chrome.permissions.request. */
  pattern: string;
  /** How to name it to the user. */
  label: string;
}

export function accessRequest(origin: string): AccessRequest {
  const u = new URL(origin);
  const [first, ...rest] = u.hostname.split(".");
  if (rest.length >= 2 && /^[0-9a-f-]{16,}$/i.test(first)) {
    return { pattern: `${u.protocol}//*.${rest.join(".")}/*`, label: rest.join(".") };
  }
  return { pattern: `${origin}/*`, label: u.host };
}
