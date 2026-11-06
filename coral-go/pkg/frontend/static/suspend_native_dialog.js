/* Keep a native dialog's exact DOM/draft while an internal view is in front.
 * Unlike its Close action this neither destroys attachments nor reports Done. */
import { importOnce } from './import_once.js';
export function suspendNativeDialog(opener) {
    const dialog = opener?.closest?.('dialog.inbox-ask-dialog[open]');
    if (!dialog) return null;
    const focus = dialog.contains(document.activeElement) ? document.activeElement : opener;
    const scroll = [...dialog.querySelectorAll('textarea, .inbox-ask-reading, .inbox-ask-compose')].map(e => [e, e.scrollTop]);
    dialog.close();
    dialog.hidden = true;
    let restored = false;
    return () => {
        if (restored) return; restored = true;
        if (!dialog.isConnected) return;
        dialog.hidden = false;
        if (!dialog.open) dialog.showModal();
        for (const [node, top] of scroll) node.scrollTop = top;
        if (focus?.isConnected) focus.focus({ preventScroll: true });
    };
}

/** A page link keeps the question until Back/Return reaches its original route. */
export async function openWithQuestionReturn(opener, open) {
    const nav = await importOnce('./nav.js'), origin = nav.currentRoute();
    const before = JSON.stringify(origin), restore = suspendNativeDialog(opener);
    if (!restore) return open(null);
    let left = false;
    const resume = () => { document.removeEventListener('coral:route-changed', changed); restore(); };
    const changed = () => { const here = JSON.stringify(nav.currentRoute()); if (here !== before) left = true; else if (left) resume(); };
    document.addEventListener('coral:route-changed', changed);
    try {
        const result = await open(() => nav.go(origin).then(resume)); changed();
        if (!left && !result?.waitForClose) { resume(); return; }
        const { showToast } = await importOnce('./notifications.js');
        showToast('Your question draft is kept. Use Back to return.', false, undefined, { action: { label: 'Return to question', onClick: () => nav.go(origin).then(resume) } });
    } catch (error) { resume(); throw error; }
}
