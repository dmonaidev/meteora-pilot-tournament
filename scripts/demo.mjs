import {randomUUID,randomBytes} from 'node:crypto';
import bs58 from 'bs58';
import {SignJWT} from 'jose';
export const demoAccounts=[
 {tg_id:900001,display_name:'Администратор',role:'admin'},
 {tg_id:900002,display_name:'Второй администратор',role:'admin'},
 {tg_id:100001,display_name:'NOVA',role:'participant'},
 {tg_id:100002,display_name:'Ваш участник',role:'participant'},
 {tg_id:100003,display_name:'ORBIT',role:'participant'},
 {tg_id:100004,display_name:'VECTOR',role:'participant'},
 {tg_id:100005,display_name:'ZENITH',role:'participant'},
 {tg_id:100006,display_name:'ECHO',role:'participant'}
];
export async function seedDemo(pool){
 const c=await pool.connect();
 try{
 await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(7849021)');
 const count=await c.query('SELECT count(*)::int AS n FROM users');
 if(count.rows[0].n===0){
 for(const [i,a]of demoAccounts.entries()){
 const id=randomUUID();
 await c.query('INSERT INTO users(id,tg_id,tg_username,display_name,registration_status,admin_notes) VALUES($1,$2,$3,$4,$5,$6)',[id,a.tg_id,null,a.display_name,i===3?'PENDING_VALIDATION':'APPROVED_AUTO',null]);
 if(i===3)continue;
 await c.query('INSERT INTO wallets(id,user_id,wallet_address,withdrawal_tx_hash,validation_status) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,bs58.encode(randomBytes(32)),i%2?null:'demo_withdrawal_'+a.tg_id,'VALID']);
 await c.query('INSERT INTO partner_rewards(user_id,reward_type,exchange_uid,uid_status) VALUES($1,$2,$3,$4)',[id,i%2?'RESPECT':'PARTNER_GIFTS',i%2?null:'00'+a.tg_id,i%2?'NOT_REQUIRED':'VALID']);
 if(i>=2){
 const pnl=({2:'1250.750000',4:'984.200000',5:'210.000000',6:'0.000000',7:'-42.800000'})[i];
 await c.query('INSERT INTO tournament_scoring(user_id,pnl,roi_percentage) VALUES($1,$2,$3)',[id,pnl,i%2?null:12.5]);
 }
 }
 await c.query('INSERT INTO initial_users(tg_id,group_name) VALUES($1,$2)',[100001,'Демо']);
 }
 await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function registerDemo(app,pool,config){
 if(!config.localDemo)return;
 app.get('/api/local-demo/accounts',async()=>({accounts:demoAccounts,tournament_start_at:(await pool.query('SELECT start_at FROM tournament_settings WHERE id=1')).rows[0].start_at}));
 app.post('/api/local-demo/login',async(req,reply)=>{
 const id=req.body?.tg_id;
 if(!demoAccounts.some(a=>a.tg_id===id))return reply.code(422).send({error:{code:'VALIDATION_ERROR',message:'Выберите демо-аккаунт',fields:[]}});
 const user=(await pool.query('SELECT id FROM users WHERE tg_id=$1',[id])).rows[0];
 if(!user)return reply.code(404).send({error:{code:'USER_NOT_FOUND',message:'Демо-аккаунт отсутствует',fields:[]}});
 const jwt=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime(config.authJwtTtlSeconds+'s').sign(new TextEncoder().encode(config.jwtSecret));
 return{access_token:jwt,token_type:'Bearer'};
 });
}
