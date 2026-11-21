/* Inbox v4 round 2: the actual message has its own box, metadata stays outside.
   Mark existing nodes rather than copying their text: links, expansion and accessible names survive. */
import { markHidden } from './visible_marks.js';
import { isPhoneLayout } from './phone_layout.js';
export function decorateMessage(row, tr) {
    const mail = tr.classList.contains('dt-mailed');
    if (mail) { tr.classList.add('inbox-kind-row'); tr.querySelector('.dt-mail-lead')?.classList.add('inbox-v4-leading'); }
    if (!tr.classList.contains('inbox-kind-row')) return;
    tr.classList.add('inbox-message-row', 'inbox-v4-row');
    const message = mail ? (row.waiting_kind === 'permission' ? null : tr.querySelector('.dt-mail-snippet')) : row.operatorAsk ? tr.querySelector('.inbox-ask-name')
        : row.review ? (!tr.querySelector('.inbox-sent-back') && tr.querySelector('.inbox-row-words'))
        : row.goalDone ? tr.querySelector('.inbox-row-words')
        : row.waiting_kind === 'permission' ? null : tr.querySelector('.inbox-row-words:not(.inbox-kind-words), .inbox-whole-name');
    const heading = (row.operatorAsk || isPhoneLayout()) ? tr.querySelector('.inbox-review-from') || tr.querySelector('.dt-person, .inbox-review-name') : tr.querySelector('.inbox-review-name, .dt-person');
    tr.querySelector('[data-key="agent"]')?.classList.add('inbox-v4-content');
    if (heading) { heading.classList.add('inbox-v4-heading'); (heading.querySelector('.dt-primary') || heading).classList.add('inbox-v4-heading-text'); }
    if (row.waiting_kind === 'permission' && !row.review && !row.operatorAsk) {
        tr.querySelectorAll('[data-key="agent"] > .inbox-row-words, .inbox-whole-name, .dt-mail-snippet').forEach(n => { if (/^(Wants to run\b|Needs input · Permission$|(?:Claude )?needs (?:your )?permission\b)/i.test(n.textContent.trim())) n.classList.add('inbox-implied-intro'); });
    }
    tr.querySelectorAll('.inbox-meta .inbox-kind-ask').forEach(n => { if (n.textContent.trim() === 'Question') n.classList.add('inbox-implied-intro'); });
    if (row.waiting_kind === 'question' && message) {
        const text = document.createTreeWalker(message, NodeFilter.SHOW_TEXT).nextNode();
        if (text) text.textContent = text.textContent.replace(/^Wants to know:\s*/i, '');
    }
    if (row.goalDone && message && !tr.querySelector('.inbox-meta')) { const meta = document.createElement('span'); meta.className = 'inbox-meta'; meta.textContent = 'Goal looks done'; message.before(meta); }
    if (message && message.textContent.trim() && !/^(For review|Needs your answer)$/.test(message.textContent.trim())) message.classList.add('inbox-message');
    if (!mail && row.waiting_kind === 'question' && message) {
        const cli = tr.querySelector('td[data-key="cli"]');
        if (cli?.childNodes.length) {
            const meta = tr.querySelector('.inbox-meta') || document.createElement('span');
            if (!meta.parentNode) { meta.className = 'inbox-meta'; message.before(meta); }
            const runtime = document.createElement('span'); runtime.className = 'inbox-question-runtime'; runtime.append(...cli.childNodes); const dir = runtime.querySelector('.inbox-meta-dir'); if (dir) dir.before(document.createTextNode(' · ')); meta.append(runtime); cli.hidden = true;
        }
    }
    if (mail && message) { message.classList.add('inbox-v4-mail-message'); message.parentElement.classList.add('inbox-v4-mail-line'); }
    if ((row.operatorAsk || row.waiting_kind === 'question') && !tr.querySelector('.inbox-author-kind')) {
        const line = document.createElement('span'); line.className = 'inbox-author-kind';
        line.textContent = `${markHidden(row.operatorAsk?.asker || row.display_name || row.name || 'an agent', { strict: true })} · ${row.operatorAsk ? 'question' : 'prompt'}`;
        const meta = tr.querySelector('.inbox-meta') || document.createElement('span');
        if (message && !mail) { if (!meta.parentNode) { meta.className = 'inbox-meta'; message.before(meta); } meta.append(line); }
        else tr.querySelector('td[data-key="waiting"]')?.append(line);
    }
    if (!mail && !isPhoneLayout()) {
        const computer = tr.querySelector('td[data-key="server"]');
        if (computer?.textContent.trim()) {
            const meta = tr.querySelector('.inbox-sent-back-meta, .inbox-meta, .inbox-command-meta');
            if (meta) { const line = document.createElement('span'); line.className = 'inbox-computer-line'; line.append(...computer.childNodes); meta.prepend(line); computer.hidden = true; }
        }
    }
}
