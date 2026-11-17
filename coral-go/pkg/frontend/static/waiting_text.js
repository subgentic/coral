/* How long an agent has waited for input, for a Needs you row (#7004, from the live row's waiting_since, #6981): "waiting 4 min", "waiting 2 h 05 min", "waiting 3 d 4 h" (the app's one duration format, format.js). Text, never a hover title.
 * '' when the start is unknown (null: nothing is said, no guess) or not a date. A start in the future (a clock a little behind the server's) reads as just begun. */
import { compactDuration } from './format.js';

export function waitingText(since, now = Date.now()) {
    if (!since) return '';
    const t = new Date(since).getTime();
    if (isNaN(t)) return '';
    const mins = Math.max(0, Math.floor((now - t) / 60000));
    if (mins < 1) return 'waiting under 1 min';
    return `waiting ${compactDuration(mins * 60, { days: true })}`;
}

/** The short form for a Needs you row (#17451, N7; guidelines 4.14 rule 7): "<1 min", "12 min", "2 h", "3 d", no word "waiting" (the cell says it to a screen reader). '' when unknown. */
export function shortWait(since, now = Date.now()) {
    const t = since ? new Date(since).getTime() : NaN;
    if (isNaN(t)) return '';
    const m = Math.max(0, Math.floor((now - t) / 60000));
    return m < 1 ? '<1 min' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}
/** Past the limit (a day, the age pill's old red, #16576) a wait takes the amber triangle: colour alone never marks it. */
export const WAIT_LIMIT_MS = 864e5;
