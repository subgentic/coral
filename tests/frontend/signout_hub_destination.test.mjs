// #17344: cloud sign-out retains the Hub route and safe next path.
import assert from 'node:assert/strict';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
installDom({mode:'cloud'});
const store=await importUi('local_store');
let target='';
globalThis.location={pathname:'/inbox/goals',search:'?q=active',hash:'#saved',replace:p=>{target=p;}};
await store.signOutThisBrowser();
assert.equal(target,'/signin?next=%2Finbox%2Fgoals%3Fq%3Dactive');
console.log('signout_hub_destination: ok');
