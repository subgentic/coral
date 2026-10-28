/* The reminders Coral puts in a chat read as sentences for a person, not as the command an agent runs (#10376, the Mobile tester: "Run 'coral-board read' to see them" in a person's chat). The agent still gets the full text and
 * the row's tooltip keeps it; only the row's words change. Pure: no DOM. */
export function reminderWords(text) {
    const t = String(text == null ? '' : text).trim();
    let m = t.match(/^You have (\d+) unread messages? on the message board\.?\s*Run 'coral-board read'[^.]*\.?$/i);
    if (m) return `You have ${m[1]} unread message${m[1] === '1' ? '' : 's'} on the message board.`;
    m = t.match(/^\[(?:New )?Task #(\d+)(?: \(([a-z]+)\))? available\]\s*Run 'coral-board task claim \d+'[^.]*\.?$/i);
    if (m) return `Task #${m[1]} is available${m[2] ? ` (${m[2]} priority)` : ''}.`;
    return t;
}
