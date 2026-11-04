/* Starting or waking an agent in the home folder itself (#13425): Coral answers 409 home_folder, and the person chooses "Launch anyway" (or "Wake anyway") or goes back to pick a project folder. A question,
 * never a refusal: the second request carries confirm_home_folder. */
import { showConfirmModal } from './confirm_dialog.js';

/** Whether an answer (a launch's {status, data}, a wake's status and body) is the home-folder question. */
export function isHomeFolderAsk(status, data) {
    return status === 409 && !!data && data.code === 'home_folder';
}

/** Asks the question; resolves true on "<verb> anyway", false on Cancel, Escape or a replaced dialog. */
export function askHomeFolder(verb, message, confirm = showConfirmModal) { // confirm: a test's stand-in for the dialog
    return new Promise(resolve => {
        let answered = false;
        const done = (v) => { if (!answered) { answered = true; resolve(v); } };
        confirm(`${verb} in your home folder?`, String(message || 'This agent will work in your whole home folder; pick a project folder?'), () => done(true), () => done(false),
            { danger: false, label: `${verb} anyway`, cancelLabel: 'Pick a folder' });
    });
}
