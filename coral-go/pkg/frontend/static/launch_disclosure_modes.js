/* What the "before starting" notice says about the members whose mode is not auto (#16500): the notice is about auto mode, so a launch whose members carry their own mode (a custom mode, or Default)
 * names them instead of claiming every agent starts in auto. Pure: `nameOf` turns a permission_mode value into the words the person sees (the caller knows the custom modes). */
const AUTO_TITLE = 'Agents launch in auto mode';

/** { title, note } for a launch payload. note is '' when every agent takes the default (the server's text stands alone). */
export function launchModeNotice(payload, nameOf) {
    const agents = Array.isArray(payload?.agents) ? payload.agents.filter(a => a && typeof a === 'object') : [];
    const own = agents.filter(a => typeof a.permission_mode === 'string' && a.permission_mode);
    if (!own.length && !(typeof payload?.permission_mode === 'string' && payload.permission_mode)) return { title: AUTO_TITLE, note: '' };
    if (!agents.length) return { title: 'This agent does not launch in auto mode', note: `It starts in ${nameOf(payload.permission_mode)}.` }; // one agent with its own mode
    const list = own.map(a => `${String(a.name || 'An agent')} (${nameOf(a.permission_mode)})`).join(', ');
    if (own.length === agents.length) return { title: 'Agents launch in the modes you chose', note: `Modes: ${list}.` };
    return { title: 'Most agents launch in auto mode', note: `Not in auto mode: ${list}.` };
}
