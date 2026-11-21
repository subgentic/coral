/* Inbox v4 round 2: the actual message has its own box, metadata stays outside.
   Mark existing nodes rather than copying their text: links, expansion and accessible names survive. */
import { markHidden } from './visible_marks.js';
import { isPhoneLayout } from './phone_layout.js';
export function decorateMessage(row, tr) {
    const mail = tr.classList.contains('dt-mailed');
    if (mail) tr.classList.add('inbox-mail-preview-row');
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
    if ((row.operatorAsk || row.waiting_kind === 'question') && heading) {
        tr.classList.add('inbox-question-heading-row');
        if (!heading.querySelector('.inbox-heading-kind')) { const kind = document.createElement('span'); kind.className = 'inbox-heading-kind'; kind.textContent = ' · question'; heading.append(kind); }
    }
    if (!mail && isPhoneLayout() && row.board_project) {
        const item = heading?.closest('.inbox-review-item');
        if (item && !item.querySelector('.inbox-header-meta')) {
            const meta = document.createElement('span'); meta.className = 'inbox-header-meta';
            const board = document.createElement('span'); board.className = 'inbox-header-board'; board.textContent = markHidden(row.board_label || row.board_project, { strict: true });
            const time = item.querySelector('.inbox-review-wait'); if (time) time.before(meta); else item.append(meta); meta.append(board); if (time) meta.append(time);
        }
    }
    if (!mail && !isPhoneLayout()) {
        const computer = tr.querySelector('td[data-key="server"]'), team = tr.querySelector('td[data-key="team"]');
        if (computer?.textContent.trim() && team) { if (!team.textContent.includes(computer.textContent.trim())) team.prepend(...computer.childNodes); computer.hidden = true; }
    }
    for (const preview of [message, tr.querySelector('.inbox-sent-back-ask')].filter(Boolean)) {
        preview.classList.add('inbox-preview');
        const native = tr.querySelector('.inbox-ask-expand');
        if (native && !native.closest('.inbox-preview-controls')) { const controls = document.createElement('span'); controls.className = 'inbox-preview-controls'; const note = tr.querySelector('.inbox-ask-note'); if (note) controls.append(note); controls.append(native); const footer = mail && tr.querySelector('.inbox-mail-footer'); if (footer) footer.before(controls); else preview.after(controls); }
        let text = preview.querySelector(':scope > .inbox-preview-text');
        if (!text) { text = document.createElement('span'); text.className = 'inbox-preview-text'; text.append(...preview.childNodes); preview.append(text); }
        if (native) { preview.classList.toggle('inbox-preview-expanded', native.getAttribute('aria-expanded') === 'true'); continue; }
        if (preview.nextElementSibling?.classList.contains('inbox-preview-toggle')) continue;
        const more = document.createElement('button'); more.type = 'button'; more.className = 'btn btn-quiet btn-small inbox-preview-toggle'; more.textContent = 'Show all'; more.hidden = true; more.setAttribute('aria-expanded', 'false');
        more.addEventListener('click', e => { e.stopPropagation(); const open = preview.classList.toggle('inbox-preview-expanded'); more.textContent = open ? 'Show less' : 'Show all'; more.setAttribute('aria-expanded', String(open)); });
        const footer = mail && tr.querySelector('.inbox-mail-footer'); if (footer) footer.before(more); else preview.after(more);
        const observer = new ResizeObserver(() => { if (!preview.isConnected) { observer.disconnect(); return; } if (!preview.classList.contains('inbox-preview-expanded')) more.hidden = text.scrollHeight <= text.clientHeight + 1; });
        observer.observe(text); // Recheck on viewport/text-size changes; removal reports zero size and disconnects the observer.
    }
}
