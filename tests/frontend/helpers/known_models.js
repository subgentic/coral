'use strict';
// A known model list for suites that pin markup or requests drawn from a model picker (settings_html_pin, dialog_requests_golden).
//
// The server keeps each CLI family's model list (agentmodels), and a suite earlier on the same shard can leave a stand-in CLI's list there (helpers/stand_in_agent.js answers the
// model-list call). The browser also keeps the lists it was given (model_labels.js, coral-models:v1:*). So what a picker shows depends on which suites ran before. KNOWN_MODELS
// makes it the built-in list every time: it forgets the browser's cached lists, and it answers GET /api/agents/models with the server's own answer (its thinking levels and the
// rest) whose models are the curated ids of GET /api/agent-models, named as the server names its built-in list. Load it with Page.addScriptToEvaluateOnNewDocument before
// the page loads. Test code only: Coral's own behaviour is unchanged.

// The names the server gives its built-in list (agentmodels.builtinDisplayNames); any other model shows its id, as there.
const BUILTIN_NAMES = {
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'claude-haiku-5-5': 'Claude Haiku 5.5',
    'claude-fable-5-1': 'Claude Fable 5.1',
};

const KNOWN_MODELS = `(() => {
    if (window.__knownModels) return;
    window.__knownModels = true;
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('coral-models:v1:')) localStorage.removeItem(k); } } catch { /* no storage: nothing cached */ }
    const NAMES = ${JSON.stringify(BUILTIN_NAMES)};
    const real = window.fetch.bind(window);
    let curated = null;
    window.fetch = async (input, init = {}) => {
        const url = String(input && input.url || input), method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        let u; try { u = new URL(url, location.href); } catch { return real(input, init); }
        if (method !== 'GET' || u.pathname !== '/api/agents/models') return real(input, init);
        const resp = await real(input, init);
        if (!resp.ok) return resp;
        const data = await resp.clone().json().catch(() => null);
        if (!data || !Array.isArray(data.models)) return resp;
        if (!curated) curated = await real('/api/agent-models').then(r => r.ok ? r.json() : {}).catch(() => ({}));
        const ids = curated[u.searchParams.get('type')] || [];
        const known = Object.assign({}, data, { models: ids.map(id => ({ value: id, display_name: NAMES[id] || id })), source: 'builtin', fetched_at: null, refreshing: false });
        delete known.error;
        return new Response(JSON.stringify(known), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
})()`;

module.exports = { KNOWN_MODELS, BUILTIN_NAMES };
