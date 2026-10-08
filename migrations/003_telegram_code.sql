ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS otp_tg_id BIGINT CHECK(otp_tg_id > 0 AND otp_tg_id <= 9007199254740991);
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS otp_tg_username VARCHAR(255);
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS otp_code_hash CHAR(64) CHECK(otp_code_hash IS NULL OR otp_code_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS otp_attempts SMALLINT NOT NULL DEFAULT 0 CHECK(otp_attempts BETWEEN 0 AND 5);
