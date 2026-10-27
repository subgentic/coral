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
