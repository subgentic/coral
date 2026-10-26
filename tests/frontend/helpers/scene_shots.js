// Per-scene evidence goes beside the CDP gate's uploaded output; local runs may choose their own folder.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function sceneShots(Page, prefix = '') {
    const dir = process.env.CORAL_SCREENSHOT_DIR || process.env.T200_SHOTS || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'out', 'shots') : '');
    return async name => {
        if (!dir) return;
        fs.mkdirSync(dir, { recursive: true });
        const label = [prefix, name].filter(Boolean).join('-').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        const shot = await Page.captureScreenshot({ format: 'png' });
        fs.writeFileSync(path.join(dir, `${label}.png`), Buffer.from(shot.data, 'base64'));
    };
};
