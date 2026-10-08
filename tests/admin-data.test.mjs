import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import { buildApp } from '../server/app.mjs';
import { migrate } from '../server/db.mjs';

test('admin data: security, literal search, pagination, privacy and consistent snapshot',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='admin_test_'+randomUUID().replaceAll('-','');
 const control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await control.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const now=new Date('2026-10-08T12:00:00Z');const config={jwtSecret:'j'.repeat(32),botApiSecret:'b'.repeat(32),adminTgIds:[900001],authJwtTtlSeconds:86400,botUsername:'TournamentBot',localDemo:false};
 let app,queryCount=0,connections=0,insertDuringCount=false;
 const tracked={query:async(...args)=>{queryCount++;return pool.query(...args);},connect:async()=>{connections++;const client=await pool.connect();return {query:async(sql,values)=>{const result=await client.query(sql,values);if(insertDuringCount&&sql.startsWith('SELECT count(*) total FROM initial_users')){insertDuringCount=false;await pool.query('INSERT INTO initial_users(tg_id,group_name) VALUES(999999,$1)',['Concurrent']);}return result;},release:()=>client.release()};}};
 try {
  await migrate(pool);const ids=[randomUUID(),randomUUID(),randomUUID()];
  for(const [index,tgId] of [900001,100001,100002].entries())await pool.query("INSERT INTO users(id,tg_id,tg_username,display_name,registration_status) VALUES($1,$2,$3,$4,'APPROVED_AUTO')",[ids[index],tgId,index?'trader_'+index:null,index?'Trader '+index:'Admin']);
  for(const row of [[100001,'100% group',null],[100002,'underscore_group',null],[100003,'back\\slash',null],[100004,"O'Reilly",'lowercase note']])await pool.query('INSERT INTO initial_users(tg_id,group_name,system_notes) VALUES($1,$2,$3)',row);
  const address='11111111111111111111111111111111';
  await pool.query("INSERT INTO wallets(id,user_id,wallet_address,withdrawal_tx_hash,validation_status) VALUES($1,$2,$3,NULL,'VALID'),($4,$5,$7,$6,'UNDER_REVIEW')",[randomUUID(),ids[1],address,randomUUID(),ids[2],'hash_100%\\value','11111111111111111111111111111112']);
  await pool.query("INSERT INTO partner_rewards(user_id,reward_type,exchange_uid,uid_status) VALUES($1,'RESPECT',NULL,'NOT_REQUIRED'),($2,'PARTNER_GIFTS','00887711','UNDER_REVIEW')",[ids[1],ids[2]]);
  await pool.query('INSERT INTO tournament_scoring(user_id,pnl,initial_capital,current_capital,in_positions_amount,roi_percentage) VALUES($1,$2,NULL,NULL,NULL,NULL),($3,$4,$5,$6,$7,$8)',[ids[1],'2',ids[2],'10','1000','1100','300',99]);
  await pool.query("INSERT INTO pending_sessions(token,session_type,display_name,expected_tg_username,tg_id,is_used,created_at) VALUES('secret-token-a','REGISTRATION','New Trader','expected_user',NULL,false,$1),('secret-token-b','AUTHORIZATION',NULL,NULL,$2,true,$3),('secret-token-c','REGISTRATION','Tie Trader',NULL,NULL,false,$1)",[new Date('2026-10-08T11:59:00Z'),100001,new Date('2026-10-08T11:30:00Z')]);
  app=buildApp({pool:tracked,config,clock:()=>now});const events=[];app.addHook('onResponse',async req=>{if(req.tournamentEvent)events.push(req.tournamentEvent);});
  const jwt=async id=>{const session=randomUUID();await pool.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,$3)',[session,id,new Date(+now+1800000)]);return new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(id).setJti(session).setIssuedAt(Math.floor(+now/1000)).setExpirationTime(Math.floor(+now/1000)+1800).sign(new TextEncoder().encode(config.jwtSecret));};
  const admin=await jwt(ids[0]),member=await jwt(ids[1]);
  const get=async(path,token=admin)=>{const response=await app.inject({method:'GET',url:'/api/v1/admin/data/'+path,headers:token?{authorization:'Bearer '+token}:{}});return {status:response.statusCode,body:response.json()};};
  await t.test('guards execute before reading private tables',async()=>{
   for(const resource of ['summary','initial-users','wallets','rewards','scoring','sessions','unknown']){let before=queryCount,beforeConnections=connections;assert.equal((await get(resource,null)).status,401);assert.equal(queryCount,before);assert.equal(connections,beforeConnections);before=queryCount;assert.equal((await get(resource,member)).status,403);assert.equal(queryCount-before,1);assert.equal(connections,beforeConnections);}
   assert.equal((await get('unknown')).body.error.code,'NOT_FOUND');
  });
  await t.test('summary and all five resource shapes retain numeric precision and private nullable fields',async()=>{
   assert.deepEqual((await get('summary')).body,{initial_users:4,users:3,wallets:2,partner_rewards:2,tournament_scoring:2,pending_sessions:3});
   const initial=(await get('initial-users')).body;assert.equal(initial.page,1);assert.equal(initial.limit,50);assert.equal(initial.total,4);assert.deepEqual(initial.rows.map(r=>r.tg_id),[100001,100002,100003,100004]);assert.equal(initial.rows[3].system_notes,'lowercase note');
   const wallets=(await get('wallets')).body;assert.equal(wallets.rows[0].withdrawal_tx_hash,null);assert.equal(wallets.rows[1].withdrawal_tx_hash,'hash_100%\\value');assert.equal(typeof wallets.rows[0].tg_id,'number');
   const rewards=(await get('rewards')).body;assert.equal(rewards.rows[1].exchange_uid,'00887711');assert.equal(rewards.rows[0].exchange_uid,null);
   const scoring=(await get('scoring')).body;assert.deepEqual(scoring.rows.map(r=>r.pnl),['10.000000','2.000000']);assert.equal(scoring.rows[0].current_capital,'1100.000000');assert.equal(scoring.rows[0].roi_percentage,99);assert.equal(scoring.rows[1].initial_capital,null);
   const sessions=(await get('sessions')).body;assert.equal(sessions.total,3);assert.deepEqual(sessions.rows.map(r=>r.display_name),['New Trader','Tie Trader',null]);assert.equal(sessions.rows[0].created_at,'2026-10-08T11:59:00.000Z');assert.equal(sessions.rows[0].expires_at,'2026-10-08T12:14:00.000Z');assert.equal(sessions.rows[0].expired,false);assert.equal(sessions.rows[2].expired,true);assert.equal(sessions.rows[2].tg_id,100001);assert.equal(sessions.rows[0].tg_id,null);
   const allowed=['created_at','display_name','expected_tg_username','expired','expires_at','is_used','session_type','tg_id'];assert.ok(sessions.rows.every(r=>Object.keys(r).sort().join(',')===allowed.join(',')));assert.ok(!JSON.stringify(sessions).includes('secret-token'));assert.deepEqual(events,[]);
  });
  await t.test('literal case insensitive searches and real page boundaries',async()=>{
   for(const [search,expected] of [['%',100001],['_',100002],['\\',100003],["O'ReIlLy",100004],['LOWERCASE',100004]]){const result=await get('initial-users?search='+encodeURIComponent(search));assert.equal(result.status,200);assert.equal(result.body.total,1);assert.equal(result.body.rows[0].tg_id,expected);}
   assert.equal((await get('wallets?search='+encodeURIComponent('hash_100%\\value'))).body.total,1);assert.equal((await get('rewards?search=00887711')).body.total,1);assert.equal((await get('sessions?search=EXPECTED_USER')).body.total,1);assert.equal((await get('scoring?search=trader_2')).body.total,1);
   const second=(await get('initial-users?page=2&limit=2')).body;assert.equal(second.total,4);assert.equal(second.page,2);assert.equal(second.limit,2);assert.deepEqual(second.rows.map(r=>r.tg_id),[100003,100004]);assert.deepEqual((await get('initial-users?page=3&limit=2')).body.rows,[]);
   assert.equal((await get('initial-users?search='+encodeURIComponent("%' OR 1=1 --"))).body.total,0);
  });
  await t.test('invalid query parameters and table names cannot widen access',async()=>{
   for(const suffix of ['?page=0','?page=-1','?page=1.2','?page=x','?limit=0','?limit=101','?limit=1.5','?search='+encodeURIComponent('x'.repeat(101)),'?page=9007199254740991&limit=100','?table=users','?page=1&page=2'])assert.equal((await get('initial-users'+suffix)).status,422,suffix);
   assert.equal((await get('users')).status,404);assert.equal((await get('tournament_settings')).status,404);assert.equal((await get('initial_users')).status,404);
   assert.deepEqual((await get('summary')).body,{initial_users:4,users:3,wallets:2,partner_rewards:2,tournament_scoring:2,pending_sessions:3});
  });
  await t.test('count and page share one read-only repeatable snapshot',async()=>{
   insertDuringCount=true;const response=await get('initial-users');assert.equal(response.body.total,4);assert.equal(response.body.rows.length,4);assert.ok(!response.body.rows.some(r=>r.tg_id===999999));assert.equal((await get('initial-users')).body.total,5);assert.deepEqual(events,[]);
  });
 }finally{if(app)await app.close();await pool.end();await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
