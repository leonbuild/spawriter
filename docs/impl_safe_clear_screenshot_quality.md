# Implementation Plan: Safe Cache Clearing + Screenshot Quality Tiers

**Date**: 2026-04-03
**Design Doc**: [SAFE_CLEAR_AND_SCREENSHOT_QUALITY_DESIGN.md](./SAFE_CLEAR_AND_SCREENSHOT_QUALITY_DESIGN.md)
**Status**: Audited — Ready for implementation

---

## Overview

Two changes to `mcp/src/mcp.ts`:

1. **Safe cache clearing** — Replace `Network.clearBrowserCache` (global, dangerous) with `Page.reload({ ignoreCache: true })` (per-tab, safe). Require explicit `storage_types` in `clear_storage`.
2. **Screenshot quality tiers** — Add `quality` (high/medium/low) and optional `model` hint. Hard 5 MB guarantee with auto-compression. WebP default.

---

## Phase 1: Safe Cache Clearing

### 1.1 `clear_cache_and_reload` — Replace global cache clear

**File**: `mcp/src/mcp.ts`, lines ~2176–2237

**Before**:
```typescript
if (clearTypes.has('cache')) {
  await sendCdpCommand(session, 'Network.clearBrowserCache', undefined, getCommandTimeout('Network.clearBrowserCache'));
  cleared.push('cache (global)');
}
```

**After**:
```typescript
let needsIgnoreCache = false;

if (clearTypes.has('cache')) {
  needsIgnoreCache = true;
  cleared.push('cache (per-tab bypass via ignoreCache reload)');
}

if (clearTypes.has('global_cache')) {
  await sendCdpCommand(session, 'Network.clearBrowserCache', undefined, getCommandTimeout('Network.clearBrowserCache'));
  cleared.push('cache (global — ALL origins affected)');
}
```

And update the reload section (replaces lines 2227–2231):
```typescript
// If 'cache' was requested, a reload with ignoreCache is mandatory even if reload=false
if (shouldReload || needsIgnoreCache) {
  await sendCdpCommand(session, 'Page.reload', { ignoreCache: needsIgnoreCache }, getCommandTimeout('Page.reload'));
  await sleep(2000);
  cleared.push(needsIgnoreCache ? 'page reloaded (cache bypassed for this tab)' : 'page reloaded');
}
```

> **Audit note**: The existing code at line 2228 already passes `ignoreCache: true` on every reload, but the problem is the **separate** `Network.clearBrowserCache` call at line 2197 which is global. Removing that call and relying on `ignoreCache` in the reload is the fix.
>
> **Edge case**: If `clear: "cache"` is requested with `reload: false`, we must still reload to bypass the cache. The `needsIgnoreCache` flag forces a reload regardless. Document this in the tool description.
>
> **Legacy mode**: `mode: "aggressive"` expands to `['cache', 'cookies']`. After this fix, `cache` will set `needsIgnoreCache = true` instead of calling `Network.clearBrowserCache`. This is correct and safe — the legacy mode becomes per-tab safe automatically.
>
> **CDP verification**: `Page.reload({ ignoreCache: true })` is confirmed per-tab only (equivalent to Shift+Refresh). Source: [Chrome DevTools Protocol v1.2 Page domain](https://chromedevtools.github.io/devtools-protocol/1-2/Page/)

### 1.2 Update `all` expansion

**Before**:
```typescript
clearTypes = new Set(raw.includes('all')
  ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
  : raw);
```

**After**:
```typescript
clearTypes = new Set(raw.includes('all')
  ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
  : raw.includes('everything')
    ? ['cache', 'global_cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
    : raw);
```

### 1.3 Update `clear_cache_and_reload` tool description

```typescript
{
  name: 'clear_cache_and_reload',
  description: `Clear browser cache/storage and optionally reload the page.
Uses SAFE per-tab operations by default. "cache" uses ignoreCache reload (current tab only).
"global_cache" clears browser-wide HTTP cache (WARNING: affects ALL tabs/origins).
"all" = safe version (per-tab cache + origin-scoped storage).
"everything" = includes global_cache (dangerous, affects other tabs).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      clear: {
        type: 'string',
        description: 'Comma-separated: cache (per-tab safe), cookies, local_storage, session_storage, cache_storage, indexeddb, service_workers, all (safe), global_cache (WARNING: all origins), everything (all + global_cache)',
      },
      origin: {
        type: 'string',
        description: 'Scope storage/cookie clearing to this origin. Default: current page origin.',
      },
      reload: { type: 'boolean', description: 'Reload page after clearing. Default: true' },
      mode: { type: 'string', enum: ['light', 'aggressive'], description: '(Deprecated)' },
    },
  },
}
```

### 1.4 `storage` tool — Require explicit `storage_types`

**File**: `mcp/src/mcp.ts`, lines ~2650–2654

**Before**:
```typescript
case 'clear_storage': {
  const origin = (args.origin as string) || await evaluateJs(session, 'window.location.origin') as string;
  const types = (args.storage_types as string) || 'all';
  await sendCdpCommand(session, 'Storage.clearDataForOrigin', { origin, storageTypes: types });
  return { content: [{ type: 'text', text: `Storage cleared for ${origin} (types: ${types}).` }] };
}
```

**After**:
```typescript
case 'clear_storage': {
  const origin = (args.origin as string) || await evaluateJs(session, 'window.location.origin') as string;
  const types = args.storage_types as string;
  if (!types) {
    return { content: [{ type: 'text', text: 'Error: clear_storage requires storage_types parameter (e.g. "cookies,local_storage,session_storage"). This prevents accidental clearing of all storage.' }] };
  }
  await sendCdpCommand(session, 'Storage.clearDataForOrigin', { origin, storageTypes: types });
  return { content: [{ type: 'text', text: `Storage cleared for ${origin} (types: ${types}).` }] };
}
```

### 1.5 Tests for Phase 1

Add to `mcp/src/mcp.test.ts`:

```typescript
describe('clear_cache_and_reload safety', () => {
  function parseClearTypes(clearArg: string): Set<string> {
    const raw = clearArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    return new Set(raw.includes('all')
      ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
      : raw.includes('everything')
        ? ['cache', 'global_cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
        : raw);
  }

  it('"all" should NOT include global_cache', () => {
    const types = parseClearTypes('all');
    assert.ok(types.has('cache'));
    assert.ok(!types.has('global_cache'));
  });

  it('"everything" should include global_cache', () => {
    const types = parseClearTypes('everything');
    assert.ok(types.has('global_cache'));
    assert.ok(types.has('cache'));
  });

  it('"cache" alone should be in the set', () => {
    const types = parseClearTypes('cache');
    assert.ok(types.has('cache'));
    assert.ok(!types.has('global_cache'));
  });

  it('"global_cache" alone should be in the set', () => {
    const types = parseClearTypes('global_cache');
    assert.ok(types.has('global_cache'));
    assert.ok(!types.has('cache'));
  });

  it('"cache,cookies" should have both', () => {
    const types = parseClearTypes('cache,cookies');
    assert.ok(types.has('cache'));
    assert.ok(types.has('cookies'));
    assert.ok(!types.has('global_cache'));
  });
});
```

---

## Phase 2: Screenshot Quality Tiers with Auto-Compression

### 2.1 Model Profiles Lookup Table

Add near the top of `mcp.ts` (after imports):

```typescript
interface ImageProfile {
  maxBytes: number;
  maxLongEdge: number;
  format: 'png' | 'webp' | 'jpeg';
  quality: number;
}

const MODEL_PROFILES: Record<string, ImageProfile> = {
  'claude-opus-4.6':    { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-sonnet-4.6':  { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-opus':        { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-sonnet':      { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude':             { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'gpt-5.4':            { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
  'gpt-5.4-mini':       { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
  'gpt-5.3-codex':      { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
  'codex':              { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
  'gemini-3':           { maxBytes: 15_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
  'gemini':             { maxBytes: 15_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
};

const DEFAULT_PROFILE: ImageProfile = { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 };

const TIER_LIMITS = {
  high: 5_000_000,
  medium: 5_000_000,
  low: 1_000_000,
} as const;

function resolveProfile(tier: string, modelHint?: string): ImageProfile & { effectiveLimit: number } {
  const tierLimit = TIER_LIMITS[tier as keyof typeof TIER_LIMITS] ?? TIER_LIMITS.medium;

  if (modelHint) {
    const key = modelHint.toLowerCase().trim();
    // Exact match first, then partial match (e.g. "my-claude-sonnet-wrapper" matches "claude-sonnet")
    const profile = MODEL_PROFILES[key]
      ?? Object.entries(MODEL_PROFILES).find(([k]) => key.includes(k))?.[1];
    if (profile) {
      // effectiveLimit = min(model's maxBytes, tier's limit)
      // This ensures 'low' tier + gpt-5.4 model = 1 MB limit (tier wins)
      return { ...profile, effectiveLimit: Math.min(profile.maxBytes, tierLimit) };
    }
  }

  switch (tier) {
    case 'high':
      return { ...DEFAULT_PROFILE, format: 'png', quality: 100, effectiveLimit: tierLimit };
    case 'low':
      return { maxBytes: 1_000_000, maxLongEdge: 1280, format: 'webp', quality: 40, effectiveLimit: tierLimit };
    default:
      return { ...DEFAULT_PROFILE, effectiveLimit: tierLimit };
  }
}
```

> **Audit note on partial match**: The `key.includes(k)` check allows "claude-sonnet-4.6-turbo" to match the "claude-sonnet-4.6" profile. However, this is order-dependent — if "claude" and "claude-sonnet" are both in the map, `Object.entries` iteration order determines which matches first. The entries are ordered from most-specific to least-specific (e.g., `claude-opus-4.6` before `claude`), so more specific profiles are checked first in practice. This is sufficient for the current model set but should be noted for future maintenance.
>
> **Audit note on `effectiveLimit`**: The `Math.min(profile.maxBytes, tierLimit)` ensures the tier limit always caps the model's allowance. Example: GPT-5.4's maxBytes is 20 MB, but with tier "medium" (5 MB limit), `effectiveLimit` = 5 MB. With tier "low" (1 MB), `effectiveLimit` = 1 MB. This is the correct behavior.

### 2.2 Auto-Compression Function

```typescript
const MAX_COMPRESS_RETRIES = 3;

// session type: CdpSession (defined at mcp.ts:23 — { ws: WebSocket, sessionId: string, nextId: number, pendingRequests: Map })
async function captureWithSizeGuarantee(
  session: CdpSession,
  profile: ImageProfile & { effectiveLimit: number },
): Promise<{ data: string; mimeType: string; originalSize: number; finalSize: number; compressed: boolean }> {
  const timeout = getCommandTimeout('Page.captureScreenshot');
  const captureParams: Record<string, unknown> = { format: profile.format };
  if (profile.format !== 'png') {
    captureParams.quality = profile.quality;
  }

  let result = await sendCdpCommand(session, 'Page.captureScreenshot', captureParams, timeout) as { data: string };
  const originalSize = Math.ceil(result.data.length * 3 / 4);

  if (originalSize <= profile.effectiveLimit) {
    return {
      data: result.data,
      mimeType: profile.format === 'png' ? 'image/png' : 'image/webp',
      originalSize,
      finalSize: originalSize,
      compressed: false,
    };
  }

  // Auto-compress: switch to WebP and calculate proportional quality
  // Formula: quality * (targetSize / actualSize) * 0.8 safety margin
  let quality = profile.format === 'png'
    ? Math.min(90, Math.floor(80 * (profile.effectiveLimit / originalSize) * 0.8))
    : Math.floor(profile.quality * (profile.effectiveLimit / originalSize) * 0.8);
  quality = Math.max(10, quality);

  for (let i = 0; i < MAX_COMPRESS_RETRIES; i++) {
    result = await sendCdpCommand(session, 'Page.captureScreenshot',
      { format: 'webp', quality, optimizeForSpeed: true }, timeout) as { data: string };
    const size = Math.ceil(result.data.length * 3 / 4);

    if (size <= profile.effectiveLimit) {
      return { data: result.data, mimeType: 'image/webp', originalSize, finalSize: size, compressed: true };
    }
    quality = Math.max(10, Math.floor(quality * 0.5));
  }

  // Final attempt: absolute minimum quality — should always produce < 5 MB
  result = await sendCdpCommand(session, 'Page.captureScreenshot',
    { format: 'webp', quality: 10, optimizeForSpeed: true }, timeout) as { data: string };
  return {
    data: result.data,
    mimeType: 'image/webp',
    originalSize,
    finalSize: Math.ceil(result.data.length * 3 / 4),
    compressed: true,
  };
}
```

> **Audit note on base64 size calculation**: `result.data` from CDP is a base64 string. The raw byte size is `base64Length * 3 / 4`. This is a standard conversion — base64 encodes 3 bytes per 4 characters. We use `Math.ceil` for safety.
>
> **Audit note on `optimizeForSpeed`**: This CDP parameter trades compression efficiency for encoding speed. During the fallback loop we prioritize speed since we may re-capture multiple times.
>
> **Audit note on `quality: 10`**: WebP at quality 10 for a 1920×1080 viewport produces ~50–100 KB. Even at 4K with dense content, this should be well under 5 MB. If somehow it's still over (theoretically impossible at quality 10), we accept it as the best-effort result.

### 2.3 Update `screenshot` Tool Schema

```typescript
{
  name: 'screenshot',
  description: `Take a screenshot of the current page. Output is always ≤5MB (auto-compressed for LLM API compatibility).
With labels=true, overlays numbered labels on interactive elements.
quality: "high" (PNG, auto-downgrades if >5MB), "medium" (WebP q80, default), "low" (WebP <1MB).
model: optional hint (e.g. "gpt-5.4") to optimize quality for your LLM's specific limits.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      labels: { type: 'boolean', description: 'Overlay numbered labels on interactive elements' },
      quality: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Quality tier. Default: "medium". high=PNG (auto-compressed if >5MB), low=compact WebP <1MB',
      },
      model: {
        type: 'string',
        description: 'Optional: LLM model name (e.g. "claude-sonnet-4.6", "gpt-5.4", "gpt-5.3-codex") for optimized quality/size targeting',
      },
    },
  },
}
```

### 2.4 Update `screenshot` Tool Handler

**Replace the entire `case 'screenshot'` block** (~mcp.ts:2045–2094):

```typescript
case 'screenshot': {
  const withLabels = args.labels as boolean | undefined;
  const tier = (args.quality as string) || 'medium';
  const modelHint = args.model as string | undefined;
  const profile = resolveProfile(tier, modelHint);

  if (!withLabels) {
    const capture = await captureWithSizeGuarantee(session, profile);
    const sizeNote = capture.compressed
      ? ` (auto-compressed from ${(capture.originalSize / 1024).toFixed(0)}KB to ${(capture.finalSize / 1024).toFixed(0)}KB)`
      : '';
    return {
      content: [
        { type: 'image', data: capture.data, mimeType: capture.mimeType },
        ...(capture.compressed ? [{ type: 'text' as const, text: `Note: screenshot was auto-compressed to fit ${(profile.effectiveLimit / 1_000_000).toFixed(0)}MB limit${sizeNote}` }] : []),
      ],
    };
  }

  // Labeled screenshot path
  await sendCdpCommand(session, 'Accessibility.enable', undefined, getCommandTimeout('Accessibility.enable'));
  await sendCdpCommand(session, 'DOM.enable', undefined, getCommandTimeout('DOM.enable'));
  const axResult = await sendCdpCommand(session, 'Accessibility.getFullAXTree', undefined, getCommandTimeout('Accessibility.getFullAXTree')) as { nodes: AXNode[] };
  const interactive = getInteractiveElements(axResult.nodes ?? []);

  const labelPositions: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
  for (const el of interactive) {
    try {
      const boxModel = await sendCdpCommand(session, 'DOM.getBoxModel', { backendNodeId: el.backendDOMNodeId }) as {
        model?: { content: number[]; border: number[] };
      };
      if (boxModel?.model) {
        const b = boxModel.model.border;
        const x = Math.min(b[0], b[2], b[4], b[6]);
        const y = Math.min(b[1], b[3], b[5], b[7]);
        const maxX = Math.max(b[0], b[2], b[4], b[6]);
        const maxY = Math.max(b[1], b[3], b[5], b[7]);
        labelPositions.push({ index: el.index, x, y, width: maxX - x, height: maxY - y });
      }
    } catch {
      // Element might not be visible
    }
  }

  if (labelPositions.length > 0) {
    await evaluateJs(session, buildLabelInjectionScript(labelPositions));
  }

  const capture = await captureWithSizeGuarantee(session, profile);

  if (labelPositions.length > 0) {
    await evaluateJs(session, REMOVE_LABELS_SCRIPT).catch(() => {});
  }

  const legend = formatLabelLegend(interactive);
  return {
    content: [
      { type: 'image', data: capture.data, mimeType: capture.mimeType },
      { type: 'text', text: legend },
      ...(capture.compressed ? [{ type: 'text' as const, text: `(auto-compressed to fit ${(profile.effectiveLimit / 1_000_000).toFixed(0)}MB limit)` }] : []),
    ],
  };
}
```

### 2.5 Tests for Phase 2

Add to `mcp/src/mcp.test.ts`:

```typescript
describe('Screenshot quality: resolveProfile', () => {
  it('default tier returns medium WebP profile', () => {
    const p = resolveProfile('medium');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('high tier returns PNG profile', () => {
    const p = resolveProfile('high');
    assert.equal(p.format, 'png');
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('low tier returns compact WebP profile', () => {
    const p = resolveProfile('low');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 40);
    assert.equal(p.effectiveLimit, 1_000_000);
  });

  it('known model hint overrides defaults', () => {
    const p = resolveProfile('medium', 'gpt-5.4');
    assert.equal(p.maxLongEdge, 2048);
    assert.equal(p.quality, 85);
    assert.equal(p.effectiveLimit, 5_000_000); // tier limit wins over model limit
  });

  it('claude model hint applies Claude limits', () => {
    const p = resolveProfile('medium', 'claude-sonnet-4.6');
    assert.equal(p.maxLongEdge, 1568);
    assert.equal(p.maxBytes, 5_000_000);
  });

  it('unknown model hint falls back to defaults', () => {
    const p = resolveProfile('medium', 'unknown-model-99');
    assert.equal(p.format, 'webp');
    assert.equal(p.quality, 80);
    assert.equal(p.effectiveLimit, 5_000_000);
  });

  it('model hint with partial match works', () => {
    const p = resolveProfile('medium', 'my-claude-sonnet-4.6-wrapper');
    assert.equal(p.maxLongEdge, 1568);
  });

  it('tier limit caps model maxBytes', () => {
    const p = resolveProfile('low', 'gpt-5.4');
    assert.equal(p.effectiveLimit, 1_000_000); // low tier wins
  });
});

describe('Screenshot quality: auto-compression size check', () => {
  function needsCompression(base64Length: number, limitBytes: number): boolean {
    return Math.ceil(base64Length * 3 / 4) > limitBytes;
  }

  function calculateFallbackQuality(currentQuality: number, currentSize: number, limit: number): number {
    return Math.max(10, Math.floor(currentQuality * (limit / currentSize) * 0.8));
  }

  it('should not compress when under limit', () => {
    assert.equal(needsCompression(1_000_000, 5_000_000), false);
  });

  it('should compress when over limit', () => {
    assert.equal(needsCompression(8_000_000, 5_000_000), true);
  });

  it('should calculate reduced quality proportionally', () => {
    const q = calculateFallbackQuality(80, 10_000_000, 5_000_000);
    assert.ok(q < 80);
    assert.ok(q >= 10);
  });

  it('should floor to 10 for extreme oversize', () => {
    const q = calculateFallbackQuality(80, 100_000_000, 1_000_000);
    assert.equal(q, 10);
  });
});
```

---

## Phase 3: Tool Description Updates

### 3.1 Update `storage` tool description

```typescript
description: `Manage browser storage: cookies, localStorage, sessionStorage, cache.
Actions: get_cookies, set_cookie, delete_cookie, get_local_storage, set_local_storage, remove_local_storage, get_session_storage, clear_storage, get_storage_usage.
clear_storage requires explicit storage_types parameter to prevent accidental full wipe.`,
```

Update `storage_types` property description:
```typescript
storage_types: {
  type: 'string',
  description: 'REQUIRED for clear_storage. Comma-separated: cookies, local_storage, session_storage, cache_storage, indexeddb, service_workers',
},
```

---

## Execution Order

| Step | What | File | Est. Time |
|------|------|------|-----------|
| 1 | Add `ImageProfile` type + `MODEL_PROFILES` + `resolveProfile()` | `mcp.ts` | 10 min |
| 2 | Add `captureWithSizeGuarantee()` | `mcp.ts` | 15 min |
| 3 | Update `screenshot` tool schema (quality, model params) | `mcp.ts` | 5 min |
| 4 | Replace `screenshot` handler with new logic | `mcp.ts` | 15 min |
| 5 | Update `clear_cache_and_reload` handler (safe cache) | `mcp.ts` | 15 min |
| 6 | Update `clear_cache_and_reload` tool description | `mcp.ts` | 5 min |
| 7 | Update `storage` `clear_storage` (require types) | `mcp.ts` | 5 min |
| 8 | Update `storage` tool description | `mcp.ts` | 5 min |
| 9 | Add Phase 1 tests | `mcp.test.ts` | 10 min |
| 10 | Add Phase 2 tests | `mcp.test.ts` | 15 min |
| 11 | Run full test suite | — | 3 min |
| 12 | Build and verify | — | 1 min |
| **Total** | | | **~1h 45min** |

---

## Verification Checklist

- [ ] `clear_cache_and_reload { clear: "cache" }` does NOT call `Network.clearBrowserCache`
- [ ] `clear_cache_and_reload { clear: "all" }` does NOT call `Network.clearBrowserCache`
- [ ] `clear_cache_and_reload { clear: "global_cache" }` DOES call `Network.clearBrowserCache`
- [ ] `clear_cache_and_reload { clear: "everything" }` DOES call `Network.clearBrowserCache`
- [ ] `storage { action: "clear_storage" }` without `storage_types` returns error
- [ ] `storage { action: "clear_storage", storage_types: "cookies" }` works
- [ ] `screenshot` default → WebP, ≤5 MB
- [ ] `screenshot { quality: "high" }` → PNG, auto-compresses to WebP if >5 MB
- [ ] `screenshot { quality: "low" }` → WebP, ≤1 MB
- [ ] `screenshot { model: "gpt-5.4" }` → uses GPT-5.4 profile
- [ ] `screenshot { model: "unknown" }` → uses default (5 MB) profile
- [ ] `screenshot { labels: true, quality: "medium" }` → labeled WebP, ≤5 MB
- [ ] All existing tests still pass (current: 1070 tests across 3 files)
- [ ] `npm run build` succeeds with 0 errors
- [ ] `clear_cache_and_reload { clear: "cache", reload: false }` still reloads (cache bypass requires reload)

---

## Audit Results (2026-04-03)

### Code Audit Findings

| # | Finding | Status | Impact |
|---|---------|--------|--------|
| 1 | `Network.clearBrowserCache` at mcp.ts:2197 is the **only** global-scope cache call. No other callers. | Confirmed | Only one line to change |
| 2 | `Network.clearBrowserCookies` in SLOW_CDP_COMMANDS set (line 818) but never actually called | Safe | No change needed |
| 3 | `Page.reload({ ignoreCache: true })` already used at line 2228 for every reload | Confirmed | Existing reload behavior is already per-tab safe |
| 4 | `legacyMode === 'aggressive'` expands to `['cache', 'cookies']` — will inherit safe behavior after fix | Confirmed | Automatic migration |
| 5 | `CdpSession` type defined at line 23 — `{ ws: WebSocket, sessionId: string, nextId: number, pendingRequests: Map }` | Confirmed | Code uses correct type |
| 6 | `ensure_fresh_render` (line 2239) uses `Page.reload({ ignoreCache: true })` — already safe | Confirmed | No change needed |
| 7 | No other tools call `Network.clearBrowserCache` | Confirmed via grep | Change is isolated |

### CDP Specification Verification

| API | Scope | Verified Source |
|-----|-------|----------------|
| `Network.clearBrowserCache` | **Global** (entire browser profile) | CDP spec + observed behavior |
| `Page.reload({ ignoreCache: true })` | **Per-tab** (equivalent to Shift+Refresh) | [CDP v1.2 Page domain](https://chromedevtools.github.io/devtools-protocol/1-2/Page/) |
| `Storage.clearDataForOrigin` | **Per-origin** | CDP Storage domain |
| `Network.getCookies` + `Network.deleteCookies` | **Per-domain** (current code filters by origin) | CDP Network domain |
| `Page.captureScreenshot({ format, quality })` | Per-tab | CDP Page domain |

### LLM API Limits Verification

| Model | File Size Limit | Source | Verified |
|-------|----------------|--------|----------|
| Claude Opus/Sonnet 4.6 | 5 MB/image (API) | [docs.anthropic.com](https://docs.anthropic.com/en/docs/build-with-claude/vision) | Yes, FAQ section |
| GPT-5.4 | 512 MB total request | [developers.openai.com](https://developers.openai.com/api/docs/guides/images-vision/) | Yes |
| GPT-5.3-Codex | 512 MB total request | Same | Yes, model listed in table |
| Gemini 3 | 20 MB inline total | [ai.google.dev](https://ai.google.dev/gemini-api/docs/image-understanding) | Yes |

### Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Agent passes invalid model name | Medium | Graceful fallback to DEFAULT_PROFILE (5 MB) |
| WebP at quality 10 still exceeds 5 MB | Near zero | Would require >50 megapixel capture — not possible via standard CDP |
| `clear: "cache"` with `reload: false` forcing a reload confuses agent | Low | Document in tool description; cache bypass requires reload |
| Partial model match hits wrong profile | Low | Profiles sorted most-specific first; similar models have similar limits |
| CDP `optimizeForSpeed` not supported on old Chrome | Near zero | Parameter is silently ignored if unsupported |
| Breaking change for existing `clear: "all"` callers | Medium | `all` still clears origin-scoped storage + per-tab cache bypass — functionally similar but safer |
