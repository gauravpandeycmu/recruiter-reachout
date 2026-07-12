import { useEffect, useState } from "react";

const PHRASES = [
  "Growing the forest…",
  "Watering the plants…",
  "Warming the sun…",
  "Fluffing the canopy…",
  "Calling the ducks…",
  "Stretching the roots…",
  "Polishing the leaves…",
  "Waking the grove…",
];

/** Same skeleton as before — the loading sentence rotates through fun phrases. */
export function GroveLoadingPlay() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * PHRASES.length));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % PHRASES.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="grove-canvas-skeleton" role="status" aria-live="polite" aria-busy="true">
      <p className="hint" key={index}>
        {PHRASES[index]}
      </p>
    </div>
  );
}
