import 'dotenv/config';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const files=['tests/backend.test.mjs','tests/admin-data.test.mjs','tests/telegram-code.test.mjs','tests/access-session.test.mjs','tests/schedule-stats.test.mjs','tests/duplicates.test.mjs','tests/rules.test.mjs','tests/partner.test.mjs','tests/tournament-name.test.mjs','tests/handoff.test.mjs','tests/wallet-exception.test.mjs','bot/notifications.test.mjs','bot/polling.test.mjs','bot/code.test.mjs','bot/session.test.mjs'];
let maintenance,ownedDatabase;
try {
 let testUrl=process.env.TEST_DATABASE_URL;
 if(testUrl){
  const supplied=new URL(testUrl),application=new URL(process.env.DATABASE_URL);
  if(supplied.host===application.host&&supplied.pathname===application.pathname)throw Error('TEST_DATABASE_MUST_BE_SEPARATE');
 }else{
  const application=new URL(process.env.DATABASE_URL);
  const maintenanceUrl=new URL(application);maintenanceUrl.pathname='/postgres';
  maintenance=new pg.Pool({connectionString:maintenanceUrl.href});
  const candidate='codex_test_'+randomUUID().replaceAll('-','');
  if(!/^codex_test_[a-f0-9]{32}$/.test(candidate))throw Error('INVALID_TEST_DATABASE_NAME');
  await maintenance.query('CREATE DATABASE "'+candidate+'"');
  ownedDatabase=candidate;
  const isolatedUrl=new URL(application);isolatedUrl.pathname='/'+ownedDatabase;testUrl=isolatedUrl.href;
  console.log('Тесты выполняются в отдельной временной БД.');
 }
 const child=spawn(process.execPath,['--test',...files],{stdio:'inherit',windowsHide:true,env:{...process.env,TEST_DATABASE_URL:testUrl}});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',value=>resolve(value??1));});
 process.exitCode=code;
}catch(error){
 console.error('Не удалось выполнить тесты:',error?.code||(['TEST_DATABASE_MUST_BE_SEPARATE','INVALID_TEST_DATABASE_NAME'].includes(error?.message)?error.message:'TEST_SETUP_FAILED'));
 process.exitCode=1;
}finally{
 if(maintenance){
  try{if(ownedDatabase&&/^codex_test_[a-f0-9]{32}$/.test(ownedDatabase))await maintenance.query('DROP DATABASE "'+ownedDatabase+'" WITH (FORCE)');}
  catch{console.error('Временная тестовая БД не удалена.');process.exitCode=1;}
  await maintenance.end();
 }
}
