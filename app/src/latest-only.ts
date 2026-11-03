/**
 * The newest of several overlapping requests wins (STC-489).
 *
 * `begin()` starts a request and returns its `isCurrent` test, true only while
 * no later request has begun. The library window rescans on several events
 * (`library:changed`, `still:captured`, a chip, an action), so two scans can
 * be in flight at once, and main answers each when ITS scan finishes, not in
 * the order they were asked. An older scan drawn last put back the list from
 * before the newest capture, which then stayed hidden until something
 * rescanned again: "slow to show" in the ticket's words.
 *
 * Pure, no DOM, so the rule is a unit test rather than a timing coincidence.
 */
export function latestOnly(): () => () => boolean {
  let newest = 0;
  return () => {
    const mine = ++newest;
    return () => mine === newest;
  };
}
