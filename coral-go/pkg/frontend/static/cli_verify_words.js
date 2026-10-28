/* The words of one CLI path check in Settings > Agents (#10083). Pure: it takes what the server answered and what the person typed, and gives the word, its class and one line saying what to do.
 * A CLI the person never set a path for and does not have is "Not installed" in a neutral colour (it is not a mistake); a path they typed that is not there is "Not found"; a path Coral refuses is
 * "Not allowed" with the reason and the way out, never the bare word. Everything returned is text for textContent. */

const USE_PATH = 'Or empty the field to use PATH.';

/** Why a refused path was refused, in words, with what to do (the server's message is matched, never shown raw unless it is unknown). */
function refusalHint(message, type) {
    const m = String(message || '');
    const where = /temporary folder/i.test(m) ? 'a temporary folder' : /data folder/i.test(m) ? "Coral's data folder" : /working folder/i.test(m) ? "an agent's working folder" : '';
    if (where) return `Coral will not run a CLI from ${where}, because an agent can write there. Move it to a folder only you can write to, then check again, or empty the field to use PATH.`;
    if (/absolute path/i.test(m)) return 'Use the full path to the program (it starts with / or a drive letter), or empty the field to use PATH.';
    if (/configured CLI path or a path to (\S+)/i.test(m)) return `That is not the ${type} program: point at its file (named ${/path to (\S+)/i.exec(m)[1]}), or empty the field to use PATH.`;
    if (/known CLI/i.test(m)) return `That name is not a CLI Coral knows: point at the ${type} program's file, or empty the field to use PATH.`;
    if (/Operator/i.test(m)) return `${m.charAt(0).toUpperCase()}${m.slice(1)}. Check it from this computer's own dashboard, or empty the field to use PATH.`;
    return m ? `${m.charAt(0).toUpperCase()}${m.slice(1)}. Empty the field to use PATH.` : `Coral would not check that path. Empty the field to use PATH.`;
}

/** { text, cls, hint } for one check. input: { ok, status, data, typed, type } for an answer, or { error: true } when the server could not be reached. */
export function cliVerifyWords({ ok, status, data, typed = '', type = 'the', error = false } = {}) {
    if (error) return { text: 'Error', cls: 'cli-verify-fail', hint: 'Coral could not be reached. Try again.' };
    if (!ok) return { text: 'Not allowed', cls: 'cli-verify-fail', hint: refusalHint(data && data.error, type) };
    if (data && data.found) return { text: data.version || 'Found', cls: 'cli-verify-ok', hint: '' };
    const value = String(typed || '').trim();
    if (!/[\\/]/.test(value)) return { text: 'Not installed', cls: 'cli-verify-none', hint: '' }; // no path of their own: PATH was searched, and the CLI is not there
    return { text: 'Not found', cls: 'cli-verify-fail', hint: `There is nothing at that path. Check it, ${USE_PATH.charAt(0).toLowerCase()}${USE_PATH.slice(1)}` };
}
