const { AUTO } = require('../resize_case_setup');
module.exports = { selector: '#group-table-view', setup: `${AUTO}
    await (await import(S+'scheduler.js')).refreshJobs();await(await import(S+'workflows.js')).refreshWorkflows();await(await import(S+'automation_runs.js')).refreshRuns(true);window.switchNavTab('automations');await(await import(S+'automations.js')).openAutomationsRoute({folder:'failed'});` };
