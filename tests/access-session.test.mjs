import { seedRules } from './helpers/rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeJwt, SignJWT } from 'jose';
import pg from 'pg';
import { buildApp } from '../server/app.mjs';
import { migrate } from '../server/db.mjs';
import { runRenewalCleanup } from '../server/access-session.mjs';

test('managed access: 30 minutes, owner renewal, logout, legacy cap and persistent cooldown',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='session_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const base=new Date('2026-10-08T12:00:00Z');let now=new Date(base),app,index=0,messageId=0,sendFailure=false,editFailure=false;const messages=[],edits=[];
 const config={jwtSecret:'j'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[100001],authJwtTtlSeconds:86400,botUsername:'TournamentBot',localDemo:false,notifyTransport:async payload=>{messages.push(payload);return sendFailure?{ok:false,error_code:403}:{ok:true,message_id:++messageId};},editTransport:async payload=>{edits.push(payload);return editFailure?{ok:false,error_code:503}:{ok:true};}};
 try{
  await migrate(pool);await migrate(pool);const rulesId=await seedRules(pool);app=buildApp({pool,config,clock:()=>now});
  const call=async(method,path,body,jwt,bot=false,target=app)=>{const r=await target.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),remoteAddress:'127.2.'+Math.floor(++index/250)+'.'+(index%250+1),headers:{...(jwt?{authorization:'Bearer '+jwt}:{}),...(bot?{'x-bot-secret':config.botApiSecret}:{})}});return {status:r.statusCode,body:r.json()};};
  const open=async(tgId=100001,name='Mixed_User')=>{const pending=(await call('POST','/auth/register',{rules_accepted:true,rules_version_id:rulesId,display_name:'Session User',tg_username:'@'+name})).body.token;assert.equal((await call('POST','/bot/verify',{token:pending,tg_id:tgId,tg_username:name},null,true)).status,200);const response=await call('GET','/auth/session/'+pending);assert.equal(response.status,200);return {token:response.body.access_token,pending,id:decodeJwt(response.body.access_token).jti};};
  const request=jwt=>call('POST','/auth/renew/request',{},jwt);
  const challenge=()=>messages.at(-1).reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  const confirm=(token,tgId=100001)=>call('POST','/bot/session/confirm',{token,tg_id:tgId},null,true);
  await t.test('code login and legacy polling link one fixed server session and issue deterministic 30-minute JWTs',async()=>{
   const code=(await call('POST','/bot/code',{tg_id:100001,tg_username:' @Mixed_User '},null,true)).body;
   const pending=(await call('POST','/auth/register',{rules_accepted:true,rules_version_id:rulesId,display_name:'Session User',tg_username:'mixed_user'})).body.token;
   const verified=await call('POST','/auth/code/verify',{token:pending,telegram_identifier:'@MIXED_USER',code:code.code});assert.equal(verified.status,200);const payload=decodeJwt(verified.body.access_token);assert.equal(payload.exp-payload.iat,1800);assert.match(payload.jti,/^[0-9a-f-]{36}$/);
   const polled=(await call('GET','/auth/session/'+pending)).body.access_token;assert.equal(polled,verified.body.access_token);assert.equal((await pool.query('SELECT * FROM auth_sessions')).rowCount,1);
   const first=await call('GET','/auth/access',undefined,polled);now=new Date(+base+60000);const second=await call('GET','/auth/access',undefined,polled);assert.equal(first.body.access_token,second.body.access_token);assert.equal(first.body.expires_at,second.body.expires_at);assert.equal(first.body.renewal,null);assert.equal((await pool.query('SELECT tg_username FROM users WHERE tg_id=100001')).rows[0].tg_username,'Mixed_User');now=new Date(base);
  });
  await t.test('renewal opens at minute 25, site click does not extend, owner confirmation wins once and late polling retrieves renewal',async()=>{
   const session=await open();now=new Date(+base+1499000);assert.equal((await request(session.token)).body.error.code,'RENEWAL_NOT_AVAILABLE');now=new Date(+base+1500000);
   const sent=await request(session.token);assert.equal(sent.status,200);assert.equal(sent.body.retry_after_seconds,90);assert.equal(sent.body.expires_at,new Date(+base+1800000).toISOString());assert.equal((await pool.query('SELECT expires_at FROM auth_sessions WHERE id=$1',[session.id])).rows[0].expires_at.toISOString(),new Date(+base+1800000).toISOString());const token=challenge();assert.equal(Buffer.byteLength('sr_'+token),46);
   const before=messages.length;now=new Date(+base+1501000);const repeated=await request(session.token);assert.equal(repeated.body.retry_after_seconds,89);assert.equal(messages.length,before);assert.equal(challenge(),token);assert.equal((await confirm(token,100002)).status,403);
   now=new Date(+base+1799000);const results=await Promise.all([confirm(token),confirm(token)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);const deadline=new Date(+now+1800000);assert.equal(results.find(r=>r.status===200).body.expires_at,deadline.toISOString());
   now=new Date(+base+1801000);assert.equal((await call('GET','/user/profile',undefined,session.token)).status,401);const access=await call('GET','/auth/access',undefined,session.token);assert.equal(access.status,200);assert.equal(access.body.expires_at,deadline.toISOString());assert.equal(access.body.renewal,null);assert.notEqual(access.body.access_token,session.token);assert.equal((await call('GET','/user/profile',undefined,access.body.access_token)).status,200);assert.equal((await confirm(token)).status,410);
   const stable=await call('GET','/auth/access',undefined,access.body.access_token);assert.equal(stable.body.access_token,access.body.access_token);now=new Date(base);
  });
  await t.test('unconfirmed deadline, exact-boundary callbacks and logout never restore access',async()=>{
   const session=await open();now=new Date(+base+1500000);await request(session.token);const token=challenge();now=new Date(+base+1800000);assert.equal((await confirm(token)).status,410);assert.equal((await call('GET','/auth/access',undefined,session.token)).status,401);assert.equal((await call('GET','/user/profile',undefined,session.token)).status,401);
   now=new Date(base);const logout=await open();now=new Date(+base+1500000);await request(logout.token);const old=challenge();assert.equal((await call('POST','/auth/logout',{},logout.token)).body.status,'logged_out');assert.equal((await confirm(old)).status,410);assert.equal((await call('GET','/auth/access',undefined,logout.token)).status,401);assert.equal((await call('GET','/auth/session/'+logout.pending)).status,410);now=new Date(base);
  });
  await t.test('legacy signed tokens require iat, cap at 30 minutes and keep one fingerprint session across app instances',async()=>{
   const user=(await pool.query('SELECT id FROM users WHERE tg_id=100001')).rows[0].id;const key=new TextEncoder().encode(config.jwtSecret);const issued=Math.floor(+base/1000);
   const legacy=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(user).setIssuedAt(issued).setExpirationTime(issued+86400).sign(key);
   const noIat=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(user).setExpirationTime(issued+86400).sign(key);assert.equal((await call('GET','/user/profile',undefined,noIat)).status,401);
   const first=await call('GET','/auth/access',undefined,legacy);assert.equal(first.status,200);assert.equal(first.body.expires_at,new Date(+base+1800000).toISOString());const nextApp=buildApp({pool,config,clock:()=>now});try{assert.equal((await call('GET','/auth/access',undefined,legacy,false,nextApp)).body.access_token,first.body.access_token);}finally{await nextApp.close();}
   assert.equal((await pool.query('SELECT * FROM auth_sessions WHERE legacy_token_hash IS NOT NULL')).rowCount,1);now=new Date(+base+960000);assert.equal((await call('GET','/user/profile',undefined,legacy)).status,200);now=new Date(+base+1800000);assert.equal((await call('GET','/user/profile',undefined,legacy)).status,401);assert.equal((await call('GET','/auth/access',undefined,legacy)).status,401);now=new Date(base);
  });
  await t.test('delivery errors preserve access, replaced buttons expire and cleanup retries without removing new messages',async()=>{
   const session=await open();now=new Date(+base+1500000);sendFailure=true;assert.equal((await request(session.token)).body.error.code,'TELEGRAM_UNAVAILABLE');assert.equal((await call('GET','/user/profile',undefined,session.token)).status,200);assert.equal((await pool.query('SELECT renewal_token FROM auth_sessions WHERE id=$1',[session.id])).rows[0].renewal_token,null);sendFailure=false;
   await request(session.token);const old=challenge(),oldMessage=messageId;now=new Date(+base+1590000);await request(session.token);assert.ok(edits.some(e=>e.message_id===oldMessage));assert.equal((await confirm(old)).status,410);const replacement=challenge();assert.notEqual(replacement,old);
   now=new Date(+base+1800000);editFailure=true;await runRenewalCleanup(pool,config,()=>now);let stored=(await pool.query('SELECT renewal_token,renewal_message_id FROM auth_sessions WHERE id=$1',[session.id])).rows[0];assert.equal(stored.renewal_token,null);assert.equal(Number(stored.renewal_message_id),messageId);editFailure=false;await runRenewalCleanup(pool,config,()=>now);stored=(await pool.query('SELECT renewal_message_id FROM auth_sessions WHERE id=$1',[session.id])).rows[0];assert.equal(stored.renewal_message_id,null);assert.equal((await confirm(replacement)).status,410);now=new Date(base);
  });
  await t.test('90-second shared OTP cooldown persists across apps, usernames and automatic/manual sources',async()=>{
   now=new Date(+base+90000);const first=await call('POST','/bot/code',{tg_id:100001,tg_username:'Mixed_User'},null,true);assert.equal(first.status,200);const grant=(await pool.query('SELECT token FROM pending_sessions WHERE otp_tg_id=100001 AND otp_code_hash IS NOT NULL')).rows[0].token;
   now=new Date(+base+179000);const denied=await call('POST','/bot/code',{tg_id:100001,tg_username:'@MIXED_USER'},null,true);assert.equal(denied.status,429);assert.equal(denied.body.error.code,'CODE_COOLDOWN');assert.equal(denied.body.retry_after_seconds,1);
   const pending=(await call('POST','/auth/login',{tg_username:'mixed_user'})).body.token,before=messages.length;const auto=await call('POST','/auth/code/request',{token:pending,telegram_identifier:'@Mixed_User'});assert.deepEqual(auto.body,{status:'requested',retry_after_seconds:90});assert.equal(messages.length,before);assert.equal((await pool.query('SELECT token FROM pending_sessions WHERE otp_tg_id=100001 AND otp_code_hash IS NOT NULL')).rows[0].token,grant);
   const restarted=buildApp({pool,config,clock:()=>now});try{assert.equal((await call('POST','/bot/code',{tg_id:100001,tg_username:null},null,true,restarted)).body.error.code,'CODE_COOLDOWN');}finally{await restarted.close();}
   now=new Date(+base+180000);const allowed=await call('POST','/bot/code',{tg_id:100001,tg_username:'Mixed_User'},null,true);assert.equal(allowed.status,200);assert.notEqual((await pool.query('SELECT token FROM pending_sessions WHERE otp_tg_id=100001 AND otp_code_hash IS NOT NULL')).rows[0].token,grant);
   await pool.query("INSERT INTO users(id,tg_id,tg_username,display_name,registration_status,admin_notes) VALUES($1,800000000000026,'TestUserDEMO_261009_16:54','TestUserDEMO_261009_16:54','APPROVED_MANUAL','Demo')",[randomUUID()]);const demoPending=(await call('POST','/auth/login',{})).body.token;const sent=messages.length;assert.deepEqual((await call('POST','/auth/code/request',{token:demoPending,telegram_identifier:'800000000000026'})).body,{status:'requested',retry_after_seconds:90});assert.equal(messages.length,sent);
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
