import React from "react";
import { useCss, always } from "kremling";

export default function ToggleSwitch({ checked, onChange, disabled }) {
  const styles = useCss(css);

  return (
    <label
      {...styles}
      className={always("toggle-switch").maybe("disabled", disabled)}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="slider"></span>
    </label>
  );
}

const css = `
& .toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

& .toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

& .toggle-switch .slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  transition: .3s;
  border-radius: 20px;
}

& .toggle-switch .slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .3s;
  border-radius: 50%;
}

& .toggle-switch input:checked + .slider {
  background-color: var(--green);
}

& .toggle-switch input:checked + .slider:before {
  transform: translateX(16px);
}

& .toggle-switch.disabled {
  opacity: 0.5;
}

& .toggle-switch.disabled .slider {
  cursor: not-allowed;
}
`;

