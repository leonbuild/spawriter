import React from "react";
import { useCss } from "kremling";
import ToggleOption from "./toggle-option";

export default function ToggleGroup(props) {
  const { name, onChange, value, children, ...rest } = props;
  const styles = useCss(css);

  // Separate legend from options
  let legend = null;
  const options = [];
  
  React.Children.forEach(children, (child) => {
    if (child && typeof child === 'object' && child.type === 'legend') {
      legend = child;
    } else if (child && child.type === ToggleOption) {
      options.push(child);
    }
  });

  return (
    <div {...styles} {...rest} className="toggle-group-wrapper">
      {legend}
      <div className="toggle-options">
        {options.map((child, index) => 
          React.cloneElement(child, {
            key: index,
            onChange,
            name,
            checked: child.props.value === value,
          })
        )}
      </div>
    </div>
  );
}

const css = `
& .toggle-group-wrapper {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  white-space: nowrap;
  flex-shrink: 0;
  gap: 0.5rem;
}
& .toggle-options {
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  white-space: nowrap;
}
& legend {
  color: var(--gray);
  font-size: .9rem;
  font-weight: 500;
  padding: 0;
  margin: 0;
  line-height: 1.2;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
}
`;
