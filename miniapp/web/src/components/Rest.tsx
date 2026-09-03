/**
 * The home screen's resting state.
 *
 * Aside's own empty state is the logo and nothing else -- no greeting, no
 * orange mark. The screen stays quiet on purpose: the composer is the
 * content, the history lives one swipe below.
 */
import { AsideLogo } from './AsideLogo';
import { ChevronDown } from './Icons';

/**
 * The centred logo. aria-hidden: it is decoration on an empty screen, the
 * composer's placeholder does the announcing.
 */
export function RestHero() {
  return (
    <div className="rest-hero">
      <AsideLogo />
    </div>
  );
}

/**
 * The affordance that says there is something below the composer.
 *
 * Without it the history is genuinely undiscoverable -- a screen that ends
 * in a composer gives no reason to think anything is under it. It is a
 * button as well as a hint so the gesture is not the only way down.
 */
export function RestCue({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  if (!count) return null;
  return (
    <button type="button" className="rest-cue" onClick={onOpen}>
      <span className="rest-cue-label">Recents</span>
      <ChevronDown size={14} strokeWidth={2} />
    </button>
  );
}
