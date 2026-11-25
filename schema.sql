CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  service TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  sla_deadline_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE incident_audit_logs (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
