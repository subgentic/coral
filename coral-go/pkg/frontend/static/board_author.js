/* The name a Board row shows for its sender (#10718): the person's own posts say "You"; the id stays Operator (colours, alignment, Reply and the @ names all keep using it).
 * A Hub user's post as the Operator is not you at this computer, so it keeps the name (its badge says who). */
export function authorLabel(m, agent) {
    const id = m && (m.subscriber_id || m.session_id);
    return (id === 'Operator' || id === 'dashboard') && m.origin !== 'hub_operator' && agent === 'Operator' ? 'You' : agent;
}
