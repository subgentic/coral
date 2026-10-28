/* The terminal's way out for the keyboard (#10345). The terminal keeps Tab and every other key for the shell, so a keyboard user needs a key it hands back: Ctrl+Shift+Escape (a browser gets it on macOS and Linux; on Windows it is Task Manager and
 * never reaches the page) and Ctrl+] (the telnet escape: no shell or agent CLI uses it, and it reaches the page on every OS). */

/** Whether this computer is Windows, where Ctrl+Shift+Escape cannot be the way out. */
export function isWindows() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /^win/i.test(p);
}

/** The keys that let go of the terminal, in words, for this person's OS. */
export function leaveKeyWords(windows = isWindows()) {
    return windows ? 'Ctrl+]' : 'Ctrl+Shift+Escape or Ctrl+]';
}

/** Whether a keydown is one of the leave keys. */
export function isLeaveKey(ev) {
    if (!ev || ev.type !== 'keydown') return false;
    if (ev.key === 'Escape' && ev.ctrlKey && ev.shiftKey) return true;
    return ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === ']' || ev.code === 'BracketRight');
}
