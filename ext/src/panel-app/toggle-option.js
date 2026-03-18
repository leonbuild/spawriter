import React from "react";
import { useCss, always } from "kremling";

export default function ToggleOption(props) {
  const { children, checked, ...rest } = props;
  const styles = useCss(css);

  return (
    <label
      {...styles}
      className={always("toggle-option").maybe("active", checked)}
    >
      <input type="radio" {...rest} />
      {children}
    </label>
  );
}

const css = `
& .toggle-option {
  background: var(--blue);
  color: #fff;
  cursor: pointer;
  font-size: .75rem;
  margin-right: 2px;
  padding: .3rem 0.6rem;
  transition: background .15s ease-in-out;
  user-select: none;
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
}

& .toggle-option:focus-within {
  outline: none;
}

& .toggle-option:first-of-type {
  border-top-left-radius: 3px;
  border-bottom-left-radius: 3px;
}

& .toggle-option:last-of-type {
  border-top-right-radius: 3px;
  border-bottom-right-radius: 3px;
}

& .toggle-option.active {
  background: var(--green);
}

& .toggle-option input {
  clip: rect(1px, 1px, 1px, 1px);
  clip-path: inset(50%);
  height: 1px;
  width: 1px;
  margin: -1px;
  overflow: hidden;
  padding: 0;
  position: absolute;
}
`;
