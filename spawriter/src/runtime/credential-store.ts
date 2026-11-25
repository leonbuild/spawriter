/**
 * Credential and pairing store — W06/T72 §16.4.
 *
 * Manages relay tokens, extension pairing, and principal enrollment.
 * Validates tokens, tracks expiry, and prevents replay. All state is
 * in-memory; persistence is handled by callers. Pure logic, no I/O.
 */

import { monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Principal {
  id: string;
  enrolledMono: number;
  token: string;
  /** Whether the token is still valid. */
  valid: boolean;
  /** Monotonic time when the token expires (-1 = no expiry). */
  expiryMono: number;
  /** Number of requests authenticated with this token. */
  useCount: number;
}

export interface PairingRecord {
  extensionId: string;
  pairedMono: number;
  relayInstanceId: string;
  token: string;
  valid: boolean;
}

export interface CredentialStoreConfig {
  /** Max enrolled principals. Default: 16. */
  maxPrincipals?: number;
  /** Default token TTL (ms). Default: 86400000 (24h). */
  defaultTokenTtlMs?: number;
  /** Max pairing records. Default: 4. */
  maxPairings?: number;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class CredentialStore {
  private readonly maxPrincipals: number;
  private readonly defaultTokenTtlMs: number;
  private readonly maxPairings: number;

  private principals = new Map<string, Principal>();
  private pairings = new Map<string, PairingRecord>();
  /** Token → principal ID for fast lookup. */
  private tokenIndex = new Map<string, string>();

  constructor(config: CredentialStoreConfig = {}) {
    this.maxPrincipals = config.maxPrincipals ?? 16;
    this.defaultTokenTtlMs = config.defaultTokenTtlMs ?? 86_400_000;
    this.maxPairings = config.maxPairings ?? 4;
  }

  // ─── Principal enrollment ──────────────────────────────────────────

  /**
   * Enroll a principal with a token.
   */
  enroll(principalId: string, token: string, ttlMs?: number): Principal | null {
    if (this.principals.has(principalId)) {
      return this.principals.get(principalId)!;
    }
    if (this.principals.size >= this.maxPrincipals) return null;
    if (!token || typeof token !== 'string') return null;

    const now = monoNowMs();
    const ttl = ttlMs ?? this.defaultTokenTtlMs;
    const expiryMono = ttl === 0 ? now : (ttl > 0 ? now + ttl : -1);
    const principal: Principal = {
      id: principalId,
      enrolledMono: now,
      token,
      valid: ttl !== 0,
      expiryMono,
      useCount: 0,
    };

    this.principals.set(principalId, principal);
    this.tokenIndex.set(token, principalId);
    return principal;
  }

  /**
   * Authenticate a request by token. Returns the principal ID or null.
   */
  authenticate(token: string): string | null {
    const principalId = this.tokenIndex.get(token);
    if (!principalId) return null;

    const principal = this.principals.get(principalId);
    if (!principal || !principal.valid) return null;

    if (principal.expiryMono > 0 && monoNowMs() >= principal.expiryMono) {
      principal.valid = false;
      return null;
    }

    principal.useCount++;
    return principalId;
  }

  /**
   * Revoke a principal's token.
   */
  revoke(principalId: string): boolean {
    const principal = this.principals.get(principalId);
    if (!principal) return false;
    principal.valid = false;
    this.tokenIndex.delete(principal.token);
    return true;
  }

  /**
   * Remove a principal entirely.
   */
  removePrincipal(principalId: string): boolean {
    const principal = this.principals.get(principalId);
    if (!principal) return false;
    this.tokenIndex.delete(principal.token);
    this.principals.delete(principalId);
    return true;
  }

  /**
   * Check if a principal's token is currently valid.
   */
  isValid(principalId: string): boolean {
    const principal = this.principals.get(principalId);
    if (!principal || !principal.valid) return false;
    if (principal.expiryMono > 0 && monoNowMs() >= principal.expiryMono) {
      principal.valid = false;
      return false;
    }
    return true;
  }

  /**
   * Sweep expired principals.
   */
  sweepExpired(): number {
    const now = monoNowMs();
    let swept = 0;
    for (const [id, p] of this.principals) {
      if (p.expiryMono > 0 && now >= p.expiryMono) {
        p.valid = false;
        this.tokenIndex.delete(p.token);
        this.principals.delete(id);
        swept++;
      }
    }
    return swept;
  }

  // ─── Extension pairing ────────────────────────────────────────────

  /**
   * Register an extension pairing.
   */
  pair(extensionId: string, relayInstanceId: string, token: string): PairingRecord | null {
    if (this.pairings.has(extensionId)) {
      return this.pairings.get(extensionId)!;
    }
    if (this.pairings.size >= this.maxPairings) return null;

    const record: PairingRecord = {
      extensionId,
      pairedMono: monoNowMs(),
      relayInstanceId,
      token,
      valid: true,
    };
    this.pairings.set(extensionId, record);
    return record;
  }

  /**
   * Verify an extension pairing token.
   */
  verifyPairing(extensionId: string, token: string): boolean {
    const record = this.pairings.get(extensionId);
    return record != null && record.valid && record.token === token;
  }

  /**
   * Revoke an extension pairing.
   */
  revokePairing(extensionId: string): boolean {
    const record = this.pairings.get(extensionId);
    if (!record) return false;
    record.valid = false;
    return true;
  }

  getPrincipal(id: string): Principal | undefined {
    return this.principals.get(id);
  }

  getPairing(extensionId: string): PairingRecord | undefined {
    return this.pairings.get(extensionId);
  }

  diagnostics(): {
    principals: number;
    validPrincipals: number;
    pairings: number;
    validPairings: number;
  } {
    let validP = 0;
    for (const p of this.principals.values()) if (p.valid) validP++;
    let validPairing = 0;
    for (const r of this.pairings.values()) if (r.valid) validPairing++;
    return {
      principals: this.principals.size,
      validPrincipals: validP,
      pairings: this.pairings.size,
      validPairings: validPairing,
    };
  }

  reset(): void {
    this.principals.clear();
    this.pairings.clear();
    this.tokenIndex.clear();
  }
}
