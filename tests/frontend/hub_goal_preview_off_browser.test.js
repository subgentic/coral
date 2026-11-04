// #13503: without the Hub's goal_preview boot value (a computer's own dashboard, the self-hosted Hub) the goal writes go out as they always did: no preview call, no X-Hub-Goal-Preview header.
const { run } = require('./helpers/hub_goal_preview_run');
run(false).catch(e => { console.error(e); process.exit(1); });
