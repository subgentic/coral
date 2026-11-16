// A theme's accent moves its dim and rgb (#17345, walk 65 F1): lazy, loaded only for a theme that sets --accent.
/** A theme that sets its accent colour moves every use of it (#17345, walk 65 F1): switches, primary buttons and progress bars read --accent-dim, and rgba() uses read --accent-rgb, so each is derived from the accent unless the theme sets its own. */
export function withAccent(vars) {
    const a = vars && typeof vars['--accent'] === 'string' ? vars['--accent'].trim() : '', out = { ...vars };
    if (!a) return out;
    if (!out['--accent-dim']) out['--accent-dim'] = `color-mix(in srgb, ${a} 72%, black)`;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(a);
    if (m && !out['--accent-rgb']) { const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]; out['--accent-rgb'] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(', '); }
    return out;
}


