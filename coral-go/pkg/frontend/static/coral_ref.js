/* Closed Coral link grammar, shared with the comment subjects accepted by
 * coral-agent. A reference never names a command, an arbitrary URL or a path. */
export function parseCoralRef(raw) {
    const value = String(raw || '');
    let m = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i.exec(value);
    if (m) return { kind: 'artifact', hex: m[1].toLowerCase() };
    m = /^coral:\/\/goals\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/([1-9][0-9]{0,9})$/.exec(value);
    if (m) return { kind: 'goal', team: m[1], id: m[2] };
    m = /^coral:\/\/diffs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_-]{5,63})\/([a-f0-9]{16})$/.exec(value);
    return m ? { kind: 'diff', team: m[1], session: m[2], hash: m[3] } : null;
}
export const coralRefUri = r => r.kind === 'artifact' ? `coral://artifacts/${r.hex}` : r.kind === 'goal' ? `coral://goals/${r.team}/${r.id}` : `coral://diffs/${r.team}/${r.session}/${r.hash}`;
