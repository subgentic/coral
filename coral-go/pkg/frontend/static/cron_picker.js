/* The schedule pickers' two halves (Automations #4): `composeCron` turns a picker's state (every N minutes or hours, daily at a time, weekly on days at a time) into the cron expression the server takes, `parseCron` reads
 * one back into a picker's state (null: only the Advanced cron box can say it). Pure, so a test round-trips them. */
export const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]; // the week as a person reads it; the number is cron's day of week
const pad2 = n => String(n).padStart(2, '0');
const clampN = (n, hi) => Math.min(hi, Math.max(1, Math.round(Number(n)) || 1));
export function composeCron(st) {
    const [h, m] = String(st.at || '09:00').split(':').map(Number);
    const at = Number.isInteger(h) && Number.isInteger(m) ? `${m} ${h}` : '0 9';
    if (st.mode === 'minutes') { const n = clampN(st.n, 59); return n === 1 ? '* * * * *' : `*/${n} * * * *`; }
    if (st.mode === 'hours') { const n = clampN(st.n, 23); return n === 1 ? '0 * * * *' : `0 */${n} * * *`; }
    if (st.mode === 'daily') return `${at} * * *`;
    if (st.mode === 'weekly') { const d = DAYS.map(([n]) => n).filter(n => st.days && st.days.has(n)).sort((a, b) => a - b); return d.length ? `${at} * * ${d.join(',')}` : ''; }
    return st.cron || '';
}
export function parseCron(expr) {
    const e = String(expr || '').trim();
    let m;
    if (e === '* * * * *') return { mode: 'minutes', n: 1 };
    if ((m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(e)) && +m[1] >= 2 && +m[1] <= 59) return { mode: 'minutes', n: +m[1] };
    if (e === '0 * * * *') return { mode: 'hours', n: 1 };
    if ((m = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(e)) && +m[1] >= 2 && +m[1] <= 23) return { mode: 'hours', n: +m[1] };
    if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(e)) && +m[1] < 60 && +m[2] < 24) return { mode: 'daily', at: `${pad2(m[2])}:${pad2(m[1])}` };
    if ((m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*|[0-7]-[0-7])$/.exec(e)) && +m[1] < 60 && +m[2] < 24) {
        const days = new Set();
        const r = /^([0-7])-([0-7])$/.exec(m[3]);
        if (r) { if (+r[1] > +r[2]) return null; for (let d = +r[1]; d <= +r[2]; d++) days.add(d % 7); } else for (const d of m[3].split(',')) days.add(+d % 7);
        return { mode: 'weekly', at: `${pad2(m[2])}:${pad2(m[1])}`, days };
    }
    return null;
}

