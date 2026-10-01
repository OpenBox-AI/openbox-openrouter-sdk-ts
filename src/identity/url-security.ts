/**
 * URL rules for IAM v3: a reusable workload token and the API key must never
 * travel in cleartext, so Core, issuer and token-endpoint URLs are HTTPS, with
 * plain HTTP allowed only for the exact loopback hosts.
 */

import { OpenBoxIdentityConfigError } from '../errors';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True only for exactly `localhost`, `127.0.0.1` or `::1`, given a WHATWG
 * `URL#hostname`. Never a substring match — `localhost.evil.com` is not local.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return LOOPBACK_HOSTNAMES.has(bare);
}

/** Reject a non-HTTPS Core URL unless it is loopback. */
export function validateUrlSecurity(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new OpenBoxIdentityConfigError(`Invalid OpenBox URL: ${apiUrl}`);
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new OpenBoxIdentityConfigError(
      `Insecure HTTP URL: ${apiUrl}. Workload identity sends a reusable token on every request, so Core must be HTTPS (plain HTTP only for localhost).`,
    );
  }
}
