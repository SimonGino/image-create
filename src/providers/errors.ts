/**
 * Unified provider error taxonomy (SPEC §3):
 *   AuthError | ValidationError | RateLimitError | ProviderError | TimeoutError.
 * Any 403 is folded into AuthError (SPEC §5 — no special-casing OpenAI org verification).
 */

import type { ProviderId, ValidationIssue } from "./types";

export type ProviderErrorCode = "auth" | "validation" | "rate_limit" | "provider" | "timeout";

export interface ProviderErrorOptions {
  providerId?: ProviderId;
  status?: number;
  raw?: unknown;
  cause?: unknown;
}

export class ImageProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId?: ProviderId;
  readonly status?: number;
  readonly raw?: unknown;

  constructor(code: ProviderErrorCode, message: string, opts: ProviderErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.raw = opts.raw;
  }
}

/** Invalid / missing key, or any 403 (SPEC §5). */
export class AuthError extends ImageProviderError {
  constructor(message: string, opts: ProviderErrorOptions = {}) {
    super("auth", message, opts);
  }
}

/** Capability pre-flight rejection (never left the app). */
export class ValidationError extends ImageProviderError {
  readonly issues: ValidationIssue[];
  constructor(message: string, issues: ValidationIssue[], opts: ProviderErrorOptions = {}) {
    super("validation", message, opts);
    this.issues = issues;
  }
}

export class RateLimitError extends ImageProviderError {
  constructor(message: string, opts: ProviderErrorOptions = {}) {
    super("rate_limit", message, opts);
  }
}

export class TimeoutError extends ImageProviderError {
  constructor(message: string, opts: ProviderErrorOptions = {}) {
    super("timeout", message, opts);
  }
}

/** Catch-all upstream failure. */
export class ProviderError extends ImageProviderError {
  constructor(message: string, opts: ProviderErrorOptions = {}) {
    super("provider", message, opts);
  }
}

/** Map a provider error code to an HTTP status for the route layer. */
export function httpStatusForCode(code: ProviderErrorCode): number {
  switch (code) {
    case "auth":
      return 401;
    case "validation":
      return 400;
    case "rate_limit":
      return 429;
    case "timeout":
      return 504;
    case "provider":
      return 502;
  }
}

/** Translate an upstream HTTP status into the right error class. */
export function errorFromHttpStatus(
  status: number,
  message: string,
  opts: ProviderErrorOptions = {},
): ImageProviderError {
  const merged = { ...opts, status };
  if (status === 401 || status === 403) return new AuthError(message, merged);
  if (status === 429) return new RateLimitError(message, merged);
  if (status >= 500) return new ProviderError(message, merged);
  return new ProviderError(message, merged);
}
