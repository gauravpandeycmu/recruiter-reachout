import React, { useMemo } from "react";

type Species = "oak" | "pine" | "birch" | "cherry" | "maple" | "willow";

/** Deterministic per-slot randomness so the grove doesn't reshuffle between renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lake footprint — trees never spawn in the water. */
function inLake(x: number, y: number, spread = 1): boolean {
  const dx = (x - 688) / (218 * spread);
  const dy = (y - 388) / (92 * spread);
  return dx * dx + dy * dy < 1;
}

function speciesForSlot(x: number, y: number, rand: () => number): Species {
  if (y > 300 && inLake(x, y, 1.45) && rand() < 0.65) return "willow";
  const roll = rand();
  if (roll < 0.14) return "cherry";
  if (roll < 0.28) return "maple";
  if (roll < 0.46) return "birch";
  if (roll < 0.68) return "pine";
  return "oak";
}

/**
 * Trees keep growing every day the streak survives:
 * sprout (day 1) -> sapling -> young -> mature -> grand.
 */
function growthFor(age: number): number {
  return Math.min(0.42 + Math.max(0, age - 3) * 0.055, 1.18);
}

function Sprout({ tint }: { tint: string }) {
  return (
    <g>
      <ellipse cx={-1} cy={1.5} rx={8} ry={2.6} fill="url(#sgShadow)" />
      <path d="M-4 1 Q0 -2.5 4 1 Q0 2.2 -4 1 Z" fill="#6d4f32" />
      <path d="M0 0 C0.2 -3.5 -0.3 -7 0.2 -10.5" fill="none" stroke="#4c8a4e" strokeWidth={1.5} strokeLinecap="round" />
      <path d="M0 -7 C-5.5 -8.5 -8 -13 -7 -15.8 C-3 -15.4 -0.6 -11.4 0 -7 Z" fill={tint} />
      <path d="M-4.8 -12.6 C-3.2 -11.6 -1.6 -9.6 -0.4 -7.8" stroke="#3c7d46" strokeWidth={0.5} fill="none" opacity={0.6} />
      <path d="M0.2 -9 C5 -10.6 7.4 -14.8 6.6 -17.4 C2.6 -16.8 0.8 -13 0.2 -9 Z" fill={tint} opacity={0.88} />
      <path d="M4.6 -14.8 C3.2 -13.2 1.6 -11 0.6 -9.4" stroke="#3c7d46" strokeWidth={0.5} fill="none" opacity={0.6} />
    </g>
  );
}

function Sapling({ tint, dark }: { tint: string; dark: string }) {
  return (
    <g>
      <ellipse cx={-1.5} cy={1.5} rx={9} ry={2.8} fill="url(#sgShadow)" />
      <path d="M-1.2 0 C-0.9 -5 -0.8 -10 -0.5 -14.5 L0.8 -14.5 C1 -10 1.1 -5 1.4 0 Z" fill="url(#sgBark)" />
      <path d="M-0.4 -12 C-2 -13.5 -3.4 -15 -4.6 -16.8" stroke="#5c4128" strokeWidth={0.9} fill="none" strokeLinecap="round" />
      <g filter="url(#sgCanopyTex)">
        <ellipse cx={-3.5} cy={-16.5} rx={5.4} ry={4.6} fill={dark} />
        <ellipse cx={0.5} cy={-20} rx={7.4} ry={6.4} fill={tint} />
        <ellipse cx={3.6} cy={-22.4} rx={4} ry={3.4} fill="#ffffff" opacity={0.25} />
      </g>
    </g>
  );
}

function OakTree({ rand, warm }: { rand: () => number; warm?: boolean }) {
  const canopy = warm ? "url(#sgMapleCanopy)" : rand() < 0.5 ? "url(#sgOakCanopy)" : "url(#sgOakCanopyB)";
  const deep = warm ? "#8a4319" : "#24512e";
  const lit = warm ? "#fbd9a0" : "#c2e2a8";
  return (
    <g>
      <ellipse cx={-4} cy={2} rx={22} ry={5} fill="url(#sgShadow)" />
      {/* trunk with root flare and two limbs reaching into the crown */}
      <path
        d="M-5 0 Q-3.6 -1.8 -3 -5 C-2.6 -9.5 -2.3 -13.5 -2.2 -16.2 C-2.2 -18.2 -5.6 -21.8 -9.4 -25.6 L-7.7 -27.2 C-4.7 -23.8 -2.2 -21.2 -1 -19.6 C-0.8 -23.2 -0.3 -27.2 0.7 -30.8 L2.9 -30.4 C2.1 -26.2 1.75 -22.6 1.75 -19.8 C3.1 -21.6 5.5 -24 8.3 -26.8 L9.9 -25.2 C6.3 -21.2 3.7 -18 3.3 -15.8 C3.2 -12.2 3.4 -8 4.1 -4.4 Q4.6 -1.6 6 0 Z"
        fill="url(#sgBark)"
        filter="url(#sgBarkTex)"
      />
      <path d="M-4 -2 C-3 -8 -2.6 -13 -2.5 -16" stroke="#3a2a1e" strokeWidth={0.7} opacity={0.5} fill="none" />
      <path d="M1 -4 C1.4 -9 1.6 -13 1.6 -17" stroke="#8a6238" strokeWidth={0.6} opacity={0.6} fill="none" />
      {/* canopy: shadow mass behind, lobed main mass, sunlit clusters upper-right */}
      <g filter="url(#sgCanopyTex)">
        <path
          d="M-21 -36 C-27 -40 -24 -50 -16 -51 C-16 -58 -8 -62 -2 -59 C3 -65 14 -64 17 -57 C25 -56 28 -47 23 -42 C27 -35 20 -29 13 -31 C9 -25 -3 -24 -8 -29 C-16 -27 -23 -31 -21 -36 Z"
          fill={deep}
          opacity={0.9}
        />
        <path
          d="M-18 -40 C-24 -45 -20 -54 -12 -54 C-11 -61 -2 -65 4 -61 C10 -66 19 -62 20 -55 C27 -53 28 -44 22 -41 C25 -34 17 -30 11 -33 C6 -27 -5 -27 -9 -32 C-16 -31 -21 -35 -18 -40 Z"
          fill={canopy}
        />
        <ellipse cx={7} cy={-52} rx={9} ry={6.5} fill={lit} opacity={0.55} />
        <ellipse cx={-4} cy={-57} rx={6} ry={4.5} fill={lit} opacity={0.4} />
        <ellipse cx={14} cy={-44} rx={5} ry={3.8} fill={lit} opacity={0.35} />
        <ellipse cx={-11} cy={-36} rx={7} ry={5} fill={deep} opacity={0.5} />
      </g>
    </g>
  );
}

function PineTree({ rand }: { rand: () => number }) {
  const tilt = (rand() - 0.5) * 3;
  return (
    <g>
      <ellipse cx={-3.5} cy={2} rx={16} ry={4} fill="url(#sgShadow)" />
      <path d="M-2.2 0 Q-1.6 -6 -1.3 -14 L1.3 -14 Q1.6 -6 2.2 0 Z" fill="url(#sgBarkDark)" filter="url(#sgBarkTex)" />
      <g filter="url(#sgCanopyTex)" transform={`rotate(${tilt})`}>
        {/* drooping tiers, dark in shadow */}
        <path
          d="M0 -64 C2.5 -58 5.5 -53 9.5 -49 Q4.5 -50 0 -49.4 Q-4.5 -50 -9.5 -49 C-5.5 -53 -2.5 -58 0 -64 Z"
          fill="url(#sgPineCanopy)"
        />
        <path
          d="M0 -56 C3.5 -49 7.5 -43 12.5 -38.5 Q6 -40 0 -39.2 Q-6 -40 -12.5 -38.5 C-7.5 -43 -3.5 -49 0 -56 Z"
          fill="url(#sgPineCanopy)"
        />
        <path
          d="M0 -47 C4.5 -39.5 9.5 -33 15.5 -28 Q7.5 -30 0 -29 Q-7.5 -30 -15.5 -28 C-9.5 -33 -4.5 -39.5 0 -47 Z"
          fill="url(#sgPineCanopy)"
        />
        <path
          d="M0 -37 C5.5 -29 11.5 -21.5 18.5 -16 Q9 -18.2 0 -17.2 Q-9 -18.2 -18.5 -16 C-11.5 -21.5 -5.5 -29 0 -37 Z"
          fill="url(#sgPineCanopy)"
        />
        {/* sunlit right edges */}
        <g fill="#79b183" opacity={0.5}>
          <path d="M0 -64 C2.5 -58 5.5 -53 9.5 -49 Q4.5 -50 1.5 -49.6 Q2 -56 0 -64 Z" />
          <path d="M0 -56 C3.5 -49 7.5 -43 12.5 -38.5 Q6 -40 2 -39.4 Q3 -47 0 -56 Z" />
          <path d="M0 -47 C4.5 -39.5 9.5 -33 15.5 -28 Q7.5 -30 2.5 -29.2 Q4 -38 0 -47 Z" />
          <path d="M0 -37 C5.5 -29 11.5 -21.5 18.5 -16 Q9 -18.2 3 -17.4 Q5 -27 0 -37 Z" />
        </g>
        {/* shaded undersides on the left */}
        <g fill="#173c29" opacity={0.55}>
          <path d="M-12.5 -38.5 Q-6 -40 0 -39.2 Q-6 -38.2 -11 -37.6 Z" />
          <path d="M-15.5 -28 Q-7.5 -30 0 -29 Q-7.5 -27.8 -13.8 -27 Z" />
          <path d="M-18.5 -16 Q-9 -18.2 0 -17.2 Q-9 -15.8 -16.5 -15 Z" />
        </g>
      </g>
    </g>
  );
}

function BirchTree({ rand }: { rand: () => number }) {
  const sway = (rand() - 0.5) * 4;
  return (
    <g>
      <ellipse cx={-3} cy={2} rx={14} ry={3.4} fill="url(#sgShadow)" />
      <path
        d={`M-2 0 C-1.6 -12 ${sway - 1.1} -26 ${sway - 0.9} -38 L${sway + 0.9} -38 C${sway + 1.1} -26 1.6 -12 2 0 Z`}
        fill="url(#sgBirchBark)"
        stroke="#c9c1ac"
        strokeWidth={0.4}
      />
      {/* lenticel scars */}
      <g fill="#3d382e" opacity={0.8}>
        <path d="M-1.5 -7 Q-0.3 -7.8 0.9 -7.2 Q-0.3 -6.6 -1.5 -7 Z" />
        <path d="M-0.8 -15 Q0.4 -15.8 1.4 -15.2 Q0.3 -14.5 -0.8 -15 Z" />
        <path d="M-1.2 -22 Q-0.2 -22.7 1 -22.2 Q-0.1 -21.6 -1.2 -22 Z" />
        <path d="M-0.6 -29 Q0.3 -29.6 1.2 -29.2 Q0.3 -28.6 -0.6 -29 Z" />
      </g>
      {/* branches reaching into the crown */}
      <g stroke="#d9d2be" strokeWidth={0.9} fill="none" strokeLinecap="round">
        <path d={`M${sway - 0.4} -33 C${sway - 4} -37 ${sway - 7} -40 ${sway - 9} -44`} />
        <path d={`M${sway + 0.4} -35 C${sway + 4} -39 ${sway + 6} -42 ${sway + 8} -46`} />
      </g>
      <g filter="url(#sgCanopyTex)">
        <ellipse cx={sway - 7} cy={-43} rx={8} ry={7} fill="url(#sgBirchCanopy)" opacity={0.92} />
        <ellipse cx={sway + 7} cy={-45} rx={8.5} ry={7} fill="url(#sgBirchCanopy)" />
        <ellipse cx={sway} cy={-51} rx={9} ry={7.5} fill="url(#sgBirchCanopy)" />
        <ellipse cx={sway + 4} cy={-55} rx={5} ry={4} fill="#e9f4c4" opacity={0.55} />
        <ellipse cx={sway - 5} cy={-38} rx={5} ry={3.6} fill="#5c8a3c" opacity={0.4} />
      </g>
    </g>
  );
}

function CherryTree({ withPetals }: { withPetals: boolean }) {
  return (
    <g>
      <ellipse cx={-3.5} cy={2} rx={19} ry={4.2} fill="url(#sgShadow)" />
      {/* twisting forked trunk */}
      <path
        d="M-3.2 0 Q-2.2 -2 -1.9 -5 C-1.8 -9 -1.7 -12 -1.7 -14.5 C-1.8 -16.5 -4.6 -19.6 -7.4 -23 L-5.7 -24.5 C-3.5 -22 -1.7 -20 -0.7 -18.4 C-0.5 -21.4 0.3 -24.6 1.5 -27.4 L3.7 -26.6 C2.5 -23.4 2 -20.6 2 -18 C3.2 -19.4 5 -21.2 7.2 -23.2 L8.7 -21.6 C5.7 -18.6 3.6 -16.2 3.2 -14.4 C3.1 -10.4 3.3 -6.4 3.9 -3.2 Q4.3 -1.2 5.2 0 Z"
        fill="url(#sgBarkDark)"
        filter="url(#sgBarkTex)"
      />
      <g filter="url(#sgCanopyTex)">
        <path
          d="M-17 -33 C-22 -38 -18 -46 -11 -46 C-10 -53 -1 -56 5 -52 C11 -56 19 -52 19 -45 C25 -42 24 -34 18 -32 C20 -26 12 -22 7 -25 C2 -20 -8 -21 -11 -26 C-17 -25 -20 -29 -17 -33 Z"
          fill="url(#sgCherryCanopy)"
        />
        <ellipse cx={7} cy={-45} rx={8} ry={5.5} fill="#ffeaf3" opacity={0.65} />
        <ellipse cx={-6} cy={-48} rx={5.5} ry={4} fill="#ffdfec" opacity={0.5} />
        <ellipse cx={-10} cy={-31} rx={7} ry={4.6} fill="#c96d97" opacity={0.5} />
        <ellipse cx={12} cy={-33} rx={4.5} ry={3.2} fill="#c96d97" opacity={0.35} />
      </g>
      {withPetals && (
        <g>
          <circle className="grove-petal p1" cx={-10} cy={-30} r={1.4} fill="#f8c3d8" />
          <circle className="grove-petal p2" cx={6} cy={-34} r={1.2} fill="#fddcea" />
          <circle className="grove-petal p3" cx={0} cy={-26} r={1.3} fill="#f2a9c6" />
        </g>
      )}
    </g>
  );
}

function WillowTree({ rand }: { rand: () => number }) {
  const lean = rand() < 0.5 ? -1 : 1;
  return (
    <g>
      <ellipse cx={-4} cy={2} rx={19} ry={4.2} fill="url(#sgShadow)" />
      <path
        d={`M-3.4 0 C-2.8 -8 ${1.5 * lean} -14 ${2.6 * lean} -22 C${3 * lean} -25 ${3.4 * lean} -28 ${3.8 * lean} -31 L${6.2 * lean} -30.4 C${5.6 * lean} -27 ${5.2 * lean} -23.6 ${4.8 * lean} -20.6 C${3.2 * lean} -13.6 ${1 * lean} -9 3.4 0 Z`}
        fill="url(#sgBark)"
        filter="url(#sgBarkTex)"
      />
      <g filter="url(#sgCanopyTex)">
        <path
          d={`M${-16 + 2 * lean} -34 C${-22 + 2 * lean} -40 ${-15 + 2 * lean} -49 ${-7 + 2 * lean} -47 C${-4 + 2 * lean} -54 ${8 + 2 * lean} -55 ${11 + 2 * lean} -48 C${19 + 2 * lean} -48 ${22 + 2 * lean} -40 ${16 + 2 * lean} -35 C${18 + 2 * lean} -30 ${8 + 2 * lean} -26 ${3 + 2 * lean} -29 C${-4 + 2 * lean} -25 ${-14 + 2 * lean} -28 ${-16 + 2 * lean} -34 Z`}
          fill="url(#sgWillowCanopy)"
        />
        <ellipse cx={7 * lean} cy={-46} rx={7} ry={4.6} fill="#d6e8ae" opacity={0.5} />
        <ellipse cx={-6 * lean} cy={-32} rx={7} ry={4.4} fill="#4a7538" opacity={0.45} />
      </g>
      <g className="grove-willow-strands" strokeLinecap="round" fill="none">
        <g stroke="#6f9c50" strokeWidth={1.3} opacity={0.9}>
          <path d={`M${-13 * lean} -33 C${-15 * lean} -22 ${-14 * lean} -12 ${-13 * lean} -4`} />
          <path d={`M${-5 * lean} -30 C${-6 * lean} -20 ${-5.4 * lean} -10 ${-5 * lean} -2`} />
          <path d={`M${3 * lean} -29 C${2.4 * lean} -19 ${3 * lean} -9 ${3.4 * lean} -1`} />
          <path d={`M${10 * lean} -32 C${11 * lean} -21 ${11.4 * lean} -12 ${12 * lean} -5`} />
          <path d={`M${16 * lean} -36 C${18 * lean} -26 ${18.5 * lean} -17 ${19 * lean} -10`} />
        </g>
        <g stroke="#9cc272" strokeWidth={0.9} opacity={0.8}>
          <path d={`M${-9 * lean} -32 C${-10.5 * lean} -22 ${-10 * lean} -13 ${-9.5 * lean} -6`} />
          <path d={`M${-1 * lean} -30 C${-1.6 * lean} -20 ${-1 * lean} -11 ${-0.6 * lean} -3`} />
          <path d={`M${6.5 * lean} -30 C${6 * lean} -20 ${6.6 * lean} -11 ${7 * lean} -4`} />
          <path d={`M${13 * lean} -34 C${14.4 * lean} -24 ${15 * lean} -15 ${15.5 * lean} -8`} />
        </g>
      </g>
    </g>
  );
}

function TreeBody({ species, rand, mature }: { species: Species; rand: () => number; mature: boolean }) {
  switch (species) {
    case "pine":
      return <PineTree rand={rand} />;
    case "birch":
      return <BirchTree rand={rand} />;
    case "cherry":
      return <CherryTree withPetals={mature} />;
    case "maple":
      return <OakTree rand={rand} warm />;
    case "willow":
      return <WillowTree rand={rand} />;
    default:
      return <OakTree rand={rand} />;
  }
}

const SAPLING_TINTS: Record<Species, [string, string]> = {
  oak: ["url(#sgOakCanopy)", "#2c5c36"],
  pine: ["url(#sgPineCanopy)", "#1f4a33"],
  birch: ["url(#sgBirchCanopy)", "#77a24a"],
  cherry: ["url(#sgCherryCanopy)", "#d97fa6"],
  maple: ["url(#sgMapleCanopy)", "#a85423"],
  willow: ["url(#sgWillowCanopy)", "#5d8a45"],
};

function Tree({
  species,
  age,
  x,
  y,
  baseScale,
  seed,
  delay,
  isNewest,
  isElder,
}: {
  species: Species;
  age: number;
  x: number;
  y: number;
  baseScale: number;
  seed: number;
  delay: number;
  isNewest: boolean;
  isElder: boolean;
}) {
  const rand = mulberry32(seed);
  const [tint, dark] = SAPLING_TINTS[species];
  const stage = age <= 1 ? "sprout" : age <= 3 ? "sapling" : "tree";
  const scale = baseScale * (stage === "tree" ? growthFor(age) : stage === "sapling" ? 1.15 : 1.5);
  return (
    <g className="grove-tree" transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="grove-tree-inner" style={{ animationDelay: `${delay}ms` }}>
        {isElder && <circle cx={0} cy={-38} r={30} fill="url(#sgElderGlow)" />}
        {stage === "sprout" && <Sprout tint={tint} />}
        {stage === "sapling" && <Sapling tint={tint} dark={dark} />}
        {stage === "tree" && (
          <g className="grove-canopy" style={{ animationDelay: `${(seed % 7) * 420}ms` }}>
            <TreeBody species={species} rand={rand} mature={age >= 7} />
          </g>
        )}
        {isNewest && (
          <g aria-hidden="true">
            <circle className="grove-sparkle gs1" cx={-9} cy={-30} r={1.6} />
            <circle className="grove-sparkle gs2" cx={10} cy={-40} r={1.3} />
            <circle className="grove-sparkle gs3" cx={2} cy={-18} r={1.2} />
          </g>
        )}
      </g>
    </g>
  );
}

function Cattails({ x, y, flip }: { x: number; y: number; flip?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})${flip ? " scale(-1 1)" : ""}`}>
      <g stroke="#4c8a4e" strokeWidth={1.4} strokeLinecap="round" fill="none">
        <path d="M0 0 C0.4 -8 0.2 -14 -0.4 -20" />
        <path d="M5 0 C5.6 -7 5.8 -12 6.6 -17" />
        <path d="M-5 0 C-5.4 -6 -5 -11 -4 -15" />
        <path d="M9 0 C9 -5 8.6 -9 8 -12" />
      </g>
      <rect x={-1.6} y={-27} width={2.6} height={8} rx={1.3} fill="#7a4e2a" />
      <rect x={5.4} y={-23} width={2.2} height={6.5} rx={1.1} fill="#8a5a32" />
    </g>
  );
}

function Swan({ x, y, small }: { x: number; y: number; small?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${small ? 0.9 : 1.35})`}>
      <g className="grove-swan">
        <ellipse cx={0} cy={4.5} rx={9} ry={1.6} fill="rgba(30,60,80,0.25)" />
        <path d="M-7 3 Q-8 -2 -3 -2 Q2 -2 3 1 Q6 2 7 3 Q2 6 -3 5.4 Q-6 5 -7 3 Z" fill="#fdfdfa" />
        <path d="M-5 -1 C-7 -7 -4 -11 -1.5 -11 C0.5 -11 1 -9.5 0.6 -8 C0.2 -6.4 -1 -4.5 -0.6 -1.6 Z" fill="#fdfdfa" />
        <circle cx={-1.6} cy={-9.8} r={0.5} fill="#333" />
        <path d="M-1 -10.4 L2 -9.8 L-0.8 -8.8 Z" fill="#e8923e" />
        <path d="M-12 5 Q0 7.5 12 5" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1} />
      </g>
    </g>
  );
}

/** Meadow slots where trees may grow, in planting order (first slot = oldest tree). */
const BANDS = [
  { y: 248, scale: 0.6, count: 12, jx: 13, jy: 6 },
  { y: 292, scale: 0.8, count: 11, jx: 15, jy: 7 },
  { y: 344, scale: 1.0, count: 10, jx: 17, jy: 8 },
  { y: 408, scale: 1.22, count: 9, jx: 18, jy: 7 },
];

type Slot = { x: number; y: number; scale: number; species: Species; seed: number };

function buildSlots(): Slot[] {
  const slots: Slot[] = [];
  let n = 0;
  for (let b = 0; b < BANDS.length; b += 1) {
    const band = BANDS[b]!;
    for (let col = 0; col < band.count; col += 1) {
      const rand = mulberry32(n * 7919 + b * 104729 + 977);
      const x = 24 + ((col + 0.5) / band.count) * 852 + (rand() - 0.5) * band.jx * 2;
      const y = band.y + (rand() - 0.5) * band.jy * 2;
      n += 1;
      if (inLake(x, y + 4, 1.06)) continue;
      slots.push({ x, y, scale: band.scale, species: speciesForSlot(x, y, rand), seed: n * 31 + 11 });
    }
  }
  // Plant outward from a sunny patch on the front-left meadow.
  const focal = { x: 220, y: 398 };
  return slots.sort((a, b) => {
    const da = (a.x - focal.x) ** 2 + ((a.y - focal.y) * 1.6) ** 2;
    const db = (b.x - focal.x) ** 2 + ((b.y - focal.y) * 1.6) ** 2;
    return da - db;
  });
}

const SLOTS = buildSlots();
const MAX_TREES = SLOTS.length;

export function StreakGrove({
  streak,
  bestStreak,
  sentToday,
  level,
  title,
  goalMet,
}: {
  streak: number;
  bestStreak: number;
  sentToday: number;
  level: number;
  title: string;
  goalMet: boolean;
}) {
  const trees = useMemo(() => {
    const count = Math.min(Math.max(0, streak), MAX_TREES);
    const planted = SLOTS.slice(0, count).map((slot, index) => ({
      ...slot,
      key: `tree-${index}`,
      age: streak - index,
      delay: 80 + index * 60,
      isNewest: index === count - 1,
      isElder: index === 0 && streak >= 30,
    }));
    // Back-to-front so closer trees overlap distant ones.
    return planted.sort((a, b) => a.y - b.y || a.x - b.x);
  }, [streak]);

  const flowers = useMemo(() => {
    const rand = mulberry32(90210);
    const colors = ["#e86a8a", "#f2c14e", "#ffffff", "#b784d6", "#f28c5a"];
    return Array.from({ length: 26 }, (_, i) => ({
      key: `fl-${i}`,
      x: 16 + rand() * 460,
      y: 356 + rand() * 84,
      r: 1.3 + rand() * 1.5,
      color: colors[Math.floor(rand() * colors.length)]!,
    })).filter((f) => !inLake(f.x, f.y, 1.08));
  }, []);

  const fireflies = useMemo(() => {
    const rand = mulberry32(777);
    return Array.from({ length: 9 }, (_, i) => ({
      key: `ff-${i}`,
      x: 40 + rand() * 820,
      y: 210 + rand() * 160,
      delay: rand() * 6,
      dur: 4.5 + rand() * 4,
    }));
  }, []);

  const overflow = Math.max(0, streak - MAX_TREES);
  const streakAtRisk = streak > 0 && sentToday === 0;

  return (
    <div
      className={`outreach-village streak-grove${goalMet ? " celebrating" : ""}`}
      aria-label={`Streak grove with ${streak} trees`}
    >
      <div className="village-sky-label">
        <div>
          <p className="eyebrow">Your streak forest</p>
          <h2>Streak Grove</h2>
          <p className="hint">
            One tree for every day in a row you send. Older trees grow taller — skip a day and the grove returns to bare soil.
          </p>
          {streakAtRisk && (
            <p className="grove-warning">
              No sends yet today — send one email to keep {streak === 1 ? "your tree" : `all ${streak} trees`} alive.
            </p>
          )}
        </div>
        <div className="village-character-card">
          <div className={`village-character level-${Math.min(level, 8)}`} aria-hidden="true">
            <span className="village-character-body" />
            <span className="village-character-head" />
            <span className="village-character-hat" />
          </div>
          <div>
            <strong>{title}</strong>
            <span>Level {level}</span>
            <span>
              {streak}-day streak{bestStreak > streak ? ` · best ${bestStreak}` : bestStreak > 1 ? " · personal best" : ""}
            </span>
          </div>
        </div>
      </div>

      <svg className="village-canvas" viewBox="0 0 900 460" role="img">
        <defs>
          {/* ---- Sky & light ---- */}
          <linearGradient id="sgSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#417db8" />
            <stop offset="28%" stopColor="#7db4dd" />
            <stop offset="52%" stopColor="#b9dcec" />
            <stop offset="74%" stopColor="#ecdfc6" />
            <stop offset="100%" stopColor="#f6d69e" />
          </linearGradient>
          <radialGradient id="sgHorizonGlow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="rgba(255,214,150,0.55)" />
            <stop offset="60%" stopColor="rgba(255,214,150,0.18)" />
            <stop offset="100%" stopColor="rgba(255,214,150,0)" />
          </radialGradient>
          <radialGradient id="sgSunGlow">
            <stop offset="0%" stopColor="rgba(255,240,190,0.95)" />
            <stop offset="45%" stopColor="rgba(255,226,150,0.4)" />
            <stop offset="100%" stopColor="rgba(255,226,150,0)" />
          </radialGradient>
          <radialGradient id="sgSunCore">
            <stop offset="0%" stopColor="#fffbe8" />
            <stop offset="62%" stopColor="#ffe9a8" />
            <stop offset="100%" stopColor="#f8cf6f" />
          </radialGradient>
          <linearGradient id="sgCloud" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="72%" stopColor="#f6ecdd" />
            <stop offset="100%" stopColor="#eddac0" />
          </linearGradient>
          <radialGradient id="sgElderGlow">
            <stop offset="0%" stopColor="rgba(255,226,122,0.5)" />
            <stop offset="100%" stopColor="rgba(255,226,122,0)" />
          </radialGradient>
          <radialGradient id="sgShadow">
            <stop offset="0%" stopColor="rgba(28,48,26,0.42)" />
            <stop offset="70%" stopColor="rgba(28,48,26,0.18)" />
            <stop offset="100%" stopColor="rgba(28,48,26,0)" />
          </radialGradient>

          {/* ---- Terrain ---- */}
          <linearGradient id="sgFarPeaks" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bfd2e8" />
            <stop offset="100%" stopColor="#9cb4d3" />
          </linearGradient>
          <linearGradient id="sgMidPeaks" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#93aecd" />
            <stop offset="100%" stopColor="#6f8db2" />
          </linearGradient>
          <linearGradient id="sgSnow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#dce8f4" />
          </linearGradient>
          <linearGradient id="sgFoothills" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#87ad7e" />
            <stop offset="100%" stopColor="#5e8a60" />
          </linearGradient>
          <linearGradient id="sgBackMeadow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9cc878" />
            <stop offset="55%" stopColor="#7fb262" />
            <stop offset="100%" stopColor="#639e50" />
          </linearGradient>
          <linearGradient id="sgFrontMeadow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#83bd63" />
            <stop offset="50%" stopColor="#5fa04c" />
            <stop offset="100%" stopColor="#3f7f3d" />
          </linearGradient>

          {/* ---- Water ---- */}
          <linearGradient id="sgWater" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c2e4ef" />
            <stop offset="34%" stopColor="#8fc5da" />
            <stop offset="70%" stopColor="#5f9dbe" />
            <stop offset="100%" stopColor="#47819e" />
          </linearGradient>
          <linearGradient id="sgWaterSheen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,244,214,0.5)" />
            <stop offset="100%" stopColor="rgba(255,244,214,0)" />
          </linearGradient>

          {/* ---- Bark & canopies (lit from the upper right, matching the sun) ---- */}
          <linearGradient id="sgBark" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#452f1c" />
            <stop offset="48%" stopColor="#6b4a2b" />
            <stop offset="78%" stopColor="#8a6238" />
            <stop offset="100%" stopColor="#a5794b" />
          </linearGradient>
          <linearGradient id="sgBarkDark" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#3a2a1e" />
            <stop offset="55%" stopColor="#5c4128" />
            <stop offset="100%" stopColor="#7d5a36" />
          </linearGradient>
          <linearGradient id="sgBirchBark" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#cdc6b2" />
            <stop offset="35%" stopColor="#efeadb" />
            <stop offset="72%" stopColor="#fdfaf0" />
            <stop offset="100%" stopColor="#d9d2be" />
          </linearGradient>
          <radialGradient id="sgOakCanopy" cx="0.46" cy="0.42" r="0.78" fx="0.64" fy="0.26">
            <stop offset="0%" stopColor="#a8d792" />
            <stop offset="38%" stopColor="#69a967" />
            <stop offset="74%" stopColor="#3f7d47" />
            <stop offset="100%" stopColor="#2c5c36" />
          </radialGradient>
          <radialGradient id="sgOakCanopyB" cx="0.46" cy="0.42" r="0.78" fx="0.64" fy="0.26">
            <stop offset="0%" stopColor="#96cb85" />
            <stop offset="40%" stopColor="#5b9c5c" />
            <stop offset="78%" stopColor="#37703f" />
            <stop offset="100%" stopColor="#27522f" />
          </radialGradient>
          <radialGradient id="sgPineCanopy" cx="0.5" cy="0.35" r="0.85" fx="0.66" fy="0.2">
            <stop offset="0%" stopColor="#6aa375" />
            <stop offset="45%" stopColor="#3d7a52" />
            <stop offset="100%" stopColor="#1f4a33" />
          </radialGradient>
          <radialGradient id="sgBirchCanopy" cx="0.48" cy="0.42" r="0.75" fx="0.64" fy="0.26">
            <stop offset="0%" stopColor="#dcedb0" />
            <stop offset="45%" stopColor="#a9cd74" />
            <stop offset="100%" stopColor="#77a24a" />
          </radialGradient>
          <radialGradient id="sgCherryCanopy" cx="0.48" cy="0.42" r="0.75" fx="0.64" fy="0.26">
            <stop offset="0%" stopColor="#ffe3ef" />
            <stop offset="42%" stopColor="#f6b5cf" />
            <stop offset="100%" stopColor="#d97fa6" />
          </radialGradient>
          <radialGradient id="sgMapleCanopy" cx="0.48" cy="0.42" r="0.78" fx="0.64" fy="0.26">
            <stop offset="0%" stopColor="#f8c987" />
            <stop offset="42%" stopColor="#e08f4a" />
            <stop offset="100%" stopColor="#a85423" />
          </radialGradient>
          <radialGradient id="sgWillowCanopy" cx="0.48" cy="0.4" r="0.8" fx="0.62" fy="0.24">
            <stop offset="0%" stopColor="#c3dd9a" />
            <stop offset="45%" stopColor="#8db566" />
            <stop offset="100%" stopColor="#5d8a45" />
          </radialGradient>

          {/* ---- Filters ---- */}
          <filter id="sgBlur1"><feGaussianBlur stdDeviation="1" /></filter>
          <filter id="sgBlur2"><feGaussianBlur stdDeviation="2.2" /></filter>
          <filter id="sgBlur4"><feGaussianBlur stdDeviation="4" /></filter>

          {/* ---- Photo-texture filters: fractal noise lit as a 3D surface, multiplied into the fill ---- */}
          <filter id="sgRockTex" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035 0.05" numOctaves="5" seed="7" result="n" />
            <feDiffuseLighting in="n" lightingColor="#fff2dc" surfaceScale="3.4" diffuseConstant="1.12" result="l">
              <feDistantLight azimuth="315" elevation="52" />
            </feDiffuseLighting>
            <feComposite in="l" in2="SourceGraphic" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit" />
            <feComposite in="lit" in2="SourceGraphic" operator="in" />
          </filter>
          <filter id="sgGrassTex" x="-3%" y="-6%" width="106%" height="112%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02 0.14" numOctaves="4" seed="21" result="n" />
            <feDiffuseLighting in="n" lightingColor="#fff6de" surfaceScale="2" diffuseConstant="1.1" result="l">
              <feDistantLight azimuth="315" elevation="62" />
            </feDiffuseLighting>
            <feComposite in="l" in2="SourceGraphic" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit" />
            <feComposite in="lit" in2="SourceGraphic" operator="in" />
          </filter>
          <filter id="sgCanopyTex" x="-25%" y="-25%" width="150%" height="150%">
            <feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="3" seed="11" result="edge" />
            <feDisplacementMap in="SourceGraphic" in2="edge" scale="5" result="disp" />
            <feTurbulence type="fractalNoise" baseFrequency="0.16" numOctaves="4" seed="13" result="n" />
            <feDiffuseLighting in="n" lightingColor="#fff4da" surfaceScale="3.2" diffuseConstant="1.12" result="l">
              <feDistantLight azimuth="315" elevation="56" />
            </feDiffuseLighting>
            <feComposite in="l" in2="disp" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit" />
            <feComposite in="lit" in2="disp" operator="in" />
          </filter>
          <filter id="sgBarkTex" x="-30%" y="-15%" width="160%" height="130%">
            <feTurbulence type="fractalNoise" baseFrequency="0.32 0.045" numOctaves="4" seed="5" result="n" />
            <feDiffuseLighting in="n" lightingColor="#ffefd8" surfaceScale="2.2" diffuseConstant="1.15" result="l">
              <feDistantLight azimuth="315" elevation="50" />
            </feDiffuseLighting>
            <feComposite in="l" in2="SourceGraphic" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit" />
            <feComposite in="lit" in2="SourceGraphic" operator="in" />
          </filter>
          <filter id="sgWaterTex" x="-4%" y="-8%" width="108%" height="116%">
            <feTurbulence type="fractalNoise" baseFrequency="0.006 0.05" numOctaves="4" seed="17" result="n" />
            <feDiffuseLighting in="n" lightingColor="#fff8e6" surfaceScale="1.1" diffuseConstant="1.12" result="l">
              <feDistantLight azimuth="315" elevation="64" />
            </feDiffuseLighting>
            <feComposite in="l" in2="SourceGraphic" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit" />
            <feComposite in="lit" in2="SourceGraphic" operator="in" />
          </filter>

          {/* ---- Post-processing ---- */}
          <radialGradient id="sgVignette" cx="0.5" cy="0.42" r="0.75">
            <stop offset="0%" stopColor="rgba(15,22,34,0)" />
            <stop offset="72%" stopColor="rgba(15,22,34,0)" />
            <stop offset="100%" stopColor="rgba(15,22,34,0.3)" />
          </radialGradient>
          <radialGradient id="sgWarmGrade" cx="0.78" cy="0.21" r="1.05">
            <stop offset="0%" stopColor="#ffd98f" />
            <stop offset="45%" stopColor="#f2c98e" />
            <stop offset="100%" stopColor="#5b7fb0" />
          </radialGradient>

          <clipPath id="sgLakeClip">
            <ellipse cx="688" cy="388" rx="218" ry="92" />
          </clipPath>
        </defs>

        {/* Dawn sky */}
        <rect width="900" height="460" fill="url(#sgSky)" />
        <ellipse cx="702" cy="140" rx="420" ry="200" fill="url(#sgHorizonGlow)" />
        <circle cx="702" cy="96" r="150" fill="url(#sgSunGlow)" />
        <g className="village-sun">
          <circle cx="702" cy="96" r="42" fill="url(#sgSunGlow)" />
          <circle cx="702" cy="96" r="25" fill="url(#sgSunCore)" />
        </g>

        <g className="village-cloud" filter="url(#sgBlur1)">
          <path
            d="M92 70 Q98 52 120 52 Q128 36 152 39 Q168 26 190 38 Q212 32 222 48 Q244 50 240 64 Q228 74 196 73 Q150 78 118 74 Q98 76 92 70 Z"
            fill="url(#sgCloud)"
            opacity="0.95"
          />
          <path d="M118 74 Q170 82 228 68 Q214 80 168 81 Q134 80 118 74 Z" fill="#e9d5ba" opacity="0.55" />
        </g>
        <g className="village-cloud village-cloud-b" filter="url(#sgBlur1)" opacity="0.85">
          <path
            d="M424 48 Q432 34 452 36 Q460 24 480 28 Q498 22 508 34 Q522 36 518 46 Q504 54 470 53 Q440 55 424 48 Z"
            fill="url(#sgCloud)"
          />
          <path d="M436 52 Q472 58 514 48 Q500 56 468 56 Q448 56 436 52 Z" fill="#ecd9c0" opacity="0.5" />
        </g>
        <g className="village-cloud village-cloud-c" filter="url(#sgBlur1)" opacity="0.6">
          <path
            d="M798 152 Q806 142 820 144 Q828 136 842 140 Q856 138 860 146 Q866 150 858 156 Q838 160 818 158 Q804 158 798 152 Z"
            fill="url(#sgCloud)"
          />
        </g>

        <g className="village-bird" aria-hidden="true">
          <path d="M0 0 Q4 -4 8 0 Q12 -4 16 0" fill="none" stroke="#41597a" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M24 7 Q27 4 30 7 Q33 4 36 7" fill="none" stroke="#41597a" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M14 -8 Q16.5 -10.5 19 -8 Q21.5 -10.5 24 -8" fill="none" stroke="#41597a" strokeWidth="1" strokeLinecap="round" />
        </g>

        {/* Far range — hazy, faceted, snow-capped */}
        <g>
          <path
            d="M0 176 L70 120 L128 158 L208 92 L286 156 L360 118 L442 168 L520 108 L604 162 L678 128 L756 168 L826 138 L900 170 L900 260 L0 260 Z"
            fill="url(#sgFarPeaks)"
          />
          {/* shaded west faces (sun rises on the right) */}
          <g fill="#8aa3c4" opacity="0.5">
            <path d="M70 120 L32 176 L70 176 Z" />
            <path d="M208 92 L156 168 L208 168 Z" />
            <path d="M360 118 L322 178 L360 178 Z" />
            <path d="M520 108 L470 180 L520 180 Z" />
            <path d="M678 128 L640 186 L678 186 Z" />
            <path d="M826 138 L790 190 L826 190 Z" />
          </g>
          <g fill="url(#sgSnow)">
            <path d="M208 92 L234 114 L224 109 L214 118 L206 108 L196 115 L186 110 Z" />
            <path d="M520 108 L542 128 L532 123 L524 132 L514 122 L506 127 L498 124 Z" />
            <path d="M70 120 L88 136 L79 132 L72 139 L62 130 L54 133 Z" />
            <path d="M826 138 L842 152 L834 148 L827 155 L818 147 L811 150 Z" />
          </g>
          {/* snow in shadow */}
          <g fill="#b8c9df" opacity="0.85">
            <path d="M208 92 L196 115 L206 108 L214 118 L212 104 Z" />
            <path d="M520 108 L506 127 L514 122 L520 128 Z" />
          </g>
        </g>
        <rect y="150" width="900" height="112" fill="url(#sgHorizonGlow)" opacity="0.35" />

        {/* Mid range — rock texture catches the light */}
        <g filter="url(#sgRockTex)">
          <path
            d="M0 208 L92 158 L172 200 L262 150 L352 202 L448 164 L540 206 L636 172 L726 208 L816 180 L900 210 L900 300 L0 300 Z"
            fill="url(#sgMidPeaks)"
          />
          <g fill="#5c7ba2" opacity="0.55">
            <path d="M92 158 L44 208 L92 208 Z" />
            <path d="M262 150 L206 210 L262 210 Z" />
            <path d="M448 164 L400 212 L448 212 Z" />
            <path d="M636 172 L588 214 L636 214 Z" />
            <path d="M816 180 L774 216 L816 216 Z" />
          </g>
          <g fill="url(#sgSnow)" opacity="0.9">
            <path d="M262 150 L282 170 L273 166 L266 174 L256 164 L248 169 L242 165 Z" />
          </g>
          <g stroke="#54739b" strokeWidth="0.8" opacity="0.4" fill="none">
            <path d="M262 150 L252 210" />
            <path d="M448 164 L438 212" />
            <path d="M636 172 L628 212" />
          </g>
        </g>
        <g className="grove-mist" opacity="0.28" filter="url(#sgBlur4)">
          <ellipse cx="200" cy="216" rx="130" ry="9" fill="#ffffff" />
          <ellipse cx="310" cy="222" rx="90" ry="6" fill="#ffffff" />
        </g>
        <g className="grove-mist grove-mist-b" opacity="0.22" filter="url(#sgBlur4)">
          <ellipse cx="620" cy="206" rx="140" ry="8" fill="#ffffff" />
          <ellipse cx="735" cy="212" rx="80" ry="5.5" fill="#ffffff" />
        </g>

        {/* Forested foothills — two depths of conifers, each with a lit face */}
        <path d="M0 244 Q150 210 300 240 T600 234 T900 240 L900 330 L0 330 Z" fill="url(#sgFoothills)" filter="url(#sgGrassTex)" />
        <g opacity="0.55">
          {Array.from({ length: 24 }, (_, i) => {
            const fx = 16 + i * 37 + (i % 3) * 9;
            const fy = 252 + Math.sin(i * 2.3) * 7;
            return <path key={i} d={`M${fx} ${fy} L${fx + 2.8} ${fy - 9} L${fx + 5.6} ${fy} Z`} fill="#3f6847" />;
          })}
        </g>
        <g opacity="0.9">
          {Array.from({ length: 30 }, (_, i) => {
            const fx = 4 + i * 30 + (i % 4) * 5;
            const fy = 240 + Math.sin(i * 1.7) * 6 + (i % 3);
            const h = 12 + (i % 4) * 2.5;
            return (
              <g key={i}>
                <path d={`M${fx} ${fy} L${fx + 3.4} ${fy - h} L${fx + 6.8} ${fy} Z`} fill="#48734e" />
                <path d={`M${fx + 3.4} ${fy - h} L${fx + 6.8} ${fy} L${fx + 3.4} ${fy} Z`} fill="#5d8c62" />
              </g>
            );
          })}
        </g>

        {/* Meadows — turf-textured contours with sunlit rims */}
        <path d="M0 288 Q220 254 450 286 T900 278 L900 460 L0 460 Z" fill="url(#sgBackMeadow)" filter="url(#sgGrassTex)" />
        <path d="M0 292 Q220 258 450 290 T900 282" fill="none" stroke="#c9e3a2" strokeWidth="2" opacity="0.5" />
        <path
          d="M0 322 Q240 296 470 320 T900 312 L900 322 Q640 330 450 326 Q220 320 0 334 Z"
          fill="#57944a"
          opacity="0.3"
        />
        <path d="M0 356 Q240 318 480 352 T900 342 L900 460 L0 460 Z" fill="url(#sgFrontMeadow)" filter="url(#sgGrassTex)" />
        <path d="M0 360 Q240 322 480 356 T900 346" fill="none" stroke="#b8dd8e" strokeWidth="2.4" opacity="0.55" />
        {/* warm light sweeping across the grass from the sun */}
        <g opacity="0.16" fill="#ffe9a8">
          <path d="M900 300 Q600 330 430 400 L560 460 L900 460 Z" />
          <path d="M340 460 Q420 400 560 372 L470 460 Z" />
        </g>

        {/* Lake */}
        <g>
          {/* damp bank ring */}
          <ellipse cx="688" cy="390" rx="223" ry="95" fill="#4f7a45" opacity="0.55" />
          <ellipse cx="688" cy="389" rx="220" ry="93" fill="#8a7a52" opacity="0.35" />
          <ellipse cx="688" cy="388" rx="218" ry="92" fill="url(#sgWater)" filter="url(#sgWaterTex)" />
          <g clipPath="url(#sgLakeClip)">
            {/* sky sheen on the far water */}
            <ellipse cx="688" cy="332" rx="200" ry="34" fill="url(#sgWaterSheen)" opacity="0.6" />
            {/* reflected tree line along the far shore */}
            <g opacity="0.16" fill="#1e4a30" filter="url(#sgBlur2)">
              <ellipse cx="580" cy="322" rx="60" ry="10" />
              <ellipse cx="688" cy="316" rx="70" ry="9" />
              <ellipse cx="790" cy="324" rx="56" ry="9" />
            </g>
            {/* faint reflected mountains */}
            <g opacity="0.12" fill="#3c5d84" filter="url(#sgBlur2)">
              <path d="M600 300 L640 300 L630 352 L610 352 Z" />
              <path d="M720 300 L764 300 L756 344 L728 344 Z" />
            </g>
            {/* sun glitter path down the water */}
            <g className="grove-sun-shimmer" fill="#ffedb8" filter="url(#sgBlur1)">
              <ellipse cx="700" cy="352" rx="30" ry="1.8" opacity="0.3" />
              <ellipse cx="705" cy="361" rx="20" ry="1.6" opacity="0.4" />
              <ellipse cx="697" cy="370" rx="25" ry="1.8" opacity="0.45" />
              <ellipse cx="707" cy="380" rx="15" ry="1.5" opacity="0.5" />
              <ellipse cx="699" cy="389" rx="19" ry="1.6" opacity="0.45" />
              <ellipse cx="705" cy="399" rx="11" ry="1.4" opacity="0.4" />
              <ellipse cx="698" cy="410" rx="14" ry="1.5" opacity="0.32" />
            </g>
            {/* wind-broken water lines */}
            <g stroke="#d9f0f8" strokeWidth="1.1" opacity="0.35" strokeLinecap="round" fill="none">
              <path d="M540 372 Q560 370 588 372" />
              <path d="M760 360 Q784 358 812 360" />
              <path d="M600 430 Q630 427 668 430" />
              <path d="M742 438 Q766 435 798 438" />
              <path d="M520 404 Q540 402 566 404" />
            </g>
          </g>
          <ellipse cx="688" cy="388" rx="218" ry="92" fill="none" stroke="#e6f4fa" strokeWidth="1.6" opacity="0.5" />
          <g className="grove-ripple-set" aria-hidden="true">
            <ellipse className="grove-ripple r1" cx="620" cy="392" rx="16" ry="4" />
            <ellipse className="grove-ripple r2" cx="748" cy="410" rx="14" ry="3.6" />
            <ellipse className="grove-ripple r3" cx="690" cy="428" rx="18" ry="4.2" />
          </g>
          {/* Lily pads */}
          <g>
            <path d="M560 420 a9 4.5 0 1 1 0.1 0 M560 420 l8 -3" fill="#3f8a4c" stroke="#2f6d3c" strokeWidth="0.6" />
            <ellipse cx="558" cy="418.5" rx="4" ry="1.6" fill="#5aa763" opacity="0.7" />
            <circle cx="556" cy="417" r="2.2" fill="#f2a9c6" />
            <circle cx="556" cy="417" r="1" fill="#fddcea" />
            <path d="M806 414 a7.5 3.8 0 1 1 0.1 0" fill="#3f8a4c" stroke="#2f6d3c" strokeWidth="0.6" />
            <path d="M782 428 a6 3 0 1 1 0.1 0 M782 428 l5 -2" fill="#4c9a55" stroke="#2f6d3c" strokeWidth="0.5" />
          </g>
          <Swan x={640} y={398} />
          {streak >= 7 && <Swan x={694} y={416} small />}
          {/* Wooden dock with plank seams, pilings, and a water shadow */}
          <g>
            <ellipse cx="540" cy="392" rx="36" ry="6" fill="#2c5570" opacity="0.35" />
            <rect x={506} y={366} width={66} height={11} rx={2} fill="url(#sgBark)" stroke="#553a20" strokeWidth={0.8} />
            <g stroke="#553a20" strokeWidth={0.6} opacity={0.7}>
              <line x1={515} y1={366} x2={515} y2={377} />
              <line x1={524} y1={366} x2={524} y2={377} />
              <line x1={533} y1={366} x2={533} y2={377} />
              <line x1={542} y1={366} x2={542} y2={377} />
              <line x1={551} y1={366} x2={551} y2={377} />
              <line x1={560} y1={366} x2={560} y2={377} />
            </g>
            <rect x={510} y={377} width={4.5} height={14} fill="#5c4128" />
            <rect x={556} y={377} width={4.5} height={17} fill="#5c4128" />
            <rect x={533} y={377} width={4} height={15} fill="#6b4a2b" />
            <g stroke="#c8e2ee" strokeWidth={0.8} opacity={0.5}>
              <line x1={512} y1={393} x2={517} y2={393} />
              <line x1={558} y1={396} x2={563} y2={396} />
            </g>
          </g>
        </g>

        {/* Shore details */}
        <Cattails x={492} y={434} />
        <Cattails x={880} y={424} flip />
        <g>
          <ellipse cx="512" cy="447" rx="10" ry="4.5" fill="#8e979c" />
          <path d="M502 447 A10 4.5 0 0 1 522 447 A10 4.2 0 0 0 504 444 Z" fill="#b9c1c5" />
          <ellipse cx="527" cy="450" rx="6.5" ry="3.2" fill="#a7afb3" />
          <ellipse cx="525.5" cy="449" rx="4" ry="1.8" fill="#c4ccd0" opacity="0.8" />
          <ellipse cx="500" cy="451" rx="5" ry="2.6" fill="#7f888d" />
        </g>

        {/* The streak grove */}
        {trees.map(({ key, scale, ...tree }) => (
          <Tree key={key} baseScale={scale} {...tree} />
        ))}

        {/* Meadow flowers — petal clusters on stems */}
        {flowers.map((flower) => (
          <g key={flower.key} transform={`translate(${flower.x} ${flower.y})`}>
            <path d="M0 0 q0.4 2.2 0 4" stroke="#3c7d3f" strokeWidth={0.7} fill="none" />
            <g fill={flower.color}>
              <circle cx={-flower.r * 0.9} cy={0} r={flower.r * 0.7} />
              <circle cx={flower.r * 0.9} cy={0} r={flower.r * 0.7} />
              <circle cx={0} cy={-flower.r * 0.9} r={flower.r * 0.7} />
              <circle cx={0} cy={flower.r * 0.9} r={flower.r * 0.7} />
            </g>
            <circle r={flower.r * 0.55} fill="#f9e8a0" />
          </g>
        ))}
        {/* Grass tufts — two-tone blades */}
        {Array.from({ length: 18 }, (_, i) => {
          const gx = 16 + i * 30 + (i % 4) * 9;
          const gy = 386 + ((i * 37) % 66);
          if (inLake(gx, gy, 1.05)) return null;
          return (
            <g key={`tuft-${i}`} strokeLinecap="round" fill="none">
              <path
                d={`M${gx} ${gy} q-2.4 -7 -4.4 -8.4 M${gx} ${gy} q-0.6 -8 0.4 -9.6 M${gx} ${gy} q3 -6.4 5.2 -7.4`}
                stroke="#2f7a3c"
                strokeWidth="1.3"
                opacity="0.75"
              />
              <path d={`M${gx + 1} ${gy} q1.6 -6 3.4 -7 M${gx - 1} ${gy} q-1.4 -6.6 -0.6 -8`} stroke="#6cb35a" strokeWidth="1" opacity="0.8" />
            </g>
          );
        })}

        {/* Foreground grass fringe — slight depth-of-field blur */}
        <g filter="url(#sgBlur1)" opacity="0.92" aria-hidden="true">
          {Array.from({ length: 64 }, (_, i) => {
            const gx = i * 14.3 + ((i * 7) % 11);
            if (inLake(gx, 470, 0.98)) return null;
            const h = 13 + ((i * 13) % 11);
            const lean = ((i * 29) % 11) - 5;
            const col = i % 3 === 0 ? "#2e6f38" : i % 3 === 1 ? "#3f8a44" : "#57a24e";
            return (
              <path
                key={`fg-${i}`}
                d={`M${gx} 464 q${lean * 0.4} ${-h * 0.55} ${lean} ${-h}`}
                stroke={col}
                strokeWidth={2.4}
                strokeLinecap="round"
                fill="none"
              />
            );
          })}
        </g>

        {/* Fireflies drifting over the meadow at all times, denser feel as grove grows */}
        {fireflies.slice(0, Math.max(3, Math.min(9, 3 + streak))).map((fly) => (
          <circle
            key={fly.key}
            className="grove-firefly"
            cx={fly.x}
            cy={fly.y}
            r="1.6"
            style={{ animationDelay: `${fly.delay}s`, animationDuration: `${fly.dur}s` }}
          />
        ))}

        {streak === 0 && (
          <g transform="translate(190 348)">
            <ellipse cx="30" cy="52" rx="16" ry="4.5" fill="#6d4f32" opacity="0.6" />
            <path d="M26 50 Q30 42 34 50 Z" fill="#8a6a42" />
            <line x1="86" y1="66" x2="86" y2="18" stroke="#6a4a2a" strokeWidth="4" />
            <rect x="18" y="0" width="150" height="42" rx="8" fill="#fff8e8" stroke="#8b6914" strokeWidth="1.5" transform="rotate(-2 93 21)" />
            <text x="93" y="17" textAnchor="middle" fill="#6b4e12" fontSize="12.5" fontWeight="700" fontFamily="Georgia, serif" transform="rotate(-2 93 21)">
              Bare soil, big plans
            </text>
            <text x="93" y="33" textAnchor="middle" fill="#8a6a2a" fontSize="10.5" fontFamily="Georgia, serif" transform="rotate(-2 93 21)">
              Send one email today to plant your first tree
            </text>
          </g>
        )}

        {overflow > 0 && (
          <g transform="translate(88 420)">
            <line x1="14" y1="26" x2="14" y2="6" stroke="#6a4a2a" strokeWidth="3" />
            <rect x="-62" y="-16" width="152" height="24" rx="6" fill="#f7ecd2" stroke="#8b6914" strokeWidth="1.2" transform="rotate(-2 14 -4)" />
            <text x="14" y="0" textAnchor="middle" fill="#5c4310" fontSize="11" fontWeight="600" fontFamily="Georgia, serif" transform="rotate(-2 14 -4)">
              +{overflow} trees deeper in the forest
            </text>
          </g>
        )}

        {/* Celebration bunting when today's goal is met */}
        <g className="village-bunting" aria-hidden="true">
          <path d="M0 12 Q225 44 450 22 T900 18" fill="none" stroke="#8a5f3a" strokeWidth="1.6" />
          {Array.from({ length: 16 }, (_, i) => {
            const t = i / 15;
            const bx = t * 900;
            const by = 12 + Math.sin(t * Math.PI) * 22 + Math.sin(t * 6) * 3;
            const colors = ["#e8564a", "#f2c14e", "#4a9455", "#3d7ab5", "#c084d8"];
            return <path key={i} d={`M${bx - 7} ${by} L${bx + 7} ${by} L${bx} ${by + 13} Z`} fill={colors[i % colors.length]} />;
          })}
        </g>

        {/* --- Post: god rays, valley mist, warm grade, vignette --- */}
        <g aria-hidden="true" pointerEvents="none">
          <g style={{ mixBlendMode: "screen" }} opacity="0.5" filter="url(#sgBlur4)">
            <path d="M702 96 L560 460 L646 460 Z" fill="rgba(255,232,170,0.16)" />
            <path d="M702 96 L748 460 L836 460 Z" fill="rgba(255,232,170,0.13)" />
            <path d="M702 96 L352 428 L436 460 Z" fill="rgba(255,232,170,0.09)" />
            <path d="M702 96 L878 372 L900 448 Z" fill="rgba(255,232,170,0.11)" />
          </g>
          <g className="grove-mist" style={{ mixBlendMode: "screen" }} opacity="0.14" filter="url(#sgBlur4)">
            <ellipse cx="260" cy="345" rx="240" ry="12" fill="#fdf3dc" />
            <ellipse cx="640" cy="330" rx="200" ry="9" fill="#fdf3dc" />
          </g>
          <rect width="900" height="460" fill="url(#sgWarmGrade)" style={{ mixBlendMode: "soft-light" }} opacity="0.6" />
          <rect width="900" height="460" fill="url(#sgVignette)" />
        </g>
      </svg>
    </div>
  );
}
