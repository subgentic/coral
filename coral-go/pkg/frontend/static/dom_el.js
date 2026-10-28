/** One element with a class and plain text (textContent, never HTML): the helper many pages and dialogs build their DOM with. */
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
