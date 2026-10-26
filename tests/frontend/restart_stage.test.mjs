// Restart's footer follows its step (#7779, the operator: "the restart agent should also have the user click next before showing the relaunch option"): on step 1 (the persona) Next is shown and Restart is not,
// on step 2 (the settings) Restart is shown and Next is not, Back appears on step 2 only, and going back hides Restart again. launchFlags.launchFromAnyStep (New Agent's switch too) puts Restart in both.
//   node restart_stage.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const { restartStage } = await importUi('controls');
const { launchFlags } = await importUi('launch_flags');
const footer = () => {
    const shown = id => !document.getElementById(id).hidden;
    return { stage: document.getElementById('restart-wizard').dataset.stage, back: shown('restart-back'), next: shown('restart-next'), go: shown('restart-go') };
};
document.getElementById('restart-wizard').dataset.who = 'QA Engineer';
restartStage('persona');
assert.deepEqual(footer(), { stage: 'persona', back: false, next: true, go: false }, 'step 1: Next, no Restart');
restartStage('next');
assert.deepEqual(footer(), { stage: 'agent', back: true, next: false, go: true }, 'step 2: Back and Restart, no Next');
restartStage('next');
assert.deepEqual(footer(), { stage: 'agent', back: true, next: false, go: true }, 'Next on the last step stays there');
restartStage('back');
assert.deepEqual(footer(), { stage: 'persona', back: false, next: true, go: false }, 'Back: step 1 again, Restart gone');
restartStage('back');
assert.equal(footer().stage, 'persona', 'Back on the first step stays there');
launchFlags.launchFromAnyStep = true;
restartStage('persona');
assert.deepEqual(footer(), { stage: 'persona', back: false, next: true, go: true }, 'the switch puts Restart on every step');
launchFlags.launchFromAnyStep = false;
assert.match(document.getElementById('restart-stage-sub').textContent, /^Step 1 of 2: Persona\. Restarting QA Engineer$/);
console.log('restart_stage: ok');
