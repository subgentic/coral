/* The one tiny element builder the dashboard's modules each wrote out again (#11760): `el(tag, cls, text)` makes an element, sets its class and its text (textContent, so markup is shown as text). */
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
