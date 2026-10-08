import { seedRules } from './helpers/rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import pg from 'pg';
import { buildApp } from '../server/app.mjs';
import { migrate } from '../server/db.mjs';

test('Telegram OTP: recipient binding, TTL, attempt commits, one-time races and privacy',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='otp_test_'+randomUUID().replaceAll('-','');const control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 let now=new Date('2026-10-08T11:00:00Z'),requestIndex=0,app;
 const deliveries=[];let deliveryFailure=null;
 const config={jwtSecret:'j'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[900001],authJwtTtlSeconds:1800,botUsername:'TournamentBot',localDemo:false,notifyTransport:async payload=>{deliveries.push(payload);if(deliveryFailure==='throw')throw new Error('private transport payload must not escape');return deliveryFailure?{ok:false,error_code:403}:{ok:true};}};
 const events=[];
 try {
  await migrate(pool);await migrate(pool);const rulesId=await seedRules(pool);assert.equal(Number((await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE'",[schema])).rows[0].count),9);
  app=buildApp({pool,config,clock:()=>now});app.addHook('onResponse',async(req,reply)=>{if(reply.statusCode===200&&req.tournamentEvent)events.push(req.tournamentEvent);});
  const call=async(method,path,body,{bot=false,jwt,ip}={})=>{const r=await app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),remoteAddress:ip||'127.1.'+Math.floor(++requestIndex/250)+'.'+(requestIndex%250+1),headers:{...(bot?{'x-bot-secret':config.botApiSecret}:{}),...(jwt?{authorization:'Bearer '+jwt}:{})}});return {status:r.statusCode,body:r.json()};};
  const website=async(type='register',extra={})=>{const result=await call('POST','/auth/'+type,type==='register'?{rules_accepted:true,rules_version_id:rulesId,display_name:'Code Trader',...extra}:extra);assert.equal(result.status,201);return result.body.token;};
  const issue=async(id,name=null,ip)=>{let result=await call('POST','/bot/code',{tg_id:id,tg_username:name},{bot:true,ip});if(result.body.error?.code==='CODE_COOLDOWN'){now=new Date(+now+result.body.retry_after_seconds*1000);result=await call('POST','/bot/code',{tg_id:id,tg_username:name},{bot:true,ip});}assert.equal(result.status,200);assert.match(result.body.code,/^\d{6}$/);return result.body;};
  const verify=(token,identifier,code,ip)=>call('POST','/auth/code/verify',{token,telegram_identifier:identifier,code},{ip});
  const grant=async id=>(await pool.query('SELECT * FROM pending_sessions WHERE otp_tg_id=$1 ORDER BY otp_code_hash IS NOT NULL DESC,created_at DESC,token',[id])).rows[0];
  const adminCode=await issue(900001,'Admin');const adminSession=await website('register',{display_name:'Admin',tg_username:'@admin'});const adminLogin=await verify(adminSession,'@ADMIN',adminCode.code);assert.equal(adminLogin.status,200);const admin=adminLogin.body.access_token;
  await t.test('trusted issuance, cryptographic hashed storage and leading zero codes',async()=>{
   const before=Number((await pool.query('SELECT count(*) FROM pending_sessions')).rows[0].count);assert.equal((await call('POST','/bot/code',{tg_id:100001,tg_username:null})).status,401);assert.equal((await call('POST','/bot/code',{tg_id:100001,tg_username:null},{jwt:admin})).status,401);assert.equal(Number((await pool.query('SELECT count(*) FROM pending_sessions')).rows[0].count),before);
   const original=crypto.randomInt;let code;try{crypto.randomInt=()=>7;syncBuiltinESMExports();code=await issue(100001,null);}finally{crypto.randomInt=original;syncBuiltinESMExports();}
   assert.equal(code.code,'000007');assert.equal(code.telegram_identifier,'100001');assert.equal(code.expires_at,new Date(+now+300000).toISOString());const row=await grant(100001);assert.match(row.token,/^otp_[\w-]{43}$/);assert.match(row.otp_code_hash,/^[a-f0-9]{64}$/);assert.notEqual(row.otp_code_hash,code.code);assert.equal(row.tg_id,null);assert.equal(row.session_type,'AUTHORIZATION');assert.equal(row.display_name,null);assert.equal(row.otp_attempts,0);
   const token=await website();const result=await verify(token,'100001','000007');assert.equal(result.status,200);assert.equal(result.body.registration_status,'PENDING_VALIDATION');assert.equal(result.body.is_used,true);const stored=await grant(100001);assert.equal(stored.is_used,true);assert.equal(stored.otp_code_hash,null);assert.equal(Number(stored.tg_id),100001);assert.equal((await pool.query('SELECT is_used FROM pending_sessions WHERE token=$1',[token])).rows[0].is_used,true);assert.equal((await call('GET','/auth/session/'+token)).body.is_used,true);
  });
  await t.test('wrong codes commit five attempts, other recipient and exhausted codes stay neutral',async()=>{
   const code=await issue(100002,'PersonTwo'),token=await website(),wrong=code.code==='000000'?'999999':'000000';
   for(let attempt=1;attempt<=5;attempt++){const result=await verify(token,'@PERSONTWO',wrong);assert.equal(result.status,422);assert.equal(result.body.error.code,'CODE_INVALID');assert.equal((await grant(100002)).otp_attempts,attempt);assert.equal((await pool.query('SELECT * FROM users WHERE tg_id=100002')).rowCount,0);}
   assert.equal((await verify(token,'PersonTwo',code.code)).body.error.code,'CODE_INVALID');assert.equal((await grant(100002)).otp_attempts,5);assert.equal((await verify(token,'different_person',code.code)).body.error.code,'CODE_INVALID');assert.equal((await pool.query('SELECT is_used FROM pending_sessions WHERE token=$1',[token])).rows[0].is_used,false);
   const newCode=await issue(100002,'PersonTwo');assert.equal((await grant(100002)).otp_attempts,0);assert.equal((await verify(token,'@PersonTwo',newCode.code)).status,200);
  });
  await t.test('new issuance invalidates previous code and exact five-minute expiry rejects without user creation',async()=>{
   const old=await issue(100003,'PersonThree');let fresh;do{fresh=await issue(100003,'PersonThree');}while(fresh.code===old.code);
   const token=await website();assert.equal((await verify(token,'PersonThree',old.code)).body.error.code,'CODE_INVALID');assert.equal((await verify(token,'personthree',fresh.code)).status,200);const replay=await website();assert.equal((await verify(replay,'PersonThree',fresh.code)).body.error.code,'CODE_INVALID');
   const expired=await issue(100004,null),expiryToken=await website(),prior=now;now=new Date(+now+300000);assert.equal((await verify(expiryToken,'100004',expired.code)).body.error.code,'CODE_INVALID');assert.equal((await pool.query('SELECT * FROM users WHERE tg_id=100004')).rowCount,0);assert.equal((await grant(100004)).is_used,false);now=prior;
   const websiteExpired=await website();now=new Date(+now+900000);const later=await issue(100005,null);assert.equal((await verify(websiteExpired,'100005',later.code)).status,410);assert.equal((await grant(100005)).otp_code_hash!==null,true);now=prior;
  });
  await t.test('expected username binding and AUTH unknown user preserve a valid grant for registration',async()=>{
   const code=await issue(100006,'ActualName'),wrongWebsite=await website('register',{tg_username:'ExpectedName'});assert.equal((await verify(wrongWebsite,'ActualName',code.code)).body.error.code,'CODE_INVALID');assert.equal((await pool.query('SELECT * FROM users WHERE tg_id=100006')).rowCount,0);
   const login=await website('login',{tg_username:'@ActualName'});assert.equal((await verify(login,'actualname',code.code)).body.error.code,'USER_NOT_REGISTERED');assert.equal((await grant(100006)).is_used,false);assert.equal((await grant(100006)).otp_code_hash!==null,true);
   await pool.query('INSERT INTO initial_users(tg_id,group_name) VALUES(100006,$1)',['Approved']);const registration=await website('register',{display_name:'Actual Trader',tg_username:'ACTUALNAME'});const result=await verify(registration,'@actualname',code.code);assert.equal(result.status,200);assert.equal(result.body.registration_status,'APPROVED_AUTO');
   const user=(await pool.query('SELECT * FROM users WHERE tg_id=100006')).rows[0];await pool.query("UPDATE users SET registration_status='REJECTED',admin_notes='Manual reason' WHERE id=$1",[user.id]);const count=events.length;const repeatCode=await issue(100006,null),repeat=await website('register',{display_name:'Ignored Name'});assert.equal((await verify(repeat,'100006',repeatCode.code)).body.registration_status,'REJECTED');const stored=(await pool.query('SELECT * FROM users WHERE id=$1',[user.id])).rows[0];assert.equal(stored.display_name,'Actual Trader');assert.equal(stored.admin_notes,'Manual reason');assert.equal(stored.tg_username,null);assert.equal(events.length,count);
  });
  await t.test('two simultaneous verifications consume one grant exactly once',async()=>{
   const code=await issue(100007,'Race'),tokens=await Promise.all([website(),website()]);const before=events.length;const results=await Promise.all(tokens.map(token=>verify(token,'@race',code.code)));assert.deepEqual(results.map(r=>r.status).sort(),[200,422]);assert.equal(results.find(r=>r.status===422).body.error.code,'CODE_INVALID');assert.equal((await pool.query('SELECT * FROM users WHERE tg_id=100007')).rowCount,1);assert.equal((await pool.query('SELECT * FROM pending_sessions WHERE token=ANY($1::text[]) AND is_used=true',[tokens])).rowCount,1);assert.equal(events.length-before,1);
   const used=tokens[results.findIndex(r=>r.status===200)];const unused=tokens[results.findIndex(r=>r.status===422)];assert.equal((await verify(used,'Race',code.code)).body.error.code,'CODE_INVALID');const replacement=await issue(100007,'Race');assert.equal((await verify(unused,'Race',replacement.code)).status,200);
  });
  await t.test('admin sessions use OTP TTL and never expose tokens, hashes or grant internal columns',async()=>{
   const code=await issue(100008,'PrivateGrant'),prior=now;now=new Date(+now+300000);const response=await call('GET','/admin/data/sessions?limit=100',undefined,{jwt:admin});assert.equal(response.status,200);const expected=['created_at','display_name','expected_tg_username','expired','expires_at','is_used','session_type','tg_id'];assert.ok(response.body.rows.every(row=>Object.keys(row).sort().join(',')===expected.join(',')));
   assert.ok(response.body.rows.some(row=>row.display_name===null&&+new Date(row.expires_at)-+new Date(row.created_at)===300000&&row.expired));assert.ok(response.body.rows.some(row=>row.display_name!==null&&+new Date(row.expires_at)-+new Date(row.created_at)===900000));const serialized=JSON.stringify(response.body);const internal=await grant(100008);assert.ok(!serialized.includes(internal.token));assert.ok(!serialized.includes(internal.otp_code_hash));assert.ok(!serialized.includes('otp_attempts'));assert.ok(!serialized.includes('otp_tg_id'));assert.equal((await verify(await website(),'PrivateGrant',code.code)).body.error.code,'CODE_INVALID');now=prior;
  });
  await t.test('automatic request targets verified users, stays neutral and does not replace codes within a minute',async()=>{
   const send=(token,identifier,extra={},ip)=>call('POST','/auth/code/request',{token,telegram_identifier:identifier,...extra},{ip});
   let before=deliveries.length;const unknown=await website('login');assert.deepEqual((await send(unknown,'NoSuchUser')).body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.length,before);
   const known=await website('login',{tg_username:'ADMIN'});const response=await send(known,'@AdMiN');assert.equal(response.status,200);assert.deepEqual(response.body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.length,before+1);assert.equal(deliveries.at(-1).chat_id,900001);const code=deliveries.at(-1).text.match(/^Код для входа: (\d{6})/)[1];const active=await grant(900001);assert.match(active.otp_code_hash,/^[0-9a-f]{64}$/);assert.ok(!JSON.stringify(response.body).includes(code));
   assert.deepEqual((await send(known,'@admin')).body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.length,before+1);assert.equal((await grant(900001)).token,active.token);assert.equal((await verify(known,'Admin',code)).status,200);
   const mismatch=await website('login',{tg_username:'SomeoneElse'});assert.deepEqual((await send(mismatch,'@Admin')).body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.length,before+1);
   const idToken=await website('login');const idResult=await send(idToken,'100001');assert.deepEqual(idResult.body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.at(-1).chat_id,100001);const idCode=deliveries.at(-1).text.match(/^Код для входа: (\d{6})/)[1];assert.equal((await verify(idToken,'100001',idCode)).status,200);
   assert.equal((await send(await website(),'100001',{chat_id:999})).status,422);assert.equal((await send('auth_'+'x'.repeat(43),'100001')).status,404);assert.equal((await send(idToken,'100001')).status,409);
   const expired=await website(),prior=now;now=new Date(+now+900000);assert.equal((await send(expired,'100001')).status,410);now=prior;
  });
  await t.test('automatic delivery failures stay neutral, manual start bypasses throttling and concurrent automatic requests send once',async()=>{
   const send=(token,identifier,ip)=>call('POST','/auth/code/request',{token,telegram_identifier:identifier},{ip});
   const prior=now;now=new Date(+now+60001);
   // A recent manual code must not suppress automatic delivery after logout.
   const manual=await issue(100002,'PersonTwo');now=new Date(+now+90000);const login=await website('login');let before=deliveries.length;assert.deepEqual((await send(login,'PersonTwo')).body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.length,before+1);assert.notEqual((await grant(100002)).otp_code_hash,null);const automatic=deliveries.at(-1).text.match(/^Код для входа: (\d{6})/)[1];assert.equal((await verify(login,'PersonTwo',automatic)).status,200);
   const failureToken=await website('login');deliveryFailure='throw';before=deliveries.length;const failed=await send(failureToken,'100003');assert.deepEqual(failed.body,{status:'requested',retry_after_seconds:90});assert.equal(deliveries.length,before+1);assert.ok(!JSON.stringify(failed.body).includes('private'));const blockedGrant=await grant(100003);assert.deepEqual((await send(failureToken,'100003')).body,{status:'requested',retry_after_seconds:90});assert.equal((await grant(100003)).token,blockedGrant.token);assert.equal(deliveries.length,before+1);deliveryFailure=null;
   const fallback=await issue(100003,'PersonThree');assert.equal((await verify(failureToken,'PersonThree',fallback.code)).status,200);
   deliveryFailure='403';const refused=await website('login');assert.deepEqual((await send(refused,'100006')).body,{status:'requested',retry_after_seconds:90});deliveryFailure=null;const retry=await issue(100006,null);assert.equal((await verify(refused,'100006',retry.code)).status,200);
   const tokens=await Promise.all([website('login'),website('login')]);before=deliveries.length;const parallel=await Promise.all(tokens.map(token=>send(token,'Race')));assert.ok(parallel.every(r=>r.status===200));assert.equal(deliveries.length,before+1);
   const rateToken=await website('login');for(let i=0;i<10;i++)assert.equal((await send(rateToken,'Unknown','127.0.0.249')).status,200);assert.equal((await send(rateToken,'Unknown','127.0.0.249')).status,429);now=prior;
  });
  await t.test('10 verification requests and 60 issuance requests per minute are enforced before writes',async()=>{
   const code=await issue(100009,null),token=await website();for(let i=0;i<10;i++)assert.equal((await verify(token,'unknown_recipient',code.code,'127.0.0.250')).status,422);const attempts=(await grant(100009)).otp_attempts;assert.equal((await verify(token,'100009',code.code,'127.0.0.250')).status,429);assert.equal((await grant(100009)).otp_attempts,attempts);
   for(let i=0;i<60;i++)await issue(101000+i,null,'127.0.0.251');assert.equal((await call('POST','/bot/code',{tg_id:102999,tg_username:null},{bot:true,ip:'127.0.0.251'})).status,429);assert.equal((await pool.query('SELECT * FROM pending_sessions WHERE otp_tg_id=102999')).rowCount,0);
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
