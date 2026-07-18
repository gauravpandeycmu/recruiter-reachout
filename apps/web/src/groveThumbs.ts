/** Static field-guide thumbs — baked PNGs in /public/grove-thumbs/. */

/** Bump when species meshes / thumb lighting / start pose change, then re-run bake. */
export const GROVE_THUMB_VERSION = "start0";

export function groveThumbUrl(speciesId: string): string {
  return `/grove-thumbs/${speciesId}.png?v=${GROVE_THUMB_VERSION}`;
}
