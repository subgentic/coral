/* Small formatters shared by several views (#3794). Each was copied into the modules that needed it; these are the copies that
 * were character for character the same. Pure functions: no DOM, no state. */

/** A count as a person reads it: 1234 -> "1.2K", 2500000 -> "2.5M", 15491800000 -> "15.5B", then T; below 1000 the number as text. A figure that rounds up to the next unit moves
 *  into it (999,950 is "1.0M", not "1000.0K"). kilo is the thousands' letter (the task rows write a lower-case k). */
export function compactCount(n, kilo = 'K') {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    const a = Math.abs(v), sign = v < 0 ? '-' : '';
    if (a >= 999.95e9) return sign + (a / 1e12).toFixed(1) + 'T';
    if (a >= 999.95e6) return sign + (a / 1e9).toFixed(1) + 'B';
    if (a >= 999950) return sign + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1000) return sign + (a / 1e3).toFixed(1) + kilo;
    const r = a >= 100 ? Math.round(v) : Math.round(v * 10) / 10; // a count is whole; a figure that is not (an average, a share of a day) has at most one decimal
    return Math.abs(r) >= 1000 ? sign + (Math.abs(r) / 1e3).toFixed(1) + kilo : String(r);
}

/** Tokens: compactCount. */
export function formatTokens(n) { return compactCount(n); }

/** The one figure format of the Analytics pages (UI/UX, #9516): K, M, B and T with no space, one decimal at most and no trailing zero (517K, 1.2M, 999.4K, 1M); below 1,000 the plain number (a figure that is not whole, an
 *  average, has at most one decimal). Tokens, calls and requests alike, in the cards, the tables, the series axes and Tokens per commit and Task time. */
export function compactFigure(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    const a = Math.abs(v), sign = v < 0 ? '-' : '';
    const tenths = x => Math.round(Number(x.toFixed(6))); // halves up: 1.15 is a tie for 1.2, whatever the float 1.1499999999999999 says (#9540)
    const unit = (div, u) => { const t = tenths(a / (div / 10)); const s = (t / 10).toFixed(1); return sign + (s.endsWith('.0') ? s.slice(0, -2) : s) + u; };
    if (a >= 999.95e9) return unit(1e12, 'T');
    if (a >= 999.95e6) return unit(1e9, 'B');
    if (a >= 999950) return unit(1e6, 'M');
    if (a >= 1000) return unit(1e3, 'K');
    const r = a >= 100 ? Math.round(v) : tenths(Math.abs(v) * 10) / 10 * (v < 0 ? -1 : 1); // a count is whole; a figure that is not (an average) has at most one decimal
    return Math.abs(r) >= 1000 ? unit(1e3, 'K') : String(r);
}

/** The one duration format of the Analytics pages (UI/UX, #9540): 38 s, 2 min, 1 h 02 min: two parts at most, the minutes zero-padded only after an hour. Seconds in; '' for a figure that is not a number. */
export function compactDuration(seconds) {
    const v = Number(seconds);
    if (!Number.isFinite(v)) return '';
    const s = Math.round(Math.max(v, 0));
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** An ISO timestamp as the local clock time (hh:mm:ss), or '' for none or a bad one. */
export function formatClockTime(isoStr) {
    if (!isoStr) return '';
    try {
        const d = new Date(isoStr);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
        return '';
    }
}

// Date and time formatters (#3866). Date.prototype.toLocale*String builds a new Intl formatter on every call, which was the top
// idle cost in the dashboard profile (the task list and the board panel format a time per row on every redraw). These keep one
// Intl.DateTimeFormat per format and use it. Like toLocale*String they answer "Invalid Date" for a bad date rather than throwing.
const _formatters = {};
const _dtf = (key, opts) => _formatters[key] || (_formatters[key] = new Intl.DateTimeFormat(undefined, opts));
const _fmt = (key, opts, d) => (isNaN(d) ? 'Invalid Date' : _dtf(key, opts).format(d));

/** A Date as the local hour and minute (hh:mm). */
export function formatHourMinute(d) { return _fmt('hm', { hour: '2-digit', minute: '2-digit' }, d); }

/** A Date as the locale's month, day, hour and minute (the task detail's dates). */
export function formatMonthDayTime(d) { return _fmt('mdt', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, d); }

/** A duration as text. The views write it four ways (#4638), kept as options so every one prints exactly what it did:
 *   shape 'clock' (default): "45s", "1m 5s", "1h 2m"; whole seconds come from the value by `whole` ('floor' or 'round') after `unit` ('ms' or 's');
 *       dropZeroSeconds writes "2m" for a whole number of minutes. `unit: 's'` takes the seconds as they are (no rounding).
 *   shape 'precise' (events): "850ms", "9.1s", "1m 15s", "1h 2m"; '' for a value that is not a number or is below zero. Takes milliseconds.
 *   shape 'rounded' (execution time): "45s", "12m", "1h", "69h 59m"; the minutes are rounded on the total so they carry into the hour; '' for none, zero or below. Takes seconds. */
export function formatDuration(value, { unit = 'ms', shape = 'clock', whole = 'floor', dropZeroSeconds = false } = {}) {
    if (shape === 'precise') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return '';
        if (n < 1000) return `${Math.round(n)}ms`;
        if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
        const totalSec = Math.round(n / 1000);
        if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
        return `${Math.floor(totalSec / 3600)}h ${Math.floor((totalSec % 3600) / 60)}m`;
    }
    if (shape === 'rounded') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '';
        if (n < 60) return `${Math.floor(n)}s`;
        const mins = Math.round(n / 60);
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const sec = unit === 'ms' ? Math[whole](value / 1000) : value;
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return dropZeroSeconds && s === 0 ? `${m}m` : `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

/** A cost in dollars as text, in the three ways the views write it (#4638):
 *   default: "$12.35", and four decimals below a cent ("$0.0042"; zero is "$0.0000");
 *   zeroAsTwo: zero is "$0.00";  nullAsZero: none is "$0.00" (else it is an error, as before);
 *   subCent 'lt': below a cent (above zero) is "<$0.01";  precise: up to four decimals with up to two trailing zeros trimmed ("$1.5", "$0.0042"). */
export function formatCost(c, { zeroAsTwo = false, nullAsZero = false, subCent = 'four', precise = false } = {}) {
    if (nullAsZero && c == null) return '$0.00';
    if (zeroAsTwo && c === 0) return '$0.00';
    if (precise) return '$' + c.toFixed(4).replace(/0{1,2}$/, '');
    if (subCent === 'lt') return c > 0 && c < 0.01 ? '<$0.01' : '$' + c.toFixed(2);
    return c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(2);
}

/** A count and its singular/plural word; localized counts retain the settings view's numeric coercion. */
export function plural(n, one, many = one + 's', { localized = false } = {}) {
    const count = localized ? Number(n) : n;
    return `${localized ? count.toLocaleString() : count} ${count === 1 ? one : many}`;
}
