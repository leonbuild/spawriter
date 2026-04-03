# Remove Global Browser Clear Operations

**Status**: Ready for implementation  
**Date**: 2026-04-03  
**Context**: Agent-safe design — all clearing operations must be scoped to the current tab/origin

---

## Background

CDP provides two browser-wide nuclear commands:
- `Network.clearBrowserCache` — wipes the entire browser HTTP disk cache (all tabs, all origins)
- `Network.clearBrowserCookies` — wipes every cookie in the browser (all tabs, all origins)

These cannot be scoped per-tab or per-origin. There is no CDP API for partial cache clearing.

In our Phase 1 implementation, we replaced the default `cache` type with per-tab `Page.reload({ ignoreCache: true })` and moved the global version behind an explicit `global_cache` keyword (plus `everything` which expands to include `global_cache`). However, even with warnings, an LLM agent may still call `global_cache` or `everything` — agents don't reliably heed danger warnings in tool descriptions.

**Decision**: Remove `global_cache` and `everything` entirely. If a human user truly needs global cache clearing, they can use `execute { code: "..." }` with raw CDP as an explicit escape hatch.

---

## 1. Code Removals in `mcp.ts`

### 1a. Remove `everything` and `global_cache` from `clear_cache_and_reload` handler

**File**: `mcp/src/mcp.ts`, lines ~2305–2328  
**Current**:
```typescript
clearTypes = new Set(raw.includes('all')
  ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
  : raw.includes('everything')
    ? ['cache', 'global_cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
    : raw);
```
**After**:
```typescript
clearTypes = new Set(raw.includes('all')
  ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
  : raw);
```

Remove the `global_cache` block entirely (~lines 2326-2329):
```typescript
// DELETE THIS BLOCK:
if (clearTypes.has('global_cache')) {
  await sendCdpCommand(session, 'Network.clearBrowserCache', undefined, getCommandTimeout('Network.clearBrowserCache'));
  cleared.push('cache (global — ALL origins affected)');
}
```

### 1b. Remove `Network.clearBrowserCache` and `Network.clearBrowserCookies` from timeout config

**File**: `mcp/src/mcp.ts`, line ~916-917  
**Current**:
```typescript
'Network.clearBrowserCache',
'Network.clearBrowserCookies',
```
**After**: Remove both lines. Neither command should ever be called.

Note: `Network.clearBrowserCookies` was already not called by any tool (cookies are individually deleted via `Network.deleteCookies`), but keeping it in the timeout config implies it could be used. Remove for clarity.

---

## 2. Tool Descriptions to Update in `mcp.ts`

### 2a. `clear_cache_and_reload` description

**File**: `mcp/src/mcp.ts`, line ~1427  
**Current**:
```
Clear browser cache/storage and optionally reload the page.
Uses SAFE per-tab operations by default. "cache" bypasses HTTP cache via reload (current tab only, does NOT clear other tabs).
"global_cache" clears browser-wide HTTP cache (WARNING: affects ALL tabs/origins).
"everything" = all + global_cache.
"all" = cache + cookies + local_storage + session_storage + cache_storage + indexeddb + service_workers (all origin-scoped).
...
```
**After**:
```
Clear browser cache/storage for the current tab/origin and optionally reload.
All operations are scoped to the current tab or origin — never affects other tabs.
"cache" bypasses HTTP cache via ignoreCache reload (current tab only).
"all" = cache + cookies + local_storage + session_storage + cache_storage + indexeddb + service_workers.
Cookies: only cookies matching the current origin are deleted.
Storage: cleared via Storage.clearDataForOrigin (origin-scoped).
```

Remove any mention of `global_cache`, `everything`, or `mode: "aggressive"` from the description. The `legacyMode` code path can stay for backward compatibility but its description should not promote it.

### 2b. `clear_cache_and_reload` inputSchema

Remove `global_cache` and `everything` from the `clear` property description/enum if present.

### 2c. `storage` description — no changes needed

Already requires explicit `storage_types` for `clear_storage`. Already safe.

---

## 3. Test Updates in `mcp.test.ts`

### 3a. Remove or update `everything`/`global_cache` tests

**Tests to update** in the `clear_cache_and_reload safety` describe block:

| Test | Action |
|------|--------|
| `"everything" should include global_cache` | **Remove** — `everything` no longer exists |
| `"everything" should include all types plus global_cache` | **Remove** — `everything` no longer exists |
| `"global_cache" alone should be in the set` | **Remove** — `global_cache` no longer recognized |

**Tests to add**:
| Test | Description |
|------|-------------|
| `"everything" should be treated as unknown type` | `parseClearTypes("everything")` produces a set containing the literal string "everything" (not expanded), which does nothing |
| `"global_cache" should be treated as unknown type` | `parseClearTypes("global_cache")` produces a set containing the literal string "global_cache", which does nothing |

### 3b. Remove timeout test for `Network.clearBrowserCache`

Update the test in `getCommandTimeout (additional)` that checks `Network.clearBrowserCache` → 60s. Remove or change the assertion.

---

## 4. Cursor Rule Updates

### What Cursor sees

Cursor provides the agent with **two sources of tool information**:
1. **MCP tool descriptors**: Auto-generated from the `inputSchema` and `description` in the tool registration. These are the authoritative reference — the agent reads these directly when calling tools.
2. **Cursor rule (`.mdc`)**: The `spawriter.mdc` rule provides behavioral guidance — *when* to use tools, *in what order*, *what workflows to follow*. It is **not** the tool reference.

**Principle**: The cursor rule should focus on **decision-making and workflows**, not duplicate tool parameter documentation. The tool descriptors already contain the authoritative parameter info.

### 4a. Changes to `mcp/cursor-rules/spawriter.mdc`

| Section | Line(s) | Change |
|---------|---------|--------|
| Tool table: Navigation & Refresh | 77 | Update `clear_cache_and_reload` description: remove "Granular cache/storage reset + reload" → replace with "Clear cache/storage for current tab/origin + reload. All operations are tab-scoped." Remove `mode? (deprecated)` from Key Args |
| Safety Rules #8 | 844 | Current: `Cookie clearing is origin-scoped — clear_cache_and_reload only removes cookies for the current page's origin. Other sites' cookies are never affected, even with mode: "aggressive".` → Update to: `All clearing operations are tab/origin-scoped. clear_cache_and_reload never affects other tabs or origins.` |
| Troubleshooting table | 852 | Keep as-is: `clear_cache_and_reload { clear: "cache,service_workers" }` — this is still valid |
| Troubleshooting: "Need to clear cookies too" | 860 | Keep as-is: `clear_cache_and_reload { clear: "cache,cookies" }` — still valid |
| Verification-after-changes protocol | 156 | Keep as-is: `ensure_fresh_render` or `clear_cache_and_reload` |
| Screenshot tool table | 22 | Update to mention `quality` and `model` args: `labels?`, `quality?` (high/medium/low), `model?` |

### 4b. Add a new safety rule

Add as Safety Rule #9 or #10:

```
9. **No global cache/cookie clearing** — spawriter never calls Network.clearBrowserCache or Network.clearBrowserCookies.
   All cache clearing is per-tab (via ignoreCache reload), all cookie deletion is per-origin.
   There is no "clear everything" option. If you need global clearing, use `execute` with explicit CDP commands.
```

### 4c. Update screenshot workflow examples (optional)

In the "Recommended Workflow" → "1. Understand current state first" section, consider updating:
```
screenshot                →  confirm the visible UI
```
to:
```
screenshot               →  confirm the visible UI (default: medium quality, auto-compressed for LLMs)
screenshot { quality: "high" }  →  maximum fidelity PNG (for visual comparison)
screenshot { quality: "low" }   →  compact for bandwidth-constrained contexts
```

### 4d. Do NOT duplicate tool parameter details

The rule should **not** re-explain what `quality: "high"` means or list the `clear` types. The tool descriptors already contain this. The rule's job is to tell the agent *when* and *why* to use each tool.

---

## 5. Release artifact update

**File**: `D:/dev/side/spawriter/release/spawriter-v1.0.0/cursor-rules/spawriter.mdc`

Apply the same changes as §4. This is the distributed version of the cursor rule.

---

## Summary

| Category | Items | Count |
|----------|-------|-------|
| Code removals in `mcp.ts` | `everything` expansion, `global_cache` handler, timeout entries | 3 |
| Tool descriptions in `mcp.ts` | `clear_cache_and_reload` description + schema | 1 |
| Tests in `mcp.test.ts` | Remove 3 obsolete, add 2 new | 5 |
| Cursor rule `.mdc` | Tool table, safety rule, screenshot args, wording | 4 spots in 2 files |

**Estimated implementation time**: 15–20 minutes

---

## Verification Checklist

- [ ] `Network.clearBrowserCache` does not appear in any tool handler code path
- [ ] `Network.clearBrowserCookies` does not appear in any tool handler code path
- [ ] `global_cache` string does not appear in tool descriptions or handler logic
- [ ] `everything` string does not appear in tool descriptions or handler logic
- [ ] All tests pass (expect count to drop by ~1 net due to removals/additions)
- [ ] `npx tsc --noEmit` passes
- [ ] Cursor rule `.mdc` has no mention of `global_cache`, `everything`, or `mode: "aggressive"`
- [ ] Screenshot tool table in `.mdc` mentions `quality?` and `model?` args
