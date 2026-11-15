import { state } from './state.js';

/** The words of a refused switch (#13761): on another computer they say WHICH computer refused and what to do about THAT computer, from what the Hub's own server list knows of it (how it is reached, and whether approvals work for it). A computer set up
 *  over SSH already holds the secret, so a refusal there is an old Coral (update it from the Hub) or a Hub with no sign-in session, never "set up approvals"; only a computer that approvals do not work for is told to set them up. This computer's own refusals
 *  and every other answer are as they came. */
export function refusedWords(server, status, out) {
    const text = (out && out.error) || 'The change was not made.';
    if (status !== 403 || !out || out.code !== 'operator_only' || !server || server === 'local') return text;
    const row = (state.servers || []).find(x => x && String(x.id) === String(server));
    const name = String((row && (row.label || row.name)) || server).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
    if (row && row.owner_stamp === true) {
        return `${name} did not take the change: the Hub signs a model change only for a signed-in person, and only for a Coral on ${name} that is new enough. Sign in to this Hub, and update Coral on ${name} (Settings > Computers) if it is old.`;
    }
    if (row && row.transport === 'ssh') return `${name} did not take the change: approvals are not set up for it. In Settings > Computers press Set up approvals for ${name}.`;
    if (row && row.transport) return `${name} did not take the change: approvals are not set up for it. In Settings > Computers press Approve through this hub for ${name}.`;
    return `${name} did not take the change: ${text}`;
}
