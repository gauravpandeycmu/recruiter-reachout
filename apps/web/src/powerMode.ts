export const POWER_MODE_KEY = "recruiter-reachout-power-mode";
export const POWER_MODE_CHANGED_EVENT = "recruiter-reachout-power-mode";

export type PowerMode = "normal" | "low";

export function readPowerMode(): PowerMode {
  try {
    return localStorage.getItem(POWER_MODE_KEY) === "low" ? "low" : "normal";
  } catch {
    return "normal";
  }
}

export function applyPowerMode(mode: PowerMode = readPowerMode()): PowerMode {
  document.documentElement.dataset.powerMode = mode;
  return mode;
}

export function writePowerMode(mode: PowerMode): PowerMode {
  try {
    localStorage.setItem(POWER_MODE_KEY, mode);
  } catch {
    // ignore
  }
  const resolved = applyPowerMode(mode);
  try {
    window.dispatchEvent(new CustomEvent(POWER_MODE_CHANGED_EVENT, { detail: { mode: resolved } }));
  } catch {
    // ignore
  }
  return resolved;
}

export function togglePowerMode(current: PowerMode = readPowerMode()): PowerMode {
  return writePowerMode(current === "low" ? "normal" : "low");
}
