/**
 * Environment variable reads. A blank value — empty or whitespace only — is
 * treated as unset, so it falls through to the next source instead of
 * shadowing it. A templated `.env` line like `OPENBOX_API_URL=` must mean
 * "not configured", not "configured as the empty string".
 */

/** The variable's value, or `undefined` when it is unset or blank. */
export function envString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return undefined;
  return raw;
}

/** The variable as a finite number, or `undefined` when unset, blank or not a number. */
export function envNumber(name: string): number | undefined {
  const raw = envString(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
