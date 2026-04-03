# Design: Safe Cache Clearing + Screenshot Quality Tiers

**Date**: 2026-04-03
**Status**: Audited — Implementation plan ready at [impl_safe_clear_screenshot_quality.md](./impl_safe_clear_screenshot_quality.md)

---

## Requirement 1: Agent-Safe Cache/Storage Clearing

### Problem

`clear_cache_and_reload` with `clear: "all"` or `clear: "cache"` calls `Network.clearBrowserCache`, which is a **global** CDP command — it clears the HTTP cache for **all origins** in the entire browser profile, not just the current tab. This is dangerous when an agent operates on a leased tab alongside other agents (or the user) who have active tabs with their own state.

Similarly, the `storage` tool's `clear_storage` action calls `Storage.clearDataForOrigin`, which is origin-scoped — but if the agent provides the wrong `origin`, or if the tool description says "all", it could clear data beyond the agent's leased tab.

### Current Code Audit

#### `clear_cache_and_reload` (mcp.ts:2176–2237)

| Type | CDP Command | Scope | Dangerous? |
|------|-------------|-------|-----------|
| `cache` | `Network.clearBrowserCache` | **Global** (entire browser profile) | **YES** — clears all origins' HTTP cache |
| `cookies` | `Network.getCookies` → filter by origin → `Network.deleteCookies` | Origin-scoped (domain match) | **Safe** — filters to current origin |
| `local_storage` | `Storage.clearDataForOrigin` | Origin-scoped | **Safe** |
| `session_storage` | `Storage.clearDataForOrigin` | Origin-scoped | **Safe** |
| `cache_storage` | `Storage.clearDataForOrigin` | Origin-scoped | **Safe** |
| `indexeddb` | `Storage.clearDataForOrigin` | Origin-scoped | **Safe** |
| `service_workers` | `Storage.clearDataForOrigin` | Origin-scoped | **Safe** |
| `all` | All of the above | **Global cache + origin storage** | **YES** — cache is global |

#### `storage` tool — `clear_storage` action (mcp.ts:2650–2654)

```typescript
case 'clear_storage': {
  const origin = (args.origin as string) || await evaluateJs(session, 'window.location.origin') as string;
  const types = (args.storage_types as string) || 'all';
  await sendCdpCommand(session, 'Storage.clearDataForOrigin', { origin, storageTypes: types });
}
```

| What | Scope | Dangerous? |
|------|-------|-----------|
| `Storage.clearDataForOrigin` | Origin-scoped | **Mostly safe** — but defaults to `storage_types: "all"` which clears everything for the origin |

#### `Network.clearBrowserCookies` (referenced in SLOW_CDP_COMMANDS but not directly used)

Not currently called, but it's in the timeout set — if exposed, it would clear **all cookies globally**.

### Danger Scenario

1. Agent A is leased to Tab 1 (localhost:8080)
2. Agent B is leased to Tab 2 (staging.example.com)
3. User has Tab 3 open with their bank session
4. Agent A calls `clear_cache_and_reload { clear: "all" }`
5. `Network.clearBrowserCache` clears the HTTP cache **for all three tabs**
6. Agent B's bundle cache is gone, forcing full reload
7. User's bank session loses cached assets

### Proposed Fix

#### Strategy: Replace global `Network.clearBrowserCache` with origin-scoped alternative

CDP has **no origin-scoped HTTP cache clear**. `Network.clearBrowserCache` is always global. Our options:

| Option | Approach | Trade-off |
|--------|----------|-----------|
| **A: Block global cache clear** | Remove `cache` from allowed types; only allow origin-scoped storage types | Agents can't bust stale bundles |
| **B: Use `Page.reload({ ignoreCache: true })`** | Replace `Network.clearBrowserCache` with `Page.reload` with `ignoreCache: true` | Per-tab cache bypass, no global side effects. Closest to what agents actually need. |
| **C: Use `Fetch` intercept to add `Cache-Control: no-cache`** | Set up network interception to force cache bypass | Over-engineered, complex |
| **D: Warn in response + add `force` flag** | Let it through but require `force: true` and warn in tool description | Agents may still call it |

**Recommendation: Option B**

In practice, agents calling `clear_cache_and_reload` want a fresh page load with up-to-date resources. `Page.reload({ ignoreCache: true })` achieves this for the current tab only, without affecting other tabs.

#### Implementation Plan

1. **`clear_cache_and_reload`**: Replace `Network.clearBrowserCache` with `Page.reload({ ignoreCache: true })` for the `cache` type. Add a `global_cache` type for when the user explicitly needs full browser cache clear, guarded by a clear warning.

2. **Tool description update**: Make it clear that `cache` is per-tab (reload with cache bypass), and add `global_cache` for the rare case of needing full browser cache invalidation.

3. **`storage` tool**: The `clear_storage` action is already origin-scoped via `Storage.clearDataForOrigin`. No change needed, but improve the default from `"all"` to require explicit `storage_types` to prevent accidental full wipe.

#### Code Changes

##### `clear_cache_and_reload` — Replace global cache clear

```typescript
// BEFORE (global, dangerous):
if (clearTypes.has('cache')) {
  await sendCdpCommand(session, 'Network.clearBrowserCache', undefined, ...);
  cleared.push('cache (global)');
}

// AFTER (per-tab, safe):
if (clearTypes.has('cache')) {
  // ignoreCache on reload bypasses HTTP cache for this tab only
  // The actual reload happens below if shouldReload is true,
  // so we just set the flag to ensure ignoreCache is used
  needsIgnoreCache = true;
  cleared.push('cache (per-tab reload with ignoreCache)');
}

// For backward compat, add explicit global_cache option:
if (clearTypes.has('global_cache')) {
  await sendCdpCommand(session, 'Network.clearBrowserCache', undefined, ...);
  cleared.push('cache (global — affects all tabs)');
}
```

##### `storage` tool — Require explicit types

```typescript
// BEFORE (defaults to "all"):
const types = (args.storage_types as string) || 'all';

// AFTER (require explicit types):
const types = args.storage_types as string;
if (!types) {
  return { content: [{ type: 'text', text: 'Error: clear_storage requires storage_types (e.g. "cookies,local_storage")' }] };
}
```

##### Tool description updates

```
clear_cache_and_reload:
  clear: "cache" → per-tab cache bypass via reload with ignoreCache (safe, affects only current tab)
  clear: "global_cache" → WARNING: clears HTTP cache for ALL origins in the browser (use only when explicitly needed)
  clear: "cookies" → origin-scoped (current page's cookies only)
  clear: "all" → all origin-scoped types + per-tab cache bypass (safe version)
  clear: "everything" → all types including global_cache (dangerous, requires explicit intent)
```

---

## Requirement 2: Screenshot Quality Tiers

### Problem

spawriter's screenshot tool always uses `Page.captureScreenshot({ format: 'png' })`, which produces **full-resolution lossless PNG** images. On high-DPI displays (deviceScaleFactor 2–3), a full-page screenshot of a complex web app can easily be **5–30 MB**.

### LLM API Image Size Limits (verified from official docs, March 2026)

#### Per-Image File Size Limits

| Provider / Model | API Image Limit | Max Dimensions | Optimal Size | Source |
|-----------------|----------------|----------------|-------------|--------|
| **Claude Opus 4.6 / Sonnet 4.6** (Anthropic) | **5 MB per image** (API), 10 MB (claude.ai) | 8000×8000 px (≤20 images); 2000×2000 px (>20 images) | ≤1568px long edge, ~1.15 megapixels | [docs.anthropic.com/en/docs/build-with-claude/vision](https://docs.anthropic.com/en/docs/build-with-claude/vision) |
| **GPT-5.4** (OpenAI) | 512 MB total request, up to 1500 images | 2048px max (high), 6000px max (original) | Patch budget: 2,500 (high), 10,000 (original) at 32×32px | [developers.openai.com/api/docs/guides/images-vision](https://developers.openai.com/api/docs/guides/images-vision/) |
| **GPT-5.3-Codex** (OpenAI) | 512 MB total request | 2048px max (high) | Patch budget: 1,536 at 32×32px | [developers.openai.com/api/docs/guides/images-vision](https://developers.openai.com/api/docs/guides/images-vision/) |
| **Gemini 3** (Google) | 20 MB inline total request, 100 MB via File API | 3600 images/request | Token budget: LOW=280, MED=560, HIGH=1120, ULTRA_HIGH=2240 | [ai.google.dev/gemini-api/docs/image-understanding](https://ai.google.dev/gemini-api/docs/image-understanding) |

**The strictest per-image file size limit is Anthropic Claude API at 5 MB.** This is the binding constraint.

#### Processing Resolution (What the Model Actually "Sees")

All providers silently downscale images before the model processes them. Sending oversized images wastes bandwidth and adds latency with no quality benefit.

| Provider / Model | Processing Resolution | Detail Modes | Token Formula |
|-----------------|----------------------|-------------|---------------|
| **Claude Opus/Sonnet 4.6** | 1568px long edge (~1.15 MP), aspect-preserving downscale | None (single consistent resolution) | (width × height) / 750 |
| **GPT-5.4** (high) | 2048px bounding box → 32×32 patches, 2500 patch budget | low / high / **original** (new: 6000px, 10K patches) / auto | Patch-based: each 32×32 patch = 1 token × multiplier |
| **GPT-5.4** (original) | 6000px bounding box → 32×32 patches, 10,000 patch budget | — | Same patch formula, much larger budget |
| **GPT-5.3-Codex** (high) | 2048px bounding box → 32×32 patches, 1536 patch budget | low / high / auto | Same patch formula |
| **Gemini 3** | Token-budget system (model decides internally) | LOW / MEDIUM / HIGH / ULTRA_HIGH | Per-level: 280–2240 tokens |

Ref: [AwesomeAgents AI Vision Input Limits Guide](https://awesomeagents.ai/guides/ai-vision-image-resolution-limits/) (verified March 2026)

#### Per-Provider Image Dimension Sweet Spots

**Claude (Opus/Sonnet 4.6)** — No resize trigger at these dimensions:

| Aspect Ratio | Max Size (no resize) | Tokens |
|---|---|---|
| 1:1 | 1092×1092 | ~1,590 |
| 3:4 | 951×1268 | ~1,607 |
| 2:3 | 896×1344 | ~1,605 |
| 9:16 | 819×1456 | ~1,590 |
| 1:2 | 784×1568 | ~1,639 |

**GPT-5.4** — Patch-based tokenization:

| Image Size | Patches (high) | Patches (original) |
|---|---|---|
| 1024×1024 | 1,024 (fits in 2,500 budget) | 1,024 |
| 1920×1080 | 2,040 (fits) | 2,040 |
| 2560×1440 | 3,600 (exceeds 2,500 → resized) | 3,600 (fits in 10,000) |
| 3840×2160 | 8,100 (exceeds → resized) | 8,100 (fits) |

**GPT-5.3-Codex** — Same as GPT-5.4 but with 1,536 patch budget (smaller):

| Image Size | Patches | Fits in 1,536 budget? |
|---|---|---|
| 1024×1024 | 1,024 | Yes |
| 1920×1080 | 2,040 | No → resize to ~1056×1408 (1,452 patches) |

#### Token Cost Comparison for a Typical 1920×1080 Screenshot

| Provider | Token Cost | Approx. Cost (input) |
|---|---|---|
| Claude Opus 4.6 | ~2,765 tokens (after downscale to ~1568px) | ~$0.041 ($15/M tokens) |
| Claude Sonnet 4.6 | ~2,765 tokens | ~$0.008 ($3/M tokens) |
| GPT-5.4 (high) | ~2,040 patches × multiplier | ~$0.005 ($2.50/M tokens) |
| GPT-5.3-Codex (high) | ~1,452 patches (resized) × multiplier | ~$0.004 |
| Gemini 3 (HIGH) | ~1,120 tokens | ~$0.0003 ($0.25/M tokens) |

### MCP Client Image Handling Issue

An additional concern: Cursor and other MCP clients currently treat base64 `ImageContent` as **plain text** rather than converting it to native image blocks ([GitHub issue #31208](https://github.com/anthropics/claude-code/issues/31208)). A full-res PNG screenshot can consume 15,000–25,000 tokens as text. The [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/950) has reported screenshots reaching 1.1 million characters in base64. Smaller images significantly reduce this token waste.

### Supported Image Formats Across Providers

| Format | Claude | GPT-5.4 | GPT-5.3-Codex | Gemini 3 |
|--------|--------|---------|---------------|----------|
| PNG | Yes | Yes | Yes | Yes |
| JPEG | Yes | Yes | Yes | Yes |
| WebP | Yes | Yes | Yes | Yes |
| GIF | Yes (static) | Yes (static) | Yes (static) | Yes |

All providers support **WebP**, making it the best format for size reduction.

### Summary of Key Constraints

| Constraint | Value | Source |
|---|---|---|
| **Binding file size limit** | **5 MB** (Anthropic Claude API) | [docs.anthropic.com](https://docs.anthropic.com/en/docs/build-with-claude/vision) |
| Optimal long-edge for Claude | 1568 px | Same |
| Max useful resolution for GPT-5.4 (high) | 2048 px | [developers.openai.com](https://developers.openai.com/api/docs/guides/images-vision/) |
| Max useful resolution for GPT-5.3-Codex | ~1200 px (1536 patch budget) | Same |
| Token-efficient sweet spot | 1092×1092 (1:1) to 784×1568 (1:2) | Claude docs |

Current screenshot sizes observed in practice:

| Scenario | Approximate Size |
|----------|-----------------|
| Simple page, 1x scale, 1920x1080 | 1–3 MB |
| Complex page, 2x scale, 1920x1080 | 5–10 MB |
| Full page, 3x scale, 2560x1440 | 10–30 MB |
| Full page with images, 2x scale | 15–50 MB |

### Current Code

```typescript
case 'screenshot': {
  const result = await sendCdpCommand(session, 'Page.captureScreenshot',
    { format: 'png' },
    getCommandTimeout('Page.captureScreenshot')
  ) as { data: string };
  return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
}
```

No quality, format, or size options are exposed.

### CDP `Page.captureScreenshot` Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `format` | string | `jpeg`, `png`, `webp` (default: `png`) |
| `quality` | integer | 0–100 (jpeg and webp only; ignored for png) |
| `clip` | Viewport | Capture a specific region only |
| `clip.scale` | number | Scale factor for the captured region |
| `fromSurface` | boolean | Capture from surface rather than view |
| `captureBeyondViewport` | boolean | Capture beyond viewport bounds |
| `optimizeForSpeed` | boolean | Optimize encoding speed vs size |

### Alternative Considered: Model-Aware Auto-Sizing

**Question**: Can we let the agent pass a `model` parameter (e.g. `"claude-sonnet-4.6"`, `"gpt-5.4"`) and have spawriter auto-select the optimal format/quality/dimensions?

#### Feasibility Analysis

| Aspect | Assessment |
|--------|-----------|
| **Technically feasible?** | Yes — a lookup table from model name → optimal params is straightforward |
| **Stable?** | Partially — model names change frequently (sonnet-4.6 today, sonnet-5.0 tomorrow), providers update limits without notice |
| **Agent cooperation?** | Unreliable — MCP tools don't know which model is calling them. Agents would have to self-report, and many don't know their own model name. Cursor, VS Code, Claude Code all use different model selection mechanisms |
| **Maintenance burden** | High — every new model release requires updating the lookup table |
| **Error-prone?** | Yes — typos in model names, outdated tables, agents sending wrong model name |

#### Model-Aware Approach Design

```typescript
const MODEL_PROFILES: Record<string, ImageProfile> = {
  'claude-opus-4.6':   { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'claude-sonnet-4.6': { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 },
  'gpt-5.4':           { maxBytes: 20_000_000, maxLongEdge: 2048, format: 'webp', quality: 85 },
  'gpt-5.4-original':  { maxBytes: 20_000_000, maxLongEdge: 6000, format: 'png',  quality: 100 },
  'gpt-5.3-codex':     { maxBytes: 20_000_000, maxLongEdge: 1200, format: 'webp', quality: 80 },
  'gemini-3':          { maxBytes: 20_000_000, maxLongEdge: 1024, format: 'webp', quality: 75 },
};
const DEFAULT_PROFILE =  { maxBytes: 5_000_000, maxLongEdge: 1568, format: 'webp', quality: 80 };
```

#### Pros

1. **Optimal quality per model** — GPT-5.4 can receive higher-quality images than Claude since its file size limit is higher
2. **Token-cost optimization** — avoid sending 1568px images to Gemini that only uses 280 tokens for LOW anyway
3. **Future-proof API** — agents can pass the model name and get automatic optimization

#### Cons

1. **MCP doesn't expose calling model** — the MCP server has no built-in way to know which LLM is calling it. The agent must explicitly pass a `model` parameter, which requires tool description changes and agent cooperation
2. **Agents don't always know their model** — in agentic frameworks, the model running the agent may not be exposed to the tool layer
3. **Frequent updates needed** — new models ship every few weeks; the table becomes stale quickly
4. **False sense of safety** — if the model name is wrong or missing, the wrong profile applies
5. **Testing complexity** — need to test every model profile combination

#### Recommendation: Hybrid Approach

**Use the tiered system (high/medium/low) as primary, with optional `model` hint for optimization.**

```typescript
screenshot({
  quality: "medium",           // Always works, always safe (5 MB guarantee)
  model: "gpt-5.4",           // Optional: spawriter optimizes for this model
})
```

**Behavior**:

1. If `model` is provided and recognized → use model-specific profile (higher quality for models with looser limits)
2. If `model` is unknown or missing → fall back to tier defaults (5 MB safe limit)
3. **Always enforce hard ceiling per tier** — even with model hint, never exceed tier limit
4. Auto-compression loop still applies as final safety net

This way:
- Agents that don't know their model → still get safe defaults
- Agents that do know → get optimized images
- No breaking changes — `model` is optional
- Unknown model names → graceful degradation to defaults

### Design: Hard 5 MB Guarantee with Auto-Compression

The strictest LLM API limit is **Anthropic Claude API at 5 MB per image**. To ensure universal compatibility, the screenshot tool must **guarantee** output is always under 5 MB. If the initial capture exceeds this, it must automatically re-capture at lower quality until it fits. No manual intervention from the agent should be needed.

### Proposed Quality Tiers

| Tier | Name | Format | Quality | Scale | Hard Size Limit | Use Case |
|------|------|--------|---------|-------|-----------------|----------|
| **high** | `high` | `png` | N/A (lossless) | device native | **5 MB** (auto-compress to WebP if exceeded) | Precise visual debugging |
| **medium** | `medium` (default) | `webp` | 80 | device native | **5 MB** (guaranteed) | General use, LLM-compatible |
| **low** | `low` | `webp` | 40 | 1x | **1 MB** | Quick context, cheap LLM calls, reduced token waste |

**Key difference from naive approach**: Even `high` has the 5 MB guarantee. If a PNG exceeds 5 MB, it's automatically downgraded to WebP with progressively lower quality until it fits.

### Size Control Strategies

1. **Format**: `webp` at quality 80 is ~5x smaller than `png` for the same content
2. **Auto-compression loop**: After capture, check size → if over limit, re-capture at lower quality → repeat until under limit
3. **Scale reduction**: For `low`, force `clip.scale: 1` to avoid high-DPI multipliers
4. **`optimizeForSpeed`**: Set to `true` during compression fallback (faster encoding)

### Size Estimation Math

For a 1920x1080 viewport:

| Format | Quality | 1x Scale | 2x Scale | 3x Scale |
|--------|---------|----------|----------|----------|
| PNG | lossless | ~2 MB | ~6 MB | ~12 MB |
| WebP | 80 | ~400 KB | ~1.2 MB | ~2.5 MB |
| WebP | 40 | ~150 KB | ~500 KB | ~1 MB |
| JPEG | 80 | ~500 KB | ~1.5 MB | ~3 MB |
| JPEG | 40 | ~200 KB | ~600 KB | ~1.2 MB |

WebP at quality 80 with 1x scale is almost always under 5 MB (typically 400 KB–1.2 MB). The auto-compression loop handles edge cases (huge pages, 4K viewports, image-heavy content, high-DPI).

### Implementation Plan

#### Auto-Compression Algorithm

```
1. Capture at initial quality (format + quality based on tier)
2. Check size: base64_length * 3/4 = raw bytes
3. If under limit (5 MB) → return
4. If over limit:
   a. Switch to WebP (if was PNG)
   b. Calculate target quality: quality * (limit / currentSize) * 0.8 (safety margin)
   c. Clamp to [10, 90]
   d. Re-capture
   e. If STILL over limit (rare), halve quality and retry (max 3 retries)
5. Return result with correct MIME type
```

#### Tool Schema Update

```typescript
{
  name: 'screenshot',
  description: 'Take a screenshot. Output always ≤5MB (auto-compressed for Anthropic/OpenAI/Gemini API limits). quality: "high" (PNG, best fidelity), "medium" (WebP, default), "low" (WebP, <1MB compact)',
  inputSchema: {
    type: 'object',
    properties: {
      labels: { type: 'boolean', description: 'Overlay numbered labels on interactive elements' },
      quality: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Image quality. Default: "medium" (WebP, <5MB). "high" = PNG (auto-downgrades if >5MB). "low" = compact WebP <1MB.',
      },
    },
  },
}
```

#### Core Capture Logic

```typescript
const MAX_SIZE_BYTES = 5_000_000;        // 5 MB hard limit (Anthropic Claude API constraint)
const LOW_MAX_SIZE_BYTES = 1_000_000;    // 1 MB for low tier
const MAX_RETRIES = 3;

function getInitialParams(tier: string) {
  switch (tier) {
    case 'high':  return { format: 'png' as const };
    case 'low':   return { format: 'webp' as const, quality: 40, optimizeForSpeed: true };
    default:      return { format: 'webp' as const, quality: 80 };
  }
}

async function captureWithSizeGuarantee(session: CdpSession, tier: string) {
  const limit = tier === 'low' ? LOW_MAX_SIZE_BYTES : MAX_SIZE_BYTES;
  let params = getInitialParams(tier);
  let result = await sendCdpCommand(session, 'Page.captureScreenshot', params, ...) as { data: string };
  let sizeBytes = Math.ceil(result.data.length * 3 / 4);

  if (sizeBytes <= limit) {
    return { data: result.data, mimeType: params.format === 'png' ? 'image/png' : 'image/webp' };
  }

  // Auto-compress: switch to WebP and reduce quality
  let quality = params.format === 'png'
    ? Math.min(90, Math.floor(80 * (limit / sizeBytes) * 0.8))
    : Math.floor((params.quality ?? 80) * (limit / sizeBytes) * 0.8);
  quality = Math.max(10, quality);

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    result = await sendCdpCommand(session, 'Page.captureScreenshot',
      { format: 'webp', quality, optimizeForSpeed: true }, ...) as { data: string };
    sizeBytes = Math.ceil(result.data.length * 3 / 4);

    if (sizeBytes <= limit) {
      return { data: result.data, mimeType: 'image/webp' };
    }
    quality = Math.max(10, Math.floor(quality * 0.5));
  }

  // Final attempt: absolute minimum quality
  result = await sendCdpCommand(session, 'Page.captureScreenshot',
    { format: 'webp', quality: 10, optimizeForSpeed: true }, ...) as { data: string };
  return { data: result.data, mimeType: 'image/webp' };
}
```

This guarantees the output is always under 5 MB. In practice, the first WebP re-capture at calculated quality is almost always sufficient — the retry loop is a safety net for extreme edge cases (4K viewports, image-heavy pages).

### Why 5 MB and not 20 MB?

- **Anthropic Claude API**: Hard limit of **5 MB per image** — API returns `400 invalid_request_error` for anything larger
- **OpenAI GPT-4o**: 512 MB total request, but images are token-counted by patches — smaller is cheaper
- **Gemini**: 20 MB inline request total (not per image) — with multiple images, 5 MB each is a safe budget
- **MCP token waste**: Base64 images in MCP are treated as text by Cursor/Claude Code, consuming ~4× the bytes as tokens. A 5 MB image = ~6.67 MB base64 = ~6.67 million characters = massive token waste. Keeping images small is critical for usability.

The 5 MB limit satisfies all providers and minimizes token waste in MCP clients.

### What About the `trace` Tool?

The `trace` tool records user interaction events (clicks, typing, scrolling) as JSON — it does **not** produce screenshots or videos. Its output size is bounded by the `maxLen = 50000` character truncation at mcp.ts:3283. No quality tier changes are needed for trace.

### What About Labeled Screenshots?

The labeled screenshot path (mcp.ts:2053–2093) injects DOM overlays, takes a PNG, then removes them. The quality tier should apply here too:

1. Inject labels
2. Capture with tier params (e.g., WebP 80 for medium)
3. Remove labels
4. Return with correct MIME type

---

## Summary of Proposed Changes

| # | Area | Change | Priority | Effort |
|---|------|--------|----------|--------|
| 1 | `clear_cache_and_reload` | Replace `Network.clearBrowserCache` with `Page.reload({ ignoreCache: true })` for `cache` type | **HIGH** | 30 min |
| 2 | `clear_cache_and_reload` | Add `global_cache` type for explicit global clear with warning | **MEDIUM** | 10 min |
| 3 | `clear_cache_and_reload` | Update `all` to NOT include global cache (only origin-scoped + reload) | **HIGH** | 5 min |
| 4 | `storage` `clear_storage` | Require explicit `storage_types` instead of defaulting to "all" | **MEDIUM** | 10 min |
| 5 | `screenshot` | Add `quality` parameter with `high`/`medium`/`low` tiers | **HIGH** | 45 min |
| 6 | `screenshot` | **Hard 5 MB guarantee**: auto-compress (PNG → WebP → lower quality) until under 5 MB (Anthropic API limit) | **HIGH** | 30 min |
| 7 | `screenshot` | Apply quality tiers + auto-compression to labeled screenshots | **MEDIUM** | 15 min |
| 8 | Tool descriptions | Update descriptions to document safety and quality options | **HIGH** | 15 min |
