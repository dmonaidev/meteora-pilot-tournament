import 'dotenv/config';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {existsSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
const execute=(file,args,options={})=>new Promise((done,fail)=>{const child=spawn(file,args,{...options,stdio:'ignore'});child.once('error',fail);child.once('exit',code=>code===0?done():fail(Error('pg_ctl failed; inspect .local/postgres.log')));});
export async function startLocalPostgres(){
 const url=new URL(process.env.DATABASE_URL);
 if(url.hostname!=='127.0.0.1'||Number(url.port)!==55432)throw Error('db:local uses only project-local PostgreSQL at 127.0.0.1:55432');
 const directory=resolve('.local/postgres');
 const logs=resolve('.local/postgres.log');
 mkdirSync('.local',{recursive:true});
 const database=new EmbeddedPostgres({databaseDir:directory,user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),port:55432,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:msg=>appendFileSync(logs,String(msg)+'\n')});
 if(!existsSync(resolve(directory,'PG_VERSION')))await database.initialise();
 let client=new pg.Client({connectionString:new URL('/postgres',url).toString(),connectionTimeoutMillis:1000});
 let existing=false;
 try{await client.connect();existing=true;}catch{await client.end().catch(()=>{});}
 if(existing){
  const {rows}=await client.query("SELECT current_setting('data_directory') AS directory");
  await client.end();
  if(resolve(rows[0].directory).toLowerCase()!==directory.toLowerCase())throw Error('Port55432 is occupied by another cluster. No changes made.');
 }else if(process.platform==='win32'){
  const {pg_ctl}=await import('@embedded-postgres/windows-x64');
  await execute(pg_ctl,['start','-D',directory,'-l',logs,'-o','-p 55432 -h 127.0.0.1','-w'],{windowsHide:true});
 }else await database.start();
 client=new pg.Client({connectionString:new URL('/postgres',url).toString()});
 await client.connect();
 const dbName=url.pathname.slice(1);
 if(!/^[a-z_][a-z0-9_]*$/.test(dbName))throw Error('Unsafe local database name');
 const found=await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[dbName]);
 if(!found.rowCount)await client.query('CREATE DATABASE "'+dbName+'"');
 await client.end();
 const stop=async()=>{if(process.platform==='win32'){const {pg_ctl}=await import('@embedded-postgres/windows-x64');await execute(pg_ctl,['stop','-D',directory,'-m','fast','-w'],{windowsHide:true});}else await database.stop();};
 return{database:{stop},owned:!existing};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/postgres.mjs')){
 const handle=await startLocalPostgres();
 console.log('PostgreSQL local: 127.0.0.1:55432 (persistent .local/postgres)');
 const keep=setInterval(()=>{},60000);
 async function close(){clearInterval(keep);if(handle.owned)await handle.database.stop();process.exit(0);}
 process.once('SIGINT',close);process.once('SIGTERM',close);
}
