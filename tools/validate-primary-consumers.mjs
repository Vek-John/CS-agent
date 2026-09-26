// Execute the existing Viewer/analysis selection helpers against bounded synthetic states.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
const root=resolve(process.argv[2] ?? '.local-data/upstream/cs2d');
function load(path,name){const text=readFileSync(resolve(root,path),'utf8'),start=text.indexOf(`function ${name}(`);assert(start>=0);const end=text.indexOf('\n}',start);assert(end>start);return stripTypeScriptTypes(text.slice(start,end+2));}
const shown=load('apps/app/src/viewer/player/ViewerRoster.vue','shownWeapon');
const normal=new Function('props',shown+'\nreturn shownWeapon;')({hostMode:false});
const host=new Function('props',shown+'\nreturn shownWeapon;')({hostMode:true});
const holds=new Function(load('apps/app/src/viewer/analysis/economy/buyBreakdown.ts','holdsGun')+'\nreturn holdsGun;')();
assert.equal(normal({weapon:'Faca',primary:'AK-47'}),'AK-47');
assert.equal(normal({weapon:'Faca'}),'Faca');
assert.equal(normal({weapon:'P250',primary:'AK-47'}),'P250');
assert.equal(host({weapon:'Faca',primary:'AK-47'}),'Faca');
assert.equal(host({weapon:'Faca'}),'Faca');
assert.equal(holds({weapon:'Faca'},'AK-47'),false);
assert.equal(holds({weapon:'Faca',primary:'AK-47'},'AK-47'),true);
assert.equal(holds({weapon:'AK-47'},'AK-47'),true);
assert.equal(holds(undefined,'AK-47'),false);
console.log(JSON.stringify({assertions:9,source:'actual ViewerRoster.shownWeapon and buyBreakdown.holdsGun',scope:'synthetic selection helpers; no browser or full economy reconstruction'}));
