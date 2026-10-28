/** The title of a chat in the list, the sidebar and a chat's header (#6200, #6251, #7756): the one the server works out (`title` on a History row: the title its notes give it, else the person's first real message with its markdown off, else the agent's name), with any path cut to its last folder, else a plain "Chat": never the session's id, and never the launch prompt. */
export function historyLabel(s) {
    const title = String((s && s.title) || '').replace(/\s+/g, ' ').trim()
        .replace(/(?:\/[\w.@~+-]+){2,}\/?/g, m => m.replace(/\/+$/, '').split('/').pop()) // a path is its last folder
        .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*([^\\\s]+)/g, '$1');
    return title || (s && s.session_id ? `Chat ${String(s.session_id).replace(/^board:/, '').slice(0, 6)}` : 'Chat'); // an untitled chat still tells its row from the next one's (#6961)
}

/** A row's search hit (`snippet`, one line of the chat around the matched words) without the row's own title repeated in it, or '' when nothing else is left: "Three day plan. plan a trip to lisbon Three day plan." under the title
 *  "Three day plan." read the title twice (#10641). The match is shown once, in the chat's own words. */
export function hitWithoutTitle(s) {
    const raw = String((s && s.snippet) || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const title = historyLabel(s).replace(/[\s.…]+$/, '').trim();
    if (!title) return raw;
    // only the whole title: on word edges (a letter, digit or underscore before or after is part of another word: the title "Plan" is not cut out of "planning")
    const bare = raw.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[.…]*(?![\\p{L}\\p{N}_])', 'giu'), ' ').replace(/\s+/g, ' ').trim();
    return bare.replace(/^[\s.,;:…-]+|[\s,;:-]+$/g, '').trim();
}
