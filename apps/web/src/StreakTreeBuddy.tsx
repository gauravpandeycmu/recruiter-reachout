import { useEffect, useRef, useState } from "react";

type TreeMood =
  | "hi"
  | "rain"
  | "sunny"
  | "sleepy"
  | "yay"
  | "butterfly"
  | "wind"
  | "bird"
  | "peek"
  | "snow"
  | "bee"
  | "apple"
  | "flower"
  | "rainbow"
  | "star"
  | "snail"
  | "storm";

const COMMON: TreeMood[] = [
  "hi",
  "rain",
  "sunny",
  "sleepy",
  "yay",
  "butterfly",
  "wind",
  "bird",
  "peek",
  "snow",
  "bee",
  "apple",
  "flower",
  "rainbow",
  "star",
  "snail",
];

const BUBBLES: Partial<Record<TreeMood, string>> = {
  hi: "Hi!",
  sunny: "Warm!",
  sleepy: "Zzz",
  yay: "Yay!",
  butterfly: "Ooh!",
  wind: "Whee!",
  bird: "Chirp!",
  peek: "Boo!",
  snow: "Brr!",
  bee: "Buzz!",
  apple: "Oops!",
  flower: "Pretty!",
  rainbow: "Wow!",
  star: "Wish!",
  snail: "Hi!",
  storm: "Eek!",
};

/** Long holds so each scene can play out. */
const MOOD_MS: Record<TreeMood, number> = {
  hi: 18000,
  rain: 22000,
  sunny: 20000,
  sleepy: 22000,
  yay: 16000,
  butterfly: 18000,
  wind: 20000,
  bird: 18000,
  peek: 15000,
  snow: 20000,
  bee: 18000,
  apple: 24000,
  flower: 18000,
  rainbow: 20000,
  star: 18000,
  snail: 18000,
  storm: 10000,
};

function pickMood(prev: TreeMood): TreeMood {
  if (Math.random() < 0.025) return "storm";

  const pool: TreeMood[] = [
    ...COMMON,
    "rain",
    "rain",
    "rain",
    "wind",
    "wind",
    "sleepy",
    "sleepy",
    "hi",
    "sunny",
    "apple",
    "yay",
  ];
  let next = pool[Math.floor(Math.random() * pool.length)]!;
  let guard = 0;
  while (next === prev && guard < 10) {
    next = pool[Math.floor(Math.random() * pool.length)]!;
    guard += 1;
  }
  return next;
}

/** Cute dancing tree — weather props visit, moods keep rotating slowly. */
export function StreakTreeBuddy() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [mood, setMood] = useState<TreeMood>("hi");
  const [hover, setHover] = useState(false);

  useEffect(() => {
    const card = rootRef.current?.closest(".send-streak-card");
    if (!card) return;
    const onEnter = () => setHover(true);
    const onLeave = () => setHover(false);
    card.addEventListener("mouseenter", onEnter);
    card.addEventListener("mouseleave", onLeave);
    card.addEventListener("focusin", onEnter);
    card.addEventListener("focusout", onLeave);
    return () => {
      card.removeEventListener("mouseenter", onEnter);
      card.removeEventListener("mouseleave", onLeave);
      card.removeEventListener("focusin", onEnter);
      card.removeEventListener("focusout", onLeave);
    };
  }, []);

  useEffect(() => {
    const card = rootRef.current?.closest(".send-streak-card");
    if (!card) return;
    card.setAttribute("data-tree-mood", hover ? "hi" : mood);
    return () => card.removeAttribute("data-tree-mood");
  }, [mood, hover]);

  useEffect(() => {
    if (hover) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const timer = window.setTimeout(() => {
      setMood((prev) => pickMood(prev));
    }, MOOD_MS[mood]);
    return () => window.clearTimeout(timer);
  }, [mood, hover]);

  const displayMood: TreeMood = hover ? "hi" : mood;
  const bubble = hover ? "Hi!" : BUBBLES[mood];
  const showRain = !hover && mood === "rain";

  return (
    <>
      <div
        ref={rootRef}
        className={`streak-tree-buddy mood-${displayMood}${hover ? " is-hover" : ""}`}
        aria-hidden="true"
      >
        {bubble ? (
          <span className="streak-tree-bubble" key={hover ? "hover-hi" : mood}>
            {bubble}
          </span>
        ) : null}

        {showRain && (
          <>
            <span className="streak-tree-cloud">
              <i />
              <i />
              <i />
            </span>
            <span className="streak-tree-rain">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </>
        )}

        {!hover && mood === "sunny" && (
          <>
            <span className="streak-tree-sun">
              <span className="streak-tree-sun-core" />
              <span className="streak-tree-sun-rays" />
            </span>
            <span className="streak-tree-sparkles">
              <i />
              <i />
              <i />
            </span>
          </>
        )}

        {!hover && mood === "sleepy" && <span className="streak-tree-moon" />}

        {!hover && mood === "storm" && (
          <>
            <span className="streak-tree-flash" />
            <span className="streak-tree-bolt" />
          </>
        )}

        {(hover || mood === "yay") && (
          <span className="streak-tree-hearts">
            <i />
            <i />
            <i />
          </span>
        )}

        {!hover && mood === "butterfly" && <span className="streak-tree-butterfly" />}

        {!hover && mood === "wind" && (
          <span className="streak-tree-leaves">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        )}

        {!hover && mood === "bird" && <span className="streak-tree-bird" />}

        {!hover && mood === "peek" && <span className="streak-tree-hands" />}

        {!hover && mood === "snow" && (
          <span className="streak-tree-snow">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        )}

        {!hover && mood === "bee" && <span className="streak-tree-bee" />}

        {!hover && mood === "flower" && <span className="streak-tree-flower" />}

        {!hover && mood === "rainbow" && <span className="streak-tree-rainbow" />}

        {!hover && mood === "star" && (
          <span className="streak-tree-stars">
            <i />
            <i />
            <i />
          </span>
        )}

        {!hover && mood === "snail" && <span className="streak-tree-snail" />}

        <div className="streak-tree-figure">
          <span className="streak-tree-arm left" />
          <span className="streak-tree-arm right" />
          {showRain && (
            <span className="streak-tree-umbrella">
              <span className="streak-tree-umbrella-canopy" />
              <span className="streak-tree-umbrella-pole" />
            </span>
          )}
          <span className="streak-tree-canopy">
            <span className="streak-tree-eye left" />
            <span className="streak-tree-eye right" />
            <span className="streak-tree-blush left" />
            <span className="streak-tree-blush right" />
            <span className="streak-tree-smile" />
          </span>
          <span className="streak-tree-trunk" />
          <span className="streak-tree-shadow" />
        </div>
      </div>

      {!hover && mood === "apple" && <span className="streak-card-apple" aria-hidden="true" />}
    </>
  );
}
