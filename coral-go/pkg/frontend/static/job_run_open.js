/* A job run's "See result" (#10378, #17186): its conversation opens with the way back being the job it came from, not All chats; a run with no conversation says why (history_note.js). Lazy: the Automations page
   hands it the run's session, its job and what Retry does, and the start path carries none of this. */
import { noChat } from './history_note.js';

export async function openRun(sid, job, retry) {
    if (await window.selectHistorySession(sid) === false) return noChat(retry);
    if (!job) return;
    const back = document.getElementById('history-back');
    if (back) { back.hidden = false; back.textContent = `← ${job.name}`; back.setAttribute('data-on-click', 'job-result-back'); back.dataset.jobId = String(job.id); }
    const phoneBack = document.querySelector('.mobile-history-back'); // a phone shows its own back control, not that one (#10578)
    if (phoneBack) { phoneBack.textContent = `← ${job.name}`; phoneBack.setAttribute('aria-label', `Back to ${job.name}`); phoneBack.setAttribute('data-on-click', 'job-result-back'); phoneBack.dataset.jobId = String(job.id); }
}
