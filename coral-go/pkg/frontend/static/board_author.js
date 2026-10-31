/* The name a Board row shows for its sender (#10718): the person's own posts say "You"; the id stays Operator (colours, alignment, Reply and the @ names all keep using it).
 * A Hub user's post as the Operator is not you at this computer, so it keeps the name (its badge says who). */
import { isGuidePost, guideName, ensureGuideRoster } from './guide_names.js';
export function authorLabel(m, agent, board = '') {
    if (isGuidePost(m)) { ensureGuideRoster(board); return guideName(m, board); } // a guide's post says who wrote it, not the Hub label (#11457)
    const id = m && (m.subscriber_id || m.session_id);
    return (id === 'Operator' || id === 'dashboard') && m.origin !== 'hub_operator' && agent === 'Operator' ? 'You' : agent;
}
