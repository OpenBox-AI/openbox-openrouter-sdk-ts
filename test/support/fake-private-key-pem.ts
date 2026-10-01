/**
 * A PEM-shaped but invalid private key for negative tests, assembled at runtime
 * so no key-shaped literal appears in source for secret scanners (SonarQube's
 * secrets detection, gitleaks) to report.
 */
export function fakePrivateKeyPem(body: string): string {
  const label = ['PRIVATE', 'KEY'].join(' ');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}
