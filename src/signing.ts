/**
 * Ed25519 signed-request construction for the OpenBox AIP protocol.
 *
 * Canonical string (must match Core agent.go:93):
 *   UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
 *
 * The five AIP headers (agent.go:26-30) are added only when both
 * agentDid and privateKey are present.
 */

import { createHash, createPrivateKey, randomBytes, sign as cryptoSign } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version: string };
const SDK_PACKAGE_VERSION = pkg.version;
/** Mirrors openbox-langchain-sdk-ts's sdk-metadata.ts identity scheme. */
const SDK_IDENTITY = `openbox-openrouter-typescript-v${SDK_PACKAGE_VERSION}`;

export const EMPTY_BODY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SignedHeaders {
  Authorization: string;
  'User-Agent': string;
  'X-OpenBox-SDK-Version': string;
  'Content-Type': string;
  [key: string]: string;
}

/**
 * Build the base auth headers (always sent).
 */
function baseHeaders(apiKey: string): SignedHeaders {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `openbox-openrouter-governance/${SDK_PACKAGE_VERSION}`,
    'X-OpenBox-SDK-Version': SDK_IDENTITY,
  };
}

/**
 * Build headers for an authenticated request, optionally AIP-signed.
 *
 * @param method   HTTP method (GET, POST, …)
 * @param path     URL path starting with "/" (no host/query)
 * @param bodyBytes Serialized body bytes (Buffer). Pass Buffer.alloc(0) for GET.
 * @param apiKey   Bearer API key
 * @param agentDid Agent DID (e.g. "did:aip:<uuid>"), or undefined for unsigned mode
 * @param privateKeyB64 Base64-encoded raw 32-byte Ed25519 seed, or undefined
 */
export function buildSignedHeaders(
  method: string,
  path: string,
  bodyBytes: Buffer,
  apiKey: string,
  agentDid?: string,
  privateKeyB64?: string,
): SignedHeaders {
  const headers = baseHeaders(apiKey);

  if (!agentDid || !privateKeyB64) {
    return headers;
  }

  // Decode the 32-byte raw Ed25519 seed and wrap in PKCS8 DER so Node.js
  // crypto can load it. The DER prefix for Ed25519 PKCS8 is fixed (RFC 8410).
  const seed = Buffer.from(privateKeyB64, 'base64');
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Prefix, seed]);
  const privateKey = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  const bodyHash = bodyBytes.length === 0
    ? EMPTY_BODY_SHA256
    : createHash('sha256').update(bodyBytes).digest('hex');

  const timestamp = new Date().toISOString();
  const nonce = randomBytes(18).toString('base64url');
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');

  const signature = cryptoSign(null, Buffer.from(canonical, 'utf-8'), privateKey)
    .toString('base64');

  headers['X-OpenBox-Agent-DID'] = agentDid;
  headers['X-OpenBox-Agent-Timestamp'] = timestamp;
  headers['X-OpenBox-Agent-Nonce'] = nonce;
  headers['X-OpenBox-Agent-Signature'] = signature;
  headers['X-OpenBox-Body-SHA256'] = bodyHash;

  return headers;
}

/**
 * Serialize a JSON body to the exact bytes that will be sent (compact, no spaces).
 * Returns an empty Buffer for null/undefined payloads (GET requests).
 */
export function serializeBody(payload: unknown): Buffer {
  if (payload == null) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(payload), 'utf-8');
}
