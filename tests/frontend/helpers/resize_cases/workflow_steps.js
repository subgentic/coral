const { AUTO } = require('../resize_case_setup');
module.exports = `${AUTO}
    await(await import(S+'workflows.js')).selectWorkflow(7); const table=document.querySelector('table[aria-label="Workflow steps"]')?.closest('.dt-box'); host.append(table); document.body.append(host);for(const child of [...document.body.children])if(child!==host)child.hidden=true;`;
