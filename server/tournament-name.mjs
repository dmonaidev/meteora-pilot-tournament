import {z} from 'zod';

const name=z.string().refine(value=>!/[\u0000-\u001f\u007f-\u009f]/.test(value),'Название содержит управляющие символы').trim().min(1).max(80);
export function registerTournamentName({route,admin,pool,tx,parse}){
 const output=row=>{if(!row)throw new Error('Missing tournament settings');return {tournament_name:row.tournament_name};};
 const read=async()=>output((await pool.query('SELECT tournament_name FROM tournament_settings WHERE id=1')).rows[0]);
 route('GET','/public/tournament/name',read);
 route('GET','/admin/tournament/name',read,admin);
 route('POST','/admin/tournament/name',async req=>{
  const body=parse(z.object({tournament_name:name}).strict(),req.body);
  return tx(async client=>output((await client.query('UPDATE tournament_settings SET tournament_name=$1 WHERE id=1 RETURNING tournament_name',[body.tournament_name])).rows[0]));
 },admin);
}
