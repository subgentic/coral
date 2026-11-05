// #13503: through the Coral Hub a goal create, close and update is previewed first when the Hub's boot value goal_preview is true: POST /api/remote/<computer>/api/hub/goal-preview with the exact text of the write, then the write with
// X-Hub-Goal-Preview and the SAME bytes; every write is previewed again; the Hub's words are plain sentences in the editor. With the boot value absent the goal writes go out as today (no preview, no header).
const { run } = require('./helpers/hub_goal_preview_run');
run(true).catch(e => { console.error(e); process.exit(1); });
