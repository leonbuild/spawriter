import React, { useState, useEffect, useRef } from "react";
import OverrideRow from "./override-row.component";

/**
 * A collapsible section displaying a group of override entries (Apps or Dependencies).
 *
 * Apps section is always expanded.
 * Dependencies section auto-expands when active count > 0.
 */
export default function OverrideSection({
  title,
  entries,
  activeCount,
  collapsible,
  onToggle,
  onSaveUrl,
  onDelete,
  pendingByName,
  errorByName,
  renderAppActions,
  onRowHover,
  onRowLeave,
}) {
  const [collapsed, setCollapsed] = useState(collapsible && activeCount === 0);
  const prevActiveCount = useRef(activeCount);
  const sectionId = `override-section-${title.toLowerCase().replace(/\s+/g, "-")}`;

  // Auto-expand when active count goes from 0 to >0
  useEffect(() => {
    if (collapsible && prevActiveCount.current === 0 && activeCount > 0) {
      setCollapsed(false);
    }
    prevActiveCount.current = activeCount;
  }, [activeCount, collapsible]);

  const headerLabel = activeCount > 0
    ? `${title} (${entries.length}) · ${activeCount} overriding`
    : `${title} (${entries.length})`;

  return (
    <div className="override-section">
      {collapsible ? (
        <button
          className="section-header section-header-collapsible"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls={sectionId}
          type="button"
        >
          <span className="collapse-icon">{collapsed ? "▸" : "▾"}</span>
          {headerLabel}
        </button>
      ) : (
        <div className="section-header">{headerLabel}</div>
      )}
      {!collapsed && (
        <div role="table" className="override-table" id={sectionId}>
          <div role="row" className="override-table-header">
            <span role="columnheader">Name</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Actions</span>
            <span role="columnheader">Override</span>
          </div>
          {entries.map((entry) => (
            <OverrideRow
              key={entry.name}
              entry={entry}
              onToggle={onToggle}
              onSaveUrl={onSaveUrl}
              onDelete={onDelete}
              pending={pendingByName[entry.name]}
              error={errorByName[entry.name]}
              registeredAppComponent={
                entry.registered && renderAppActions
                  ? renderAppActions(entry)
                  : null
              }
              onHover={onRowHover ? () => onRowHover(entry) : null}
              onLeave={onRowLeave}
            />
          ))}
        </div>
      )}
    </div>
  );
}
