import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});
const {askSubjectLinks}=await importUi('ask_subject_links');
const {state}=await importUi('state');
const ask={board:'team-a',asker:'Orchestrator'},subjects=[{kind:'goal',id:7,title:'Ship it'},{kind:'task',id:12,title:'Check it'}];
let opens=[],rows=0;const host=document.createElement('div');host.addEventListener('click',()=>rows++);document.body.append(host);
const local=askSubjectLinks(ask,subjects,'local',r=>opens.push(r));host.append(local);
assert.deepEqual([...local.querySelectorAll('a')].map(a=>a.getAttribute('href')),['/team/team-a/goals/7','/team/team-a/tasks/12']);
const link=local.querySelector('a');assert.equal(link.tabIndex,0);assert.match(link.getAttribute('aria-label'),/Goal #7.*Ship it.*team-a/);
const click=new window.MouseEvent('click',{bubbles:true,cancelable:true,button:0});link.dispatchEvent(click);assert.equal(click.defaultPrevented,true);assert.equal(rows,0);assert.equal(opens.length,1);assert.equal(opens[0].item,7);
const modified=new window.MouseEvent('click',{bubbles:true,cancelable:true,button:0,ctrlKey:true});link.dispatchEvent(modified);assert.equal(modified.defaultPrevented,false);assert.equal(rows,0);assert.equal(opens.length,1);
state.hub=true;state.servers=[{id:'source-a',status:'online',label:'Laptop'}];
const remote=askSubjectLinks(ask,subjects,'source-a',()=>{});assert.deepEqual([...remote.querySelectorAll('a')].map(a=>a.getAttribute('href')),['/team/@source-a/team-a/goals/7','/team/@source-a/team-a/tasks/12']);
for(const server of ['unknown','offline']){state.servers.push({id:'offline',status:'offline'});const words=askSubjectLinks(ask,subjects,server,()=>assert.fail('unavailable source opened'));assert.equal(words.querySelectorAll('a').length,0);assert.equal(words.querySelectorAll('strong').length,2);assert.equal(words.textContent,'Goal #7 · Task #12');}
assert.equal(askSubjectLinks(ask,[],'local',()=>{}),null);
const invalid=askSubjectLinks(ask,[{kind:'goal',id:1.5,title:'bad'}],'local',()=>{});assert.equal(invalid.querySelectorAll('a').length,0);
dom.window.close();console.log('PASS subject links carry source, isolate row clicks, preserve modified navigation and keep unavailable subjects bold words');
