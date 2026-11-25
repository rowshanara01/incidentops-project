import crypto from 'crypto';
import dns from 'dns/promises';
import express from 'express';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.VERCEL && fs.existsSync(path.resolve(__dirname, '.env'))) {
  const envLines = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf8').split(/\r?\n/);
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export const app = express();
app.use(express.json({ limit: '1mb' }));

// PostgreSQL pool (automatically active when DATABASE_URL is set, e.g. Neon / Supabase)
let pgPool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err?.message || 'Internal server error' });
  });

const AUTH_SECRET =
  process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const usersStore = [];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function signSessionToken(user) {
  const headerPart = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url');
  const payloadPart = Buffer.from(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: user.role,
      exp: Date.now() + TOKEN_TTL_MS,
    })
  ).toString('base64url');
  const data = `${headerPart}.${payloadPart}`;
  const sig = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8')
    );
    if (!parsed.sub || !parsed.exp || Date.now() > parsed.exp) return null;
    return { sub: parsed.sub, exp: parsed.exp };
  } catch {
    return null;
  }
}

function sanitizeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    createdAtMs: Number(u.createdAtMs || u.created_at_ms || Date.now()),
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function ensureUsersTable() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL
    );
  `);
}

async function findUserById(id) {
  if (pgPool) {
    await ensureUsersTable();
    const res = await pgPool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      passwordHash: r.password_hash,
      role: r.role,
      createdAtMs: Number(r.created_at_ms),
    };
  }
  return usersStore.find((u) => u.id === id) || null;
}

async function findUserByEmail(email) {
  if (pgPool) {
    await ensureUsersTable();
    const res = await pgPool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      passwordHash: r.password_hash,
      role: r.role,
      createdAtMs: Number(r.created_at_ms),
    };
  }
  return usersStore.find((u) => u.email === email) || null;
}

async function countUsers() {
  if (pgPool) {
    await ensureUsersTable();
    const res = await pgPool.query('SELECT COUNT(*)::int AS cnt FROM users');
    return res.rows[0].cnt;
  }
  return usersStore.length;
}

const requireAuth = asyncHandler(async (req, res, next) => {
  const authHeader = String(req.headers.authorization || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  const verified = verifySessionToken(match[1]);
  if (!verified) {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    return;
  }
  const user = await findUserById(verified.sub);
  if (!user) {
    res.status(401).json({ error: 'User account not found.' });
    return;
  }
  req.user = user;
  next();
});

function requireRoles(allowed) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({
        error: `Forbidden: role "${role || 'unknown'}" is not permitted to perform this action.`,
      });
      return;
    }
    next();
  };
}

app.get('/api/auth/status', asyncHandler(async (_req, res) => {
  const totalUsers = await countUsers();
  res.json({ needsSetup: totalUsers === 0, totalUsers });
}));

app.post('/api/auth/setup', asyncHandler(async (req, res) => {
  const totalUsers = await countUsers();
  if (totalUsers > 0) {
    res.status(409).json({ error: 'Workspace admin already configured. Please sign in.' });
    return;
  }
  const { name, email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const cleanPass = String(password || '');

  if (!cleanName || !validateEmail(cleanEmail) || cleanPass.length < 6) {
    res.status(400).json({
      error: 'Valid name, email, and password (min 6 characters) are required.',
    });
    return;
  }

  const admin = {
    id: `usr-${crypto.randomUUID()}`,
    name: cleanName,
    email: cleanEmail,
    passwordHash: hashPassword(cleanPass),
    role: 'admin',
    createdAtMs: Date.now(),
  };

  if (pgPool) {
    await ensureUsersTable();
    await pgPool.query(
      'INSERT INTO users (id, name, email, password_hash, role, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6)',
      [admin.id, admin.name, admin.email, admin.passwordHash, admin.role, admin.createdAtMs]
    );
  } else {
    usersStore.push(admin);
  }

  res.status(201).json({ token: signSessionToken(admin), user: sanitizeUser(admin) });
}));

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const cleanPass = String(password || '');

  if (!cleanName || !validateEmail(cleanEmail) || cleanPass.length < 6) {
    res.status(400).json({
      error: 'Valid name, email, and password (min 6 characters) are required.',
    });
    return;
  }
  const existing = await findUserByEmail(cleanEmail);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }

  const totalUsers = await countUsers();
  const created = {
    id: `usr-${crypto.randomUUID()}`,
    name: cleanName,
    email: cleanEmail,
    passwordHash: hashPassword(cleanPass),
    role: totalUsers === 0 ? 'admin' : 'viewer',
    createdAtMs: Date.now(),
  };

  if (pgPool) {
    await ensureUsersTable();
    await pgPool.query(
      'INSERT INTO users (id, name, email, password_hash, role, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6)',
      [created.id, created.name, created.email, created.passwordHash, created.role, created.createdAtMs]
    );
  } else {
    usersStore.push(created);
  }

  res.status(201).json({ token: signSessionToken(created), user: sanitizeUser(created) });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');
  const user = await findUserByEmail(cleanEmail);
  if (!user || !verifyPassword(cleanPass, user.passwordHash)) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }
  res.json({ token: signSessionToken(user), user: sanitizeUser(user) });
}));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

const NEXT_STATUS = {
  open: 'investigating',
  investigating: 'mitigated',
  mitigated: 'resolved',
  resolved: null,
};

const nowSeed = Date.now();
const SEED_INCIDENTS = [
  {
    id: 'INC-401',
    title: 'Checkout webhook returning HTTP 502 on EU-West edge nodes',
    service: 'payments-gateway',
    severity: 'SEV-1',
    status: 'investigating',
    owner: 'oncall@company.io',
    notes: 'Edge upstream pool reset in progress; monitoring 502 error rate.',
    version: 3,
    slaDeadlineMs: nowSeed + 24 * 60 * 1000,
    createdAtMs: nowSeed - 18 * 60 * 1000,
  },
  {
    id: 'INC-402',
    title: 'PostgreSQL connection pool saturation during batch CSV import',
    service: 'ledger-worker',
    severity: 'SEV-2',
    status: 'open',
    owner: 'platform@company.io',
    notes: 'Awaiting batch worker throttling deploy.',
    version: 1,
    slaDeadlineMs: nowSeed + 52 * 60 * 1000,
    createdAtMs: nowSeed - 9 * 60 * 1000,
  },
  {
    id: 'INC-403',
    title: 'Stale cache headers on user avatar CDN invalidation',
    service: 'media-cdn',
    severity: 'SEV-3',
    status: 'mitigated',
    owner: 'edge@company.io',
    notes: 'Cache-Control max-age lowered and edge purge completed.',
    version: 4,
    slaDeadlineMs: nowSeed + 110 * 60 * 1000,
    createdAtMs: nowSeed - 45 * 60 * 1000,
  },
];

let incidentsStore = [...SEED_INCIDENTS];
let auditStore = [
  {
    id: 'aud-1',
    incidentId: 'INC-401',
    actor: 'system',
    role: 'responder',
    message: 'Transitioned INC-401 from open to investigating (v3)',
    timestamp: new Date(nowSeed - 5 * 60 * 1000).toTimeString().slice(0, 8),
  },
];

let dbInitialized = false;
async function ensureDb() {
  if (!pgPool || dbInitialized) return;
  await ensureUsersTable();
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
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
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS incident_audit_logs (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    ALTER TABLE incident_audit_logs ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT '';
  `);

  const countRes = await pgPool.query('SELECT COUNT(*)::int AS cnt FROM incidents');
  if (countRes.rows[0].cnt === 0) {
    for (const inc of SEED_INCIDENTS) {
      await pgPool.query(
        'INSERT INTO incidents (id, title, service, severity, status, owner, notes, version, sla_deadline_ms, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [inc.id, inc.title, inc.service, inc.severity, inc.status, inc.owner, inc.notes, inc.version, inc.slaDeadlineMs, inc.createdAtMs]
      );
    }
    await pgPool.query(
      'INSERT INTO incident_audit_logs (id, incident_id, actor, role, message, timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
      ['aud-1', 'INC-401', 'system', 'responder', 'Transitioned INC-401 from open to investigating (v3)', new Date().toTimeString().slice(0, 8)]
    );
  }
  dbInitialized = true;
}

function mapIncidentRow(r) {
  return {
    id: r.id,
    title: r.title,
    service: r.service,
    severity: r.severity,
    status: r.status,
    owner: r.owner,
    notes: r.notes || '',
    version: Number(r.version),
    slaDeadlineMs: Number(r.sla_deadline_ms),
    createdAtMs: Number(r.created_at_ms),
  };
}

async function recordAudit(incidentId, actor, role, message) {
  const entry = {
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    incidentId,
    actor,
    role,
    message,
    timestamp: new Date().toTimeString().slice(0, 8),
  };
  if (pgPool) {
    await pgPool.query(
      'INSERT INTO incident_audit_logs (id, incident_id, actor, role, message, timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
      [entry.id, entry.incidentId, entry.actor, entry.role, entry.message, entry.timestamp]
    );
    const logsRes = await pgPool.query(
      'SELECT id, incident_id AS "incidentId", actor, role, message, timestamp FROM incident_audit_logs ORDER BY seq DESC LIMIT 40'
    );
    return logsRes.rows;
  }
  auditStore = [entry, ...auditStore].slice(0, 40);
  return auditStore;
}

app.get('/api/health', asyncHandler(async (_req, res) => {
  if (pgPool) {
    await ensureDb();
    await pgPool.query('SELECT 1');
  }
  res.json({ ok: true, database: pgPool ? 'postgresql' : 'in-memory', auth: 'hmac-scrypt' });
}));

app.get('/api/incidentops/incidents', requireAuth, asyncHandler(async (req, res) => {
  await ensureDb();
  const severity = String(req.query.severity || 'ALL');

  let allIncidents = incidentsStore;
  let logs = auditStore;

  if (pgPool) {
    const incRes = await pgPool.query('SELECT * FROM incidents ORDER BY created_at_ms DESC');
    allIncidents = incRes.rows.map(mapIncidentRow);
    const logRes = await pgPool.query(
      'SELECT id, incident_id AS "incidentId", actor, role, message, timestamp FROM incident_audit_logs ORDER BY seq DESC LIMIT 40'
    );
    logs = logRes.rows;
  }

  const filtered =
    severity === 'ALL'
      ? allIncidents
      : allIncidents.filter((i) => i.severity === severity);

  const metrics = {
    active: allIncidents.filter((i) => i.status !== 'resolved').length,
    sev1: allIncidents.filter(
      (i) => i.severity === 'SEV-1' && i.status !== 'resolved'
    ).length,
    resolved: allIncidents.filter((i) => i.status === 'resolved').length,
  };

  res.json({ incidents: filtered, auditLogs: logs, metrics });
}));

app.post('/api/incidentops/incidents', requireAuth, requireRoles(['admin', 'responder']), asyncHandler(async (req, res) => {
  await ensureDb();
  const user = req.user;
  const { title, service, severity, notes } = req.body || {};
  if (!title || !String(title).trim()) {
    res.status(400).json({ error: 'Incident title is required.' });
    return;
  }

  const sev = ['SEV-1', 'SEV-2', 'SEV-3'].includes(severity) ? severity : 'SEV-2';
  let maxNum = 403;

  if (pgPool) {
    const resIds = await pgPool.query('SELECT id FROM incidents');
    for (const r of resIds.rows) {
      const n = Number(String(r.id).replace('INC-', ''));
      if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
    }
  } else {
    for (const item of incidentsStore) {
      const n = Number(item.id.replace('INC-', ''));
      if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
    }
  }

  const created = {
    id: `INC-${maxNum + 1}`,
    title: String(title).trim(),
    service: String(service || 'core-api').trim(),
    severity: sev,
    status: 'open',
    owner: user.email,
    notes: String(notes || '').trim(),
    version: 1,
    slaDeadlineMs: Date.now() + (sev === 'SEV-1' ? 30 : 90) * 60 * 1000,
    createdAtMs: Date.now(),
  };

  if (pgPool) {
    await pgPool.query(
      'INSERT INTO incidents (id, title, service, severity, status, owner, notes, version, sla_deadline_ms, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [created.id, created.title, created.service, created.severity, created.status, created.owner, created.notes, created.version, created.slaDeadlineMs, created.createdAtMs]
    );
  } else {
    incidentsStore = [created, ...incidentsStore];
  }

  const logs = await recordAudit(created.id, user.email, user.role, `Created ${created.id} (${created.severity})`);
  res.status(201).json({ incident: created, auditLogs: logs });
}));

app.patch(
  '/api/incidentops/incidents/:id/status',
  requireAuth,
  requireRoles(['admin', 'responder']),
  asyncHandler(async (req, res) => {
    await ensureDb();
    const user = req.user;
    const { id } = req.params;
    const { expectedVersion } = req.body || {};

    let target = incidentsStore.find((i) => i.id === id);
    if (pgPool) {
      const found = await pgPool.query('SELECT * FROM incidents WHERE id = $1', [id]);
      target = found.rows[0] ? mapIncidentRow(found.rows[0]) : undefined;
    }

    if (!target) {
      res.status(404).json({ error: `Incident ${id} not found.` });
      return;
    }

    const next = NEXT_STATUS[target.status];
    if (!next) {
      res.status(400).json({ error: 'Incident is already resolved.' });
      return;
    }

    if (typeof expectedVersion !== 'number' || target.version !== expectedVersion) {
      const logs = await recordAudit(
        target.id,
        user.email,
        user.role,
        `409 Conflict: client expected v${expectedVersion}, server holds v${target.version}`
      );
      res.status(409).json({
        error: `HTTP 409 Conflict on ${target.id}: stale version v${expectedVersion}. Server holds v${target.version}.`,
        current: target,
        auditLogs: logs,
      });
      return;
    }

    const prevStatus = target.status;
    if (pgPool) {
      const upd = await pgPool.query(
        'UPDATE incidents SET status = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING *',
        [next, id, expectedVersion]
      );
      if (upd.rowCount === 0) {
        const logs = await recordAudit(id, user.email, user.role, '409 Conflict during concurrent update');
        res.status(409).json({ error: `HTTP 409 Conflict on ${id}.`, auditLogs: logs });
        return;
      }
      target = mapIncidentRow(upd.rows[0]);
    } else {
      target.status = next;
      target.version += 1;
    }

    const logs = await recordAudit(
      target.id,
      user.email,
      user.role,
      `Transitioned ${target.id}: ${prevStatus} -> ${next} (v${target.version})`
    );
    res.json({ incident: target, auditLogs: logs });
  })
);

app.patch(
  '/api/incidentops/incidents/:id/notes',
  requireAuth,
  requireRoles(['admin', 'responder']),
  asyncHandler(async (req, res) => {
    await ensureDb();
    const user = req.user;
    const { id } = req.params;
    const { notes, expectedVersion } = req.body || {};
    const cleanNotes = String(notes || '').trim();

    if (pgPool) {
      const found = await pgPool.query('SELECT * FROM incidents WHERE id = $1', [id]);
      if (!found.rows[0]) {
        res.status(404).json({ error: `Incident ${id} not found.` });
        return;
      }
      const current = mapIncidentRow(found.rows[0]);
      if (typeof expectedVersion === 'number' && current.version !== expectedVersion) {
        res.status(409).json({ error: `HTTP 409 Conflict on ${id}.` });
        return;
      }
      const upd = await pgPool.query(
        'UPDATE incidents SET notes = $1, version = version + 1 WHERE id = $2 RETURNING *',
        [cleanNotes, id]
      );
      const updated = mapIncidentRow(upd.rows[0]);
      const logs = await recordAudit(id, user.email, user.role, `Updated resolution notes on ${id} (v${updated.version})`);
      res.json({ incident: updated, auditLogs: logs });
      return;
    }

    const target = incidentsStore.find((i) => i.id === id);
    if (!target) {
      res.status(404).json({ error: `Incident ${id} not found.` });
      return;
    }
    if (typeof expectedVersion === 'number' && target.version !== expectedVersion) {
      res.status(409).json({ error: `HTTP 409 Conflict on ${id}.` });
      return;
    }
    target.notes = cleanNotes;
    target.version += 1;
    const logs = await recordAudit(id, user.email, user.role, `Updated resolution notes on ${id} (v${target.version})`);
    res.json({ incident: target, auditLogs: logs });
  })
);

app.post('/api/incidentops/incidents/:id/reopen', requireAuth, requireRoles(['admin']), asyncHandler(async (req, res) => {
  await ensureDb();
  const user = req.user;
  const { id } = req.params;

  let target = incidentsStore.find((i) => i.id === id);
  if (pgPool) {
    const upd = await pgPool.query(
      "UPDATE incidents SET status = 'investigating', version = version + 1 WHERE id = $1 RETURNING *",
      [id]
    );
    target = upd.rows[0] ? mapIncidentRow(upd.rows[0]) : undefined;
  } else if (target) {
    target.status = 'investigating';
    target.version += 1;
  }

  if (!target) {
    res.status(404).json({ error: `Incident ${id} not found.` });
    return;
  }

  const logs = await recordAudit(
    target.id,
    user.email,
    user.role,
    `Admin reopened ${target.id} to investigating (v${target.version})`
  );
  res.json({ incident: target, auditLogs: logs });
}));

app.delete('/api/incidentops/incidents/:id', requireAuth, requireRoles(['admin']), asyncHandler(async (req, res) => {
  await ensureDb();
  const user = req.user;
  const { id } = req.params;

  if (pgPool) {
    const del = await pgPool.query('DELETE FROM incidents WHERE id = $1 RETURNING id', [id]);
    if (del.rowCount === 0) {
      res.status(404).json({ error: `Incident ${id} not found.` });
      return;
    }
  } else {
    const exists = incidentsStore.some((i) => i.id === id);
    if (!exists) {
      res.status(404).json({ error: `Incident ${id} not found.` });
      return;
    }
    incidentsStore = incidentsStore.filter((i) => i.id !== id);
  }

  const logs = await recordAudit(id, user.email, user.role, `Admin deleted incident ${id}`);
  res.json({ deleted: id, auditLogs: logs });
}));

app.get('/api/incidentops/users', requireAuth, requireRoles(['admin']), asyncHandler(async (_req, res) => {
  await ensureDb();
  if (pgPool) {
    const r = await pgPool.query('SELECT id, name, email, role, created_at_ms FROM users ORDER BY created_at_ms ASC');
    res.json({ users: r.rows.map(sanitizeUser) });
    return;
  }
  res.json({ users: usersStore.map(sanitizeUser) });
}));

app.patch('/api/incidentops/users/:id/role', requireAuth, requireRoles(['admin']), asyncHandler(async (req, res) => {
  await ensureDb();
  const { id } = req.params;
  const { role } = req.body || {};
  if (!['admin', 'responder', 'viewer'].includes(role)) {
    res.status(400).json({ error: 'Invalid role.' });
    return;
  }

  if (pgPool) {
    if (id === req.user.id && role !== 'admin') {
      const cnt = await pgPool.query("SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'admin'");
      if (cnt.rows[0].cnt <= 1) {
        res.status(400).json({ error: 'Cannot demote the only workspace admin.' });
        return;
      }
    }
    const upd = await pgPool.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role, created_at_ms', [role, id]);
    if (!upd.rows[0]) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    res.json({ user: sanitizeUser(upd.rows[0]) });
    return;
  }

  const target = usersStore.find((u) => u.id === id);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  if (target.id === req.user.id && role !== 'admin') {
    const adminCount = usersStore.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'Cannot demote the only workspace admin.' });
      return;
    }
  }
  target.role = role;
  res.json({ user: sanitizeUser(target) });
}));

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  void startServer();
}
