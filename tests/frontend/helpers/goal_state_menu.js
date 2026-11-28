// Exercise the visible State menu rather than the former tabs/select.
module.exports.pickGoalState = async (ev, waitFor, key) => {
    await ev(`document.querySelector('.gl-state-menu>button').click();true`);
    await waitFor(`document.querySelector('.gl-state-menu [role=menu]:not([hidden])')`, 'State menu opens');
    await ev(`(()=>{const label=${JSON.stringify(key==='all'?'All':key[0].toUpperCase()+key.slice(1))};[...document.querySelectorAll('.gl-state-menu [role=menuitemcheckbox]')].find(b=>b.textContent.startsWith(label+' ')).click();return true})()`);
};
