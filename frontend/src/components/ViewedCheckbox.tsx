import type { MouseEventHandler, ReactElement } from "react";

export function ViewedCheckbox({
  viewed,
  onClick,
}: {
  viewed: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}): ReactElement {
  return (
    <button
      type="button"
      className={`sb-chk${viewed ? " on" : ""}`}
      aria-label={viewed ? "Mark not viewed" : "Mark viewed"}
      title="Viewed"
      onClick={onClick}
    >
      <svg className="sb-checkmark" viewBox="0 0 12 12" aria-hidden="true">
        <path d="m2 6.25 2.4 2.4L10 3" />
      </svg>
    </button>
  );
}
