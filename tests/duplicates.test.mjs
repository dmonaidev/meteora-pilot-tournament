import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import bs58 from 'bs58';
import pg from 'pg';
import {buildApp} from '../server/app.mjs';
import {migrate} from '../server/db.mjs';

test('profile duplicate checks: privacy, atomic saves and index races',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='duplicates_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const now=new Date('2026-10-08T12:00:00Z'),config={jwtSecret:'d'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[],authJwtTtlSeconds:1800,botUsername:'TestBot',localDemo:false};
 const ids=Array.from({length:8},()=>randomUUID()),tokens=[],addr=i=>bs58.encode(Buffer.alloc(32,i+1));
 let app,index=0,queryCount=0,raceBarrier;
 const tracked={query:async(...args)=>{queryCount++;return pool.query(...args);},connect:async()=>{const client=await pool.connect();return {query:async(sql,args)=>{queryCount++;const result=await client.query(sql,args);if(raceBarrier&&sql.startsWith('SELECT EXISTS(SELECT 1 FROM wallets')){const barrier=raceBarrier;if(++barrier.arrivals===2){raceBarrier=null;barrier.release();}await barrier.promise;}return result;},release:()=>client.release()};}};
 const race=async operations=>{let release;const promise=new Promise(resolve=>{release=resolve;});raceBarrier={arrivals:0,promise,release};try{return await Promise.all(operations.map(operation=>operation()));}finally{release();raceBarrier=null;}};
 const call=async(path,body,token=tokens[1],ip)=>{const response=await app.inject({method:'POST',url:'/api/v1'+path,payload:body,remoteAddress:ip??'127.4.0.'+(++index%250+1),headers:token?{authorization:'Bearer '+token}:{}});return {status:response.statusCode,body:response.json()};};
 const check=(body,token)=>call('/user/profile-check',body,token);
 const wallet=(i,body)=>call('/user/wallet',body,tokens[i]);
 const reward=(i,body)=>call('/user/rewards',body,tokens[i]);
 const state=async i=>({wallet:(await pool.query('SELECT * FROM wallets WHERE user_id=$1',[ids[i]])).rows[0]??null,reward:(await pool.query('SELECT * FROM partner_rewards WHERE user_id=$1',[ids[i]])).rows[0]??null});
 const conflict=(response,field)=>{assert.equal(response.status,409);assert.equal(response.body.error.code,field==='wallet_address'?'WALLET_ALREADY_REGISTERED':'UID_ALREADY_REGISTERED');assert.deepEqual(response.body.error.fields,[{field,message:field==='wallet_address'?'Этот кошелёк уже зарегистрирован другим участником':'Этот UID уже зарегистрирован другим участником'}]);};
 try{
  await migrate(pool);await migrate(pool);
  for(let i=0;i<ids.length;i++){
   await pool.query("INSERT INTO users(id,tg_id,tg_username,display_name,registration_status) VALUES($1,$2,$3,$4,'PENDING_VALIDATION')",[ids[i],930001+i,'private_owner_'+i,'Private Owner '+i]);
   const session=randomUUID();await pool.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[session,ids[i],new Date(+now+1800000)]);
   tokens.push(await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(ids[i]).setJti(session).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+now/1000)+1800).sign(new TextEncoder().encode(config.jwtSecret)));
  }
  await pool.query("INSERT INTO wallets(id,user_id,wallet_address,withdrawal_tx_hash,validation_status,rejection_reason) VALUES($1,$2,$3,'owner-hash','INVALID','private reason')",[randomUUID(),ids[0],addr(0)]);
  await pool.query("INSERT INTO partner_rewards(user_id,reward_type,exchange_uid,uid_status) VALUES($1,'PARTNER_GIFTS','00000123','INVALID')",[ids[0]]);
  app=buildApp({pool:tracked,config,clock:()=>now});
  await t.test('authentication, strict validation, exact comparison, own exclusion and read-only privacy',async()=>{
   const before=queryCount;assert.equal((await check({wallet_address:addr(0)},null)).status,401);assert.equal(queryCount,before);
   for(const body of [{},{wallet_address:''},{wallet_address:'bad'},{exchange_uid:''},{exchange_uid:null},{exchange_uid:'x'.repeat(51)},{exchange_uid:'ok',owner:true}])assert.equal((await check(body)).status,422);
   const original=await state(0),other=await state(1);
   const result=await check({wallet_address:' '+addr(0)+' ',exchange_uid:' 00000123 '});assert.deepEqual(result.body,{wallet_address:{available:false},exchange_uid:{available:false}});
   assert.deepEqual((await check({wallet_address:addr(0),exchange_uid:'00000123'},tokens[0])).body,{wallet_address:{available:true},exchange_uid:{available:true}});
   assert.deepEqual((await check({exchange_uid:'123'})).body,{wallet_address:null,exchange_uid:{available:true}});
   assert.deepEqual((await check({wallet_address:addr(1)})).body,{wallet_address:{available:true},exchange_uid:null});
   assert.deepEqual(await state(0),original);assert.deepEqual(await state(1),other);
   assert.ok(!JSON.stringify(result.body).includes('owner'));assert.ok(!JSON.stringify(result.body).includes(ids[0]));
  });
  await t.test('both saving paths reject duplicates and roll back the wallet/hash/reward pair',async()=>{
   conflict(await wallet(1,{wallet_address:addr(0)}),'wallet_address');assert.deepEqual(await state(1),{wallet:null,reward:null});
   conflict(await wallet(1,{wallet_address:addr(1),exchange_uid:' 00000123 ',withdrawal_tx_hash:'new-hash'}),'exchange_uid');assert.deepEqual(await state(1),{wallet:null,reward:null});
   assert.equal((await wallet(1,{wallet_address:addr(1),exchange_uid:'123',withdrawal_tx_hash:'original'})).status,200);const original=await state(1);
   conflict(await reward(1,{exchange_uid:'00000123',withdrawal_tx_hash:'changed'}),'exchange_uid');assert.deepEqual(await state(1),original);
   conflict(await wallet(1,{wallet_address:addr(0),exchange_uid:null}),'wallet_address');assert.deepEqual(await state(1),original);
   assert.equal((await wallet(1,{wallet_address:addr(1),exchange_uid:'123',withdrawal_tx_hash:'original'})).status,200);
   for(const i of [1,2]){if(i===2)await wallet(i,{wallet_address:addr(i)});assert.equal((await reward(i,{exchange_uid:null})).status,200);}
   await assert.rejects(pool.query("INSERT INTO wallets(id,user_id,wallet_address) VALUES($1,$2,$3)",[randomUUID(),ids[3],addr(0)]),error=>error.code==='23505'&&error.constraint==='wallets_wallet_address_unique');
   await assert.rejects(pool.query("INSERT INTO partner_rewards(user_id,reward_type,exchange_uid,uid_status) VALUES($1,'PARTNER_GIFTS','00000123','UNDER_REVIEW')",[ids[3]]),error=>error.code==='23505'&&error.constraint==='partner_rewards_exchange_uid_unique');
  });
  await t.test('concurrent same-wallet writes produce one success and one mapped index conflict',async()=>{
   const results=await race([()=>wallet(3,{wallet_address:addr(20),exchange_uid:'race-wallet-a',withdrawal_tx_hash:'a'}),()=>wallet(4,{wallet_address:addr(20),exchange_uid:'race-wallet-b',withdrawal_tx_hash:'b'})]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);conflict(results.find(r=>r.status===409),'wallet_address');
   const loser=results[0].status===409?3:4;assert.deepEqual(await state(loser),{wallet:null,reward:null});
  });
  await t.test('concurrent same-UID writes roll back the losing wallet insert after index conflict',async()=>{
   const results=await race([()=>wallet(5,{wallet_address:addr(5),exchange_uid:'race-uid',withdrawal_tx_hash:'a'}),()=>wallet(6,{wallet_address:addr(6),exchange_uid:'race-uid',withdrawal_tx_hash:'b'})]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);conflict(results.find(r=>r.status===409),'exchange_uid');
   assert.deepEqual(await state(results[0].status===409?5:6),{wallet:null,reward:null});
  });
  await t.test('alternative reward writes also map index races and restore the losing hash/status',async()=>{
   const originals=[await state(1),await state(2)];
   const results=await race([()=>reward(1,{exchange_uid:'reward-race',withdrawal_tx_hash:'new-one'}),()=>reward(2,{exchange_uid:'reward-race',withdrawal_tx_hash:'new-two'})]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);conflict(results.find(r=>r.status===409),'exchange_uid');
   const loser=results[0].status===409?0:1;assert.deepEqual(await state(loser+1),originals[loser]);
  });
  await t.test('profile-check rate limit rejects request 121 before authentication/database reads',async()=>{
   for(let i=0;i<120;i++)assert.equal((await call('/user/profile-check',{exchange_uid:'unused'},tokens[7],'127.9.9.9')).status,200);
   const before=queryCount,response=await call('/user/profile-check',{exchange_uid:'unused'},tokens[7],'127.9.9.9');assert.equal(response.status,429);assert.equal(response.body.error.code,'RATE_LIMITED');assert.equal(queryCount,before);
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
