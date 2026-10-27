/* Workflows: Build with Agent and Edit with Agent (moved out of workflows.js, #8360; no behaviour change). */

import { showToast } from './utils.js';
import { apiFetch, loadLiveSessions } from './api.js';
import { selectLiveSession } from './sessions.js';

// ── Build with Agent ──────────────────────────────────────────────────

// Workflows are hub-local (definitions, runs and the builder prompt all live on
// the hub), so these agents always launch on the hub itself, in the hub's coral
// root. They intentionally do not use the multi-server launch picker.

export async function launchWorkflowAgent() {
    const btn = document.activeElement?.closest?.('[data-on-click="wf-build-agent"]') || document.getElementById('wf-build-agent-btn'); // the empty page's button or the table head's
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:var(--fs-xl)" aria-hidden="true">hourglass_top</span> Launching\u2026'; }

    try {
        // Fetch the skill prompt
        const doc = await apiFetch('/api/agent-docs/workflow-builder');
        if (!doc || !doc.content) {
            showToast('Workflow builder skill not found', true);
            return;
        }

        // Get default working directory from body data attribute
        const workingDir = document.body.dataset.coralRoot || '';
        if (!workingDir) {
            showToast('Could not determine working directory', true);
            return;
        }

        const resp = await fetch('/api/sessions/launch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                working_dir: workingDir,
                agent_type: 'claude',
                display_name: 'Workflow Builder',
                prompt: doc.content,
                capabilities: { allow: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'] },
            }),
        });

        const result = await resp.json();
        if (result.error) {
            showToast(result.error, true);
            return;
        }

        showToast('Launched: Workflow Builder'); // the name it was sent with (the list shows it), not the session's raw id (#5895)

        // Switch to agents tab and navigate to the new session
        setTimeout(async () => {
            await loadLiveSessions();
            if (window.switchNavTab) window.switchNavTab('agents');
            selectLiveSession(result.session_name, 'claude', result.session_id);
        }, 1500);
    } catch (e) {
        showToast('Failed to launch workflow agent', true);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:var(--fs-xl)" aria-hidden="true">smart_toy</span> Build with Agent'; }
    }
}

export async function editWorkflowWithAgent(workflowId) {
    try {
        // Fetch the workflow details and skill prompt in parallel
        const [wfResp, doc] = await Promise.all([
            apiFetch(`/api/workflows/${workflowId}`),
            apiFetch('/api/agent-docs/workflow-builder'),
        ]);
        if (!doc || !doc.content) { showToast('Workflow builder skill not found', true); return; }
        if (!wfResp) { showToast('Could not load workflow', true); return; }

        const workingDir = document.body.dataset.coralRoot || '';
        if (!workingDir) { showToast('Could not determine working directory', true); return; }

        // Build an edit-specific prompt with the current workflow context
        const wfJSON = JSON.stringify(wfResp, null, 2);
        const editPrompt = `${doc.content}

---

## Current Task: Edit an Existing Workflow

The user wants to modify an existing workflow. Here is the current workflow definition (ID: ${workflowId}):

\`\`\`json
${wfJSON}
\`\`\`

**Instructions:**
1. Start by showing the user a summary of this workflow — its name, description, steps, and what each step does
2. Ask what they'd like to change (add/remove/modify steps, change prompts, add hooks, adjust timeouts, etc.)
3. After confirming the changes, update the workflow using: \`curl -X PUT http://localhost:\${CORAL_PORT}/api/workflows/${workflowId} -H 'Content-Type: application/json' -d '...'\`
4. Offer to trigger a test run and help debug if anything fails
5. To update the workflow, use PUT (not POST) since it already exists`;

        const resp = await fetch('/api/sessions/launch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                working_dir: wfResp.repo_path || workingDir,
                agent_type: 'claude',
                display_name: `Edit: ${wfResp.name}`,
                prompt: editPrompt,
                capabilities: { allow: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'] },
            }),
        });

        const result = await resp.json();
        if (result.error) { showToast(result.error, true); return; }

        showToast(`Launched: Edit ${wfResp.name}`);
        setTimeout(async () => {
            await loadLiveSessions();
            if (window.switchNavTab) window.switchNavTab('agents');
            selectLiveSession(result.session_name, 'claude', result.session_id);
        }, 1500);
    } catch (e) {
        showToast('Failed to launch workflow edit agent', true);
    }
}
