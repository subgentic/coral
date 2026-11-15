import { importOnce } from './import_once.js';

/** The Restart dialog, opened with the model or level chosen in the chip filled in (#4969); `running` is the agent's row. */
export async function viaRestart(change, running) {
    window.restartSession();
    for (let i = 0; i < 50 && !document.querySelector('#restart-acf .acf-model'); i++) await new Promise(r => setTimeout(r, 100));
    const { setAgentConfig, getAgentConfig } = await importOnce('./agent_config_form.js');
    const cfg = getAgentConfig('restart-acf');
    // The choice, over what the agent runs now: a level chosen for a model it is not yet on belongs to the model it is on.
    setAgentConfig('restart-acf', {
        ...cfg,
        model: change.model !== undefined ? change.model : (running.model || cfg.model),
        ...(change.thinking !== undefined ? { thinking: change.thinking } : {}),
    });
}
