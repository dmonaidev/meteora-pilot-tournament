import {z} from 'zod';

const control=/[\u0000-\u001f\u007f-\u009f]/;
const referralUrl=z.string().refine(value=>!control.test(value),'Ссылка содержит управляющие символы').trim().max(2048).nullable().transform(value=>value||null).refine(value=>{
 if(value===null)return true;
 try{
  const parsed=new URL(value);
  return /^https:\/\//i.test(value)&&parsed.protocol==='https:'&&!!parsed.hostname&&!parsed.username&&!parsed.password&&!value.split(/[/?#]/)[2]?.includes('@');
 }catch{return false;}
},'Укажите абсолютную HTTPS ссылку без данных входа');

export function registerPartner({route,admin,pool,tx,parse}){
 const output=row=>{if(!row)throw new Error('Missing tournament settings');return {referral_url:row.partner_referral_url};};
 const read=async()=>output((await pool.query('SELECT partner_referral_url FROM tournament_settings WHERE id=1')).rows[0]);
 route('GET','/public/partner',read);
 route('GET','/admin/tournament/partner',read,admin);
 route('POST','/admin/tournament/partner',async req=>{
  const body=parse(z.object({referral_url:referralUrl}).strict(),req.body);
  return tx(async client=>output((await client.query('UPDATE tournament_settings SET partner_referral_url=$1 WHERE id=1 RETURNING partner_referral_url',[body.referral_url])).rows[0]));
 },admin);
}
