/* A reminder's Custom (cron) line (#21330), checked in the dialog the way the server checks it (store.CronLine, which has the last word): five fields, minute hour day month weekday, and in them only numbers, ranges, lists and steps; no @reboot, no seconds, no names;
 * and never more often than every 5 minutes. Pure functions (node-tested). nextRun says when it next fires in the person's own time zone. */
export const MIN_GAP_MINUTES = 5;
const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]; // minute, hour, day of month, month, weekday (Sunday is 0; the scheduler takes no 7)
const FIELD_NAMES = ['minute', 'hour', 'day of the month', 'month', 'weekday'];

/** One field as the set of values it names, or { error }. A part is a star, a star with a step, a, a-b, a-b with a step, or a with a step (a to the top, every n). */
function expand(text, [lo, hi], name) {
    const set = new Set();
    for (const part of text.split(',')) {
        const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
        if (!m || (m[1] === '*' && m[2] !== undefined)) return { error: `"${text}" is not a ${name} (use numbers, *, ranges like 1-5, lists like 1,3 and steps like */10)` };
        let a = m[1] === '*' ? lo : +m[1], b = m[2] !== undefined ? +m[2] : (m[1] === '*' || m[3] !== undefined ? hi : a);
        const step = m[3] === undefined ? 1 : +m[3];
        if (step < 1) return { error: `a step in the ${name} must be 1 or more` };
        if (a < lo || a > hi || b < lo || b > hi) return { error: `the ${name} runs from ${lo} to ${hi}` };
        if (b < a) return { error: `"${part}" counts backwards in the ${name}` };
        for (let v = a; v <= b; v += step) set.add(v);
    }
    return { set, star: text[0] === '*' };
}

/** The first firings from a start, as [y, m(1-12), d, h, mi] in wall-clock fields (no zone), `count` of them at most, stopping after `years` years. The day of the month and the weekday both restricted: either one (cron's rule). */
function* firings(sets, start, years) {
    const [min, hour, dom, mon, dow] = sets;
    const end = Date.UTC(start.getUTCFullYear() + years, 0, 1);
    for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t < end; t += 86400000) {
        const d = new Date(t), mo = d.getUTCMonth() + 1, day = d.getUTCDate(), wd = d.getUTCDay();
        if (!mon.set.has(mo)) continue;
        const byDay = dom.set.has(day), byWeek = dow.set.has(wd);
        if (!((dom.star || dow.star) ? byDay && byWeek : byDay || byWeek)) continue;
        for (const h of [...hour.set].sort((x, y) => x - y)) for (const mi of [...min.set].sort((x, y) => x - y)) yield [d.getUTCFullYear(), mo, day, h, mi];
    }
}

/** { ok: true, line } with the line as it will be stored (one space between the fields), or { ok: false, error } in one line a person can read. */
export function checkCron(input) {
    const fields = String(input || '').trim().split(/\s+/).filter(Boolean);
    if (!fields.length) return { ok: false, error: 'Write a cron line: minute hour day month weekday.' };
    if (fields[0][0] === '@') return { ok: false, error: 'Use five fields (minute hour day month weekday); @words like @reboot are not taken.' };
    if (fields.length !== 5) return { ok: false, error: `A cron line has exactly 5 fields (minute hour day month weekday); this has ${fields.length}.` };
    if (fields.join(' ').length > 100) return { ok: false, error: 'That cron line is too long.' };
    const sets = [];
    for (let i = 0; i < 5; i++) {
        if (/[^0-9*,/-]/.test(fields[i])) return { ok: false, error: `"${fields[i]}": only numbers, *, ranges (1-5), lists (1,3) and steps (*/10) are taken, no names or other signs.` };
        const r = expand(fields[i], LIMITS[i], FIELD_NAMES[i]);
        if (r.error) return { ok: false, error: r.error[0].toUpperCase() + r.error.slice(1) + '.' };
        sets.push(r);
    }
    let prev = null, least = 0, n = 0;
    for (const f of firings(sets, new Date(Date.UTC(2024, 0, 1)), 8)) {
        const t = Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4]);
        if (prev !== null && (least === 0 || t - prev < least)) least = t - prev;
        prev = t;
        if (++n >= 2000) break;
    }
    if (least && least < MIN_GAP_MINUTES * 60000) {
        const mins = Math.round(least / 60000);
        return { ok: false, error: `Two firings can be ${mins} minute${mins === 1 ? '' : 's'} apart; a reminder can repeat at most every ${MIN_GAP_MINUTES} minutes.` };
    }
    return { ok: true, line: fields.join(' '), sets };
}

/** The next time a checked line fires after `from`, as a Date in the person's own zone; null when none in the next 4 years. */
export function nextRun(line, from = new Date()) {
    const c = checkCron(line);
    if (!c.ok) return null;
    const start = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate() - 1)); // a day early: walk the wall-clock days, the first whose time is after `from`
    for (const [y, mo, d, h, mi] of firings(c.sets, start, 5)) {
        const t = new Date(y, mo - 1, d, h, mi);
        if (t.getTime() > from.getTime()) return t;
    }
    return null;
}
