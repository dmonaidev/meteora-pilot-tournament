import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {migrate} from '../server/db.mjs';

const publicTables=['tournament_rules','tournament_settings'];
const privateTables=[...publicTables,'initial_users','users','wallets','partner_rewards','tournament_scoring'];
const allTables=[...privateTables,'pending_sessions','auth_sessions'];
const columns={
 tournament_settings:['id','start_at','registration_start_at','registration_end_at','end_at','partner_referral_url','tournament_name'],
 tournament_rules:['id','version','title','body','status','created_at','published_at','archived_at','deleted_at'],
 initial_users:['tg_id','tg_username','group_name','subgroup_1','subgroup_2','subgroup_3','system_notes'],
 users:['id','tg_id','tg_username','display_name','registration_status','admin_notes','accepted_rules_version_id','rules_accepted_at'],
 wallets:['id','user_id','wallet_address','withdrawal_tx_hash','validation_status','rejection_reason'],
 partner_rewards:['user_id','reward_type','exchange_uid','uid_status'],
 tournament_scoring:['user_id','pnl','initial_capital','current_capital','in_positions_amount','roi_percentage','lp_volume']
};
const quote=s=>'"'+s+'"';
const format='meteora-handoff-v1';

export async function exportData(pool){
 const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables={};
  for(const table of privateTables){
   const order=table==='tournament_rules'?'version':table==='initial_users'?'tg_id':table==='partner_rewards'||table==='tournament_scoring'?'user_id':'id';
   tables[table]=(await client.query('SELECT '+columns[table].map(quote).join(',')+' FROM '+quote(table)+' ORDER BY '+quote(order))).rows;
  }
  const exported_at=new Date().toISOString();
  await client.query('COMMIT');
  return {
   public:{format,scope:'public-settings',exported_at,tables:Object.fromEntries(publicTables.map(t=>[t,tables[t]]))},
   private:{format,scope:'private-application',exported_at,tables}
  };
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

function validate(bundle){
 if(!bundle||bundle.format!==format||!['public-settings','private-application'].includes(bundle.scope)||!bundle.tables||Array.isArray(bundle.tables))throw Error('INVALID_HANDOFF_FORMAT');
 const expected=bundle.scope==='public-settings'?publicTables:privateTables;
 if(Object.keys(bundle.tables).sort().join('|')!==[...expected].sort().join('|'))throw Error('INVALID_HANDOFF_TABLES');
 for(const table of expected){
  if(!Array.isArray(bundle.tables[table]))throw Error('INVALID_HANDOFF_ROWS');
  for(const row of bundle.tables[table]){
   if(!row||Array.isArray(row)||Object.keys(row).sort().join('|')!==[...columns[table]].sort().join('|'))throw Error('INVALID_HANDOFF_COLUMNS');
  }
 }
 if(bundle.tables.tournament_settings.length!==1||bundle.tables.tournament_settings[0].id!==1)throw Error('INVALID_SETTINGS_SINGLETON');
 return expected;
}

async function assertEmpty(client){
 for(const table of allTables){
  if(!(await client.query('SELECT to_regclass($1) AS relation',[table])).rows[0].relation)continue;
  if(table==='tournament_settings'){
   const rows=(await client.query('SELECT row_to_json(s) AS data FROM tournament_settings s')).rows;
   if(rows.some(({data})=>Object.entries(data).some(([key,value])=>key==='id'?value!==1:key==='tournament_name'?value!=='PILOT TOURNAMENT':value!==null)))throw Error('TARGET_DATABASE_NOT_EMPTY');
  }else if((await client.query('SELECT 1 FROM '+quote(table)+' LIMIT 1')).rowCount)throw Error('TARGET_DATABASE_NOT_EMPTY');
 }
}

export async function restoreData(pool,bundle){
 const tables=validate(bundle);
 // Refuse an existing application before migration changes its schema.
 const check=await pool.connect();try{await assertEmpty(check);}finally{check.release();}
 await migrate(pool);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('LOCK TABLE '+allTables.map(quote).join(',')+' IN ACCESS EXCLUSIVE MODE');
  await assertEmpty(client);
  for(const table of tables){
   for(const row of bundle.tables[table]){
    const fields=columns[table];
    if(table==='tournament_settings'){
     const keys=fields.filter(k=>k!=='id');
     await client.query('UPDATE tournament_settings SET '+keys.map((k,i)=>quote(k)+'=$'+(i+1)).join(',')+' WHERE id=1',keys.map(k=>row[k]));
    }else{
     await client.query('INSERT INTO '+quote(table)+' ('+fields.map(quote).join(',')+')'+(table==='tournament_rules'?' OVERRIDING SYSTEM VALUE':'')+' VALUES ('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',fields.map(k=>row[k]));
    }
   }
  }
  await client.query("SELECT setval(pg_get_serial_sequence('tournament_rules','version'), COALESCE(MAX(version),1), count(*)>0) FROM tournament_rules");
  await client.query('COMMIT');
  return Object.fromEntries(tables.map(t=>[t,bundle.tables[t].length]));
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function main(){
 await import('dotenv/config');
 const [action,file,confirmation]=process.argv.slice(2);
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL_REQUIRED');
 if(!file||!['export','restore'].includes(action)||action==='restore'&&confirmation!=='--fresh-database')throw Error('USAGE: node scripts/handoff.mjs export DIRECTORY | restore FILE --fresh-database');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
 try{
  if(action==='export'){
   const directory=resolve(file);
   // Private export stays below ignored .local to avoid accidental publication.
   const local=resolve('.local');
   if(!directory.startsWith(local+'/')&&!directory.startsWith(local+'\\'))throw Error('EXPORT_DIRECTORY_MUST_BE_BELOW_LOCAL');
   const data=await exportData(pool);await mkdir(resolve(directory,'private'),{recursive:true});
   const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
   await save(resolve(directory,'public-settings.json'),data.public);
   await save(resolve(directory,'private/application-data.json'),data.private);
   const keys=['BOT_USERNAME','ADMIN_TG_IDS','AUTH_JWT_TTL_SECONDS','PUBLIC_BASE_URL','BACKEND_URL','LOCAL_DEMO'];
   await save(resolve(directory,'private/runtime-settings.json'),Object.fromEntries(keys.map(k=>[k,process.env[k]??null])));
   console.log(JSON.stringify({exported:true,publicSettings:2,privateCounts:Object.fromEntries(privateTables.map(t=>[t,data.private.tables[t].length])),sessionsAndSecretsExcluded:true}));
  }else{
   const bundle=JSON.parse(await readFile(resolve(file),'utf8'));
   console.log(JSON.stringify({restored:await restoreData(pool,bundle),scope:bundle.scope}));
  }
 }finally{await pool.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(error=>{console.error('HANDOFF_FAILED',String(error?.message||'UNKNOWN_ERROR').startsWith('USAGE:')?error.message:/^[A-Z_]+$/.test(error?.message||'')?error.message:error?.code||'CHECK_DATABASE_AND_INPUT');process.exitCode=1;});
}
