import pg from 'pg';
import { readFile } from 'node:fs/promises';
export function createPool(databaseUrl) { return new pg.Pool({ connectionString: databaseUrl }); }
export async function migrate(pool) {
 const initial = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
 const changes = await readFile(new URL('../migrations/002_contract_v03.sql', import.meta.url), 'utf8');
 const telegramCode = await readFile(new URL('../migrations/003_telegram_code.sql', import.meta.url), 'utf8');
 const accessSessions = await readFile(new URL('../migrations/004_auth_sessions.sql', import.meta.url), 'utf8');
 const demoLabels = await readFile(new URL('../migrations/005_demo_display_name.sql', import.meta.url), 'utf8');
 const scheduleStats = await readFile(new URL('../migrations/006_schedule_stats.sql', import.meta.url), 'utf8');
 const profileUniqueness = await readFile(new URL('../migrations/007_profile_uniqueness.sql', import.meta.url), 'utf8');
 const rules = await readFile(new URL('../migrations/008_tournament_rules.sql', import.meta.url), 'utf8');
 const partner = await readFile(new URL('../migrations/009_partner_referral_url.sql', import.meta.url), 'utf8');
 const tournamentName = await readFile(new URL('../migrations/010_tournament_name.sql', import.meta.url), 'utf8');
 const client = await pool.connect();
 try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(712037461)'); const existing=await client.query("SELECT to_regclass('users') AS users"); if(!existing.rows[0].users) await client.query(initial); await client.query(changes); await client.query(telegramCode); await client.query(accessSessions); await client.query(demoLabels); await client.query(scheduleStats); await client.query(profileUniqueness); await client.query(rules); await client.query(partner); await client.query(tournamentName); await client.query('COMMIT'); }
 catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
