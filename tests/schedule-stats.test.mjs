import { seedRules } from './helpers/rules.mjs';
import bs58 from 'bs58';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../server/app.mjs';
import {migrate} from '../server/db.mjs';

test('schedule windows and exact public statistics',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='schedule_test_'+randomUUID().replaceAll('-','');
 const control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 let now=new Date('2026-10-08T12:00:00Z'),index=0,app,rulesId;
 const base=+now,iso=offset=>new Date(base+offset).toISOString();
 const config={jwtSecret:'s'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[900001],authJwtTtlSeconds:1800,botUsername:'TestBot',localDemo:false,notifyTransport:async()=>({ok:true}),editTransport:async()=>({ok:true})};
 const ids=Array.from({length:6},()=>randomUUID());
 const token=async id=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(id).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+now/1000)+1800).sign(new TextEncoder().encode(config.jwtSecret));
 const call=async(method,path,body,auth=false,bot=false)=>{
  const response=await app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),remoteAddress:'127.3.0.'+(++index%250+1),headers:{...(auth?{authorization:'Bearer '+(typeof auth==='string'?auth:await token(ids[0]))}:{}),...(bot?{'x-bot-secret':config.botApiSecret}:{})}});
  return {status:response.statusCode,body:response.json()};
 };
 const settings=body=>call('POST','/admin/tournament/settings',body,true);
 const reset=async()=>{now=new Date(base);await pool.query('UPDATE tournament_settings SET registration_start_at=NULL,registration_end_at=NULL,start_at=NULL,end_at=NULL WHERE id=1');};
 const pending=async()=>{const result=await call('POST','/auth/register',{rules_accepted:true,rules_version_id:rulesId,display_name:'New Trader'});assert.equal(result.status,201);return result.body.token;};
 const verify=(p,id)=>call('POST','/bot/verify',{token:p,tg_id:id,tg_username:null},false,true);
 const issue=async id=>(await call('POST','/bot/code',{tg_id:id,tg_username:null},false,true)).body.code;
 const codeVerify=(p,id,code)=>call('POST','/auth/code/verify',{token:p,telegram_identifier:String(id),code});
 try{
  await migrate(pool);await migrate(pool);rulesId=await seedRules(pool);app=buildApp({pool,config,clock:()=>now});
  for(let i=0;i<ids.length;i++)await pool.query("INSERT INTO users(id,tg_id,display_name,registration_status) VALUES($1,$2,$3,$4)",[ids[i],900001+i,'Fixture '+i,i===4?'PENDING_VALIDATION':'APPROVED_AUTO']);
  await t.test('four dates merge, validate ordering, persist and use exact exclusive boundaries',async()=>{
   const initial=(await call('GET','/public/tournament')).body;assert.equal(initial.registration_open,true);assert.equal(initial.registration_status,'OPEN');assert.equal(initial.end_at,null);
   assert.equal((await settings({})).status,422);assert.equal((await settings({end_at:iso(600000)})).status,422);
   assert.equal((await settings({registration_start_at:iso(1000),registration_end_at:iso(1000)})).status,422);
   assert.equal((await settings({start_at:iso(5000),end_at:iso(4000)})).status,422);
   assert.equal((await settings({start_at:iso(2000),end_at:iso(6000),registration_end_at:iso(6001)})).status,422);
   await settings({registration_start_at:iso(1000),registration_end_at:iso(4000),start_at:iso(2000),end_at:iso(6000)});
   let state=(await call('GET','/public/tournament')).body;assert.equal(state.registration_status,'UPCOMING');assert.equal(state.registration_open,false);
   now=new Date(base+1000);state=(await call('GET','/public/tournament')).body;assert.equal(state.registration_open,true);
   assert.equal((await settings({registration_start_at:null})).body.error.code,'SCHEDULE_DATE_LOCKED');
   assert.equal((await settings({registration_end_at:iso(5000)})).body.registration_end_at,iso(5000));
   now=new Date(base+2000);state=(await call('GET','/public/tournament')).body;assert.equal(state.started,true);assert.equal(state.registration_open,true);
   assert.equal((await settings({start_at:null})).body.error.code,'TOURNAMENT_ALREADY_STARTED');
   now=new Date(base+5000);assert.equal((await call('GET','/public/tournament')).body.registration_status,'CLOSED');assert.equal((await settings({registration_end_at:null})).body.error.code,'SCHEDULE_DATE_LOCKED');
   now=new Date(base+6000);assert.equal((await call('GET','/public/tournament')).body.ended,true);assert.equal((await settings({end_at:iso(7000)})).body.error.code,'SCHEDULE_DATE_LOCKED');
   await reset();const outcomes=await Promise.all([settings({registration_start_at:iso(1000)}),settings({registration_end_at:iso(5000)})]);assert.ok(outcomes.every(r=>r.status===200));state=(await call('GET','/admin/tournament/settings',undefined,true)).body;assert.equal(state.registration_start_at,iso(1000));assert.equal(state.registration_end_at,iso(5000));
   await reset();assert.equal((await settings({registration_end_at:iso(-1)})).body.registration_open,false);
  });
  await t.test('closed registration blocks new pending and both new-user verification paths but preserves existing login',async()=>{
   await reset();const deepNew=await pending(),deepExisting=await pending(),codeNew=await pending(),codeExisting=await pending();
   const freshCode=await issue(910002),existingCode=await issue(900002);
   await settings({registration_end_at:iso(1000)});now=new Date(base+1000);
   assert.equal((await call('POST','/auth/register',{rules_accepted:true,rules_version_id:rulesId,display_name:'Closed User'})).body.error.code,'REGISTRATION_NOT_OPEN');
   assert.equal((await verify(deepNew,910001)).body.error.code,'REGISTRATION_NOT_OPEN');
   assert.equal((await codeVerify(codeNew,910002,freshCode)).body.error.code,'REGISTRATION_NOT_OPEN');
   assert.equal((await pool.query('SELECT id FROM users WHERE tg_id IN (910001,910002)')).rowCount,0);
   assert.equal((await pool.query('SELECT is_used FROM pending_sessions WHERE token=$1',[codeNew])).rows[0].is_used,false);
   assert.equal((await verify(deepExisting,900001)).status,200);assert.equal((await codeVerify(codeExisting,900002,existingCode)).status,200);
   const login=(await call('POST','/auth/login',{})).body.token;assert.equal((await verify(login,900003)).status,200);
   const auth=(await call('POST','/auth/login',{})).body.token,newCode=await issue(910003);assert.equal((await codeVerify(auth,910003,newCode)).body.error.code,'USER_NOT_REGISTERED');
   assert.equal((await call('POST','/bot/code',{tg_id:910004,tg_username:null},false,true)).status,200);
  });
  await t.test('settings row lock serializes registration closure and preserves wallet lock after end',async()=>{
   await reset();const p=await pending(),c=await pool.connect();let response;
   try{await c.query('BEGIN');await c.query('SELECT id FROM tournament_settings WHERE id=1 FOR UPDATE');
    const waiting=verify(p,920001).then(r=>{response=r;return r;});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(response,undefined);
    await c.query('UPDATE tournament_settings SET registration_end_at=$1',[iso(-1)]);await c.query('COMMIT');assert.equal((await waiting).body.error.code,'REGISTRATION_NOT_OPEN');
   }finally{await c.query('ROLLBACK');c.release();}
   await reset();const address='11111111111111111111111111111111';const jwt=await token(ids[0]);assert.equal((await call('POST','/user/wallet',{wallet_address:address},jwt)).status,200);
   await settings({start_at:iso(1000),end_at:iso(2000)});now=new Date(base+2000);assert.equal((await call('GET','/user/profile',undefined,jwt)).body.wallet_address_locked,true);
   assert.equal((await call('POST','/user/wallet',{wallet_address:'11111111111111111111111111111112'},jwt)).body.error.code,'WALLET_CHANGE_LOCKED');
  });
  await t.test('numeric aggregates include actual zero, partial coverage and exclude inadmissible wallets/users',async()=>{
   await reset();await pool.query('DELETE FROM wallets');
   for(let i=0;i<ids.length;i++)await pool.query("INSERT INTO wallets(id,user_id,wallet_address,validation_status) VALUES($1,$2,$3,$4)",[randomUUID(),ids[i],bs58.encode(Buffer.alloc(32,i+1)),i===5?'UNDER_REVIEW':'VALID']);
   const score=rows=>call('POST','/admin/scoring/import',{rows},true);
   assert.equal((await call('GET','/public/stats')).body.pnl,null);
   await score([{tg_id:900001,pnl:'-10.123456',initial_capital:'99999999999999.999999',current_capital:'2',in_positions_amount:'0.5',lp_volume:'50'},{tg_id:900002,pnl:'0',initial_capital:'0.000001',current_capital:'0',lp_volume:'0'},{tg_id:900003,pnl:'1.123455'},{tg_id:900005,pnl:'999',current_capital:'999',lp_volume:'999'},{tg_id:900006,pnl:'999',current_capital:'999',lp_volume:'999'}]);
   const stats=(await call('GET','/public/stats')).body;assert.deepEqual(stats,{participant_count:4,initial_capital:'100000000000000.000000',current_capital:'2.000000',pnl:'-9.000001',lp_volume:'50.000000',scored_participant_count:3,capital_participant_count:2,lp_participant_count:2,server_time:now.toISOString()});
   await score([{tg_id:900001,pnl:'-10.123456'}]);assert.equal((await call('GET','/user/profile',undefined,true)).body.scoring.lp_volume,'50.000000');
   assert.equal((await call('GET','/admin/data/scoring',undefined,true)).body.rows.find(r=>r.tg_id===900001).lp_volume,'50.000000');
   assert.equal((await score([{tg_id:900001,pnl:'100',lp_volume:'1'},{tg_id:900002,pnl:'100',lp_volume:'-1'}])).status,422);assert.equal((await pool.query('SELECT pnl,lp_volume FROM tournament_scoring WHERE user_id=$1',[ids[0]])).rows[0].lp_volume,'50.000000');
   await score([{tg_id:900001,pnl:'0',lp_volume:null}]);assert.equal((await pool.query('SELECT lp_volume FROM tournament_scoring WHERE user_id=$1',[ids[0]])).rows[0].lp_volume,null);
   await assert.rejects(pool.query('UPDATE tournament_scoring SET lp_volume=-1 WHERE user_id=$1',[ids[0]]));
   assert.ok(!(await call('GET','/public/leaderboard')).body.some(row=>Object.hasOwn(row,'lp_volume')));
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
