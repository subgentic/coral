/* One artifact bookmark: the Starred folder and, while the document needs
 * review, a pin above Needs you's goal groups (#13889). Review rows expose a
 * 44px button on phones too; other artifact lists retain their existing layout.
 * Writes use the document's source computer and the existing star endpoint. */
import { showToast } from './utils.js';
import { serverFetch } from './server_base.js';
import { serverOf } from './inbox_servers.js';

/** One row's star control. labelled (#15722): a text button, "Star", beside the row's other buttons (its pressed state is aria-pressed and the filled look), not the icon alone. item.starred is read and kept; `name` is the artifact's name for the button's words and the failure. onChange(on) runs after the server says yes. */
export function starControl(item, { hex, name, onChange, reviewPin = false, labelled = false } = {}) {
    if (!hex) return null;
    const b = document.createElement('button');
    b.type = 'button';
    const paint = () => {
        const on = !!item.starred;
        b.className = `dt-star${on ? ' dt-star-on' : ''}${labelled ? ` btn btn-quiet btn-small dt-star-labelled inbox-star${on ? ' inbox-star-on' : ''}` : ''}`;
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', `${on ? 'Remove the star from' : 'Star'} ${name}`);
        b.title = on ? 'Starred (click to remove the star)' : reviewPin ? 'Star: keep this document at the top of Needs you' : 'Star: find this again in Starred';
        if (labelled) { b.replaceChildren('Star'); return; } // the word is the same on and off (the name 'Remove the star from X' holds it): aria-pressed and the filled look say which
        b.replaceChildren(Object.assign(document.createElement('span'), { className: 'material-icons', textContent: 'star' })); // one glyph for both (the icon font has no outline star): a starred row's is brighter, and aria-pressed says it
        b.firstChild.setAttribute('aria-hidden', 'true');
    };
    paint();
    b.addEventListener('click', async (e) => {
        e.stopPropagation(); // the row opens on a click: the star is not the row
        if (b.disabled) return;
        b.disabled = true;
        const on = !item.starred;
        const r = await serverFetch(serverOf(item), `/api/artifacts/${hex}/star`, { method: on ? 'PUT' : 'DELETE' }).catch(() => null); // on the computer the file is on: a bare path through the Hub is the Hub's own (#12617)
        b.disabled = false;
        if (!r || !r.ok) { showToast(`Couldn't ${on ? 'star' : 'unstar'} ${name}.`, true); return; }
        item.starred = on; paint(); onChange?.(on);
        document.dispatchEvent(new CustomEvent('artifact-star-changed')); // the Inbox's Starred folder reads its artifacts again (#10258)
    });
    return b;
}
