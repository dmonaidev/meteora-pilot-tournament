import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../server/app.mjs';
import {migrate} from '../server/db.mjs';

test('rules versions, publication races, consent and retained tombstones',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='rules_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 let now=new Date('2026-10-08T12:00:00Z'),app,index=0,admin,member;
 const config={jwtSecret:'r'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[940001],authJwtTtlSeconds:1800,botUsername:'TestBot',localDemo:false};
 const call=async(method,path,body,auth=false,bot=false)=>{const response=await app.inject({method,url:'/api/v1'+path,...(body===undefined?{}:{payload:body}),remoteAddress:'127.5.0.'+(++index%250+1),headers:{...(auth?{authorization:'Bearer '+(auth===true?admin:auth)}:{}),...(bot?{'x-bot-secret':config.botApiSecret}:{})}});return {status:response.statusCode,body:response.json()};};
 const create=async title=>{const result=await call('POST','/admin/rules',{title,body:' Body for '+title+'\n<script>plain text</script> '},true);assert.equal(result.status,201);return result.body;};
 const publish=rule=>call('POST','/admin/rules/'+rule.id+'/publish',{},true);
 const remove=rule=>call('POST','/admin/rules/'+rule.id+'/delete',{},true);
 const pending=async rule=>{const response=await call('POST','/auth/register',{display_name:'Rules Trader',rules_accepted:true,rules_version_id:rule.id});assert.equal(response.status,201);return response.body.token;};
 const deep=(token,id)=>call('POST','/bot/verify',{token,tg_id:id,tg_username:null},false,true);
 const otp=async id=>{const response=await call('POST','/bot/code',{tg_id:id,tg_username:null},false,true);assert.equal(response.status,200);return response.body.code;};
 const code=(token,id,value)=>call('POST','/auth/code/verify',{token,telegram_identifier:String(id),code:value});
 let first,second,deleteDeep,deleteCode,expired,completedDeep,completedCode,acceptance;
 try{
  await migrate(pool);await migrate(pool);assert.equal(Number((await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE'",[schema])).rows[0].count),9);
  const ids=[randomUUID(),randomUUID()];for(let i=0;i<ids.length;i++){
   await pool.query("INSERT INTO users(id,tg_id,display_name,registration_status) VALUES($1,$2,'Old account','PENDING_VALIDATION')",[ids[i],940001+i]);
   const session=randomUUID();await pool.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[session,ids[i],new Date(+now+1800000)]);
   const token=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(ids[i]).setJti(session).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+now/1000)+1800).sign(new TextEncoder().encode(config.jwtSecret));if(i===0)admin=token;else member=token;
  }
  app=buildApp({pool,config,clock:()=>now});
  await t.test('no active rules blocks new registration but existing users and admin guards keep working',async()=>{
   assert.deepEqual((await call('GET','/public/rules')).body,{active:null,versions:[]});
   assert.equal((await call('POST','/auth/register',{display_name:'New User',rules_accepted:true,rules_version_id:randomUUID()})).body.error.code,'RULES_UNAVAILABLE');
   for(const body of [{display_name:'New User'},{display_name:'New User',rules_accepted:false,rules_version_id:randomUUID()}])assert.equal((await call('POST','/auth/register',body)).status,422);
   for(const [method,path,body] of [['GET','/admin/rules'],['POST','/admin/rules',{title:'x',body:'x'}],['POST','/admin/rules/'+randomUUID()+'/publish',{}],['POST','/admin/rules/'+randomUUID()+'/delete',{}],['POST','/admin/rules/'+randomUUID()+'/save',{title:'x',body:'x'}]]){assert.equal((await call(method,path,body)).status,401);assert.equal((await call(method,path,body,member)).status,403);}
   const login=(await call('POST','/auth/login',{})).body.token;assert.equal((await deep(login,940002)).status,200);assert.equal((await call('GET','/auth/session/'+login)).status,200);
   const profile=(await call('GET','/user/profile',undefined,member)).body;assert.equal(profile.accepted_rules_version_id,null);assert.equal(profile.rules_accepted_at,null);
   assert.ok((await call('GET','/admin/users',undefined,true)).body.every(row=>row.accepted_rules_version_id===null&&row.rules_accepted_at===null));
  });
  await t.test('drafts are private, strict and editable; published content is immutable and publication idempotent',async()=>{
   for(const body of [{title:'',body:'x'},{title:'x',body:''},{title:'x',body:'x',status:'ACTIVE'}])assert.equal((await call('POST','/admin/rules',body,true)).status,422);
   first=await create('First');assert.equal(first.status,'DRAFT');assert.equal(first.title,'First');assert.equal(first.body.startsWith('Body'),true);assert.equal(first.version,1);
   assert.equal((await call('GET','/public/rules/'+first.id)).status,404);assert.deepEqual((await call('GET','/public/rules')).body.versions,[]);
   assert.equal((await call('GET','/public/rules/not-a-uuid')).status,422);
   const saved=await call('POST','/admin/rules/'+first.id+'/save',{title:'First edited',body:'Exact agreed body'},true);assert.equal(saved.body.version,first.version);
   first=(await publish(first)).body;assert.equal(first.status,'ACTIVE');assert.equal(first.body,'Exact agreed body');const repeated=(await publish(first)).body;assert.deepEqual(repeated,first);
   assert.equal((await call('POST','/admin/rules/'+first.id+'/save',{title:'Mutated',body:'Mutated'},true)).body.error.code,'RULES_VERSION_LOCKED');assert.equal((await remove(first)).body.error.code,'RULES_ACTIVE_DELETE_FORBIDDEN');
   assert.equal((await call('POST','/admin/rules/'+first.id+'/publish',{extra:true},true)).status,422);
   const publicResult=(await call('GET','/public/rules')).body;assert.deepEqual(publicResult.active,first);assert.ok(publicResult.versions.every(row=>!Object.hasOwn(row,'body')&&!Object.hasOwn(row,'deleted_at')));
   await assert.rejects(pool.query('UPDATE tournament_rules SET body=$2 WHERE id=$1',[first.id,'Altered directly']));
  });
  await t.test('both verification paths copy exact consent and allow published archive after an intervening publication',async()=>{
   assert.equal((await call('POST','/auth/register',{display_name:'New User',rules_accepted:true,rules_version_id:randomUUID()})).body.error.code,'RULES_CHANGED');
   completedDeep=await pending(first);completedCode=await pending(first);deleteDeep=await pending(first);deleteCode=await pending(first);expired=await pending(first);
   acceptance=(await pool.query('SELECT rules_version_id,rules_accepted_at FROM pending_sessions WHERE token=$1',[completedDeep])).rows[0];assert.equal(acceptance.rules_version_id,first.id);assert.equal(acceptance.rules_accepted_at.toISOString(),now.toISOString());
   second=await create('Second');now=new Date(+now+1000);assert.equal((await publish(second)).status,200);
   assert.equal((await deep(completedDeep,941001)).status,200);const value=await otp(941002);assert.equal((await code(completedCode,941002,value)).status,200);
   const rows=(await pool.query('SELECT accepted_rules_version_id,rules_accepted_at FROM users WHERE tg_id IN (941001,941002)')).rows;assert.equal(rows.length,2);assert.ok(rows.every(row=>row.accepted_rules_version_id===first.id&&row.rules_accepted_at.toISOString()===acceptance.rules_accepted_at.toISOString()));
   const jwt=(await call('GET','/auth/session/'+completedDeep)).body.access_token;assert.equal((await call('GET','/user/profile',undefined,jwt)).body.accepted_rules_version_id,first.id);
   const reuse=await pending(second);assert.equal((await deep(reuse,941001)).status,200);assert.equal((await pool.query('SELECT accepted_rules_version_id FROM users WHERE tg_id=941001')).rows[0].accepted_rules_version_id,first.id);
   const oldReuse=await pending(second);assert.equal((await deep(oldReuse,940002)).status,200);assert.equal((await pool.query('SELECT accepted_rules_version_id FROM users WHERE tg_id=940002')).rows[0].accepted_rules_version_id,null);
   assert.equal((await call('POST','/admin/rules/'+first.id+'/save',{title:'Archived mutation',body:'x'},true)).status,409);assert.equal((await publish(first)).status,409);
   const archive=(await call('GET','/public/rules/'+first.id)).body;assert.equal(archive.status,'ARCHIVED');assert.equal(archive.body,'Exact agreed body');assert.deepEqual((await call('GET','/public/rules')).body.versions.map(row=>row.version),[2,1]);
  });
  await t.test('deleted archive clears text but preserves FK consent and blocks pending new users atomically',async()=>{
   const value=await otp(941004);assert.equal((await remove(first)).status,200);assert.equal((await call('GET','/public/rules/'+first.id)).body.error.code,'RULES_NOT_FOUND');
   assert.ok(!(await call('GET','/admin/rules',undefined,true)).body.versions.some(row=>row.id===first.id));
   assert.equal((await deep(deleteDeep,941003)).body.error.code,'RULES_CHANGED');assert.equal((await code(deleteCode,941004,value)).body.error.code,'RULES_CHANGED');
   assert.equal((await pool.query('SELECT id FROM users WHERE tg_id IN (941003,941004)')).rowCount,0);assert.equal((await pool.query('SELECT is_used FROM pending_sessions WHERE token=$1',[deleteCode])).rows[0].is_used,false);
   const tombstone=(await pool.query('SELECT * FROM tournament_rules WHERE id=$1',[first.id])).rows[0];assert.equal(tombstone.body,null);assert.ok(tombstone.deleted_at);assert.equal(tombstone.title,'First edited');
   assert.equal((await pool.query('SELECT accepted_rules_version_id FROM users WHERE tg_id=941001')).rows[0].accepted_rules_version_id,first.id);
   await assert.rejects(pool.query('DELETE FROM tournament_rules WHERE id=$1',[first.id]));
   const historical='reg_'+randomBytes(32).toString('base64url');await pool.query("INSERT INTO pending_sessions(token,session_type,display_name,created_at) VALUES($1,'REGISTRATION','Historical',$2)",[historical,now]);assert.equal((await deep(historical,941005)).body.error.code,'RULES_CHANGED');
   const before=now;now=new Date(+acceptance.rules_accepted_at+900000);assert.equal((await deep(expired,941006)).status,410);now=before;
  });
  await t.test('concurrent publication retains all versions and serializes save and delete races',async()=>{
   const a=await create('Concurrent A'),b=await create('Concurrent B');const outcomes=await Promise.all([publish(a),publish(b)]);assert.ok(outcomes.every(row=>row.status===200));
   const listing=(await call('GET','/admin/rules',undefined,true)).body;assert.equal(listing.versions.filter(row=>row.status==='ACTIVE').length,1);assert.equal(listing.versions.filter(row=>[a.id,b.id].includes(row.id)).length,2);assert.equal(listing.versions.find(row=>row.id===second.id).status,'ARCHIVED');
   const editable=await create('Save race');const saved=await Promise.all([call('POST','/admin/rules/'+editable.id+'/save',{title:'Saved first',body:'New body'},true),publish(editable)]);assert.equal(saved[1].status,200);assert.ok([200,409].includes(saved[0].status));const row=(await call('GET','/public/rules/'+editable.id)).body;assert.equal(row.body,saved[0].status===200?'New body':editable.body);
   const removable=await create('Delete race');const race=await Promise.all([remove(removable),publish(removable)]);assert.ok(race[0].status===200&&race[1].status===404||race[0].status===409&&race[1].status===200);
   const draft=await create('Deleted draft');assert.equal((await remove(draft)).status,200);assert.equal((await call('GET','/public/rules/'+draft.id)).status,404);assert.equal((await publish(draft)).status,404);
   await migrate(pool);assert.equal((await call('GET','/public/rules')).body.versions.filter(row=>row.status==='ACTIVE').length,1);
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
