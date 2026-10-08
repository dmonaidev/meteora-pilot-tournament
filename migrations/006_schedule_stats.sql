ALTER TABLE tournament_settings ADD COLUMN IF NOT EXISTS registration_start_at TIMESTAMPTZ;
ALTER TABLE tournament_settings ADD COLUMN IF NOT EXISTS registration_end_at TIMESTAMPTZ;
ALTER TABLE tournament_settings ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;
ALTER TABLE tournament_settings DROP CONSTRAINT IF EXISTS tournament_schedule_order;
ALTER TABLE tournament_settings ADD CONSTRAINT tournament_schedule_order CHECK (
 (registration_start_at IS NULL OR registration_end_at IS NULL OR registration_start_at < registration_end_at)
 AND (end_at IS NULL OR (start_at IS NOT NULL AND start_at < end_at))
 AND (end_at IS NULL OR registration_start_at IS NULL OR registration_start_at < end_at)
 AND (end_at IS NULL OR registration_end_at IS NULL OR registration_end_at <= end_at)
);
ALTER TABLE tournament_scoring ADD COLUMN IF NOT EXISTS lp_volume NUMERIC(20,6);
ALTER TABLE tournament_scoring DROP CONSTRAINT IF EXISTS scoring_lp_volume_nonnegative;
ALTER TABLE tournament_scoring ADD CONSTRAINT scoring_lp_volume_nonnegative CHECK (lp_volume >= 0);
