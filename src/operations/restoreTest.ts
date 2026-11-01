import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { restoreSnapshot } from '../adapters/targets/restic.js';
import type { LoadedConfig } from '../config/load.js';
import { BackupError } from '../domain/errors.js';
import { sha256 } from '../domain/identity.js';
import { EvidenceStore, type ReceiptSummary } from '../evidence/store.js';
import { ensurePrivateDirectory } from '../runtime/atomic.js';
import { runCommand } from '../runtime/process.js';
import { acquireLock } from '../runtime/lock.js';
import { imageIdentity } from '../runtime/version.js';

function files(root: string): Array<{ path_sha256: string; content_sha256: string; bytes: number }> {
  const values: Array<{ path_sha256: string; content_sha256: string; bytes: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const absolute=path.join(directory,entry.name); const stat=fs.lstatSync(absolute);
      if(stat.isSymbolicLink())throw new BackupError('RESTORE_TEST_SYMLINK',6,'restored data contains a symlink','restore-test');
      if(entry.isDirectory())walk(absolute); else if(entry.isFile()){const content=fs.readFileSync(absolute);values.push({path_sha256:sha256(path.relative(root,absolute)),content_sha256:sha256(content),bytes:content.length});}
      else throw new BackupError('RESTORE_TEST_TYPE_INVALID',6,'restored data contains an unsupported entry','restore-test');
    }
  }; walk(root); return values;
}

function latestSnapshot(store: EvidenceStore, targetId: string): { snapshotId: string; backupSetId: string } {
  const receipt=store.latestReceipt((candidate)=>candidate.operation.kind==='backup'&&candidate.targets.some((item)=>item.id===targetId&&item.result==='PASS'&&item.snapshot_id));
  if(receipt){const target=receipt.targets.find((item)=>item.id===targetId&&item.result==='PASS'&&item.snapshot_id);if(target?.snapshot_id)return{snapshotId:target.snapshot_id,backupSetId:receipt.backup_set_id};}
  throw new BackupError('RESTORE_TEST_SNAPSHOT_UNAVAILABLE',6,'no verified snapshot is available','restore-test');
}

function restoredBackupRoot(root:string,backupSetId:string):string{
  const matches:string[]=[];const walk=(directory:string):void=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const absolute=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new BackupError('RESTORE_TEST_SYMLINK',6,'restored data contains a symlink','restore-test');if(entry.isDirectory())walk(absolute);else if(entry.isFile()&&entry.name==='manifest.json'){try{const value=JSON.parse(fs.readFileSync(absolute,'utf8'));if(value?.schema==='isy.backup.manifest/v1'&&value?.backup_set_id===backupSetId)matches.push(path.dirname(absolute));}catch{/* rejected below */}}}};walk(root);if(matches.length!==1)throw new BackupError('RESTORE_TEST_MANIFEST_INVALID',6,'restored snapshot does not contain exactly one bound manifest','restore-test');return matches[0]!;
}

async function verifyPostgres(loaded:LoadedConfig,dump:string,database:string):Promise<void>{
  const verifier=loaded.config.restore_test?.postgres_verifier;if(!verifier)throw new BackupError('RESTORE_TEST_VERIFIER_UNAVAILABLE',6,'PostgreSQL verifier is unavailable','restore-test');
  const common=['--host',verifier.host,'--port',String(verifier.port),'--username',verifier.username]; const env={PGPASSFILE:verifier.password_file}; const psql=loaded.config.tools?.psql??'psql';
  const create=await runCommand(psql,[...common,'--dbname',verifier.maintenance_database,'--set','ON_ERROR_STOP=1','--command',`CREATE DATABASE "${database}"`],{env,timeoutMs:5*60_000});
  if(create.exitCode!==0)throw new BackupError('RESTORE_TEST_DATABASE_CREATE_FAILED',6,'isolated verification database could not be created','restore-test');
  const pgRestore=loaded.config.tools?.pg_restore??'pg_restore';
  const restoreSection=async(section:'pre-data'|'data'|'post-data'):Promise<void>=>{
    const restore=await runCommand(pgRestore,[...common,'--dbname',database,'--exit-on-error','--no-owner','--no-privileges','--section',section,dump],{env,timeoutMs:60*60_000});
    if(restore.exitCode!==0)throw new BackupError('RESTORE_TEST_POSTGRES_FAILED',6,`PostgreSQL ${section} restore into verifier failed`,'restore-test');
  };
  await restoreSection('pre-data');
  const functionSearchPath=await runCommand(psql,[...common,'--dbname',database,'--set','ON_ERROR_STOP=1','--command',`DO $$
    DECLARE item record;
    BEGIN
      FOR item IN
        SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
      LOOP
        EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path TO public, pg_catalog', item.nspname, item.proname, item.arguments);
      END LOOP;
    END $$`],{env,timeoutMs:5*60_000});
  if(functionSearchPath.exitCode!==0)throw new BackupError('RESTORE_TEST_POSTGRES_FAILED',6,'PostgreSQL verifier function search path could not be hardened','restore-test');
  await restoreSection('data');
  await restoreSection('post-data');
  const query=await runCommand(psql,[...common,'--dbname',database,'--tuples-only','--set','ON_ERROR_STOP=1','--command',"SELECT count(*) FROM pg_catalog.pg_class WHERE relkind IN ('r','p')"],{env,timeoutMs:5*60_000});
  if(query.exitCode!==0||!/^\s*[0-9]+\s*$/u.test(query.stdout))throw new BackupError('RESTORE_TEST_POSTGRES_INVARIANT_FAILED',6,'PostgreSQL restore invariant failed','restore-test');
}

export async function runRestoreTest(loaded:LoadedConfig,commandId:string=crypto.randomUUID(),expected?:{targetId:string;snapshotId:string},signal?:AbortSignal):Promise<ReceiptSummary>{
  const policy=loaded.config.restore_test;if(!policy?.enabled)throw new BackupError('RESTORE_TEST_DISABLED',2,'restore testing is disabled','restore-test');
  const target=loaded.config.targets.find((item)=>item.id===policy.target_id);if(!target)throw new BackupError('RESTORE_TEST_TARGET_UNAVAILABLE',2,'restore target is unavailable','restore-test');
  const store=new EvidenceStore(loaded.config.state_directory);const snapshot=latestSnapshot(store,target.id);const startedAt=new Date().toISOString();
  if(expected&&(expected.targetId!==target.id||expected.snapshotId!==snapshot.snapshotId))throw new BackupError('RESTORE_TEST_SNAPSHOT_MISMATCH',6,'restore test must use the latest configured snapshot','restore-test');
  const release=acquireLock(loaded.config.state_directory,commandId);
  try {
  const root=path.join(policy.directory,`restore-test-${commandId}`);ensurePrivateDirectory(policy.directory);if(fs.existsSync(root))throw new BackupError('RESTORE_TEST_COLLISION',6,'restore-test destination already exists','restore-test');ensurePrivateDirectory(root);
  let database:string|null=null;let state:'PASS'|'FAIL'|'CANCELLED'='PASS';let code='RESTORE_TEST_PASS';
  try{
    if(signal?.aborted)throw new BackupError('COMMAND_CANCELLED',7,'restore test was cancelled','control');
    await restoreSnapshot(target,loaded.config.tools??{},snapshot.snapshotId,root);
    if(signal?.aborted)throw new BackupError('COMMAND_CANCELLED',7,'restore test was cancelled','control');
    const backupRoot=restoredBackupRoot(root,snapshot.backupSetId);const manifestPath=path.join(backupRoot,'manifest.json');const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')) as {schema?:string;backup_set_id?:string;sources?:Array<{id:string;type:string;result:string;sha256:string|null}>};
    if(manifest.schema!=='isy.backup.manifest/v1'||manifest.backup_set_id!==snapshot.backupSetId||!Array.isArray(manifest.sources))throw new BackupError('RESTORE_TEST_MANIFEST_INVALID',6,'restored manifest is invalid','restore-test');
    for(const source of loaded.config.sources){const observed=manifest.sources.find((item)=>item.id===source.id&&item.type===source.type&&item.result==='PASS');if(!observed)throw new BackupError('RESTORE_TEST_SOURCE_MISSING',6,'a configured source is missing','restore-test');const directory=path.join(backupRoot,'sources',source.id);
      if(source.type==='postgres'){const dump=path.join(directory,'database.dump');if(sha256(fs.readFileSync(dump))!==observed.sha256)throw new BackupError('RESTORE_TEST_POSTGRES_HASH_FAILED',6,'PostgreSQL archive hash differs','restore-test');const verifier=policy.postgres_verifier!;database=`${verifier.database_prefix}_${commandId.replaceAll('-','').slice(0,20)}`;await verifyPostgres(loaded,dump,database);if(signal?.aborted)throw new BackupError('COMMAND_CANCELLED',7,'restore test was cancelled','control');}
      else {const inventory=JSON.parse(fs.readFileSync(path.join(directory,'inventory.json'),'utf8')) as {entries?:unknown};const artifact=path.join(directory,source.type==='filesystem'?'files':'objects');const actual=files(artifact);if(JSON.stringify(inventory.entries)!==JSON.stringify(actual)||sha256(JSON.stringify(actual))!==observed.sha256)throw new BackupError('RESTORE_TEST_INVENTORY_FAILED',6,'restored source inventory differs','restore-test');}
    }
  }catch(error){state=signal?.aborted?'CANCELLED':'FAIL';code=signal?.aborted?'COMMAND_CANCELLED':error instanceof BackupError?error.code:'RESTORE_TEST_FAILED';}
  if(database&&policy.postgres_verifier){const verifier=policy.postgres_verifier;let cleaned=false;for(let attempt=1;attempt<=3;attempt+=1){const drop=await runCommand(loaded.config.tools?.psql??'psql',['--host',verifier.host,'--port',String(verifier.port),'--username',verifier.username,'--dbname',verifier.maintenance_database,'--set','ON_ERROR_STOP=1','--command',`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`],{env:{PGPASSFILE:verifier.password_file},timeoutMs:5*60_000});if(drop.exitCode===0){cleaned=true;break;}if(attempt<3)await new Promise((resolve)=>setTimeout(resolve,500));}if(!cleaned){state='FAIL';code='RESTORE_TEST_CLEANUP_FAILED';}}
  const completedAt=new Date().toISOString();const summary=store.recordCommandOperation({operationId:commandId,kind:'restore-test',commandId,state,code,startedAt,completedAt,configSha256:loaded.sha256,image:imageIdentity(),targets:[{id:target.id,provider_class:target.type==='filesystem'?'filesystem':target.type==='s3'?'s3':'rclone',required:true,result:state==='CANCELLED'?'SKIPPED':state,snapshot_id:snapshot.snapshotId,verification:'RESTORE_TEST',verified_at:state==='PASS'?completedAt:null,code}]});
  fs.rmSync(root,{recursive:true,force:false});return summary;
  } finally { release(); }
}
