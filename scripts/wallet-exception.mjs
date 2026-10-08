import 'dotenv/config';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {z} from 'zod';
import bs58 from 'bs58';
import {createPool} from '../server/db.mjs';

export async function applyWalletException({pool,userId,oldAddress,oldHash,newAddress,newHash,confirmed}){
 if(confirmed!==true)throw Error('Подтверждение конкретного исключения обязательно');
 z.string().uuid().parse(userId);
 const validAddress=z.string().trim().max(44).refine(v=>{try{return bs58.decode(v).length===32;}catch{return false;}});
 const validHash=z.string().trim().min(1).max(255).refine(v=>!/[\u0000-\u001f\u007f]/.test(v));
 const previousAddress=validAddress.parse(oldAddress),previousHash=validHash.parse(oldHash);
 const address=validAddress.parse(newAddress),hash=validHash.parse(newHash);
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const u=await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
  if(!u.rowCount)throw Error('USER_NOT_FOUND');
  const w=(await c.query('SELECT * FROM wallets WHERE user_id=$1',[userId])).rows[0];
  if(!w)throw Error('WALLET_NOT_FOUND');
  if(w.wallet_address!==previousAddress||w.withdrawal_tx_hash!==previousHash)throw Error('WALLET_CHANGED');
  const result=(await c.query("UPDATE wallets SET wallet_address=$2,withdrawal_tx_hash=$3,validation_status='UNDER_REVIEW',rejection_reason=NULL WHERE user_id=$1 RETURNING id,user_id,validation_status",[userId,address,hash])).rows[0];
  await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/wallet-exception.mjs')){
 const {values}=parseArgs({options:{'user-id':{type:'string'},'old-address':{type:'string'},'old-hash':{type:'string'},'new-address':{type:'string'},'new-hash':{type:'string'},confirm:{type:'boolean',default:false}}});
 const pool=createPool(process.env.DATABASE_URL);
 try{await applyWalletException({pool,userId:values['user-id'],oldAddress:values['old-address'],oldHash:values['old-hash'],newAddress:values['new-address'],newHash:values['new-hash'],confirmed:values.confirm});console.log('Исключение применено. Прогресс сохранён; новая пара ожидает обычной ручной проверки.');}
 catch{console.error('Исключение не применено: проверьте подтверждение, ID и актуальность обеих пар.');process.exitCode=1;}
 finally{await pool.end();}
}
