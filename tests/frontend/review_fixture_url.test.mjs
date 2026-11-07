import assert from 'node:assert/strict';import test from 'node:test';import fixture from './helpers/review_fixture.js';
test('legacy UI fixture URL predicates recognize the private review read without redirecting the request',()=>{
 assert.equal(fixture.reviewFixtureURL('/api/team-artifacts?team=~no-team&tag=for+review&starred_first=true','http://localhost').pathname,'/api/team-artifacts');
 const original='/api/remote/m2/api/team-artifacts?team=a%2Fb&tag=for+review&starred_first=true&cursor=next';
 const parsed=fixture.reviewFixtureURL(original,'http://localhost');assert.equal(parsed.pathname,'/api/remote/m2/api/board/a%2Fb/artifacts');assert.equal(parsed.searchParams.get('cursor'),'next');assert.equal(original,'/api/remote/m2/api/team-artifacts?team=a%2Fb&tag=for+review&starred_first=true&cursor=next');
 for(const path of ['/api/team-artifacts?starred=true','/api/team-artifacts?team=dev&tag=saved&starred_first=true','/api/board/dev/artifacts?tag=for+review'])assert.equal(fixture.reviewFixtureURL(path,'http://localhost').pathname,new URL(path,'http://localhost').pathname);
});
