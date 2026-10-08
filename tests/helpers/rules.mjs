import {randomUUID} from 'node:crypto';
export async function seedRules(pool,current=new Date('2026-10-08T10:00:00Z')){
 const id=randomUUID();await pool.query("INSERT INTO tournament_rules(id,title,body,status,created_at,published_at) VALUES($1,'Explicit test rules','Isolated test fixture only','ACTIVE',$2,$2)",[id,current]);return id;
}
