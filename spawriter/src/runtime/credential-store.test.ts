import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStore } from './credential-store.js';

describe('CredentialStore', () => {
  let store: CredentialStore;

  beforeEach(() => {
    store = new CredentialStore({ maxPrincipals: 3, maxPairings: 2 });
  });

  describe('principal enrollment (T64/T72)', () => {
    it('enrolls a principal', () => {
      const p = store.enroll('agent-1', 'tok-abc');
      assert(p);
      assert.equal(p.id, 'agent-1');
      assert(p.valid);
    });

    it('returns existing on duplicate', () => {
      const p1 = store.enroll('agent-1', 'tok-abc');
      const p2 = store.enroll('agent-1', 'tok-xyz');
      assert.equal(p1, p2);
    });

    it('rejects at capacity', () => {
      store.enroll('a1', 'tok-1');
      store.enroll('a2', 'tok-2');
      store.enroll('a3', 'tok-3');
      assert.equal(store.enroll('a4', 'tok-4'), null);
    });

    it('rejects empty token', () => {
      assert.equal(store.enroll('a1', ''), null);
    });
  });

  describe('authentication (T64)', () => {
    it('authenticates with valid token', () => {
      store.enroll('agent-1', 'tok-abc');
      assert.equal(store.authenticate('tok-abc'), 'agent-1');
    });

    it('rejects unknown token', () => {
      assert.equal(store.authenticate('tok-unknown'), null);
    });

    it('rejects revoked token', () => {
      store.enroll('agent-1', 'tok-abc');
      store.revoke('agent-1');
      assert.equal(store.authenticate('tok-abc'), null);
    });

    it('rejects expired token', () => {
      store.enroll('agent-1', 'tok-abc', 0); // immediate expiry
      assert.equal(store.authenticate('tok-abc'), null);
    });

    it('increments use count', () => {
      store.enroll('agent-1', 'tok-abc');
      store.authenticate('tok-abc');
      store.authenticate('tok-abc');
      assert.equal(store.getPrincipal('agent-1')?.useCount, 2);
    });
  });

  describe('revoke and remove', () => {
    it('revokes a principal token', () => {
      store.enroll('agent-1', 'tok-abc');
      assert(store.revoke('agent-1'));
      assert(!store.isValid('agent-1'));
    });

    it('removes a principal entirely', () => {
      store.enroll('agent-1', 'tok-abc');
      assert(store.removePrincipal('agent-1'));
      assert.equal(store.getPrincipal('agent-1'), undefined);
    });
  });

  describe('sweep expired', () => {
    it('sweeps expired principals', () => {
      store.enroll('agent-1', 'tok-abc', 0);
      assert.equal(store.sweepExpired(), 1);
      assert.equal(store.diagnostics().principals, 0);
    });
  });

  describe('extension pairing (T72)', () => {
    it('pairs an extension', () => {
      const r = store.pair('ext-abc', 'relay-1', 'pair-tok');
      assert(r);
      assert(r.valid);
    });

    it('verifies pairing', () => {
      store.pair('ext-abc', 'relay-1', 'pair-tok');
      assert(store.verifyPairing('ext-abc', 'pair-tok'));
      assert(!store.verifyPairing('ext-abc', 'wrong-tok'));
    });

    it('revokes pairing', () => {
      store.pair('ext-abc', 'relay-1', 'pair-tok');
      assert(store.revokePairing('ext-abc'));
      assert(!store.verifyPairing('ext-abc', 'pair-tok'));
    });

    it('rejects at pairing capacity', () => {
      store.pair('ext-1', 'relay-1', 'tok-1');
      store.pair('ext-2', 'relay-1', 'tok-2');
      assert.equal(store.pair('ext-3', 'relay-1', 'tok-3'), null);
    });
  });

  describe('diagnostics', () => {
    it('reports counts', () => {
      store.enroll('a1', 'tok-1');
      store.enroll('a2', 'tok-2');
      store.revoke('a2');
      store.pair('ext-1', 'relay-1', 'p-1');
      const d = store.diagnostics();
      assert.equal(d.principals, 2);
      assert.equal(d.validPrincipals, 1);
      assert.equal(d.pairings, 1);
    });
  });
});
