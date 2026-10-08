ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_check;
ALTER TABLE users ADD CONSTRAINT users_display_name_check CHECK (length(btrim(display_name)) BETWEEN 3 AND 100);
