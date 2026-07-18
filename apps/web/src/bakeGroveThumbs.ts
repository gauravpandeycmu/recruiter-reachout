/**
 * Dev-only entry: render every species thumb to a data URL for the bake script.
 * Open via Vite at /bake-thumbs.html — not linked from the app.
 */
import { SPECIES_POOL } from "./grovePlanting";
import { renderSpeciesThumbnail } from "./StreakGrove3D";

const thumbs: Record<string, string> = {};
for (const id of SPECIES_POOL) {
  const url = renderSpeciesThumbnail(id);
  if (url) thumbs[id] = url;
}

(window as unknown as { __GROVE_THUMBS__: Record<string, string> }).__GROVE_THUMBS__ = thumbs;
document.title = `baked:${Object.keys(thumbs).length}`;
document.body.textContent = `Baked ${Object.keys(thumbs).length} / ${SPECIES_POOL.length} thumbs.`;
