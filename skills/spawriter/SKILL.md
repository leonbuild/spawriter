---
name: spawriter
description: Control the user's real Chrome tab through spawriter (extension + relay + MCP server). Use this for single-spa dashboard workflows and AI-assisted runtime checks without launching a second browser.
---

## REQUIRED: Read Full Documentation First

Before using this skill, you MUST read these docs:

1. `README.md` (Part 2: MCP 使用)
2. `doc/CHROME_INSTALL_TEST_GUIDE.md`
3. `doc/MCP_DEV_GUIDE.md`

Do NOT skip this step. Most failures come from missing setup (extension not loaded, MCP not running, or tab restrictions).

## Minimal startup

```bash
npm run mcp:serve
```

Or:

```bash
node dist/cli.js serve
```

## Recommended workflow

1. Call `dashboard_state` first to read full dashboard/runtime state.
2. Check `isAnyAppUsingLocalhostOverride` and `targetAppState` to verify local override is really active for the app you are changing.
3. Call `screenshot` to confirm visible UI and app mount status match the state report.
4. Use `execute` for small checks (URL, selector existence, runtime values).
5. If state looks stale, call `ensure_fresh_render`.
6. Use `clear_cache_and_reload` only when explicit cache reset is required.
7. If CDP/session is unstable, call `reset` and continue.

## Safety rules

- Prefer normal web pages; avoid `chrome://`, `edge://`, and extension pages.
- Do not infer single-spa state from static HTML alone; verify via runtime checks.
- Keep operations incremental and verify with screenshot between major actions.
- For project development tasks, do not assume your code change is active until `dashboard_state` confirms localhost override is effective.
