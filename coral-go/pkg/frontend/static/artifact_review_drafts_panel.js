/* The private part of a document's comments panel. All content uses text nodes. */
import { el } from './dom_el.js';
const { commentIcon } = await importOnce('./artifact_comment_actions.js');
import { importOnce } from './import_once.js';
const bidi = await importOnce('./bidi_marks.js').catch(() => null);
const markBidi = bidi ? bidi.markBidi : node => node;
const { commentImageUrl } = await importOnce('./artifact_comments_api.js');
const editors = new WeakMap();
export function draftPanel({ review, run, refresh, server, composing, bar }) {
    const snapshot = review.snapshot(), data = snapshot.data;
    const host = el('section', 'ac-review-drafts');
    if (!data?.drafts_supported) return host;

    for (const draft of data.drafts || []) {
        const card = el('div', 'ac-draft-card');
        const author = el('div', 'ac-draft-author');
        author.append(markBidi(el('strong', '', draft.source === 'gdoc' ? `${draft.source_name || 'Someone'} · Google Docs` : 'You')), el('span', 'ac-draft-label', 'Draft · only you')); card.append(author);
        const parent = (data.drafts || []).find(item => item.id === draft.parent_draft_id);
        const quote = draft.anchor?.quote || (parent ? `Reply to: ${parent.body}` : '') || (draft.parent_draft_id ? 'Reply to a draft comment' : draft.parent_id ? 'Reply to a published thread' : 'Whole document');
        card.append(markBidi(el('blockquote', '', quote)), markBidi(el('p', '', draft.body)));
        for (const picture of draft.images || []) {
            if (!/^[a-f0-9]{64}$/.test(picture.hex)) continue;
            const link = el('a', 'ac-pic-link'), image = el('img', 'ac-pic-img');
            link.href = commentImageUrl(picture.hex, server); link.target = '_blank'; link.rel = 'noopener';
            image.src = link.href; image.alt = picture.name || 'Picture in draft comment'; image.loading = 'lazy'; link.append(image); card.append(link);
        }
        const button = (label, action) => { const b = el('button', 'btn', label); b.type = 'button'; b.disabled = snapshot.busy || composing || !data.can_write || !!snapshot.pending; b.addEventListener('click', action); return b; };
        const editForm = () => {
            const editor = editors.get(review);
            const input = el('textarea', 'ac-input'); input.value = editor.body; input.dataset.focusId = `draft-${draft.id}`; input.setAttribute('aria-label', 'Edit draft comment'); input.maxLength = 8192;
            input.addEventListener('input', () => { editor.body = input.value; });
            card.replaceChildren(input, button('Save draft', () => run(async () => {
                await review.edit(draft.id, { body: input.value, images: (draft.images || []).map(i => i.hex) }); editors.delete(review);
            }, 'Draft saved. Not sent.')), button('Cancel edit', () => { editors.delete(review); refresh(); }));
            return input;
        };
        if (editors.get(review)?.id === draft.id) editForm();
        else {
            const tools = el('span', 'ac-comment-tools');
            tools.append(commentIcon(button('Edit', () => {
            editors.set(review, { id: draft.id, body: draft.body }); editForm().focus();
            }), 'Edit', draft.source === 'gdoc' ? (draft.source_name || 'Someone') : 'You'), commentIcon(button('Delete', () => run(() => review.remove(draft.id), 'Draft deleted')), 'Delete', draft.source === 'gdoc' ? (draft.source_name || 'Someone') : 'You'));
            author.append(tools);
        }
        host.append(card);
    }
    bar.replaceChildren();
    bar.hidden = !data.count && !snapshot.pending;
    const count = data.count || 0;
    bar.append(el('strong', '', count === 1 ? '1 comment not sent' : `${count} comments not sent`));
    bar.append(el('span', 'ac-draft-privacy', 'Draft review · only you can see it'));
    const targets = data.targets || [];
    if (targets.length > 3) {
        const recipients = el('details', 'ac-draft-recipients');
        const summary = markBidi(el('summary', '', `To: ${targets[0]}, ${targets[1]} and ${targets.length - 2} more`));
        summary.title = targets.join(', ');
        recipients.append(summary, markBidi(el('span', '', targets.join(', ')))); bar.append(recipients);
    } else if (targets.length) bar.append(markBidi(el('span', 'ac-draft-recipients', `To: ${targets.join(', ')}`)));
    const send = el('button', 'btn btn-primary', snapshot.pending ? 'Retry pending send' : 'Send comments'); send.type = 'button';
    send.disabled = (!count && !snapshot.pending) || (!data.can_send && !snapshot.pending) || snapshot.busy || composing;
    send.addEventListener('click', () => run(async () => { const outcome = await review.send(); return outcome.status === 'queued' ? { queuedFor: data.targets?.join(', ') || 'the agent' } : (data.targets?.join(', ') || ''); }, 'Review comments sent'));
    bar.append(send);
    if (composing) bar.append(el('p', '', 'Save or cancel the comment you are writing before sending.'));
    if (!data.can_send && count) bar.append(el('p', '', ({ no_uploader: 'No agent is recorded as the uploader of this file.', ambiguous_uploader: 'More than one agent uploaded this file, so Coral cannot choose who should receive the review.', no_board: 'This file has no team available to receive the review.', no_agent: 'No agent is available to receive this review.', board_paused: 'The team is paused.', comments_locked: 'Comments are locked.' }[data.reason] || 'Sending is not available here yet.') + ' Your drafts stay saved.'));
    return host;
}
