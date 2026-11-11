/* Where in the agent docs (coral-go/agent_docs/) each screen's information is (#15063, the Operator): the robot button on a screen copies the object's command and ONE line naming the doc topic and the
 * heading in it, so the agent reads only that part (`coral-agent docs <topic>` prints the topic; the section is named in the line). Every entry names a real heading: agent_doc_map.test.mjs fails
 * when one is missing from agent_docs/. No imports: the node test loads this file as it is. */

/** key -> { topic, section }: section '' is the whole topic (a short one). */
export const DOC_POINTERS = {
    goal: { topic: 'board', section: 'Goals' },
    task: { topic: 'board', section: 'Tasks' },
    board: { topic: 'board', section: 'Messages' },
    settings_workflow: { topic: 'task-workflows', section: 'From assignment to result' },
    settings_health: { topic: 'using-the-dashboard', section: 'Turn on the team health monitor' },
    settings_messaging: { topic: 'board', section: 'Cross-team messaging' },
    settings_orchestrator: { topic: 'board', section: 'Board status and routing' },
    settings_guides: { topic: 'board', section: 'Groups' },
    needs_you: { topic: 'artifacts', section: 'Answer a comment the Operator sent you' },
    artifact: { topic: 'artifacts', section: 'Read an artifact someone else shared' },
    agent: { topic: 'sessions', section: 'Session Lifecycle' },
    jobs: { topic: 'scheduled-jobs', section: 'Create a scheduled job' },
    hub: { topic: 'hub', section: 'Registry (hub only)' },
    resources: { topic: 'resource-queue', section: 'For an agent' },
    merge_queue: { topic: 'merge-queue', section: 'For an agent that makes a change' },
    notifications: { topic: 'notifications', section: 'Create Notification' },
    saved_messages: { topic: 'saved-messages', section: 'In the dashboard' },
    settings: { topic: 'settings-system', section: 'Settings' },
};

/** The one line that says where to read: `Docs: coral-agent docs board, section "Goals"` (just the topic when the entry has no section). */
export function pointerLine(topic, section = '') {
    return `Docs: coral-agent docs ${topic}${section ? `, section “${section}”` : ''}`;
}

/** What a robot button copies: the subject's own line(s) (its command), then where in the docs to read. `key` is a DOC_POINTERS entry, or { topic, section } (the Docs viewer: the page being read). */
export function agentCopyText(key, subject = '') {
    const p = typeof key === 'string' ? DOC_POINTERS[key] : key;
    if (!p) return String(subject || '');
    return [String(subject || '').trim(), pointerLine(p.topic, p.section)].filter(Boolean).join('\n');
}
