// The exact reviewed public frame, rendered as text only (#21030). No Markdown,
// auto-links, local session rows or browser-side redaction can widen this pane.
export function renderLivePreview(host, frame, { teamLabel, live, delaySeconds }) {
    host.replaceChildren();
    const node = (tag, text, className) => {
        const el = document.createElement(tag);
        el.textContent = text;
        if (className) el.className = `coral-live-${className}`;
        return el;
    };
    const author = item => item.from + (Number.isFinite(item.at) && item.at > 0 ? ' · ' + new Date(item.at * 1000).toLocaleString() : '');
    const header = node('div', '', 'previewhead');
    header.append(node('h2', teamLabel), node('small', `${live ? 'Live' : 'Owner preview · not public'} · Public, read-only · shown ${delaySeconds} seconds late`));
    host.append(header, node('h3', 'Team'));
    for (const agent of frame.agents || []) {
        const row = node('div', '', 'agent');
        row.append(node('strong', agent.role), node('small', ({working:'Working',idle:'Idle',waiting:'Waiting',asleep:'Asleep'})[agent.status] || agent.status), node('span', agent.task, 'task'));
        host.append(row);
    }
    host.append(node('h3', 'Recent posts'));
    for (const post of frame.posts || []) {
        const row = node('div', '', 'post');
        if (post.w) row.append(node('p', '... (message withheld) ...', 'withheld'));
        else row.append(node('small', author(post)), node('p', post.text));
        host.append(row);
    }
    let hasChat = false;
    for (const agent of frame.agents || []) {
        if (!Array.isArray(agent.chat)) continue;
        hasChat = true;
        host.append(node('h3', `Chat · ${agent.role}`), node('small', `Shown ${delaySeconds} seconds late · last 2 minutes only`));
        for (const message of agent.chat) {
            const row = node('div', '', 'message');
            if (message.w) row.append(node('p', '... (message withheld) ...', 'withheld'));
            else row.append(node('small', author(message)), node('p', message.text));
            host.append(row);
        }
    }
    if (!hasChat) host.append(node('p', 'Chat is not shared.', 'muted'));
    const footer = node('div', '', 'section-separator');
    footer.append(node('small', 'Text is checked for secrets on your computer, but checks can miss. Anyone with the link can read it. Held for a short time on Coral’s service.'));
    host.append(footer);
}
