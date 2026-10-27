/* Escaping text and attribute values for HTML (moved out of utils.js, #5065; no behaviour change). */
/** Escape for HTML text AND for double- or single-quoted attribute values: & < > " ' */
const _HTML_SPECIAL = /[&<>"']/;

const _HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    // The list draws every row again for each feed message and nearly every string in it needs no escaping: one test, and the string itself (#5010).
    return _HTML_SPECIAL.test(s) ? s.replace(/[&<>"']/g, c => _HTML_ESCAPES[c]) : s;
}

// A tag's colour goes into a style attribute, where HTML escaping is not enough ("red;position:fixed;inset:0" is a valid
// attribute value): only #rgb, #rrggbb and #rrggbbaa are used, anything else (a row stored before the server checked it, #4875) is the default.
const _tagColorRe = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function tagColor(c) {
    return typeof c === 'string' && _tagColorRe.test(c) ? c : '#58a6ff';
}

/** Escape for use as the value of an HTML attribute (data-*, title, value, id, ...). */
export function escapeAttr(str) {
    return escapeHtml(str);
}

/** The family's three-dot More icon (#7686, the list bars'), as markup for a dense .btn-icon.btn-xs (the sidebar's kebab, #9332): a constant, never built from data. */
export const MORE_DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
