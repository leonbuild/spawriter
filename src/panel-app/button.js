import React from "react";
import { useCss } from "kremling";

export default function Button({ children, className = "", ...props }) {
  const scope = useCss(css);
  return (
    <button {...props} {...scope} className={`button ${className}`.trim()}>
      {children}
    </button>
  );
}

const css = `
& .button {
  background: var(--blue);
  border: none;
  border-radius: 3px;
  color: #fff;
  font-size: .75rem;
  padding: .3rem .6rem;
  text-shadow: 0px 2px 4px rgba(0,0,0,.15);
  transition: background .15s ease-in-out;
  line-height: 1.2;
  user-select: none;
  box-sizing: border-box;
}
& .button:hover,
& .button:focus {
  background: var(--blue-dark);
  outline: none;
}
& .button:not(:first-of-type) {
  margin-left: .25rem;
}
& .button:disabled {
  background: var(--blue-light);
}
`;
