// How a page that an address does not reach gets to the screen: a dialog, a Settings section. Each opener gets (page, seed, entry) and leaves the dialog open and settled. They click what a person
// clicks, by the dashboard's own action names (data-on-click), so a renamed button fails here, in the first run of a release, and not in a shot of the wrong page.
const act = name => `[data-on-click="${name}"]`;

async function clickVisible(page, selector, what) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { throw new Error(`no visible ${what} (${selector})`); });
    await loc.click();
}

/** Fires the dashboard's own action by clicking the control that carries it, wherever it is: a control that sits in a drawer off the screen at a middle width is still the dashboard's action. */
async function fire(page, selector, what) {
    const ok = await page.evaluate(sel => { const e = [...document.querySelectorAll(sel)].find(x => !x.disabled); if (!e) return false; e.click(); return true; }, selector);
    if (!ok) throw new Error(`no ${what} (${selector})`);
}

/** The gear's menu (on a phone the header's account menu: "Account and more" up to v2.0.7, the list's own m-top-menu button since the v2.0.8 phone redesign): open it, then click the entry. */
async function fromMenu(page, action, what) {
    const gear = page.locator(act('m-toggle-top-bar-settings')).filter({ visible: true });
    if (await gear.count()) await gear.first().click();
    else await clickVisible(page, 'button[aria-label="Account and more"], #mobile-agent-list [data-on-click="m-top-menu"]', 'the phone\'s account and more menu button');
    await clickVisible(page, act(action), what);
}

async function home(page, seed) { await page.goto(page.__base + '/agents', { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__coralReady); }

export const OPENERS = {
    async settings(page, seed, entry) {
        await home(page, seed);
        await fromMenu(page, 'm-close-top-bar-settings-then-show-settings-modal', 'Settings entry');
        await page.locator('#settings-modal').waitFor({ state: 'visible' });
        const tab = page.locator(`#settings-tab-${entry.group}`);
        if (await tab.isVisible().catch(() => false)) await tab.click();
        else { // a phone: the list of sections first, then the section
            const row = page.locator(`#settings-modal [data-group="${entry.group}"], #settings-modal #settings-tab-${entry.group}`).first();
            if (await row.count()) await row.click().catch(() => {});
        }
        await page.locator(`#settings-pane-${entry.group}`).waitFor({ state: 'visible' }).catch(() => {});
    },
    async themes(page, seed) { await home(page, seed); await fromMenu(page, 'm-close-top-bar-settings-then-show-theme-configurator', 'Themes entry'); await page.locator('#theme-configurator-modal').waitFor({ state: 'visible' }); },
    async newAgent(page, seed) { await home(page, seed); if (await page.locator('#phone-fab').filter({ visible: true }).count()) { // a phone: the round button opens a two-item menu
            await page.locator('#phone-fab').click();
            await clickVisible(page, '[role=menuitem]:has-text("New agent")', 'New agent menu item');
        } else await fire(page, '[data-on-click="launch-show"]', 'New agent button'); await page.locator('#launch-modal').waitFor({ state: 'visible' }); },
    async newTeam(page, seed) {
        await home(page, seed);
        if (await page.locator('#phone-fab').filter({ visible: true }).count()) {
            await page.locator('#phone-fab').click();
            await clickVisible(page, '[role=menuitem]:has-text("New team")', 'New team menu item');
        } else {
            await fire(page, '[data-on-click="launch-show"]', 'New agent button');
            await page.locator('#launch-modal').waitFor({ state: 'visible' });
            await clickVisible(page, `#launch-modal ${act('m-select-launch-type')}[data-arg="team"]`, 'New team card');
        }
        await page.locator('#team-wizard-modal, #launch-modal').first().waitFor({ state: 'visible' });
    },
    async openFolder(page, seed) { await OPENERS.newAgent(page, seed); await fire(page, '#launch-type-open-folder', 'Open folder card'); await page.locator('#open-folder-modal').waitFor({ state: 'visible' }); },
    async updateDialog(page, seed) { // the stubbed status makes the top bar offer "Update and relaunch": its click opens the dialog
        await home(page, seed);
        await page.locator('#update-pill').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}); // the status answer makes it appear; a phone keeps it in a menu, so go on after the wait
        await page.waitForTimeout(500);
        await fire(page, '#update-pill', 'Update and relaunch button');
        await page.locator('#update-confirm-modal').waitFor({ state: 'visible', timeout: 10000 });
    },
    async jump(page, seed) { await home(page, seed); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); await page.locator('#jump-modal').waitFor({ state: 'visible', timeout: 8000 }); },
    async newJob(page, seed) { await page.goto(page.__base + '/automations/jobs', { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__coralReady); await clickVisible(page, 'button:has-text("New job")', 'New job button'); await page.locator('#job-modal').waitFor({ state: 'visible' }); },
    async newTask(page, seed) { await page.goto(`${page.__base}/team/${seed.teams[0].name}/tasks`, { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__coralReady); await clickVisible(page, 'button:has-text("New task")', 'New task button'); await page.locator('#create-task-modal').waitFor({ state: 'visible' }); },
    // the Mobile QR code is not on Home any more (the operator, #11414): its button is by the API key in Settings > Security
    async mobileConnect(page, seed) { await OPENERS.settings(page, seed, { group: 'security' }); await fire(page, `#settings-modal ${act('m-show-mobile-connect-modal')}`, 'Mobile QR button by the API key'); await page.locator('#mobile-connect-modal').waitFor({ state: 'visible' }); },
    // the CSV viewer (#11382): the seeded phone-pass.csv, opened from the Inbox's Artifacts as a person opens it
    async csvViewer(page, seed) {
        await page.goto(page.__base + '/inbox/artifacts', { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__coralReady);
        const row = page.locator('#group-table-view button, #group-table-view a').filter({ hasText: 'phone-pass.csv' }).filter({ visible: true }).first();
        await row.waitFor({ state: 'visible', timeout: 10000 }).catch(() => { throw new Error('no phone-pass.csv in the Inbox Artifacts (seed.mjs uploads it)'); });
        await row.click();
        await page.locator('.csv-view .csv-status').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => { throw new Error('the CSV table did not open (.csv-view)'); });
    },
    async teamSettings(page, seed) { await page.goto(`${page.__base}/team/${seed.teams[0].name}`, { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__coralReady); 
        const header = page.locator('.team-page-actions button:has-text("Settings"), #team-page-actions button:has-text("Settings")').filter({ visible: true });
        if (await header.count()) await header.first().click();
        else { await fire(page, '#team-page-more', 'Actions menu button'); await fire(page, '#team-page-more-settings', 'Settings menu item'); } // a phone: Actions, then Settings
        await page.locator('#team-settings-modal, .modal:has-text("Team settings")').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    },
    async welcome(page) { await page.goto(page.__base + '/agents', { waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__coralReady); },
};
