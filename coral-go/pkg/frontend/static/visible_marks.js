// Text that hides what it says is written out, never drawn (#11399). A control or format character other than a newline or a tab (a right-to-left override that reorders a command, a zero-width space,
// a bell) is shown as <U+202E>, in a permission card and in a chat bubble, the same words the server writes into a request it serves (internal/permreview). A Windows line end (CR then LF) is a newline.
// In a chat bubble a zero-width joiner or non-joiner between two visible characters is left alone: emoji sequences and several scripts are written with it. In a request the person is asked to allow
// ({ strict: true }) nothing is left alone: `git<ZWJ>status` is not the command it looks like.

const HIDDEN = /[\p{Cc}\p{Cf}]/gu;
const VISIBLE = /\S/u;

/** The text with every hidden character written out as <U+XXXX>. */
export function markHidden(text, { strict = false } = {}) {
    if (text == null) return '';
    return String(text).replace(/\r\n/g, '\n').replace(HIDDEN, (c, i, s) => {
        if (c === '\n' || c === '\t') return c;
        if (!strict && (c === '\u200d' || c === '\u200c') && i > 0 && i + 1 < s.length && VISIBLE.test(s[i - 1]) && VISIBLE.test(s[i + 1])) return c;
        return `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;
    });
}
