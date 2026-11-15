import { importOnce } from './import_once.js';
/* The answer a link into Docs wants shown (#10765): Settings' Learn more beside Default permission mode opens the How do I answer "What the permission modes allow", not a box behind Settings. The link
   names the heading; the Docs page scrolls to it once the topic is drawn. Taken once: the next topic opened by hand starts at its top. */

let wanted = '';

/** Remember the heading of the answer the next Docs page should open at. */
export function wantDocsAnswer(heading) { wanted = String(heading || ''); }

/** The heading wanted, once ('' when none): asking clears it. */
export function takeDocsAnswer() { const h = wanted; wanted = ''; return h; }

/** The Learn more that is a link into Docs (help.docs: { topic, answer }): the answer is Docs', not a box behind Settings (#10765). A plain click goes through the router (a[data-route]); the answer's heading is remembered for the page to open at. */
export function settingsDocsLink(help, field) {
    const a = document.createElement('a'); a.className = 'sv-learn'; a.textContent = 'Learn more'; a.href = `/docs/${encodeURIComponent(help.docs.topic)}`; a.setAttribute('data-route', ''); a.setAttribute('aria-label', `Learn more about ${help.about || field.label}, in Docs`);
    a.addEventListener('click', async e => {
        const dlg = a.closest('.modal');
        if (!dlg || a.dataset.afterClose) { if (!dlg) wantDocsAnswer(help.docs.answer); return; }
        // A link out of a dialog closes the dialog first: the answer opens in Docs under it otherwise, and it looks as if nothing happened (#10906). Settings asks about unsaved changes before it closes: Discard
        // follows the link, Keep editing does not, and the answer is remembered only once the link is followed, so nothing is left waiting to scroll a Docs page opened by hand later.
        e.preventDefault();
        const follow = () => setTimeout(() => { wantDocsAnswer(help.docs.answer); a.dataset.afterClose = '1'; a.click(); delete a.dataset.afterClose; }); /* after this click has finished: a click on a link already being clicked is dropped when the dialog was already loaded and closes at once */ // the router takes it now, with nothing over the page it opens
        if (dlg.id === 'settings-modal') window.hideSettingsModal?.(false, follow);
        else { const { closeDialog } = await importOnce('./modal_chrome.js'); closeDialog(dlg); follow(); }
    });
    return a;
}
