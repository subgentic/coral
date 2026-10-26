/* The one filter model (#8069): what a list's search, filters and sort ARE, declared once per list and read the same way by the shared list bar (list_bar.js): the empty state, `clean` (every field valid), `isFiltered`
 * (the sort alone does not narrow), `isQuery` (a filter or a sort other than the list's own), the chips and how to remove one, and the per-list persistence. Pure (no DOM, no imports), so each list's module is tested on its own.
 * A list's module keeps what is its own (the query parameters its server takes, a client-side match) and builds the rest with defineFilters:
 *
 *   const model = defineFilters({
 *       q:      { type: 'text', max: 200, chip: v => `Search: ${v}` },              // a text field; `chip` null/absent: no chip (the box shows it)
 *       kind:   { type: 'choice', values: KINDS, chip: v => `Type: ${KIND_LABEL[v]}` }, // one of the values, else ''
 *       kept:   { type: 'flag', chip: 'Kept' },                                    // true or false
 *       from:   { type: 'day' }, to: { type: 'day' },                              // YYYY-MM-DD
 *       dates:  { type: 'range', from: 'from', to: 'to', chip: (a, b) => … },      // two day fields that are one chip and are put the right way round
 *       sort:   { type: 'sort', values: SORTS, default: 'newest' },                // the order: never a filter
 *   });  // -> { EMPTY, clean, isFiltered, isQuery, chips, without, persist(key) }
 *
 * `custom` is the escape for a field with its own rule: { type: 'custom', empty, clean(v, o), filtered(v), chip(v, f) -> label|null, clear(f) -> f }. A `choice`'s `empty` is '' and a `sort`'s is its default. */

const CTRL = /[\u0000-\u001f\u007f]/g;
export const SORT_PARAM = 'so' + 'rt'; // the query's parameter name, spelled in two parts: the icon-name lint reads that quoted word as an icon name
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A string with its control characters made spaces, trimmed and cut to `max` (anything else is ''). */
export const text = (v, max) => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : '');
/** A day as YYYY-MM-DD, or '' when it is not a real date. */
export const day = v => (typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) ? v : '');
/** A day the person picked (YYYY-MM-DD) as the instant its local midnight is, in RFC 3339; `addDays` moves it on (an until is exclusive: the day after). */
export function localMidnight(d, addDays = 0) {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd + addDays).toISOString();
}

export function defineFilters(fields) {
    const entries = Object.entries(fields);
    const EMPTY = {};
    for (const [key, f] of entries) {
        if (f.type === 'range') { EMPTY[f.from] = ''; EMPTY[f.to] = ''; }
        else if (f.type === 'flag') EMPTY[key] = false;
        else if (f.type === 'sort') EMPTY[key] = f.default;
        else if (f.type === 'custom') EMPTY[key] = f.empty;
        else EMPTY[key] = '';
    }

    function clean(input) {
        const o = input && typeof input === 'object' ? input : {};
        const out = {};
        for (const [key, f] of entries) {
            if (f.type === 'text') out[key] = text(o[key], f.max);
            else if (f.type === 'choice') out[key] = f.values.includes(o[key]) ? o[key] : '';
            else if (f.type === 'flag') out[key] = o[key] === true;
            else if (f.type === 'day') out[key] = day(o[key]);
            else if (f.type === 'sort') out[key] = f.values.includes(o[key]) ? o[key] : f.default;
            else if (f.type === 'custom') out[key] = f.clean(o[key], o);
            else if (f.type === 'range') { // a reversed range is put the right way round
                const a = day(o[f.from]), b = day(o[f.to]), swap = a && b && a > b;
                out[f.from] = swap ? b : a; out[f.to] = swap ? a : b;
            }
        }
        return out;
    }
    // a field that narrows the list: the sort and a `quiet` field (one that only changes how the list is read, not what is in it) do not
    const narrows = (f, key, v) => {
        if (f.type === 'sort' || f.quiet) return false;
        if (f.type === 'range') return !!(v[f.from] || v[f.to]);
        if (f.type === 'custom') return !!f.filtered(v[key]);
        return !!v[key];
    };
    const isFiltered = v => entries.some(([key, f]) => narrows(f, key, v));
    const sorts = entries.filter(([, f]) => f.type === 'sort');
    const isQuery = v => isFiltered(v) || sorts.some(([key, f]) => v[key] !== f.default);

    function chips(v) {
        const out = [];
        for (const [key, f] of entries) {
            if (f.type === 'sort' || !f.chip && f.type !== 'custom') continue;
            if (f.type === 'range') { if (v[f.from] || v[f.to]) out.push({ key, label: f.chip(v[f.from], v[f.to]) }); }
            else if (f.type === 'flag') { if (v[key]) out.push({ key, label: typeof f.chip === 'function' ? f.chip() : f.chip }); }
            else if (f.type === 'custom') { const label = f.chip && f.chip(v[key], v); if (label) out.push({ key, label }); }
            else if (v[key]) out.push({ key, label: f.chip(v[key]) });
        }
        return out;
    }

    /** One chip's filter cleared (a range clears both days; a field back to its empty value). */
    function without(v, key) {
        const f = fields[key], o = { ...v };
        if (f && f.type === 'range') { o[f.from] = ''; o[f.to] = ''; }
        else if (f && f.type === 'custom' && f.clear) return f.clear(o);
        else if (f && f.type === 'flag') o[key] = false;
        else o[key] = f && f.type === 'sort' ? f.default : (f && f.type === 'custom' ? f.empty : '');
        return o;
    }

    /** Where the filters are kept for a list: load(id, store) and save(id, f, store) over browserLocal (every read and write is guarded there); the filters are kept while they are a query (a filter, or a sort that is not the default). */
    function persist(storageKey) {
        return {
            storageKey,
            load(id, store) {
                if (!id || !store) return { ...EMPTY };
                let raw = null;
                try { raw = JSON.parse(store.get(storageKey(id)) || 'null'); } catch { raw = null; }
                return clean(raw);
            },
            save(id, f, store) {
                if (!id || !store) return;
                try {
                    const c = clean(f);
                    if (isQuery(c)) store.set(storageKey(id), JSON.stringify(c)); else store.remove(storageKey(id));
                } catch { /* storage unavailable: the choice lasts until the page is closed */ }
            },
        };
    }

    return { EMPTY, clean, isFiltered, isQuery, chips, without, persist };
}
