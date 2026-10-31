/* The "How agents ask you for things" read of the new-user Inbox (#11443): its own file so the start does not carry the text. */
import { showConfirmModal } from './confirm_dialog.js';

const ASKS_TEXT = 'When an agent needs a decision it appears in Needs you with its question: a permission to allow, a question to answer, a plan to approve, or a dialog in its terminal that needs one click. A review artifact an agent made waits there too, marked For review. Answer from the list or open the agent. Once answered, the item leaves.';

/** Show the read; closing it either way counts as read. */
export function readAsks(title, done) { showConfirmModal(title, ASKS_TEXT, done, done, { label: 'Got it', cancelLabel: 'Close', danger: false }); }
