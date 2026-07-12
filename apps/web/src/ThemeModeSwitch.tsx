import type { ThemePreference } from "./theme";

/** Portfolio-style sun/moon switch — light ↔ dark only. */
export function ThemeModeSwitch({
  theme,
  onToggle,
  showLabel = false,
}: {
  theme: ThemePreference;
  onToggle: () => void;
  showLabel?: boolean;
}) {
  const isDark = theme === "dark";

  return (
    <div className={`theme-mode-switch-wrap${showLabel ? " with-label" : ""}`}>
      {showLabel && (
        <span className="theme-mode-switch-label">{isDark ? "Dark mode" : "Light mode"}</span>
      )}
      <button
        type="button"
        className={`theme-mode-switch${isDark ? " is-dark" : " is-light"}`}
        onClick={onToggle}
        role="switch"
        aria-checked={isDark}
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        title={isDark ? "Dark mode — click for light" : "Light mode — click for dark"}
      >
        <span className="theme-mode-track" aria-hidden="true">
          {isDark ? (
            <>
              <i className="theme-mode-star a" />
              <i className="theme-mode-star b" />
              <i className="theme-mode-star c" />
            </>
          ) : (
            <span className="theme-mode-rays" />
          )}
        </span>
        <span className="theme-mode-knob">
          <span className={`theme-mode-icon moon${isDark ? " show" : ""}`}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z" />
            </svg>
          </span>
          <span className={`theme-mode-icon sun${!isDark ? " show" : ""}`}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path
                d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="theme-mode-shine" />
        </span>
      </button>
    </div>
  );
}
