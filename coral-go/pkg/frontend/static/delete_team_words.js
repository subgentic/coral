/* The Remove team dialog's words, in a module of their own (#16895): the dialog is drawn from a click, so they are read then, not at start. Short lines, one under another. */
const oneLine = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** The Remove team dialog's words (#15277): what goes, what stays, and (with the names of agents still running on it) that they are stopped first by "Stop agents and remove". */
export function deleteTeamWords(team, running = []) {
    const name = oneLine(team);
    const shown = running.length > 5 ? `${running.slice(0, 5).join(', ')} and ${running.length - 5} more` : running.join(', ');
    const live = running.length ? ` ${running.length} agent${running.length === 1 ? ' is' : 's are'} running on it: ${shown}. Stop agents and remove stops them first.` : '';
    return [`Remove team "${name}"?`, live.trim(), "This removes the team's messages, tasks, goals, members, reminders, waits, presets, settings, artifact tags and health data for good.",
        "The files its agents uploaded are not deleted, but their tags, review questions and decisions go with the team.", "The agents' chats stay in History; the files in the team's folder and the logs are not touched.", 'This cannot be undone.'].filter(Boolean).join('\n');
}
