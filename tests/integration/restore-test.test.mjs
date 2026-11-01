import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../dist/config/load.js';
import { EvidenceStore } from '../../dist/evidence/store.js';
import { runRestoreTest } from '../../dist/operations/restoreTest.js';
import { executable, fixture, writeConfig } from '../helpers/fixture.mjs';

const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');

test('isolated restore test restores and verifies filesystem backup evidence',async()=>{
  const value=fixture();
  try{
    const archive=path.join(value.root,'archive','captured');const files=path.join(archive,'sources','files','files');fs.mkdirSync(files,{recursive:true});fs.writeFileSync(path.join(files,'proof.txt'),'restored proof');
    const entries=[{path_sha256:hash('proof.txt'),content_sha256:hash('restored proof'),bytes:14}];
    fs.writeFileSync(path.join(archive,'sources','files','inventory.json'),JSON.stringify({schema:'isy.backup.filesystem-inventory/v1',entries}));
    fs.writeFileSync(path.join(archive,'manifest.json'),JSON.stringify({schema:'isy.backup.manifest/v1',backup_set_id:'backup-set-001',sources:[{id:'files',type:'filesystem',required:true,result:'PASS',sha256:hash(JSON.stringify(entries))}]}));
    const restic=executable(value.root,'restore-restic',`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);if(a.includes('restore'))fs.cpSync(${JSON.stringify(path.dirname(archive))},a[a.indexOf('--target')+1],{recursive:true});\n`);
    const configFile=writeConfig(value,{tools:{restic},restore_test:{enabled:true,directory:path.join(value.root,'restore-tests'),interval_seconds:3600,target_id:'primary'}});const loaded=loadConfig(configFile);const store=new EvidenceStore(value.state);
    store.recordBackup({schema:'isy.backup.receipt/v1',operation:'backup',deployment:'test-deployment',environment:'test',backup_set_id:'backup-set-001',result:'PASS',started_at:'2026-11-01T00:00:00Z',completed_at:'2026-11-01T00:01:00Z',config_sha256:loaded.sha256,image:{version:'0.2.0',source_revision:'test',digest:null},sources:[{id:'files',type:'filesystem',required:true,result:'PASS',artifact:'/redacted',sha256:hash(JSON.stringify(entries)),bytes:14,entries:1}],targets:[{id:'primary',type:'filesystem',required:true,result:'PASS',snapshot_id:'0123456789abcdef',verification:'RESTIC_CHECK'}],findings:[]},'schedule');
    const result=await runRestoreTest(loaded,'88888888-8888-4888-8888-888888888888');
    assert.equal(result.result,'PASS');assert.equal(result.operation.kind,'restore-test');assert.equal(fs.existsSync(path.join(value.root,'restore-tests','restore-test-88888888-8888-4888-8888-888888888888')),false);
  }finally{value.cleanup();}
});
