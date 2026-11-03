const { AUTO } = require('../resize_case_setup');
module.exports = `${AUTO}
    await(await import(S+'scheduler.js')).refreshJobs();await(await import(S+'scheduler.js')).selectScheduledJob(5); const table=document.querySelector('table[aria-label="Job runs"]')?.closest('.dt-box'); host.append(table); document.body.append(host);for(const child of [...document.body.children])if(child!==host)child.hidden=true;`;
