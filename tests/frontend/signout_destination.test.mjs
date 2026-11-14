// #17344: local sign-out returns to local auth, Hub sign-out keeps Hub auth.
import assert from 'node:assert/strict';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
installDom({mode:'local'});
const store=await importUi('local_store');
let target='';
globalThis.location={pathname:'/inbox/goals',search:'?q=active',hash:'#saved',replace:p=>{target=p;}};
await store.signOutThisBrowser();
assert.equal(target,'/auth?return_to=%2Finbox%2Fgoals%3Fq%3Dactive%23saved');
console.log('signout_destination: ok');
