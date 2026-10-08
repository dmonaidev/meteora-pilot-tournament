import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../server/app.mjs';
import {migrate} from '../server/db.mjs';

test('tournament name: default, permissions, strict validation and isolated persistence',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='name_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const now=new Date('2026-10-08T12:00:00Z'),config={jwtSecret:'n'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[960001],authJwtTtlSeconds:1800,botUsername:'TestBot',localDemo:false};
 let app,admin,member,queryCount=0;
 const tracked={query:async(...args)=>{queryCount++;return pool.query(...args);},connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{queryCount++;return client.query(...args);},release:()=>client.release()};}};
 const call=async(method,path,body,token)=>{const response=await app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),headers:token?{authorization:'Bearer '+token}:{}});return {status:response.statusCode,body:response.json()};};
 const save=value=>call('POST','/admin/tournament/name',{tournament_name:value},admin);
 const otherSettings=async()=>(await pool.query('SELECT registration_start_at,registration_end_at,start_at,end_at,partner_referral_url FROM tournament_settings WHERE id=1')).rows[0];
 try{
  await migrate(pool);await migrate(pool);
  for(let i=0;i<2;i++){
   const id=randomUUID(),session=randomUUID();await pool.query("INSERT INTO users(id,tg_id,display_name,registration_status) VALUES($1,$2,'Existing account','PENDING_VALIDATION')",[id,960001+i]);await pool.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[session,id,new Date(+now+1800000)]);
   const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(id).setJti(session).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+now/1000)+1800).sign(new TextEncoder().encode(config.jwtSecret));if(i===0)admin=token;else member=token;
  }
  app=buildApp({pool:tracked,config,clock:()=>now});
  await t.test('default is public, while admin checks precede private reads and writes',async()=>{
   assert.deepEqual((await call('GET','/public/tournament/name')).body,{tournament_name:'PILOT TOURNAMENT'});
   for(const method of ['GET','POST']){const body=method==='POST'?{tournament_name:'Unauthorized'}:undefined;let before=queryCount;assert.equal((await call(method,'/admin/tournament/name',body)).status,401);assert.equal(queryCount,before);before=queryCount;assert.equal((await call(method,'/admin/tournament/name',body,member)).status,403);assert.equal(queryCount-before,1);}
   assert.deepEqual((await call('GET','/admin/tournament/name',undefined,admin)).body,{tournament_name:'PILOT TOURNAMENT'});
  });
  await t.test('strict plain text trims, enforces 1–80 and refuses clearing or C0/C1 controls',async()=>{
   for(const body of [{},{tournament_name:null},{tournament_name:12},{tournament_name:'Valid',start_at:null}])assert.equal((await call('POST','/admin/tournament/name',body,admin)).status,422);
   for(const value of ['', '   ','x'.repeat(81),'Name\nline','\tName','Name\u0000','Name\u007f','Name\u0085']){const result=await save(value);assert.equal(result.status,422);assert.equal(result.body.error.code,'VALIDATION_ERROR');}
   assert.deepEqual((await save('  Турнир сообщества  ')).body,{tournament_name:'Турнир сообщества'});assert.deepEqual((await save('x'.repeat(80))).body,{tournament_name:'x'.repeat(80)});
   assert.deepEqual((await save('<b>Plain title</b>')).body,{tournament_name:'<b>Plain title</b>'});assert.equal((await save(' ')).status,422);assert.equal((await call('GET','/public/tournament/name')).body.tournament_name,'<b>Plain title</b>');
  });
  await t.test('after-start edits persist through restart/migration without changing schedules, referral or profiles',async()=>{
   await pool.query('UPDATE tournament_settings SET registration_start_at=$1,registration_end_at=$2,start_at=$3,end_at=$4,partner_referral_url=$5 WHERE id=1',[new Date(+now-4000),new Date(+now-3000),new Date(+now-2000),new Date(+now-1000),'https://example.invalid/partner']);
   const before=await otherSettings(),users=(await pool.query('SELECT * FROM users ORDER BY tg_id')).rows;
   assert.deepEqual((await save('AFTER START')).body,{tournament_name:'AFTER START'});assert.deepEqual(await otherSettings(),before);assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY tg_id')).rows,users);
   assert.equal((await call('GET','/public/tournament')).body.ended,true);assert.deepEqual((await call('GET','/public/partner')).body,{referral_url:before.partner_referral_url});
   const restarted=buildApp({pool,config,clock:()=>now});try{assert.deepEqual((await restarted.inject({method:'GET',url:'/api/v1/public/tournament/name'})).json(),{tournament_name:'AFTER START'});}finally{await restarted.close();}
   await migrate(pool);assert.deepEqual((await call('GET','/admin/tournament/name',undefined,admin)).body,{tournament_name:'AFTER START'});assert.deepEqual(await otherSettings(),before);
   assert.equal(Number((await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE'",[schema])).rows[0].count),9);
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
