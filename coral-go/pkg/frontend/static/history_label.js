/** The title of a chat in the list, the sidebar and a chat's header (#6200, #6251, #7756): the one the server works out (`title` on a History row: the title its notes give it, else the person's first real message with its markdown off, else the agent's name), with any path cut to its last folder, else a plain "Chat": never the session's id, and never the launch prompt. */
export function historyLabel(s) {
    const title = String((s && s.title) || '').replace(/\s+/g, ' ').trim()
        .replace(/(?:\/[\w.@~+-]+){2,}\/?/g, m => m.replace(/\/+$/, '').split('/').pop()) // a path is its last folder
        .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*([^\\\s]+)/g, '$1');
    return title || (s && s.session_id ? `Chat ${String(s.session_id).replace(/^board:/, '').slice(0, 6)}` : 'Chat'); // an untitled chat still tells its row from the next one's (#6961)
}
