/* What Chief looks like (#11796, the Coral dot's front door): a name, one of the eight avatar colours with one letter on it, and the team it fronts. The Operator chooses them in Settings > Chief; the machine keeps them as
 * the chief_name, chief_avatar, chief_avatar_letter and chief_fronts settings and gives them cleaned through GET /api/chief. This module draws the avatar, reads the look and puts it on the /chief page: the header's
 * name and avatar, the page title, and (by the --chief-color and --chief-letter variables chief.css reads) the avatar beside each of Chief's chat bubbles. Everything is set as text, never as HTML. Lazy: only /chief
 * and Settings > Chief load it. */
import { loadStyles } from './lazy_styles.js';
await loadStyles('chief.css');

/** The eight colours are the avatar tokens (variables.css): the number is the token's, the word is what the Operator reads. */
export const COLORS = [['1', 'Indigo'], ['2', 'Orange'], ['3', 'Teal'], ['4', 'Green'], ['5', 'Blue'], ['6', 'Violet'], ['7', 'Rose'], ['8', 'Magenta']];

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The look from /api/chief's answer, with the defaults for what is missing. */
export function lookOf(j) {
    const o = j && typeof j === 'object' ? j : {};
    const color = COLORS.some(c => c[0] === String(o.avatar)) ? String(o.avatar) : '1';
    return { name: String(o.name || ''), color, letter: String(o.avatar_letter || ''), fronts: String(o.fronts || '') };
}

/** The letter on the avatar: the one chosen, or the first letter or digit of the name, or C for Chief. */
export function letterOf(look, fallbackName = '') {
    if (look.letter) return look.letter.toUpperCase();
    const first = [...(look.name || fallbackName)].find(c => /[\p{L}\p{N}]/u.test(c));
    return first ? first.toUpperCase() : 'C';
}

/** The avatar: a circle in the chosen colour with the letter on it. Decorative: the name beside it is what a screen reader reads. */
export function avatarNode(look, fallbackName = '') {
    const a = el('span', 'chief-avatar', letterOf(look, fallbackName));
    a.dataset.color = look.color; a.setAttribute('aria-hidden', 'true');
    return a;
}

let cached = null;
/** What the machine says about Chief, once per page load; null when it cannot be read (the page then keeps the agent's own name). */
export function readChief(force = false) {
    if (!cached || force) cached = fetch('/api/chief', { credentials: 'same-origin', cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(j => (j && j.enabled ? lookOf(j) : null)).catch(() => null);
    return cached;
}

/** The /chief page's face: the header shows the avatar and the chosen name (the agent's own name when none is chosen), the page title follows, and the chat's avatar variables are set. */
export async function showChiefFace(label, identity) {
    const look = await readChief();
    if (!look || !label || !label.isConnected) return;
    const name = look.name || identity;
    label.textContent = name;
    let head = document.getElementById('chief-avatar-head');
    if (!head) { head = avatarNode(look, name); head.id = 'chief-avatar-head'; label.before(head); }
    head.textContent = letterOf(look, name); head.dataset.color = look.color;
    document.body.style.setProperty('--chief-color', `var(--avatar-${look.color})`);
    document.body.style.setProperty('--chief-letter', `"${letterOf(look, name)}"`);
    document.title = document.title.replace(identity, name);
}
