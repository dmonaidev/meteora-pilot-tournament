import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../server/db.mjs';
import {applyWalletException} from '../scripts/wallet-exception.mjs';
test('AC-61 closed exception preserves IDs, all score fields and rewards; stale pair rolls back',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='test_exception_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 try{
 await migrate(pool);const id=randomUUID(),wid=randomUUID();
 await pool.query("INSERT INTO users(id,tg_id,display_name,registration_status) VALUES($1,800001,'ExceptionUser','APPROVED_AUTO')",[id]);
 await pool.query("INSERT INTO wallets(id,user_id,wallet_address,withdrawal_tx_hash,validation_status) VALUES($1,$2,$3,'old','VALID')",[wid,id,'11111111111111111111111111111111']);
 await pool.query('INSERT INTO tournament_scoring(user_id,pnl,initial_capital,current_capital,in_positions_amount,roi_percentage) VALUES($1,12.125,100,111,7,-9)',[id]);
 await pool.query("INSERT INTO partner_rewards(user_id,reward_type,exchange_uid,uid_status) VALUES($1,'PARTNER_GIFTS','00123','VALID')",[id]);
 const before=(await pool.query('SELECT * FROM tournament_scoring WHERE user_id=$1',[id])).rows[0];
 const input={pool,userId:id,oldAddress:'11111111111111111111111111111111',oldHash:'old',newAddress:'So11111111111111111111111111111111111111112',newHash:'new',confirmed:true};
 await assert.rejects(applyWalletException({...input,confirmed:false}));
 await assert.rejects(applyWalletException({...input,oldHash:'stale'}),/WALLET_CHANGED/);
 const result=await applyWalletException(input);assert.equal(result.id,wid);assert.equal(result.user_id,id);assert.equal(result.validation_status,'UNDER_REVIEW');
 assert.deepEqual((await pool.query('SELECT * FROM tournament_scoring WHERE user_id=$1',[id])).rows[0],before);
 assert.equal((await pool.query('SELECT exchange_uid,uid_status FROM partner_rewards WHERE user_id=$1',[id])).rows[0].exchange_uid,'00123');
 const w=(await pool.query('SELECT * FROM wallets WHERE user_id=$1',[id])).rows[0];assert.equal(w.wallet_address,input.newAddress);assert.equal(w.withdrawal_tx_hash,'new');assert.equal(w.rejection_reason,null);
 }finally{await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
});
