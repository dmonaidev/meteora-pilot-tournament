DO $$ BEGIN CREATE TYPE registration_status AS ENUM ('APPROVED_AUTO','APPROVED_MANUAL','PENDING_VALIDATION','REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_status AS ENUM ('UNDER_REVIEW','VALID','INVALID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE reward_type AS ENUM ('RESPECT','PARTNER_GIFTS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE uid_status AS ENUM ('NOT_REQUIRED','UNDER_REVIEW','VALID','INVALID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE session_type AS ENUM ('REGISTRATION','AUTHORIZATION'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS initial_users (
 tg_id BIGINT PRIMARY KEY CHECK (tg_id > 0 AND tg_id <= 9007199254740991), tg_username VARCHAR(255),
 group_name VARCHAR(100) NOT NULL CHECK (length(btrim(group_name)) > 0), subgroup_1 VARCHAR(255), subgroup_2 VARCHAR(255), subgroup_3 VARCHAR(255), system_notes TEXT
);
CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY, tg_id BIGINT UNIQUE NOT NULL CHECK (tg_id > 0 AND tg_id <= 9007199254740991), tg_username VARCHAR(255),
 display_name VARCHAR(100) NOT NULL CHECK (length(btrim(display_name)) BETWEEN 3 AND 20), registration_status registration_status NOT NULL,
 admin_notes TEXT, CHECK (registration_status NOT IN ('APPROVED_MANUAL','REJECTED') OR length(btrim(admin_notes)) > 0 AND admin_notes IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS wallets (
 id UUID PRIMARY KEY, user_id UUID UNIQUE NOT NULL REFERENCES users(id), wallet_address VARCHAR(44) NOT NULL,
 withdrawal_tx_hash VARCHAR(255) NOT NULL CHECK (length(btrim(withdrawal_tx_hash)) > 0), validation_status wallet_status NOT NULL DEFAULT 'UNDER_REVIEW', rejection_reason TEXT,
 CHECK ((validation_status = 'INVALID' AND rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0) OR (validation_status <> 'INVALID' AND rejection_reason IS NULL))
);
CREATE TABLE IF NOT EXISTS partner_rewards (
 user_id UUID PRIMARY KEY REFERENCES users(id), reward_type reward_type NOT NULL, exchange_uid VARCHAR(50), uid_status uid_status NOT NULL DEFAULT 'UNDER_REVIEW',
 CHECK ((reward_type = 'RESPECT' AND exchange_uid IS NULL AND uid_status = 'NOT_REQUIRED') OR (reward_type = 'PARTNER_GIFTS' AND exchange_uid IS NOT NULL AND length(btrim(exchange_uid)) > 0 AND uid_status <> 'NOT_REQUIRED'))
);
CREATE TABLE IF NOT EXISTS tournament_scoring (
 user_id UUID PRIMARY KEY REFERENCES users(id), pnl NUMERIC(20,6) NOT NULL, initial_capital NUMERIC(20,6) DEFAULT NULL CHECK(initial_capital >= 0),
 current_capital NUMERIC(20,6) DEFAULT NULL CHECK(current_capital >= 0), in_positions_amount NUMERIC(20,6) DEFAULT NULL CHECK(in_positions_amount >= 0),
 roi_percentage DOUBLE PRECISION DEFAULT NULL CHECK (roi_percentage > '-Infinity'::float8 AND roi_percentage < 'Infinity'::float8)
);
CREATE TABLE IF NOT EXISTS pending_sessions (
 token VARCHAR(64) PRIMARY KEY, session_type session_type NOT NULL, display_name VARCHAR(100), tg_id BIGINT REFERENCES users(tg_id), is_used BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((session_type='REGISTRATION' AND display_name IS NOT NULL AND length(btrim(display_name)) BETWEEN 3 AND 20) OR (session_type='AUTHORIZATION' AND display_name IS NULL)),
 CHECK ((is_used AND tg_id IS NOT NULL) OR (NOT is_used AND tg_id IS NULL))
);
CREATE OR REPLACE VIEW leaderboard AS
 SELECT u.id AS user_id, u.display_name, s.pnl, s.initial_capital, s.current_capital, s.in_positions_amount, s.roi_percentage,
 CASE WHEN r.reward_type='PARTNER_GIFTS' AND r.uid_status='VALID' THEN 'Special Partner Gift' ELSE 'RespectGift' END AS reward_tag
 FROM users u JOIN wallets w ON w.user_id=u.id LEFT JOIN partner_rewards r ON r.user_id=u.id LEFT JOIN tournament_scoring s ON s.user_id=u.id
 WHERE u.registration_status IN ('APPROVED_AUTO','APPROVED_MANUAL') AND w.validation_status='VALID';
