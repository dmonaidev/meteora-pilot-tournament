CREATE TABLE IF NOT EXISTS tournament_settings (id SMALLINT PRIMARY KEY CHECK(id=1), start_at TIMESTAMPTZ NULL);
INSERT INTO tournament_settings(id,start_at) VALUES(1,NULL) ON CONFLICT(id) DO NOTHING;
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS expected_tg_username VARCHAR(255);
ALTER TABLE wallets ALTER COLUMN withdrawal_tx_hash DROP NOT NULL;
CREATE OR REPLACE VIEW leaderboard AS
 SELECT u.id AS user_id, u.display_name, s.pnl, s.initial_capital, s.current_capital, s.in_positions_amount, s.roi_percentage,
 CASE WHEN r.reward_type='PARTNER_GIFTS' AND r.uid_status='VALID' THEN 'SpecialPartnerGift' ELSE 'RespectGift' END AS reward_tag, w.wallet_address
 FROM users u JOIN wallets w ON w.user_id=u.id LEFT JOIN partner_rewards r ON r.user_id=u.id LEFT JOIN tournament_scoring s ON s.user_id=u.id
 WHERE u.registration_status IN ('APPROVED_AUTO','APPROVED_MANUAL') AND w.validation_status='VALID';
