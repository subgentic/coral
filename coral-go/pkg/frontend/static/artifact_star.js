/* The star on an artifact row (#9834, #9819): a bookmark, find it again in Starred only. At a mouse a row shows the empty star as a button when it is hovered or has the keyboard, and a starred row always
 * shows the filled one; on a phone the row has no control (the star is in the item) and a starred row keeps the glyph, which is not a button there. The glyph is hidden from a screen reader: the row's name
 * ends ", starred". The call is the one the detail pane makes: PUT or DELETE /api/artifacts/<digest>/star (on this computer's store, and the owner's through Coral Hub). */
import { showToast } from './utils.js';

/** One row's star control. item.starred is read and kept; `name` is the artifact's name for the button's words and the failure. onChange(on) runs after the server says yes. */
export function starControl(item, { hex, name, onChange } = {}) {
    if (!hex) return null;
    const b = document.createElement('button');
    b.type = 'button';
    const paint = () => {
        const on = !!item.starred;
        b.className = `dt-star${on ? ' dt-star-on' : ''}`;
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', `${on ? 'Remove the star from' : 'Star'} ${name}`);
        b.title = on ? 'Starred (click to remove the star)' : 'Star: find this again in Starred only';
        b.replaceChildren(Object.assign(document.createElement('span'), { className: 'material-icons', textContent: 'star' })); // one glyph for both (the icon font has no outline star): a starred row's is brighter, and aria-pressed says it
        b.firstChild.setAttribute('aria-hidden', 'true');
    };
    paint();
    b.addEventListener('click', async (e) => {
        e.stopPropagation(); // the row opens on a click: the star is not the row
        const on = !item.starred;
        const r = await fetch(`/api/artifacts/${hex}/star`, { method: on ? 'PUT' : 'DELETE' }).catch(() => null);
        if (!r || !r.ok) { showToast(`Couldn't ${on ? 'star' : 'unstar'} ${name}.`, true); return; }
        item.starred = on; paint(); onChange?.(on);
        document.dispatchEvent(new CustomEvent('artifact-star-changed')); // the Inbox's Starred folder reads its artifacts again (#10258)
    });
    return b;
}
