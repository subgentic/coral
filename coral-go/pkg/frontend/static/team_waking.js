/* A team that was just woken (#10052): until its agents report in, the team page's status says how many have, not only "waiting for first signal". The page asks wakingSince(team); it is 0 when the team was not woken
 * here, or when two minutes have passed (an agent that never reports is the "needs attention" story, not a progress line for ever). */
const WAKING_MAX_MS = 120000;
const since = new Map();

/** The team's Wake just went through (or its Sleep: the progress is over). The team page reads its availability again at once and says so, not at the next poll (#10359). */
export function noteTeamSleep(team, sleeping) {
    if (sleeping) since.delete(team); else since.set(team, Date.now());
    document.dispatchEvent(new CustomEvent('coral:team-sleep-changed', { detail: { team } }));
}

/** When the team was woken from here and is still within the progress window, else 0. */
export function wakingSince(team) {
    const t = since.get(team) || 0;
    if (t && Date.now() - t > WAKING_MAX_MS) { since.delete(team); return 0; }
    return t;
}

/** Every agent has reported, or the person left: the progress line is done. */
export function stopWaking(team) { since.delete(team); }
