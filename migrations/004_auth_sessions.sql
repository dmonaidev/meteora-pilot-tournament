CREATE TABLE IF NOT EXISTS auth_sessions (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id),
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ NULL,
 legacy_token_hash CHAR(64) NULL UNIQUE CHECK(legacy_token_hash IS NULL OR legacy_token_hash ~ '^[0-9a-f]{64}$'),
 renewal_token VARCHAR(43) NULL UNIQUE CHECK(renewal_token IS NULL OR renewal_token ~ '^[A-Za-z0-9_-]{43}$'),
 renewal_expires_at TIMESTAMPTZ NULL,
 renewal_requested_at TIMESTAMPTZ NULL,
 renewal_message_id BIGINT NULL CHECK(renewal_message_id > 0),
 CHECK((renewal_token IS NULL) = (renewal_expires_at IS NULL)),
 CHECK(renewal_expires_at IS NULL OR renewal_expires_at <= expires_at),
 CHECK(revoked_at IS NULL OR renewal_token IS NULL)
);
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS renewal_message_id BIGINT NULL CHECK(renewal_message_id > 0);
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS auth_session_id UUID REFERENCES auth_sessions(id);
