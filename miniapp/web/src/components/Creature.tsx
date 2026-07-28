/**
 * The coloured blob that identifies a subagent.
 *
 * This is the one place Aside uses colour in the thread, and it is doing
 * real work: with two or three subagents running at once, the hue is how
 * you tell which nested card belongs to which spawn row at a glance. So it
 * is deliberately NOT monochrome like the rest of the icon set.
 *
 * The slot comes from the server, which hands them out in spawn order
 * (`SUBAGENT_PALETTE_SIZE` in `thread.ts`). That is deliberately not a hash
 * of the spawn id, which is what this used to be: a hash over eight hues
 * gives two of five siblings the same colour about 60% of the time, and a
 * colour two cards share is worse than no colour at all. Spawn order is
 * derived from the transcript, so it is as stable across reloads as a hash
 * was -- and unique until the palette actually runs out.
 */

/**
 * Evenly spaced around the wheel rather than hand-picked.
 *
 * A first cut used pleasant-sounding hues that happened to include both 180
 * and 210; two sibling subagents landed on them and both read as "the cyan
 * one". At 45 degrees apart no two entries can be confused at 16px.
 */
export const HUES = [30, 75, 120, 165, 210, 255, 300, 345];

/** Degrees on the wheel for a palette slot. Wraps, so any integer works. */
export function creatureHue(slot: number | undefined): number {
  const index = Number.isFinite(slot) ? Math.trunc(slot as number) : 0;
  return HUES[((index % HUES.length) + HUES.length) % HUES.length];
}

export function Creature({ slot, size = 16 }: { slot: number | undefined; size?: number }) {
  const hue = creatureHue(slot);
  const body = `oklch(72% 0.17 ${hue})`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
      className="creature"
    >
      {/* A rounded body with a flat-ish top, and two eyes -- enough to read
          as a small creature at 16px without any detail that would mush. */}
      <path
        d="M8 1.6c3.1 0 5.4 2.2 5.4 5.2v6.1c0 .9-.9 1.4-1.6.9l-1-.7-1.2.8a1.1 1.1 0 0 1-1.2 0L8 13.2l-1.4.7a1.1 1.1 0 0 1-1.2 0l-1.2-.8-1 .7c-.7.5-1.6 0-1.6-.9V6.8c0-3 2.3-5.2 5.4-5.2Z"
        fill={body}
      />
      <circle cx="5.9" cy="6.6" r="1.15" fill="#fff" />
      <circle cx="10.1" cy="6.6" r="1.15" fill="#fff" />
    </svg>
  );
}
