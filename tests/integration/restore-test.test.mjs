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

test('PostgreSQL restore verification stages schema, data, and constraints with a safe function path',async()=>{
  const value=fixture();
  try{
    const archive=path.join(value.root,'archive','captured');const source=path.join(archive,'sources','postgres');fs.mkdirSync(source,{recursive:true});
    const dump=Buffer.from('portable PostgreSQL archive');fs.writeFileSync(path.join(source,'database.dump'),dump);
    fs.writeFileSync(path.join(archive,'manifest.json'),JSON.stringify({schema:'isy.backup.manifest/v1',backup_set_id:'backup-set-postgres',sources:[{id:'postgres',type:'postgres',required:true,result:'PASS',sha256:hash(dump)}]}));
    const events=path.join(value.root,'postgres-events');
    const restic=executable(value.root,'restore-restic-postgres',`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);if(a.includes('restore'))fs.cpSync(${JSON.stringify(path.dirname(archive))},a[a.indexOf('--target')+1],{recursive:true});\n`);
    const psql=executable(value.root,'restore-psql',`#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2),command=a[a.indexOf('--command')+1]||'';fs.appendFileSync(${JSON.stringify(events)},'psql '+command.replaceAll('\\n',' ')+'\\n');if(a.includes('--tuples-only'))process.stdout.write('1\\n');\n`);
    const pgRestore=executable(value.root,'restore-pg-restore',`#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(events)},'pg_restore '+a.join(' ')+'\\n');\n`);
    const restorePassword=path.join(value.root,'restore.pgpass');fs.writeFileSync(restorePassword,'fixture',{mode:0o600});
    const configFile=writeConfig(value,{sources:[{id:'postgres',type:'postgres',required:true,host:'db',port:5432,database:'app',username:'backup',password_file:value.password}],tools:{restic,psql,pg_restore:pgRestore},restore_test:{enabled:true,directory:path.join(value.root,'restore-tests'),interval_seconds:3600,target_id:'primary',postgres_verifier:{host:'db',port:5432,username:'restore',password_file:restorePassword,maintenance_database:'postgres',database_prefix:'restore_test'}}});
    const loaded=loadConfig(configFile);const store=new EvidenceStore(value.state);
    store.recordBackup({schema:'isy.backup.receipt/v1',operation:'backup',deployment:'test-deployment',environment:'test',backup_set_id:'backup-set-postgres',result:'PASS',started_at:'2026-11-01T00:00:00Z',completed_at:'2026-11-01T00:01:00Z',config_sha256:loaded.sha256,image:{version:'0.3.0',source_revision:'test',digest:null},sources:[{id:'postgres',type:'postgres',required:true,result:'PASS',artifact:'/redacted',sha256:hash(dump),bytes:dump.length}],targets:[{id:'primary',type:'filesystem',required:true,result:'PASS',snapshot_id:'abcdef0123456789',verification:'RESTIC_CHECK'}],findings:[]},'schedule');
    const result=await runRestoreTest(loaded,'99999999-9999-4999-8999-999999999999');
    assert.equal(result.result,'PASS');
    const lines=fs.readFileSync(events,'utf8').trim().split('\n');
    assert.match(lines[1],/pg_restore .*--exit-on-error .*--section pre-data/u);
    assert.match(lines[2],/^psql .*ALTER FUNCTION .* SET search_path TO public, pg_catalog/u);
    assert.match(lines[3],/pg_restore .*--exit-on-error .*--section data/u);
    assert.match(lines[4],/pg_restore .*--exit-on-error .*--section post-data/u);
  }finally{value.cleanup();}
});
