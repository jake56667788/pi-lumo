/** True for `lumo.proton.me` itself or any of its subdomains, never a look-alike like `evillumo.proton.me`. */
export function isLumoCookieDomain(domain: string): boolean {
  return domain === "lumo.proton.me" || domain.endsWith(".lumo.proton.me");
}

/**
 * Signing in to Lumo sets more than one `AUTH-*` cookie. The one whose value is
 * JWT-shaped (`eyJ…`) is not accepted by Lumo's API and gets `401 "Invalid access token"`;
 * only the opaque value works as a token.
 */
export function isUsableLumoToken(value: string): boolean {
  return Boolean(value) && !value.startsWith("eyJ");
}
