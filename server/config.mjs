import 'dotenv/config';
export function loadConfig(env = process.env) {
 const required = (name) => { const value=env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
 const jwtSecret=required('JWT_SECRET'), botApiSecret=required('BOT_API_SECRET');
 if (Buffer.byteLength(jwtSecret)<32 || Buffer.byteLength(botApiSecret)<32) throw new Error('JWT_SECRET and BOT_API_SECRET require at least 32 bytes');
 const adminTgIds=required('ADMIN_TG_IDS').split(',').map(s=>Number(s.trim()));
 if (adminTgIds.some(n=>!Number.isSafeInteger(n)||n<=0)) throw new Error('ADMIN_TG_IDS must contain positive safe integer IDs');
 const configuredTtl=Number(env.AUTH_JWT_TTL_SECONDS || 1800), port=Number(env.PORT || 3000);
 if (!Number.isSafeInteger(configuredTtl)||configuredTtl<900 || !Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid TTL or PORT');
 const authJwtTtlSeconds=Math.min(configuredTtl,1800);
 const botUsername=required('BOT_USERNAME').replace(/^@/,'');
 if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Error('Invalid BOT_USERNAME');
 if (env.LOCAL_DEMO && !['true','false'].includes(env.LOCAL_DEMO)) throw new Error('LOCAL_DEMO must be true or false');
 const localDemo=env.LOCAL_DEMO==='true';
 if (localDemo && (env.NODE_ENV==='production' || (env.HOST && env.HOST!=='127.0.0.1'))) throw new Error('LOCAL_DEMO requires a non-production loopback host');
 return {databaseUrl:required('DATABASE_URL'), jwtSecret,botApiSecret,adminTgIds,authJwtTtlSeconds,botUsername,localDemo,port,host:env.HOST||'127.0.0.1'};
}
