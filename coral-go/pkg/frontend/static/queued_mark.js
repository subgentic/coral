/* Which messages say Queued while a team is paused (#15378). Both times are parsed, never compared as text: the server writes RFC 3339 UTC today, but a message from another Coral or an older row may be
 * "2026-11-10 20:43:00" (a space, no zone: UTC) or carry an offset or fractions, and as text "2026-11-10 20:43:00" is below "2026-11-10T20:43:00Z" for the whole day. A time that does not parse is never queued. */
export function timeMs(s) {
    if (typeof s !== 'string' || !s) return NaN;
    return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}
export function isQueued(createdAt, since) {
    const a = timeMs(createdAt), b = timeMs(since);
    return !Number.isNaN(a) && !Number.isNaN(b) && a >= b;
}
