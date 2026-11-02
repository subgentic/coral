// The Windows server answers GET /api/system/cli-check?type=hermes with `supported: false` and one line (Hermes is not offered there, #12038), and the pickers then draw no Hermes card or option and add that line.
// A suite that counts the dialog's words or pins its markup is written from the other servers' answer, so it asks for the page to see Hermes the way those servers' answer lands, and the same suite is green on every OS
// (#12398: launch_text_budget 75 words vs 72 and settings_html_pin, red on Windows since v2.0.34). `found` is what the page is told: false (not installed) for a suite that waits for the CLI checks to answer, as the budget does;
// null (the check could not say) for a suite that draws a form and reads it before the answers arrive, as the pin does: a real answer of not installed lands after the snapshot, so the golden has no mark. The Windows answer
// itself is provider_cards_hermes_browser's. Call it after the page is installed and before the form is drawn.
const osNeutralCli = (ev, found = false) => ev(`(() => { const R = window.fetch;
    window.fetch = async (u, o = {}) => { const r = await R(u, o), url = new URL(String(u), location.origin);
        if (url.pathname !== '/api/system/cli-check' || url.searchParams.get('type') !== 'hermes' || !r.ok) return r;
        const d = await r.clone().json().catch(() => null); if (!d || d.supported !== false) return r;
        return new Response(JSON.stringify({ agent_type: 'hermes', found: ${JSON.stringify(found)} }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    return true; })()`);
module.exports = { osNeutralCli };
