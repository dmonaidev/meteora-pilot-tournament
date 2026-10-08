import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPool,migrate} from '../server/db.mjs';

const title='Правила пилотной платформы · рабочий черновик draft-2026-10-01';
const body=(await readFile(new URL('../docs/source/pilot-rules-draft-2026-10-01.md',import.meta.url),'utf8')).trim();
if(!body||body.length>100000)throw Error('INVALID_RULES_SOURCE');
const pool=createPool(process.env.DATABASE_URL);
try{
 await migrate(pool);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(712037462)');
  const existing=await client.query('SELECT id,version,status FROM tournament_rules WHERE title=$1 AND body=$2 AND deleted_at IS NULL ORDER BY version LIMIT 1',[title,body]);
  const row=existing.rows[0]||(await client.query("INSERT INTO tournament_rules(id,title,body,status,created_at) VALUES($1,$2,$3,'DRAFT',now()) RETURNING id,version,status",[randomUUID(),title,body])).rows[0];
  await client.query('COMMIT');
  console.log(JSON.stringify({imported:!existing.rowCount,...row}));
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}finally{await pool.end();}
