// The same named icon controls on private drafts and published comments.
import { el } from './dom_el.js';
export function commentIcon(button, action) {
    const label = action + ' comment', icon = el('span', 'material-icons', action === 'Edit' ? 'edit' : 'delete');
    icon.setAttribute('aria-hidden', 'true');
    button.classList.add('ac-comment-icon'); button.setAttribute('aria-label', label); button.setAttribute('title', label);
    button.replaceChildren(icon);
    return button;
}
