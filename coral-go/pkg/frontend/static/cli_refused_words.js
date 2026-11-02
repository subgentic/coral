/* What the server says of a CLI that was found and not used, in pieces (#12364). No imports: the page's list and banner use it, and a node test reads it against tests/frontend/fixtures/cli_refusal_sentences.json, which
 * the Go test builds the same sentences from. The note is "Found but not used: <path> is in an agent's working folder: the agent "<name>" works in <folder>. Archive ..., so a launch refuses it. ...". */
export function refusedWords(note) {
    const text = String(note || ''), out = { path: '', kind: 'other', agent: '', folder: '' };
    const p = /^Found but not used: ([~\/\\]\S*|[A-Za-z]:\\\S*) is /.exec(text); if (p) out.path = p[1]; // a path, not the Hub's "it is in a folder ..."
    const a = /the agent ("(?:[^"\\]|\\.)*") works in (\S+?)\. /.exec(text);
    if (a) { try { out.agent = JSON.parse(a[1]); } catch { out.agent = a[1].slice(1, -1); } out.folder = a[2]; out.kind = 'agent'; }
    else if (/ is in a temporary folder/.test(text)) out.kind = 'temp';
    else if (/ is in Coral's data folder/.test(text)) out.kind = 'data';
    return out;
}
