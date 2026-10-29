-- Auth owns heartbeat; existing sessions start unknown/offline until a real heartbeat.
ALTER TABLE ky_user_session ADD COLUMN last_seen_at timestamptz;
CREATE INDEX ky_user_session_presence_idx ON ky_user_session(user_id,last_seen_at) WHERE status='active';
