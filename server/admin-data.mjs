import { z } from 'zod';

const integer = (min, max, fallback) => z.string().regex(/^\d+$/).transform(Number)
 .refine(value => Number.isSafeInteger(value) && value >= min && value <= max).prefault(String(fallback));
const querySchema = z.object({page:integer(1,Number.MAX_SAFE_INTEGER,1),limit:integer(1,100,50),search:z.string().trim().max(100).default('')}).strict();
const resources = {
 'initial-users': {
  from:'initial_users i', select:'i.tg_id,i.tg_username,i.group_name,i.subgroup_1,i.subgroup_2,i.subgroup_3,i.system_notes',
  search:['i.tg_id','i.tg_username','i.group_name','i.subgroup_1','i.subgroup_2','i.subgroup_3','i.system_notes'],order:'i.tg_id ASC'
 },
 wallets: {
  from:'wallets w JOIN users u ON u.id=w.user_id', select:'w.id,w.user_id,u.tg_id,u.display_name,u.tg_username,w.wallet_address,w.withdrawal_tx_hash,w.validation_status,w.rejection_reason',
  search:['u.tg_id','u.display_name','u.tg_username','w.wallet_address','w.withdrawal_tx_hash'],order:'u.tg_id ASC'
 },
 rewards: {
  from:'partner_rewards r JOIN users u ON u.id=r.user_id',select:'r.user_id,u.tg_id,u.display_name,u.tg_username,r.reward_type,r.exchange_uid,r.uid_status',
  search:['u.tg_id','u.display_name','u.tg_username','r.exchange_uid'],order:'u.tg_id ASC'
 },
 scoring: {
  from:'tournament_scoring s JOIN users u ON u.id=s.user_id',select:'s.user_id,u.tg_id,u.display_name,u.tg_username,s.pnl,s.initial_capital,s.current_capital,s.in_positions_amount,s.roi_percentage,s.lp_volume',
  search:['u.tg_id','u.display_name','u.tg_username'],order:'s.pnl DESC,s.user_id ASC'
 },
 sessions: {
  from:'pending_sessions p',select:"p.session_type,p.display_name,p.expected_tg_username,p.tg_id,p.is_used,p.created_at,(p.otp_tg_id IS NOT NULL) AS internal_is_otp",
  search:['p.tg_id','p.display_name','p.expected_tg_username'],order:'p.created_at DESC,p.token ASC'
 }
};

export function registerAdminData({route,admin,pool,clock,parse,ApiError}) {
 route('GET','/admin/data/summary',async()=>{
  const {rows}=await pool.query(`SELECT
   (SELECT count(*) FROM initial_users) initial_users,
   (SELECT count(*) FROM users) users,
   (SELECT count(*) FROM wallets) wallets,
   (SELECT count(*) FROM partner_rewards) partner_rewards,
   (SELECT count(*) FROM tournament_scoring) tournament_scoring,
   (SELECT count(*) FROM pending_sessions) pending_sessions`);
  return Object.fromEntries(Object.entries(rows[0]).map(([name,value])=>[name,Number(value)]));
 },admin);
 route('GET','/admin/data/:resource',async req=>{
  const resource=req.params.resource;
  if(!Object.hasOwn(resources,resource))throw new ApiError(404,'NOT_FOUND');
  const parsed=parse(querySchema,req.query),{page,limit}=parsed,search=parsed.search.replace(/^@/,'');
  const offset=(page-1)*limit;
  if(!Number.isSafeInteger(offset))throw new ApiError(422,'VALIDATION_ERROR','Некорректная страница',[{field:'page',message:'Слишком большой номер страницы'}]);
  const definition=resources[resource];
  // Only predefined SQL identifiers are used; user text is always a parameter.
  const pattern='%'+search.replace(/[\\%_]/g,value=>'\\'+value)+'%';
  const where=search?' WHERE ('+definition.search.map(column=>`${column}::text ILIKE $1 ESCAPE '\\'`).join(' OR ')+')':'';
  const filter=search?[pattern]:[];
  const client=await pool.connect();
  try {
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const count=await client.query('SELECT count(*) total FROM '+definition.from+where,filter);
   const result=await client.query('SELECT '+definition.select+' FROM '+definition.from+where+' ORDER BY '+definition.order+` LIMIT $${filter.length+1} OFFSET $${filter.length+2}`,[...filter,limit,offset]);
   const current=clock();
   const rows=result.rows.map(row=>{
    const normalized={...row,...(row.tg_id!==undefined?{tg_id:row.tg_id===null?null:Number(row.tg_id)}:{})};
    if(resource==='sessions'){
     const created=new Date(row.created_at),expires=new Date(+created+(row.internal_is_otp?300000:900000));
     delete normalized.internal_is_otp;
     return {...normalized,created_at:created.toISOString(),expires_at:expires.toISOString(),expired:+current>=+expires};
    }
    return normalized;
   });
   await client.query('COMMIT');
   return {rows,total:Number(count.rows[0].total),page,limit};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 },admin);
}
