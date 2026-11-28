// A backlog task (#22048, task add --later): parked for later with no end. Its state word is Backlog, never Queued or Waiting: a bare claim skips it and its assignee claims it by number. Lazy modules only (the start bundle is net zero).
import { taskStatusWord, isParked } from './goal_words.js';

export const isBacklog = (t) => !!(t && t.parked_reason === 'backlog' && !t.parked_until);
/** The state word of task t as the tables say it; `review` is a completion review pending. */
export const statusWord = (t, review) => (isBacklog(t) && t.status !== 'completed' && t.status !== 'skipped' && !review ? 'Backlog' : taskStatusWord(t.status, review, isParked(t)));
