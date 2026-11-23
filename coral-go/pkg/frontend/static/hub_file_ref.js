// Through a Hub the tunnel refuses an absolute file reference (View tier: values starting with / or ~ get a 404 and nothing is forwarded, #20817). So the chat sends the path relative to the agent's own folder.
// Rules (coral-hub Security): strip only the session's own folder, at a whole-segment boundary (/work/app2 is not inside /work/app); never strip a git root; never produce '..' or a value starting with / or ~;
// the outside-folder answer comes from the path alone, with no request, and does not depend on whether the file exists. A reference that is not absolute is returned unchanged (the tunnel decides, as today).
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

const segs = p => String(p || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.');

/** @returns {{ref: string}|{outside: true}} ref to send through the Hub, or outside when the file lies beyond the folder. */
export function hubFileRef(ref, folder) {
    const raw = String(ref || '').replace(/^file:\/\//i, '');
    const absolute = raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('~') || WIN_DRIVE.test(raw);
    if (!absolute) return { ref: String(ref) };
    if (!folder || raw.startsWith('~')) return { outside: true };
    const fold = !!WIN_DRIVE.test(folder); // a Windows drive path compares without case
    const norm = s => (fold ? s.toLowerCase() : s);
    const base = segs(folder), path = segs(raw);
    if (!!WIN_DRIVE.test(raw) !== fold) return { outside: true }; // a drive path against a POSIX folder, or the reverse
    if (path.length <= base.length || !base.every((s, i) => norm(s) === norm(path[i]))) return { outside: true };
    const rest = path.slice(base.length);
    if (rest.includes('..')) return { outside: true };
    // the line suffix (file.js:12) stays on the last segment: the route reads it
    return { ref: rest.join('/') };
}

export const outsideWords = agent => `This file is outside ${agent}'s folder; it opens on that computer only.`;
