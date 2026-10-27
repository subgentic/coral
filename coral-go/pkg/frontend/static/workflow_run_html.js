/* Workflows: the markup of a run's page: its header line, progress bar and step timeline (moved out of workflows.js, #8360; no behaviour change). Pure builders: a run in, escaped HTML out. */

import { escapeHtml as esc, escapeAttr as escAttr } from './utils.js';
import { compactDuration } from './format.js';
import { reasonWords } from './job_words.js';

export function formatTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch (_) {
        return ts.slice(0, 16);
    }
}

// A step's state in words, for a reader: the mark beside it is a glyph (#6639).
const STEP_WORDS = { completed: 'Passed', running: 'Running', failed: 'Failed', killed: 'Stopped', skipped: 'Skipped' };

function statusIconChar(status) {
    switch (status) {
        case 'completed': return '&#10003;';
        case 'running': return '&#9654;';
        case 'failed': return '&#10007;';
        case 'killed': return '!';
        case 'skipped': return '&#8212;';
        default: return '&#8226;';
    }
}

/** Why a run failed, as the run page says it: the Jobs pages' words with a capital ("Step 2 (Test) exited with 3"). */
export function runErrorWords(msg) {
    const w = reasonWords({ error_msg: String(msg || '').trim() });
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
}

/** How a run was started, in words (the server's trigger_type is a code: "ui", "schedule", "api"). */
export function triggerWords(type) {
    const t = String(type || '').trim();
    return ({ ui: 'Run by you', manual: 'Run by you', schedule: 'On schedule', api: 'Started by an API call', job: 'Run by a job' })[t] || (t ? `Started by ${t}` : 'Started by an API call');
}

/** The run's elapsed time as words for the meta line: "took 2s" when it has ended, "running 5s" while it goes; '' for a run that has not started. */
export function runElapsedWords(run) {
    if (!run.started_at) return '';
    const end = run.finished_at ? new Date(run.finished_at) : new Date();
    const sec = Math.max(0, Math.round((end - new Date(run.started_at)) / 1000));
    return `${run.finished_at ? 'took' : 'running'} ${compactDuration(sec)}`;
}

/** The run's elapsed time, or '' for a run that has not started. */
export function runDurationHtml(run) {
    let durationHtml = '';
    if (run.started_at) {
        const endTime = run.finished_at ? new Date(run.finished_at) : new Date();
        const durSec = Math.round((endTime - new Date(run.started_at)) / 1000);
        durationHtml = `<span><span class="material-icons" aria-hidden="true">hourglass_empty</span> ${compactDuration(durSec)}</span>`;
    }
    return durationHtml;
}

/** The progress bar and its "n/m steps" line, or '' for a run with no steps. */
export function runProgressHtml(run, steps) {
    const completedCount = steps.filter(s => s.status === 'completed').length;
    const totalSteps = steps.length;
    const progressPct = totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 0;
    return totalSteps > 0 ? `
        <div class="wf-progress">
            <div class="wf-progress-bar">
                <div class="wf-progress-fill ${esc(run.status)}" style="width:${progressPct}%"></div>
            </div>
            <span class="wf-progress-text">${completedCount}/${totalSteps} steps</span>
        </div>` : '';
}

/** One step of the timeline: its mark, name, type, exit code, agent link, timing, output, error tail and files. `count` is how many steps the run has. */
export function runStepHtml(run, s, i, count) {
        const icon = statusIconChar(s.status);
        const iconClass = s.status || 'pending';
        const isLast = i === count - 1;

        let timingHtml = '';
        if (s.started_at && s.finished_at) {
            const dur = Math.round((new Date(s.finished_at) - new Date(s.started_at)) / 1000);
            timingHtml = `<span class="wf-run-step-timing">${compactDuration(dur)}</span>`;
        } else if (s.started_at) {
            const elapsed = Math.round((new Date() - new Date(s.started_at)) / 1000);
            timingHtml = `<span class="wf-run-step-timing wf-timing-active">${compactDuration(elapsed)}...</span>`;
        }

        const isFailed = s.status === 'failed' || s.status === 'killed';

        // Exit code badge for shell steps
        let exitCodeHtml = '';
        if (s.type === 'shell' && s.exit_code != null) {
            const ecClass = s.exit_code === 0 ? 'wf-exit-ok' : 'wf-exit-err';
            exitCodeHtml = `<span class="wf-exit-code ${ecClass}">exit ${s.exit_code}</span>`;
        }

        // Output section — auto-expanded for failed steps
        let outputHtml = '';
        if (s.output_tail) {
            const outputId = `wf-step-output-${run.id}-${i}`;
            const autoExpand = isFailed ? ' wf-expanded' : '';
            const first = String(s.output_tail).split('\n').map(l => l.trim()).find(Boolean) || ''; // a closed step says what its output began with (#7156)
            const peek = first ? `<span class="wf-run-step-peek">${esc(first.length > 120 ? first.slice(0, 119) + '…' : first)}</span>` : '';
            outputHtml = `
                <button type="button" class="wf-run-step-output-toggle" aria-expanded="${escAttr(isFailed)}" aria-controls="${escAttr(outputId)}" aria-label="${escAttr('Output of ' + (s.name || 'step ' + (i + 1)))}" data-on-click="wf-output-toggle">
                    <span class="material-icons" style="font-size:var(--fs-lg)" aria-hidden="true">terminal</span> Output${peek}
                    <span class="material-icons wf-toggle-arrow" style="font-size:var(--fs-lg)" aria-hidden="true">expand_more</span>
                </button>
                <div id="${escAttr(outputId)}" class="wf-run-step-output${autoExpand}">${esc(s.output_tail)}</div>`;
        }
        // Why a step failed: the end of its stderr, always shown (stderr.txt is still in the file list).
        if (isFailed && s.error_tail && s.error_tail.trim()) {
            outputHtml += `
                <div class="wf-run-step-error-label"><span class="material-icons" style="font-size:var(--fs-lg)" aria-hidden="true">error_outline</span> Error output</div>
                <div class="wf-run-step-output wf-expanded wf-run-step-error">${esc(s.error_tail.replace(/\s+$/, ''))}</div>`;
        }

        // File list for steps with artifacts
        let filesHtml = '';
        const files = s.files || [];
        if (files.length > 0) {
            const fileItems = files.map(f => `<span class="wf-step-file">${esc(f)}</span>`).join('');
            filesHtml = `<details class="wf-step-files-more"><summary aria-label="${escAttr('Files of ' + (s.name || 'step ' + (i + 1)))}">Files</summary><div class="wf-step-files">${fileItems}</div></details>`; // exit_code, stderr.txt, stdout.txt: the way to the files, not the face of the step (#7156)
        }

        // Session link for agent steps
        let agentHtml = '';
        if (s.type === 'agent' && s.session_id) {
            agentHtml = `<button type="button" class="wf-step-agent-link" data-on-click="wf-step-agent" data-session="${escAttr(s.session_name || s.session_id)}" aria-label="${escAttr('View agent of ' + (s.name || 'step ' + (i + 1)))}">
                <span class="material-icons" style="font-size:var(--fs-md)" aria-hidden="true">open_in_new</span> View agent
            </button>`;
        }

        return `<div class="wf-run-step ${isLast ? '' : 'wf-run-step-connected'}">
            <div class="wf-timeline-node ${iconClass}"></div>
            <div class="wf-run-step-content${isFailed ? ' wf-step-failed' : ''}">
                <div class="wf-run-step-header">
                    <span class="wf-run-step-status ${iconClass}" role="img" aria-label="${escAttr(STEP_WORDS[s.status] || 'Waiting')}">${icon}</span>
                    <span class="wf-run-step-name"><span class="sr-only">Step ${i + 1}: </span>${esc(s.name || 'Step ' + (i + 1))}</span>
                    <span class="wf-step-type">${esc(s.type || '')}</span>
                    ${exitCodeHtml}
                    ${agentHtml}
                    ${timingHtml}
                </div>
                ${outputHtml}
                ${filesHtml}
            </div>
        </div>`;
}

/** The run's meta line: its state, trigger, start, duration, finish and why it failed. */
export function runMetaHtml(run, signInFailure, errorExcerpt) {
    // One line of words: the state, how it started, "Started 05:40, took 2s" (the finish time is the line's tooltip), and why it failed (#9294, the Operator's audit)
    const elapsed = runElapsedWords(run);
    return `
        <div class="wf-run-meta">
            <span><span class="chip wf-status-badge ${esc(run.status)}">${esc(run.status)}</span></span>
            <span>${esc(triggerWords(run.trigger_type))}</span>
            ${run.started_at ? `<span${run.finished_at ? ` title="${escAttr('Finished ' + formatTime(run.finished_at))}"` : ''}>Started ${esc(formatTime(run.started_at))}${elapsed ? `, ${esc(elapsed)}` : ''}</span>` : ''}
            ${signInFailure ? `<span class="wf-run-error" style="color:var(--error-text)"><span class="material-icons" aria-hidden="true">error</span> ${signInFailure}</span>` : run.error_msg ? `<span class="wf-run-error" style="color:var(--error-text)"><span class="material-icons" aria-hidden="true">error</span> <span class="wf-run-error-text">${esc(runErrorWords(run.error_msg))}${errorExcerpt ? `<span class="wf-run-error-excerpt">: ${esc(errorExcerpt)}</span>` : ''}</span></span>` : ''}
        </div>`;
}
