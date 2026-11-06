/* Native capture listeners must defer only validated dashboard-owned links.
 * Metadata cannot exempt an external/look-alike URL from the browser policy. */
import { parseCoralRef } from '../coral_ref.js';
export function isManagedCoralLink(a, page) {
    const href = a.getAttribute('href') || '';
    const subject = a.getAttribute('data-coral-ref') || '';
    const ref = parseCoralRef(subject);
    if (ref && ref.kind !== 'artifact' && href === subject) return true;
    const chat = a.getAttribute('data-file-ref') || '', chatRef = parseCoralRef(chat);
    if (chatRef?.kind === 'artifact' && href === chat) return true;
    let url; try { url = new URL(href, page.href); } catch { return false; }
    const hex = a.getAttribute('data-artifact') || a.getAttribute('data-attachment') || (chatRef?.kind === 'artifact' ? chatRef.hex : '');
    const match = /^(?:\/api\/remote\/[^/]+)?\/api\/artifacts\/([a-f0-9]{64})$/i.exec(url.pathname);
    return !!(url.origin === page.origin && !url.username && !url.password && !url.hash && (!url.search || url.search === '?v=2') && !a.hasAttribute('download') && match && /^[a-f0-9]{64}$/i.test(hex) && hex.toLowerCase() === match[1].toLowerCase());
}
