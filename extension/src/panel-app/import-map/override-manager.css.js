/**
 * Kremling CSS for the Override Manager.
 * Matches the original apps.component.js visual style.
 */
export const overrideManagerCss = `
:root {
  --gray: #82889a;
  --blue-light: #96b0ff;
  --blue: #3366ff;
  --blue-dark: #2850c8;
  --pink: #e62e5c;
  --green: #28cb51;
  --table-spacing: .5rem;
  --text-primary: #1a1a1a;
  --text-secondary: #82889a;
  --bg-tab: #f0f0f0;
}
body {
  font-family: sans-serif;
  color: var(--text-primary);
}
body.dark {
  --text-primary: #F8F8F2;
  --text-secondary: #a0a0a0;
  --bg-tab: #3c3c3c;
  background-color: #272822;
}

& .om-root {
  font-family: sans-serif;
}

& .om-toolbar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 16px;
  padding: 4px var(--table-spacing);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow-x: visible;
  flex-wrap: nowrap;
}

& .om-toolbar-bottom {
  margin-top: 0;
}

& .om-toolbar-right {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  flex-wrap: nowrap;
}

& .om-label {
  color: var(--gray);
  font-size: .9rem;
  font-weight: 500;
  white-space: nowrap;
  margin-right: 0;
  line-height: 1.2;
  user-select: none;
}

& .om-btn {
  background-color: var(--blue);
  color: #fff;
  font-size: .75rem;
  padding: .3rem .6rem;
  white-space: nowrap;
  line-height: 1.2;
  user-select: none;
  box-sizing: border-box;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
& .om-btn:hover { background-color: var(--blue-dark); outline: none; }

& .om-btn-danger {
  background-color: var(--pink);
  color: #fff;
  font-size: .7rem;
  padding: .2rem .5rem;
  line-height: 1.2;
  box-sizing: border-box;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
& .om-btn-danger:hover { background-color: #c4264f; }

& .om-btn-secondary {
  background-color: var(--gray);
  color: #fff;
  font-size: .7rem;
  padding: .2rem .5rem;
  line-height: 1.2;
  box-sizing: border-box;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
& .om-btn-secondary:hover { background-color: #6a6f7d; }

& .om-message {
  font-size: 0.75rem;
  font-weight: 500;
  white-space: nowrap;
  margin-left: 8px;
}
& .om-message-success { color: var(--green, #28cb51); }
& .om-message-error { color: var(--pink, #e62e5c); }

& .om-notice {
  color: var(--gray, #82889a);
  padding: 16px;
}

& .om-warning {
  background: #fff8e1;
  color: #8d6e00;
  border: 1px solid #ffe082;
  border-radius: 4px;
  padding: 6px 12px;
  margin: 4px 0.5rem;
  font-size: 0.8rem;
}
body.dark & .om-warning {
  background: #3e2e00;
  color: #ffd54f;
  border-color: #5d4500;
}

& .om-phase {
  color: var(--blue, #3366ff);
  font-size: 0.8rem;
  padding: 2px 0.5rem;
  font-style: italic;
}

& .reset-confirm {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
& .reset-confirm-text {
  color: var(--pink, #e62e5c);
  font-size: 0.75rem;
  font-weight: normal;
}

/* ---- Section ---- */

& .override-section {
  margin-bottom: 4px;
}

& .section-header {
  font-size: .9rem;
  font-weight: 600;
  color: var(--text-primary);
  padding: 6px var(--table-spacing);
  user-select: none;
  border-bottom: 1px solid #e0e0e0;
  margin-bottom: 2px;
}
body.dark & .section-header { border-bottom-color: #444; }

& .section-header-collapsible {
  cursor: pointer;
  background: none;
  border: none;
  border-bottom: 1px solid #e0e0e0;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: .9rem;
  font-weight: 600;
  color: var(--text-primary);
  padding: 6px var(--table-spacing);
}
& .section-header-collapsible:hover {
  background: rgba(0,0,0,0.04);
}
body.dark & .section-header-collapsible {
  border-bottom-color: #444;
}
body.dark & .section-header-collapsible:hover {
  background: rgba(255,255,255,0.06);
}
& .collapse-icon {
  display: inline-block;
  width: 1.2em;
  text-align: center;
}

/* ---- Table ---- */

& .override-table {
  display: table;
  border-collapse: separate;
  border-spacing: calc(var(--table-spacing) * 2) 2px;
  padding: 0;
  margin-left: calc(var(--table-spacing) - var(--table-spacing) * 2);
}

& .override-table-header [role="columnheader"] {
  color: var(--gray);
  font-size: .9rem;
  padding-left: .25rem;
  text-align: left;
  white-space: nowrap;
  line-height: 1.2;
}

& .override-row,
& .override-table-header {
  display: table-row;
}

& .override-row [role="cell"],
& .override-table-header [role="columnheader"] {
  display: table-cell;
  vertical-align: top;
  white-space: nowrap;
  padding-top: 2px;
}

/* ---- Row cells ---- */

& .cell-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #1a1a1a;
}
body.dark & .cell-name { color: #ffffff; }

& .cell-override {
  display: inline-flex !important;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: nowrap;
  white-space: nowrap;
}

& .cell-actions { white-space: nowrap; }
& .cell-actions .button { min-width: 64px; text-align: center; box-sizing: border-box; }
& .no-actions { color: var(--gray); }

/* ---- Status badges ---- */

& .status-badge {
  display: inline-block;
  min-width: 88px;
  text-align: center;
  border-radius: 1rem;
  color: #fff;
  font-size: .75rem;
  padding: .25rem .5rem .125rem;
  text-shadow: 0px 2px 4px rgba(0,0,0,.15);
  text-transform: capitalize;
  white-space: nowrap;
  box-sizing: border-box;
}
& .status-overridden { background-color: var(--green); }
& .status-default { background-color: var(--gray); }
& .status-import-only { background-color: #b0b0b0; }
& .status-drift { background-color: #ff9800; }
& .status-error { background-color: #f44336; }
& .status-orphan { background-color: #9c27b0; }
& .status-syncing { background-color: var(--blue); }
& .status-lifecycle.status-mounted { background-color: var(--green); }
& .status-lifecycle.status-not-mounted { background-color: var(--gray); }
& .status-lifecycle.status-not-loaded { background-color: #9e9e9e; }
& .status-lifecycle.status-loading-source-code { background-color: var(--blue); }
& .status-lifecycle.status-not-bootstrapped { background-color: #b0b0b0; }
& .status-lifecycle.status-bootstrapping { background-color: #ff9800; }
& .status-lifecycle.status-mounting { background-color: #8bc34a; }
& .status-lifecycle.status-unmounting { background-color: #ff9800; }
& .status-lifecycle.status-unloading { background-color: #ff9800; }
& .status-lifecycle.status-skip-because-broken { background-color: #f44336; }
& .status-lifecycle.status-load-error { background-color: #f44336; }

/* ---- Toggle, input, buttons ---- */

& .toggle-wrapper { flex-shrink: 0; }

& .input-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
}

& .input-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

& .import-override {
  border: 1.5px solid lightgrey;
  border-radius: 3px;
  box-sizing: border-box;
  font-size: 0.75rem;
  padding: 0.2rem;
  padding-right: 22px;
  transition: all 0.15s ease-in-out;
  width: 210px;
}
& .import-override:read-only {
  background-color: #f5f5f5;
  cursor: pointer;
  border-color: lightgrey;
}
& .import-override:read-only:focus { outline: none; border-color: lightgrey; }
& .import-override.editing {
  background-color: #fff;
  border-color: var(--blue, #3366ff);
  box-shadow: 0 0 0 1px var(--blue, #3366ff);
}
& .import-override.editing:focus {
  border-color: var(--blue, #3366ff);
  box-shadow: 0 0 0 1px var(--blue, #3366ff);
  outline: none;
}
& .import-override.active { color: var(--green); font-weight: 600; }

body.dark & .import-override:read-only { background-color: #3c3c3c; color: var(--text-primary); border-color: #555; }
body.dark & .import-override.editing { background-color: #2a2a2a; color: var(--text-primary); }

& .input-clear-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  border: none;
  background: #999;
  color: #fff;
  border-radius: 50%;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
& .input-clear-btn:hover { background: #666; }

& .override-buttons {
  display: inline-flex;
  gap: 4px;
  width: 130px;
  flex-shrink: 0;
  justify-content: flex-start;
  align-self: flex-start;
}
& .override-buttons .button { min-width: 60px; text-align: center; }

& .drift-info {
  color: #ff9800;
  font-size: 0.65rem;
  white-space: nowrap;
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
}
& .row-error {
  color: var(--pink, #e62e5c);
  font-size: 0.65rem;
  white-space: nowrap;
}
`;
