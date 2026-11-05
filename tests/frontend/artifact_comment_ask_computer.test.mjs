// #13687 (the Operator: 'Send to agent' on a file an agent of their team posted for review, the agent running on a remote computer of their self-hosted Hub, said 'No agent on this board can be asked.'):
// the picker asks for the team's agents on the computer the FILE is on. A team of a remote computer is read as '@<computer>/<team>': the bare board id went to this computer, which has no such board and answers an empty list.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { registerBundled } = await importUi('import_once');
const asked = [];
registerBundled({
    'artifact_comments_api.js': { listComments: async () => ({ comments: [], canComment: true, canLock: true }), sendComment: async () => ({ results: [] }) },
    'artifact_comment_send.js': { MAX_AGENTS: 10, pickableAgents: () => [], askedWords: () => '', buildSendBlock: () => { const e = document.createElement('div'); e.className = 'ac-ask'; return e; } },
    'artifact_comment_send_queue.js': { sendCommentQueue: async () => ({}) },
    'agent_link.js': { agentLink: () => document.createElement('a') },
    'team_availability.js': { refreshTeamAvailability: async team => { asked.push(team); return { agents: [] }; } },
});
const { state } = await importUi('state'); state.servers = [{ id: 'A', owner_stamp: true }];
const { createAsk } = await importUi('artifact_comment_ask');
let st, ask;
registerBundled({ 'artifact_comment_ask.js': { createAsk: opts => { st = opts.st; ask = createAsk(opts); return ask; } } });
const { attachComments } = await importUi('artifact_comments');
for (const [server, expected] of [['A', '@A/team-a'], [undefined, 'team-a'], ['local', 'team-a']]) {
    const dialog = document.createElement('div'), body = document.createElement('div'), host = document.createElement('div'); dialog.append(body, host); document.body.append(dialog);
    const panel = attachComments(dialog, body, host); panel.open('current', server, 'team-a'); st.data = { canLock: true, comments: [] };
    asked.length = 0;
    await ask.openMany([{ id: 1 }]);
    assert.deepEqual(asked, [expected], `the team's agents are asked of ${server ?? 'this computer'} as ${expected}`);
    panel.close(); dialog.remove();
}
console.log('artifact_comment_ask_computer: the picker reads the agents on the computer the file is on');
