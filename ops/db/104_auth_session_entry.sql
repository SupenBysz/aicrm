CREATE TABLE ky_auth_session_entry (
 session_id text PRIMARY KEY,hostname text NOT NULL,binding_id text NOT NULL,agency_id text NOT NULL,generation bigint NOT NULL
);
REVOKE ALL ON ky_auth_session_entry FROM PUBLIC;
