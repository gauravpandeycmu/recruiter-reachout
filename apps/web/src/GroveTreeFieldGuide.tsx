import { useEffect, useMemo, useRef, useState, memo, type CSSProperties } from "react";
import { buildExpandedVisible } from "./groveFieldGuideLayout";
import { GROVE_TREE_GUIDE, type GroveTreeGuideEntry } from "./groveTreeGuide";

type Grove3DModule = typeof import("./StreakGrove3D");

let grove3dModulePromise: Promise<Grove3DModule> | null = null;

function loadGrove3D(): Promise<Grove3DModule> {
  if (!grove3dModulePromise) grove3dModulePromise = import("./StreakGrove3D");
  return grove3dModulePromise;
}

function GroveTreeThumb({ speciesId, live }: { speciesId: string; live: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [LiveThumb, setLiveThumb] = useState<null | Grove3DModule["LiveSpeciesThumb"]>(null);
  const [liveReady, setLiveReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadGrove3D().then((mod) => {
      if (cancelled) return;
      setLiveThumb(() => mod.LiveSpeciesThumb);
      const url = mod.renderSpeciesThumbnail(speciesId);
      setSrc(url || null);
    });
    return () => {
      cancelled = true;
    };
  }, [speciesId]);

  useEffect(() => {
    if (!live) setLiveReady(false);
  }, [live]);

  return (
    <div className="grove-guide-thumb-wrap">
      {src ? (
        <img
          className={`grove-guide-thumb${live && liveReady ? " is-idle-hidden" : ""}`}
          src={src}
          alt=""
          width={112}
          height={128}
        />
      ) : (
        <div className="grove-guide-thumb is-loading" aria-hidden="true" />
      )}
      {live && LiveThumb ? (
        <LiveThumb
          speciesId={speciesId}
          className="grove-guide-thumb is-live"
          onFirstFrame={() => setLiveReady(true)}
        />
      ) : null}
    </div>
  );
}

function GroveGuideCard({
  tree,
  unlocked,
  revealIndex = 0,
}: {
  tree: GroveTreeGuideEntry;
  unlocked: boolean;
  /** Stagger index for expand extras (0 = no delay). */
  revealIndex?: number;
}) {
  const [live, setLive] = useState(false);

  return (
    <article
      className={`grove-guide-card${unlocked ? " unlocked" : " locked"}`}
      style={revealIndex > 0 ? ({ "--guide-reveal-i": revealIndex } as CSSProperties) : undefined}
      aria-label={unlocked ? `${tree.name}: unlocked` : "Locked tree: not grown yet"}
      onMouseEnter={() => setLive(true)}
      onMouseLeave={() => setLive(false)}
      onFocus={() => setLive(true)}
      onBlur={() => setLive(false)}
    >
      <GroveTreeThumb speciesId={tree.id} live={live} />
      <div className="grove-guide-copy">
        <div className="grove-guide-title-row">
          <h3>{unlocked ? tree.name : "???"}</h3>
          <span className="grove-guide-state">{unlocked ? "Grown" : "Locked"}</span>
        </div>
        <p>{unlocked ? tree.fact : "Keep the streak alive — this one’s still hiding in the fog."}</p>
      </div>
    </article>
  );
}

export const GroveTreeFieldGuide = memo(function GroveTreeFieldGuide({
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
  const headRef = useRef<HTMLDivElement | null>(null);
  const total = GROVE_TREE_GUIDE.length;

  const effectiveUnlocked = useMemo(() => {
    if (!testMode) return unlocked;
    return new Set(GROVE_TREE_GUIDE.map((tree) => tree.id));
  }, [testMode, unlocked]);

  const realUnlockedCount = GROVE_TREE_GUIDE.filter((tree) => unlocked.has(tree.id)).length;

  const sorted = useMemo(() => {
    const grown = GROVE_TREE_GUIDE.filter((tree) => effectiveUnlocked.has(tree.id));
    const locked = GROVE_TREE_GUIDE.filter((tree) => !effectiveUnlocked.has(tree.id));
    return [...grown, ...locked];
  }, [effectiveUnlocked]);

  const { head, rest } = useMemo(
    () => buildExpandedVisible(sorted, effectiveUnlocked),
    [sorted, effectiveUnlocked],
  );

  const showAll = testMode || expanded;
  const extras = testMode ? sorted : rest;
  const headCards = testMode ? [] : head;
  const hiddenCount = testMode ? 0 : rest.length;
  const showExpandToggle = !testMode && (hiddenCount > 0 || expanded);

  return (
    <section className={`analytics-section grove-guide-section${showAll ? " is-expanded" : ""}`}>
      <div ref={headRef} className="analytics-section-head grove-guide-head">
        <div>
          <p className="eyebrow">Field guide</p>
          <h2>Trees you can grow</h2>
          <p className="hint">
            {testMode
              ? `TEST MODE — previewing all ${total} species (not saved to your collection; real progress is ${realUnlockedCount} of ${total}).`
              : `Each streak day plants one tree in the grove. All ${total} unlock by day 100 of your best streak.`}
          </p>
        </div>
      </div>

      {testMode ? (
        <div className="grove-guide-grid">
          {sorted.map((tree) => (
            <GroveGuideCard key={tree.id} tree={tree} unlocked={effectiveUnlocked.has(tree.id)} />
          ))}
        </div>
      ) : (
        <>
          <div className="grove-guide-grid">
            {headCards.map((tree) => (
              <GroveGuideCard key={tree.id} tree={tree} unlocked={effectiveUnlocked.has(tree.id)} />
            ))}
          </div>
          {extras.length > 0 && (
            <div className={`grove-guide-extras${expanded ? " is-open" : ""}`} aria-hidden={!expanded}>
              <div className="grove-guide-extras-inner">
                <div className="grove-guide-grid grove-guide-grid-extras">
                  {extras.map((tree, index) => (
                    <GroveGuideCard
                      key={tree.id}
                      tree={tree}
                      unlocked={effectiveUnlocked.has(tree.id)}
                      revealIndex={index + 1}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {showExpandToggle && (
        <button
          type="button"
          className={`grove-guide-expand${expanded ? " is-open" : ""}`}
          onClick={() => {
            if (expanded) {
              setExpanded(false);
              // Collapse first, then pin the field-guide title to the top of the viewport.
              window.setTimeout(() => {
                headRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }, 80);
            } else {
              setExpanded(true);
            }
          }}
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
});
