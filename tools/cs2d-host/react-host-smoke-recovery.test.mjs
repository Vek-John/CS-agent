import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { IDBFactory, IDBObjectStore } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('fake-indexeddb');
import { syntheticRecoveryAdmission, observeSyntheticRecoveryWrites } from './react-host-smoke-selection.ts';
const nonce = 'a'.repeat(32);
it('keeps the normal fresh-origin requirement and grants exactly this run one captured reload', () => {
 expect(syntheticRecoveryAdmission(nonce,undefined,[],[])).toBe('FRESH');
 const marker={nonce,captured:true,recoveryId:'own-record',targetTick:1064,localKeys:['own-setting']};
 expect(syntheticRecoveryAdmission(nonce,marker,['cs-coach-host-recovery'],['own-setting'])).toBe('RELOAD');
 for(const bad of [{...marker,nonce:'b'.repeat(32)},{...marker,captured:false},{...marker,reloaded:true},{...marker,targetTick:undefined}])
  expect(syntheticRecoveryAdmission(nonce,bad,['cs-coach-host-recovery'],[])).toBe('REJECT');
 expect(syntheticRecoveryAdmission(nonce,marker,['user-db'],[])).toBe('REJECT');
 expect(syntheticRecoveryAdmission(nonce,marker,['cs-coach-host-recovery'],['foreign-setting'])).toBe('REJECT');
 expect(syntheticRecoveryAdmission(nonce,undefined,['cs-coach-host-recovery'],[])).toBe('REJECT');
});
it('observes real IndexedDB commits but not aborted writes and releases its prototype hook',async()=>{
 const factory=new IDBFactory(),seen=[];
 const original=IDBObjectStore.prototype.put;
 const release=observeSyntheticRecoveryWrites(value=>seen.push(value),IDBObjectStore.prototype);
 let db;
 try{
  db=await new Promise((resolve,reject)=>{const request=factory.open('cs-coach-host-recovery',1);request.onupgradeneeded=()=>request.result.createObjectStore('session-recovery-records',{keyPath:'recoveryId'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  const value={recoveryId:'synthetic-observation',boundary:{kind:'ORDINARY_SEGMENT'}};
  await new Promise((resolve,reject)=>{const tx=db.transaction('session-recovery-records','readwrite');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.objectStore('session-recovery-records').put(value);expect(seen).toEqual([])});
  expect(seen).toEqual([value]);
  await new Promise(resolve=>{const tx=db.transaction('session-recovery-records','readwrite');tx.onabort=resolve;tx.objectStore('session-recovery-records').put({...value,recoveryId:'aborted'});tx.abort()});
  expect(seen).toHaveLength(1);
 }finally{release();db?.close();await new Promise(resolve=>{const request=factory.deleteDatabase('cs-coach-host-recovery');request.onsuccess=resolve;request.onerror=resolve})}
 expect(IDBObjectStore.prototype.put).toBe(original);
});
