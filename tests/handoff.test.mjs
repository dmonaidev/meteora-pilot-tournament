import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../server/db.mjs';
import {exportData,restoreData} from '../scripts/handoff.mjs';

test('handoff restores settings and private records in fresh databases only',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const control=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),pools=[],schemas=[];
 const make=async()=>{const schema='handoff_'+randomUUID().replaceAll('-','');schemas.push(schema);await control.query('CREATE SCHEMA "'+schema+'"');const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});pools.push(pool);return pool;};
 const json=value=>JSON.parse(JSON.stringify(value));
 try{
  const source=await make();await migrate(source);
  const archived=randomUUID(),active=randomUUID(),user=randomUUID();
  await source.query("INSERT INTO tournament_rules(id,version,title,body,status,created_at,published_at,archived_at,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1,5,'Archived',NULL,'ARCHIVED','2026-10-01Z','2026-10-02Z','2026-10-03Z','2026-10-04Z'),($2,8,'Current rules','Accept these rules','ACTIVE','2026-10-05Z','2026-10-06Z',NULL,NULL)",[archived,active]);
  await source.query("UPDATE tournament_settings SET tournament_name='Transferred Tournament',registration_start_at='2026-10-11T12:00Z',registration_end_at='2026-10-13T11:59:59Z',start_at='2026-10-15T00:00Z',end_at='2026-10-28T11:59:59Z',partner_referral_url='https://example.org/register?ref=test' WHERE id=1");
  await source.query("INSERT INTO initial_users(tg_id,tg_username,group_name) VALUES(930001,'PrivateMember','Approved registry')");
  await source.query("INSERT INTO users(id,tg_id,tg_username,display_name,registration_status,accepted_rules_version_id,rules_accepted_at) VALUES($1,930001,'PrivateMember','Private Name','APPROVED_AUTO',$2,'2026-10-07T13:00Z')",[user,active]);
  await source.query("INSERT INTO wallets(id,user_id,wallet_address,withdrawal_tx_hash,validation_status) VALUES($1,$2,'11111111111111111111111111111111','private-withdrawal','VALID')",[randomUUID(),user]);
  await source.query("INSERT INTO partner_rewards(user_id,reward_type,exchange_uid,uid_status) VALUES($1,'PARTNER_GIFTS','000000009','VALID')",[user]);
  await source.query('INSERT INTO tournament_scoring(user_id,pnl,initial_capital,current_capital,lp_volume) VALUES($1,1,1,2,50)',[user]);
  await source.query("INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 minutes')",[randomUUID(),user]);
  const data=json(await exportData(source));
  await t.test('public export contains only rules/settings; private export omits credentials and sessions',()=>{
   assert.deepEqual(Object.keys(data.public.tables).sort(),['tournament_rules','tournament_settings']);
   assert.equal(JSON.stringify(data.public).includes('PrivateMember'),false);
   assert.equal(data.private.tables.users.length,1);assert.equal(data.private.tables.auth_sessions,undefined);assert.equal(data.private.tables.pending_sessions,undefined);
  });
  await t.test('private round trip preserves IDs, UTC seconds, leading UID zeroes and rule tombstones',async()=>{
   const target=await make();const counts=await restoreData(target,data.private);assert.equal(counts.users,1);
   const again=json(await exportData(target));assert.deepEqual(again.private.tables,data.private.tables);
   assert.equal(Number((await target.query('SELECT count(*) FROM auth_sessions')).rows[0].count),0);
   const next=(await target.query("INSERT INTO tournament_rules(id,title,body,status,created_at) VALUES($1,'Next','New draft','DRAFT',NOW()) RETURNING version",[randomUUID()])).rows[0];assert.equal(next.version,9);
  });
  await t.test('public round trip restores settings but no private records',async()=>{
   const target=await make();await restoreData(target,data.public);
   assert.deepEqual(json((await exportData(target)).public.tables),data.public.tables);
   for(const table of ['initial_users','users','wallets','partner_rewards','tournament_scoring'])assert.equal(Number((await target.query('SELECT count(*) FROM '+table)).rows[0].count),0);
  });
  await t.test('populated targets are refused and remain unchanged',async()=>{
   const before=json(await exportData(source));await assert.rejects(restoreData(source,data.private),/TARGET_DATABASE_NOT_EMPTY/);assert.deepEqual(json((await exportData(source)).private.tables),before.private.tables);
  });
  await t.test('a failed row rolls back settings, rules and users',async()=>{
   const target=await make(),bad=structuredClone(data.private);bad.tables.users.push({...bad.tables.users[0],id:randomUUID()});
   await assert.rejects(restoreData(target,bad));assert.equal(Number((await target.query('SELECT count(*) FROM users')).rows[0].count),0);assert.equal(Number((await target.query('SELECT count(*) FROM tournament_rules')).rows[0].count),0);assert.equal((await target.query('SELECT tournament_name FROM tournament_settings')).rows[0].tournament_name,'PILOT TOURNAMENT');
  });
  await t.test('unapproved tables and columns are refused before database writes',async()=>{
   const target=await make(),extra=structuredClone(data.public);extra.tables.auth_sessions=[];
   await assert.rejects(restoreData(target,extra),/INVALID_HANDOFF_TABLES/);
   delete extra.tables.auth_sessions;extra.tables.tournament_settings[0].unexpected='value';await assert.rejects(restoreData(target,extra),/INVALID_HANDOFF_COLUMNS/);
   assert.equal((await target.query("SELECT to_regclass('users') AS relation")).rows[0].relation,null);
  });
 }finally{for(const pool of pools)await pool.end();for(const schema of schemas)await control.query('DROP SCHEMA "'+schema+'" CASCADE');await control.end();}
});
