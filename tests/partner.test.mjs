import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../server/app.mjs';
import {migrate} from '../server/db.mjs';

test('partner referral setting: access, HTTPS validation and independent persistence',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='partner_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const now=new Date('2026-10-08T12:00:00Z'),config={jwtSecret:'p'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[950001],authJwtTtlSeconds:1800,botUsername:'TestBot',localDemo:false};
 let app,admin,member,queryCount=0,fetchCount=0;const originalFetch=globalThis.fetch;
 const tracked={query:async(...args)=>{queryCount++;return pool.query(...args);},connect:async()=>{const client=await pool.connect();return {query:async(...args)=>{queryCount++;return client.query(...args);},release:()=>client.release()};}};
 const call=async(method,path,body,token)=>{const response=await app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),headers:token?{authorization:'Bearer '+token}:{}});return {status:response.statusCode,body:response.json()};};
 const save=value=>call('POST','/admin/tournament/partner',{referral_url:value},admin);
 const dates=()=>pool.query('SELECT registration_start_at,registration_end_at,start_at,end_at FROM tournament_settings WHERE id=1');
 try{
  await migrate(pool);await migrate(pool);
  for(let i=0;i<2;i++){
   const id=randomUUID(),session=randomUUID();await pool.query("INSERT INTO users(id,tg_id,display_name,registration_status) VALUES($1,$2,'Existing account','PENDING_VALIDATION')",[id,950001+i]);await pool.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[session,id,new Date(+now+1800000)]);
   const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(id).setJti(session).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+now/1000)+1800).sign(new TextEncoder().encode(config.jwtSecret));if(i===0)admin=token;else member=token;
  }
  app=buildApp({pool:tracked,config,clock:()=>now});
  globalThis.fetch=async()=>{fetchCount++;throw new Error('No referral URL may be fetched');};
  await t.test('guest response is exact and admin guards precede setting reads/writes',async()=>{
   assert.deepEqual((await call('GET','/public/partner')).body,{referral_url:null});
   for(const method of ['GET','POST']){const body=method==='POST'?{referral_url:'https://example.invalid/?ref=admin'}:undefined;let before=queryCount;assert.equal((await call(method,'/admin/tournament/partner',body)).status,401);assert.equal(queryCount,before);before=queryCount;assert.equal((await call(method,'/admin/tournament/partner',body,member)).status,403);assert.equal(queryCount-before,1);}
   assert.deepEqual((await call('GET','/admin/tournament/partner',undefined,admin)).body,{referral_url:null});
  });
  await t.test('strict URL schema rejects unsafe input, accepts exact boundary and never fetches',async()=>{
   for(const body of [{},{referral_url:4},{referral_url:true},{referral_url:'https://example.invalid',start_at:null}])assert.equal((await call('POST','/admin/tournament/partner',body,admin)).status,422);
   for(const value of ['http://example.invalid','javascript:alert(1)','//example.invalid','https:example.invalid','https://','https://user:password@example.invalid','https://user@example.invalid','https://@example.invalid','https://example.invalid/\nsecret','\thttps://example.invalid','https://example.invalid/\u007f','https://example.invalid/\u0085'])assert.equal((await save(value)).status,422,value);
   const prefix='https://example.invalid/',boundary=prefix+'x'.repeat(2048-prefix.length);assert.equal((await save(boundary)).status,200);assert.equal((await save(boundary+'x')).status,422);
   const value='https://example.invalid/register?ref=0000123&language=ru#signup';assert.deepEqual((await save('  '+value+'  ')).body,{referral_url:value});assert.deepEqual((await call('GET','/public/partner')).body,{referral_url:value});assert.equal(fetchCount,0);
  });
  await t.test('partner writes work after all schedule boundaries and preserve every date/profile',async()=>{
   await pool.query('UPDATE tournament_settings SET registration_start_at=$1,registration_end_at=$2,start_at=$3,end_at=$4 WHERE id=1',[new Date(+now-4000),new Date(+now-3000),new Date(+now-2000),new Date(+now-1000)]);
   const before=(await dates()).rows[0],users=(await pool.query('SELECT * FROM users ORDER BY tg_id')).rows;
   assert.equal((await save('https://example.invalid/qualified?ref=partner')).status,200);assert.deepEqual((await dates()).rows[0],before);assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY tg_id')).rows,users);
   assert.equal((await call('GET','/public/tournament')).body.ended,true);
   const restarted=buildApp({pool,config,clock:()=>now});try{assert.deepEqual((await restarted.inject({method:'GET',url:'/api/v1/public/partner'})).json(),{referral_url:'https://example.invalid/qualified?ref=partner'});}finally{await restarted.close();}
   await migrate(pool);assert.equal((await call('GET','/public/partner')).body.referral_url,'https://example.invalid/qualified?ref=partner');assert.deepEqual((await dates()).rows[0],before);
  });
  await t.test('blank and null clear only the URL and subsequent reads agree',async()=>{
   const before=(await dates()).rows[0];assert.deepEqual((await save('   ')).body,{referral_url:null});assert.deepEqual((await call('GET','/public/partner')).body,{referral_url:null});await save('https://example.invalid/new');assert.deepEqual((await save(null)).body,{referral_url:null});assert.deepEqual((await call('GET','/admin/tournament/partner',undefined,admin)).body,{referral_url:null});assert.deepEqual((await dates()).rows[0],before);assert.equal(fetchCount,0);
  });
 }finally{globalThis.fetch=originalFetch;if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
