/**
 * RSA private-key loading, shared by the IAM v3 workload client assertion and
 * the Okta v2 agent assertion.
 *
 * Errors name the setting the key came from and state only shape and size
 * facts — never key bytes.
 */

import { createPrivateKey, type KeyObject } from 'crypto';

import { OpenBoxIdentityConfigError } from '../errors';

/** Minimum RSA modulus size Core and Keycloak accept — rejected locally below it. */
export const MIN_RSA_MODULUS_BITS = 2048;

/**
 * Load a PEM-encoded RSA private key, rejecting non-RSA keys and keys below
 * {@link MIN_RSA_MODULUS_BITS} before any request is sent.
 */
export function loadRsaPrivateKey(pem: unknown, keyLabel: string): KeyObject {
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) {
    throw new OpenBoxIdentityConfigError(
      `Invalid ${keyLabel}: expected a PKCS8 PEM-encoded RSA private key (key bytes not shown).`,
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new OpenBoxIdentityConfigError(
      `Invalid ${keyLabel}: could not load a PEM RSA private key (key bytes not shown).`,
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new OpenBoxIdentityConfigError(
      `Invalid ${keyLabel}: expected an RSA key, got '${String(key.asymmetricKeyType)}' (key bytes not shown).`,
    );
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_RSA_MODULUS_BITS) {
    throw new OpenBoxIdentityConfigError(
      `Invalid ${keyLabel}: RSA modulus must be at least ${MIN_RSA_MODULUS_BITS} bits, got ${modulusBits} (key bytes not shown).`,
    );
  }
  return key;
}
