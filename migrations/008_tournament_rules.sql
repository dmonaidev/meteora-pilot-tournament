CREATE TABLE IF NOT EXISTS tournament_rules (
 id UUID PRIMARY KEY,
 version INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
 title VARCHAR(150) NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 150),
 body TEXT CHECK (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 100000),
 status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
 created_at TIMESTAMPTZ NOT NULL,
 published_at TIMESTAMPTZ,
 archived_at TIMESTAMPTZ,
 deleted_at TIMESTAMPTZ,
 CHECK ((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL AND status <> 'ACTIVE')),
 CHECK (status='DRAFT' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS tournament_rules_one_active ON tournament_rules(status) WHERE status='ACTIVE' AND deleted_at IS NULL;
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS rules_version_id UUID REFERENCES tournament_rules(id);
ALTER TABLE pending_sessions ADD COLUMN IF NOT EXISTS rules_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_rules_version_id UUID REFERENCES tournament_rules(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS rules_accepted_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION protect_tournament_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rules metadata must be retained'; END IF;
 IF OLD.deleted_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.version<>OLD.version OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Rules metadata is immutable'; END IF;
 IF OLD.status<>'DRAFT' AND (NEW.title IS DISTINCT FROM OLD.title OR (NEW.body IS DISTINCT FROM OLD.body AND NOT (NEW.body IS NULL AND NEW.deleted_at IS NOT NULL))) THEN RAISE EXCEPTION 'Published rules content is immutable'; END IF;
 IF OLD.status='ARCHIVED' AND NEW.status<>'ARCHIVED' OR OLD.status='ACTIVE' AND NEW.status NOT IN ('ACTIVE','ARCHIVED') THEN RAISE EXCEPTION 'Published rules cannot be reactivated'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_tournament_rules_rows ON tournament_rules;
CREATE TRIGGER protect_tournament_rules_rows BEFORE UPDATE OR DELETE ON tournament_rules FOR EACH ROW EXECUTE FUNCTION protect_tournament_rules();
