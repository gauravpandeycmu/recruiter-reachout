import { useEffect, useMemo, useState } from "react";
import { GROVE_TREE_GUIDE } from "./groveTreeGuide";

const COLLAPSED_COUNT = 8;

function GroveTreeThumb({ speciesId, unlocked }: { speciesId: string; unlocked: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [LiveThumb, setLiveThumb] = useState<null | typeof import("./StreakGrove3D").LiveSpeciesThumb>(
    null,
  );

  useEffect(() => {
    if (!unlocked) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    void import("./StreakGrove3D").then((mod) => {
      if (cancelled) return;
      setLiveThumb(() => mod.LiveSpeciesThumb);
      const url = mod.renderSpeciesThumbnail(speciesId);
      setSrc(url || null);
    });
    return () => {
      cancelled = true;
    };
  }, [speciesId, unlocked]);

  if (!unlocked) {
    return <div className="grove-guide-thumb is-locked" aria-hidden="true" />;
  }

  return (
    <div
      className="grove-guide-thumb-wrap"
      onMouseEnter={() => setLive(true)}
      onMouseLeave={() => setLive(false)}
      onFocus={() => setLive(true)}
      onBlur={() => setLive(false)}
    >
      {src ? (
        <img
          className={`grove-guide-thumb${live ? " is-idle-hidden" : ""}`}
          src={src}
          alt=""
          width={112}
          height={128}
        />
      ) : (
        <div className="grove-guide-thumb is-loading" aria-hidden="true" />
      )}
      {live && LiveThumb ? <LiveThumb speciesId={speciesId} className="grove-guide-thumb is-live" /> : null}
    </div>
  );
}

export function GroveTreeFieldGuide({
  unlocked,
  bestUnlockDays = 0,
  testMode = false,
}: {
  unlocked: ReadonlySet<string>;
  /** Best streak days driving unlocks — shown so “2 trees now / 4 collected” is understandable. */
  bestUnlockDays?: number;
  /** Preview every species (thumbs + copy) without writing to the real collection. */
  testMode?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = GROVE_TREE_GUIDE.length;

  const effectiveUnlocked = useMemo(() => {
    if (!testMode) return unlocked;
    return new Set(GROVE_TREE_GUIDE.map((tree) => tree.id));
  }, [testMode, unlocked]);

  const unlockedCount = GROVE_TREE_GUIDE.filter((tree) => effectiveUnlocked.has(tree.id)).length;
  const realUnlockedCount = GROVE_TREE_GUIDE.filter((tree) => unlocked.has(tree.id)).length;

  const sorted = useMemo(() => {
    const grown = GROVE_TREE_GUIDE.filter((tree) => effectiveUnlocked.has(tree.id));
    const locked = GROVE_TREE_GUIDE.filter((tree) => !effectiveUnlocked.has(tree.id));
    return [...grown, ...locked];
  }, [effectiveUnlocked]);

  const showAll = testMode || expanded;
  const visible = showAll ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const hiddenCount = testMode ? 0 : Math.max(0, sorted.length - COLLAPSED_COUNT);

  return (
    <section className="analytics-section grove-guide-section">
      <div className="analytics-section-head">
        <div>
          <p className="eyebrow">Field guide</p>
          <h2>Trees you can grow</h2>
          <p className="hint">
            {testMode
              ? `TEST MODE — previewing all ${total} species (not saved to your collection; real progress is ${realUnlockedCount} of ${total}).`
              : `Each streak day plants a tree — which species is a roll of the dice (repeats welcome). Collect the full catalog by day 100. Unlocks follow your best streak${
                  bestUnlockDays > 0
                    ? ` (best ${bestUnlockDays} day${bestUnlockDays === 1 ? "" : "s"})`
                    : ""
                } and stay collected even if the live grove resets. ${unlockedCount} of ${total} collected.`}
          </p>
        </div>
      </div>
      <div className="grove-guide-grid">
        {visible.map((tree) => {
          const isUnlocked = effectiveUnlocked.has(tree.id);
          return (
            <article
              key={tree.id}
              className={`grove-guide-card${isUnlocked ? " unlocked" : " locked"}`}
              aria-label={isUnlocked ? `${tree.name}: unlocked` : `${tree.name}: not grown yet`}
            >
              <GroveTreeThumb speciesId={tree.id} unlocked={isUnlocked} />
              <div className="grove-guide-copy">
                <div className="grove-guide-title-row">
                  <h3>{isUnlocked ? tree.name : "???"}</h3>
                  <span className="grove-guide-state">{isUnlocked ? "Grown" : "Locked"}</span>
                </div>
                <p>{isUnlocked ? tree.fact : "Keep the streak alive — this one’s still hiding in the fog."}</p>
              </div>
            </article>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className={`grove-guide-expand${expanded ? " is-open" : ""}`}
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
        >
          <span>{expanded ? "Show fewer trees" : `Show ${hiddenCount} more trees`}</span>
          <span className="grove-guide-expand-arrow" aria-hidden="true">
            {expanded ? "↑" : "↓"}
          </span>
        </button>
      )}
    </section>
  );
}
