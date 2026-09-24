import React, { useState, useRef } from "react";
import ToggleSwitch from "../toggle-switch";
import Button from "../button";

/**
 * Single row in the override table.
 * Displays import name, status badge, lifecycle actions (if registered),
 * toggle, URL editor, and save/edit buttons.
 */
export default function OverrideRow({ entry, onToggle, onSaveUrl, onDelete, pending, error, registeredAppComponent, onHover, onLeave }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef(null);

  const isPending = !!pending;
  const isOrphan = entry.sourceState === "saved-only" || entry.sourceState === "active-only";

  const startEdit = () => {
    setEditing(true);
    setEditValue(entry.activeOverrideUrl || entry.savedUrl || "");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const cancelEdit = () => {
    inputRef.current?.blur();
    setEditing(false);
    setEditValue("");
  };

  const handleSave = async () => {
    inputRef.current?.blur();
    setEditing(false);
    await onSaveUrl(entry.name, editValue);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  };

  const hasSavedUrl = !!entry.savedUrl;
  const displayUrl = editing ? editValue : (entry.savedUrl || "");

  // Status badge: classic lifecycle statuses + ORPHAN for deletable entries.
  // Override state is already visible from the toggle + URL color.
  // Drift is resolved silently by background sync — not shown.
  let statusText = "", statusClass = "status-default";
  if (error) {
    statusText = "ERROR";
    statusClass = "status-error";
  } else if (isPending) {
    statusText = "SYNCING";
    statusClass = "status-syncing";
  } else if (isOrphan) {
    statusText = "ORPHAN";
    statusClass = "status-orphan";
  } else if (entry.registered && entry.lifecycleStatus) {
    statusText = entry.lifecycleStatus.replace(/_/g, " ");
    statusClass = `status-lifecycle status-${entry.lifecycleStatus.toLowerCase().replace(/_/g, "-")}`;
  }

  return (
    <div role="row" className="override-row" data-sync={entry.syncStatus} data-kind={entry.kind}
      onMouseEnter={onHover} onMouseLeave={onLeave}>
      <div role="cell" className="cell-name" title={entry.name}>{entry.name}</div>
      <div role="cell" className="cell-status">
        <span className={`status-badge ${statusClass}`}>{statusText}</span>
      </div>
      <div role="cell" className="cell-actions">
        {registeredAppComponent || <span className="no-actions">—</span>}
      </div>
      <div role="cell" className="cell-override">
        <div className="toggle-wrapper">
          <ToggleSwitch
            checked={entry.actualEnabled}
            onChange={(enabled) => onToggle(entry.name, enabled)}
            disabled={!hasSavedUrl || isPending}
            aria-label={`Override ${entry.name}`}
          />
        </div>
        <div className="input-container">
          <div className="input-wrapper">
            <input
              ref={inputRef}
              className={`import-override${editing ? " editing" : ""}${entry.actualEnabled && hasSavedUrl ? " active" : ""}`}
              value={displayUrl}
              readOnly={!editing}
              onChange={(e) => setEditValue(e.target.value)}
              onClick={() => { if (!editing) startEdit(); }}
              onKeyDown={handleKeyDown}
              placeholder="Enter override URL..."
              title={entry.defaultUrl ? `Default: ${entry.defaultUrl}` : ""}
            />
            {editing && editValue && (
              <button
                className="input-clear-btn"
                onClick={() => setEditValue("")}
                type="button"
                title="Clear"
              >×</button>
            )}
          </div>
          {error && <span className="row-error">{error}</span>}
        </div>
        <div className="override-buttons">
          {editing ? (
            <>
              <Button onClick={handleSave}>Save</Button>
              <Button onClick={cancelEdit}>Cancel</Button>
            </>
          ) : (
            <>
              <Button onClick={startEdit}>Edit</Button>
              {isOrphan && <Button className="om-btn-danger" onClick={() => onDelete(entry.name)}>Delete</Button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
