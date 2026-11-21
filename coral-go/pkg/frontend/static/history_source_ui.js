/* The linked-computer chooser for the cloud Chats page. */
import { state } from './state.js';
import { isCloud } from './server_base.js';
import { historyServer, setHistorySource } from './history_source.js';
import { filterState } from './search_filters.js';
import { importOnce } from './import_once.js';
import { setHistoryPage } from './history_state.js';

let drawnSource = null;
export async function refreshHistorySource() {
    const row = document.getElementById('history-computer-row');
    if (!row) return;
    row.hidden = !isCloud();
    if (!isCloud()) return;
    const server = historyServer();
    if (server !== drawnSource) {
        drawnSource = server;
        importOnce('./history_filters.js').then(m => m.populateHfTagSelect());
    }
    const { computerBar } = await importOnce('./computer_bar.js'), { machineChoices } = await importOnce('./analytics_machine.js');
    row.replaceChildren(computerBar({ id: 'history-computer', choices: machineChoices(), current: server || '', onPick: pickHistorySource }));
}

async function pickHistorySource(id) {
    if (!setHistorySource(id)) return;
    (await importOnce('./analytics_machine.js')).pickMachine(id); // the choice is shared by every per-computer page (#20207)
    if (state.currentSession?.type === 'history') state.currentSession = null;
    state.historySessionsList = [];
    filterState.tagIds = []; // tag ids belong to their computer
    document.getElementById('hf-tag-pills')?.replaceChildren();
    setHistoryPage(1);
    window.switchNavTab?.('history');
}
