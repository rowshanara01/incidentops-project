import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
export type Language = 'bn' | 'en';

type Role = 'admin' | 'responder' | 'viewer';
type Severity = 'SEV-1' | 'SEV-2' | 'SEV-3';
type IncidentStatus = 'open' | 'investigating' | 'mitigated' | 'resolved';

interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

interface Incident {
  id: string;
  title: string;
  service: string;
  severity: Severity;
  status: IncidentStatus;
  owner: string;
  notes: string;
  version: number;
  slaDeadlineMs: number;
  createdAtMs: number;
}

interface AuditEntry {
  id: string;
  incidentId: string;
  actor?: string;
  role: Role;
  message: string;
  timestamp: string;
}

const NEXT_STATUS: Record<IncidentStatus, IncidentStatus | null> = {
  open: 'investigating',
  investigating: 'mitigated',
  mitigated: 'resolved',
  resolved: null,
};

function formatCountdown(targetMs: number, nowMs: number): string {
  const diffSec = Math.floor((targetMs - nowMs) / 1000);
  if (diffSec <= 0) return 'BREACHED';
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function IncidentOpsApp({
  lang,
  onAuthChange,
}: {
  lang: Language;
  onAuthChange?: (signedIn: boolean) => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState({ active: 0, sev1: 0, resolved: 0 });
  const [loading, setLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<'ALL' | Severity>('ALL');
  const [simulateConflict, setSimulateConflict] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [newTitle, setNewTitle] = useState('');
  const [newService, setNewService] = useState('auth-service');
  const [newSeverity, setNewSeverity] = useState<Severity>('SEV-2');
  const [newNotes, setNewNotes] = useState('');

  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [editingNotesText, setEditingNotesText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [showTeam, setShowTeam] = useState(false);
  const [teamUsers, setTeamUsers] = useState<AuthUser[]>([]);

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status');
      if (res.ok) {
        const data = (await res.json()) as { needsSetup: boolean };
        setNeedsSetup(data.needsSetup);
      } else {
        setNeedsSetup(false);
      }
    } catch {
      setNeedsSetup(false);
    }
  }, []);

  useEffect(() => {
    void checkAuthStatus();
  }, [checkAuthStatus]);

  useEffect(() => {
    onAuthChange?.(Boolean(token && user));
  }, [token, user, onAuthChange]);

  const fetchIncidents = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/incidentops/incidents?severity=${encodeURIComponent(severityFilter)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (res.status === 401) {
        setToken(null);
        setUser(null);
        return;
      }
      if (!res.ok) throw new Error('Failed to load incidents');
      const data = (await res.json()) as {
        incidents: Incident[];
        auditLogs: AuditEntry[];
        metrics: { active: number; sev1: number; resolved: number };
      };
      setIncidents(data.incidents);
      setAuditLogs(data.auditLogs);
      setMetrics(data.metrics);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Unable to reach IncidentOps API'
      );
    } finally {
      setLoading(false);
    }
  }, [token, severityFilter]);

  const fetchTeamUsers = useCallback(async () => {
    if (!token || user?.role !== 'admin') return;
    const res = await fetch('/api/incidentops/users', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { users: AuthUser[] };
      setTeamUsers(data.users);
    }
  }, [token, user?.role]);

  useEffect(() => {
    if (token) {
      void fetchIncidents();
      if (user?.role === 'admin') {
        void fetchTeamUsers();
      }
    }
  }, [token, user?.role, fetchIncidents, fetchTeamUsers]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthBusy(true);
    try {
      const endpoint = needsSetup
        ? '/api/auth/setup'
        : authMode === 'register'
        ? '/api/auth/register'
        : '/api/auth/login';
      const body =
        needsSetup || authMode === 'register'
          ? { name: authName.trim(), email: authEmail.trim(), password: authPassword }
          : { email: authEmail.trim(), password: authPassword };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        token?: string;
        user?: AuthUser;
        error?: string;
      };
      if (!res.ok || !data.token || !data.user) {
        setAuthError(data.error || 'Authentication failed.');
        return;
      }
      setToken(data.token);
      setUser(data.user);
      setNeedsSetup(false);
      setAuthPassword('');
    } catch {
      setAuthError('Network error while signing in.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = () => {
    setToken(null);
    setUser(null);
    setIncidents([]);
    setAuditLogs([]);
    setTeamUsers([]);
    void checkAuthStatus();
  };

  if (!token || !user) {
    const rbacRows = [
      {
        action: lang === 'bn' ? 'ইনসিডেন্ট ঘোষণা (Declare)' : 'Declare Incident',
        admin: true,
        responder: true,
        viewer: false,
      },
      {
        action: lang === 'bn' ? 'স্ট্যাটাস আপডেট ও নোট' : 'Advance Status & Notes',
        admin: true,
        responder: true,
        viewer: false,
      },
      {
        action: lang === 'bn' ? 'রি-ওপেন ও ডিলিট' : 'Reopen & Delete',
        admin: true,
        responder: false,
        viewer: false,
      },
      {
        action: lang === 'bn' ? 'টিম রোল পরিবর্তন' : 'Manage Team Roles',
        admin: true,
        responder: false,
        viewer: false,
      },
    ];

    const lifecycle = [
      {
        step: '01',
        state: 'OPEN',
        sla: 'SEV-1 · 15m',
        desc:
          lang === 'bn'
            ? 'সার্ভিস ও সিভিয়ারিটিসহ নতুন ইনসিডেন্ট রেকর্ড হয়।'
            : 'Incident logged with severity tier and live SLA countdown.',
      },
      {
        step: '02',
        state: 'INVESTIGATING',
        sla: 'v1 → v2',
        desc:
          lang === 'bn'
            ? 'অন-কল রেসপন্ডার রুট-কজ তদন্ত ও নোট আপডেট করেন।'
            : 'Responders triage logs and record root-cause findings.',
      },
      {
        step: '03',
        state: 'MITIGATED',
        sla: 'HTTP 409 Check',
        desc:
          lang === 'bn'
            ? 'অপটিমিস্টিক ভার্সন যাচাই করে রোলব্যাক সেফটি নিশ্চিত করে।'
            : 'Version guard prevents concurrent edits from overwriting state.',
      },
      {
        step: '04',
        state: 'RESOLVED',
        sla: 'Admin Reopen',
        desc:
          lang === 'bn'
            ? 'অ্যাডমিন প্রয়োজন হলে রি-ওপেন ও সম্পূর্ণ অডিট লগ দেখেন।'
            : 'SLA stops at MET; Admins retain reopen and audit governance.',
      },
    ];

    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <section
          id="overview"
          className="scroll-mt-24 bg-slate-950 text-white border border-slate-800 rounded-2xl p-6 sm:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
        >
          <div className="lg:col-span-7 space-y-6">
            <div className="space-y-3">
              <p className="text-xs font-mono text-rose-400">
                {lang === 'bn'
                  ? 'INCIDENTOPS · SRE অন-কল কমান্ড সেন্টার'
                  : 'INCIDENTOPS · SRE ON-CALL COMMAND'}
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white leading-[1.15] text-balance">
                {lang === 'bn'
                  ? 'লাইভ আউটেজ নিয়ন্ত্রণ, সার্ভার-ভেরিফায়েড RBAC এবং জিরো ওভাররাইট'
                  : 'Run outage response with verified RBAC and optimistic locking'}
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed max-w-2xl">
                {lang === 'bn'
                  ? 'প্রথম অ্যাকাউন্ট অ্যাডমিন হিসেবে কনফিগার হয় এবং পরবর্তী ইউজাররা ভিউয়ার হিসেবে যুক্ত হন। প্রতিটি রিকোয়েস্ট সার্ভার থেকে পারমিশন ও ভার্সন যাচাই করে।'
                  : 'Bootstrap your workspace Admin, promote team responders, enforce HTTP 409 conflict rollbacks, and track real-time SLA windows across SEV-1 to SEV-3 alerts.'}
              </p>
            </div>

            <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">
                  {lang === 'bn'
                    ? 'সার্ভার-এনফোর্সড RBAC পারমিশন ম্যাট্রিক্স'
                    : 'Server-Enforced RBAC Matrix'}
                </span>
                <span className="font-mono text-slate-400">
                  SEV-1 15m · SEV-2 30m · SEV-3 60m
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400 border-b border-slate-800/80">
                    <tr>
                      <th className="py-2 px-4 font-medium">
                        {lang === 'bn' ? 'অপারেশন' : 'Capability'}
                      </th>
                      <th className="py-2 px-3 font-mono text-center">admin</th>
                      <th className="py-2 px-3 font-mono text-center">responder</th>
                      <th className="py-2 px-3 font-mono text-center">viewer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {rbacRows.map((row) => (
                      <tr key={row.action}>
                        <td className="py-2 px-4 text-slate-200">{row.action}</td>
                        <td className="py-2 px-3 text-center font-mono text-emerald-400">
                          {row.admin ? 'ALLOW' : '—'}
                        </td>
                        <td
                          className={`py-2 px-3 text-center font-mono ${
                            row.responder ? 'text-emerald-400' : 'text-slate-500'
                          }`}
                        >
                          {row.responder ? 'ALLOW' : '403'}
                        </td>
                        <td className="py-2 px-3 text-center font-mono text-slate-500">
                          {row.viewer ? 'ALLOW' : '403'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div
            id="auth-panel"
            className="scroll-mt-24 lg:col-span-5 bg-white text-slate-900 border border-slate-200 rounded-xl p-6 space-y-5"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-slate-950 text-white flex items-center justify-center shrink-0">
                <Lock className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {needsSetup
                    ? lang === 'bn'
                      ? 'প্রথমবার অ্যাডমিন অ্যাকাউন্ট সেটআপ'
                      : 'Initial Workspace Admin Setup'
                    : lang === 'bn'
                    ? 'IncidentOps কমান্ড লগইন'
                    : 'Sign in to IncidentOps'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                  {needsSetup
                    ? lang === 'bn'
                      ? 'নিরাপদ RBAC সক্রিয় করতে প্রথম অ্যাডমিন অ্যাকাউন্ট তৈরি করুন।'
                      : 'Create the first administrator account to enable server-enforced RBAC.'
                    : lang === 'bn'
                    ? 'JWT সেশন ও রোল-ভিত্তিক পারমিশন সার্ভার থেকে ভেরিফাই হয়।'
                    : 'Authenticated sessions and role permissions are verified on the server.'}
                </p>
              </div>
            </div>

            {needsSetup === false && (
              <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-lg text-xs font-medium">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                  }}
                  className={`py-2 rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === 'login'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lang === 'bn' ? 'সাইন ইন' : 'Sign In'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError(null);
                  }}
                  className={`py-2 rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === 'register'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lang === 'bn' ? 'নতুন অ্যাকাউন্ট' : 'Create Account'}
                </button>
              </div>
            )}

            {authError && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
                {authError}
              </div>
            )}

            <form onSubmit={(e) => void handleAuthSubmit(e)} className="space-y-3.5">
              {(needsSetup || authMode === 'register') && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {lang === 'bn' ? 'পূর্ণ নাম' : 'Full Name'}
                  </label>
                  <input
                    type="text"
                    required
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    placeholder="Rafiq Ahmed"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {lang === 'bn' ? 'ওয়ার্ক ইমেইল' : 'Work Email'}
                </label>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="engineer@company.io"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {lang === 'bn'
                    ? 'পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর)'
                    : 'Password (min 6 characters)'}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-3 pr-10 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={authBusy || needsSetup === null}
                className="w-full py-2.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 rounded-lg transition-colors cursor-pointer"
              >
                {authBusy
                  ? lang === 'bn'
                    ? 'যাচাই করা হচ্ছে...'
                    : 'Authenticating...'
                  : needsSetup
                  ? lang === 'bn'
                    ? 'অ্যাডমিন তৈরি করে প্রবেশ করুন'
                    : 'Create Admin & Enter'
                  : authMode === 'register'
                  ? lang === 'bn'
                    ? 'অ্যাকাউন্ট রেজিস্টার করুন'
                    : 'Register Account'
                  : lang === 'bn'
                  ? 'কমান্ড সেন্টারে প্রবেশ করুন'
                  : 'Enter Command Console'}
              </button>
            </form>

            <div className="pt-3 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-500">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>
                {lang === 'bn'
                  ? 'রোল-ভিত্তিক এক্সেস কন্ট্রোল ও ড্যাশবোর্ডে লগআউট সুবিধা।'
                  : 'Verified session tokens with instant dashboard Logout.'}
              </span>
            </div>
          </div>
        </section>

        <section
          id="workflow"
          className="scroll-mt-24 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              {lang === 'bn'
                ? '৪-ধাপের ইনসিডেন্ট লাইফসাইকেল ও SLA প্রবাহ'
                : 'Four-Stage Incident Escalation Pipeline'}
            </h3>
            <span className="text-xs font-mono text-slate-500">
              OPEN → INVESTIGATING → MITIGATED → RESOLVED
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {lifecycle.map((item) => (
              <div
                key={item.step}
                className="p-4 rounded-lg bg-slate-50 border border-slate-200/80 space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="font-semibold text-slate-900">{item.step} · {item.state}</span>
                  <span className="text-slate-500">{item.sla}</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section
          id="capabilities"
          className="scroll-mt-24 grid grid-cols-1 lg:grid-cols-12 gap-6"
        >
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-rose-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  {lang === 'bn'
                    ? 'HTTP 409 অপটিমিস্টিক কনকারেন্সি ও UI রোলব্যাক'
                    : 'HTTP 409 Optimistic Locking & Safe Rollback'}
                </h3>
              </div>
              <span className="text-xs font-mono text-slate-500">expectedVersion</span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {lang === 'bn'
                ? 'প্রতিটি স্ট্যাটাস আপডেটের সাথে expectedVersion পাঠানো হয়। সার্ভারের ভার্সনের সাথে না মিললে HTTP 409 Conflict রিটার্ন করে এবং ক্লায়েন্ট UI পূর্ববর্তী নিরাপদ অবস্থায় ফিরে আসে।'
                : 'Every status transition carries expectedVersion. If another responder updated the incident first, the server rejects stale writes with HTTP 409 Conflict and rolls back the optimistic UI state.'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-xs font-mono">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <span className="text-slate-500 block">1. Client Send</span>
                <span className="text-slate-900 font-semibold">expectedVersion: 2</span>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <span className="text-slate-500 block">2. DB Row</span>
                <span className="text-rose-600 font-semibold">currentVersion: 3</span>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <span className="text-slate-500 block">3. Outcome</span>
                <span className="text-emerald-700 font-semibold">409 + Rollback</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-slate-900" />
                <h3 className="text-sm font-semibold text-slate-900">
                  {lang === 'bn'
                    ? 'লাইভ SLA ও টিম অডিট ট্রেইল'
                    : 'Audit History & Role Governance'}
                </h3>
              </div>
              <span className="text-xs font-mono text-slate-500">Audit Log</span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              {lang === 'bn'
                ? 'কে কখন ইনসিডেন্ট তৈরি করেছেন, স্ট্যাটাস বদলেছেন বা কনফ্লিক্ট হয়েছে তার সম্পূর্ণ রেকর্ড টিম রোলসহ সার্ভার অডিট লগে সংরক্ষিত থাকে।'
                : 'Every creation, state transition, rejection, reopen, and role change is stamped with actor identity, role, and UTC timestamp in PostgreSQL or memory.'}
            </p>
            <div className="pt-2 border-t border-slate-100 flex items-center gap-4 text-xs text-slate-600 font-mono">
              <span>PATCH /status</span>
              <span>·</span>
              <span>PATCH /notes</span>
              <span>·</span>
              <span>PATCH /users/:id/role</span>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const role = user.role;
  const canCreate = role === 'admin' || role === 'responder';
  const canTransition = role === 'admin' || role === 'responder';
  const canReopen = role === 'admin';

  const handleAdvanceStatus = async (inc: Incident) => {
    if (!canTransition) return;
    const next = NEXT_STATUS[inc.status];
    if (!next) return;

    setErrorBanner(null);
    setIncidents((prev) =>
      prev.map((item) =>
        item.id === inc.id
          ? { ...item, status: next, version: item.version + 1 }
          : item
      )
    );

    try {
      const expectedVersion = simulateConflict ? inc.version - 1 : inc.version;
      const res = await fetch(`/api/incidentops/incidents/${inc.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ expectedVersion }),
      });

      const payload = (await res.json()) as {
        error?: string;
        auditLogs?: AuditEntry[];
      };

      if (!res.ok) {
        setIncidents((prev) =>
          prev.map((item) =>
            item.id === inc.id
              ? { ...item, status: inc.status, version: inc.version }
              : item
          )
        );
        if (payload.auditLogs) setAuditLogs(payload.auditLogs);
        setErrorBanner(payload.error || 'Status transition rejected by server.');
        return;
      }

      await fetchIncidents();
    } catch {
      setIncidents((prev) =>
        prev.map((item) =>
          item.id === inc.id
            ? { ...item, status: inc.status, version: inc.version }
            : item
        )
      );
      setErrorBanner('Network error while updating incident status.');
    }
  };

  const handleSaveNotes = async (inc: Incident) => {
    setErrorBanner(null);
    const res = await fetch(`/api/incidentops/incidents/${inc.id}/notes`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ notes: editingNotesText, expectedVersion: inc.version }),
    });
    if (!res.ok) {
      const payload = (await res.json()) as { error?: string };
      setErrorBanner(payload.error || 'Failed to update notes.');
      return;
    }
    setEditingNotesId(null);
    await fetchIncidents();
  };

  const handleReopen = async (inc: Incident) => {
    if (!canReopen) return;
    setErrorBanner(null);
    const res = await fetch(`/api/incidentops/incidents/${inc.id}/reopen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const payload = (await res.json()) as { error?: string };
      setErrorBanner(payload.error || 'Forbidden');
      return;
    }
    await fetchIncidents();
  };

  const handleDeleteIncident = async (id: string) => {
    if (!canReopen) return;
    setErrorBanner(null);
    const res = await fetch(`/api/incidentops/incidents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const payload = (await res.json()) as { error?: string };
      setErrorBanner(payload.error || 'Delete failed');
      return;
    }
    setConfirmDeleteId(null);
    await fetchIncidents();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate || !newTitle.trim()) return;
    setErrorBanner(null);
    const res = await fetch('/api/incidentops/incidents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: newTitle.trim(),
        service: newService.trim() || 'core-api',
        severity: newSeverity,
        notes: newNotes.trim(),
      }),
    });
    if (!res.ok) {
      const payload = (await res.json()) as { error?: string };
      setErrorBanner(payload.error || 'Unable to create incident');
      return;
    }
    setNewTitle('');
    setNewNotes('');
    await fetchIncidents();
  };

  const handleRoleUpdate = async (targetUserId: string, nextRole: Role) => {
    setErrorBanner(null);
    const res = await fetch(`/api/incidentops/users/${targetUserId}/role`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: nextRole }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to update role.');
      return;
    }
    await fetchTeamUsers();
  };

  return (
    <div id="overview" className="scroll-mt-24 space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>{user.name}</span>
            <span className="text-slate-400">({user.email})</span>
          </div>
          <span className="px-2.5 py-1 text-xs font-mono font-semibold uppercase bg-slate-100 text-slate-800 rounded-md">
            {role}
          </span>
          <span className="text-xs text-slate-500">
            {role === 'admin'
              ? 'Create · Transition · Reopen · Delete · Manage Team'
              : role === 'responder'
              ? 'Create · Transition · Edit Notes'
              : 'Read-Only Viewer'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {canTransition && (
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={simulateConflict}
                onChange={(e) => setSimulateConflict(e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
              <span>
                {lang === 'bn'
                  ? 'HTTP 409 Conflict রোলব্যাক টেস্ট'
                  : 'Test HTTP 409 Conflict Rollback'}
              </span>
            </label>
          )}
          {role === 'admin' && (
            <button
              type="button"
              onClick={() => {
                setShowTeam((v) => !v);
                if (!showTeam) void fetchTeamUsers();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              <Users className="w-3.5 h-3.5" />
              <span>Team Roles ({teamUsers.length})</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            aria-label={lang === 'bn' ? 'লগআউট করুন' : 'Logout'}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'লগআউট' : 'Logout'}</span>
          </button>
        </div>
      </div>

      {showTeam && role === 'admin' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Team Access Control (Server-Persisted RBAC)
            </h3>
            <span className="text-xs text-slate-500">
              Promote registered viewers to responder or admin
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {teamUsers.map((member) => (
              <div
                key={member.id}
                className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div>
                  <span className="font-medium text-slate-900">{member.name}</span>{' '}
                  <span className="text-slate-500">({member.email})</span>
                </div>
                <select
                  value={member.role}
                  onChange={(e) =>
                    void handleRoleUpdate(member.id, e.target.value as Role)
                  }
                  className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white font-mono"
                >
                  <option value="admin">admin</option>
                  <option value="responder">responder</option>
                  <option value="viewer">viewer</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {errorBanner && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-between gap-4 text-xs text-rose-900"
        >
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span className="font-medium">{errorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="font-medium text-rose-700 hover:underline cursor-pointer whitespace-nowrap"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs text-slate-500">Active Incidents</p>
          <p className="text-2xl font-semibold text-slate-900 tabular-nums mt-1">
            {metrics.active}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs text-slate-500">Open SEV-1 Critical</p>
          <p className="text-2xl font-semibold text-rose-600 tabular-nums mt-1">
            {metrics.sev1}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs text-slate-500">Resolved Total</p>
          <p className="text-2xl font-semibold text-emerald-700 tabular-nums mt-1">
            {metrics.resolved}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 space-y-4">
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
          >
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                disabled={!canCreate}
                placeholder={
                  canCreate
                    ? lang === 'bn'
                      ? 'নতুন Incident লিখুন (যেমন: Redis timeout on session store)...'
                      : 'Log new incident (e.g. Redis timeout on session store)...'
                    : 'Viewer role cannot create incidents (ask an Admin to promote your role)'
                }
                className="flex-1 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <input
                type="text"
                value={newService}
                onChange={(e) => setNewService(e.target.value)}
                disabled={!canCreate}
                className="sm:w-32 px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg disabled:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <select
                value={newSeverity}
                onChange={(e) => setNewSeverity(e.target.value as Severity)}
                disabled={!canCreate}
                className="px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg disabled:bg-slate-100"
              >
                <option value="SEV-1">SEV-1</option>
                <option value="SEV-2">SEV-2</option>
                <option value="SEV-3">SEV-3</option>
              </select>
              <button
                type="submit"
                disabled={!canCreate}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Declare</span>
              </button>
            </div>
            {canCreate && (
              <input
                type="text"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="Initial triage notes or runbook link (optional)..."
                className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            )}
          </form>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
              <span className="text-sm font-semibold text-slate-900">
                Incident Queue (Authenticated Express REST API)
              </span>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                {(['ALL', 'SEV-1', 'SEV-2', 'SEV-3'] as const).map((sev) => (
                  <button
                    key={sev}
                    type="button"
                    onClick={() => setSeverityFilter(sev)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      severityFilter === sev
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {sev}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Loading incidents from backend API...
              </div>
            ) : incidents.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No incidents match the selected severity filter.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {incidents.map((inc) => {
                  const next = NEXT_STATUS[inc.status];
                  const countdown =
                    inc.status === 'resolved'
                      ? 'MET'
                      : formatCountdown(inc.slaDeadlineMs, nowMs);

                  return (
                    <div
                      key={inc.id}
                      className="p-5 space-y-3 hover:bg-slate-50/70 transition-colors"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono font-semibold text-slate-800">
                              {inc.id}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span
                              className={`font-semibold ${
                                inc.severity === 'SEV-1'
                                  ? 'text-rose-600'
                                  : inc.severity === 'SEV-2'
                                  ? 'text-amber-700'
                                  : 'text-slate-700'
                              }`}
                            >
                              {inc.severity}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{inc.service}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">v{inc.version}</span>
                          </div>
                          <p className="text-sm font-medium text-slate-900">
                            {inc.title}
                          </p>
                          <p className="text-xs text-slate-500">
                            Status:{' '}
                            <span className="font-medium text-slate-800 capitalize">
                              {inc.status}
                            </span>{' '}
                            · Owner: {inc.owner}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                          <div className="text-right mr-1">
                            <p className="text-[11px] text-slate-400">SLA Timer</p>
                            <p
                              className={`text-xs font-mono font-semibold tabular-nums ${
                                countdown === 'MET'
                                  ? 'text-emerald-700'
                                  : countdown === 'BREACHED'
                                  ? 'text-rose-600'
                                  : 'text-slate-900'
                              }`}
                            >
                              {countdown}
                            </p>
                          </div>

                          {next && (
                            <button
                              type="button"
                              disabled={!canTransition}
                              onClick={() => void handleAdvanceStatus(inc)}
                              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:cursor-not-allowed capitalize"
                            >
                              Mark {next}
                            </button>
                          )}

                          {inc.status === 'resolved' && canReopen && (
                            <button
                              type="button"
                              onClick={() => void handleReopen(inc)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <RotateCcw className="w-3 h-3" />
                              <span>Reopen</span>
                            </button>
                          )}

                          {canReopen &&
                            (confirmDeleteId === inc.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteIncident(inc.id)}
                                  className="px-2.5 py-1.5 text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer"
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="px-2 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(inc.id)}
                                title="Delete incident"
                                className="p-1.5 text-slate-400 hover:text-rose-600 border border-slate-200 rounded-lg cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            ))}
                        </div>
                      </div>

                      {editingNotesId === inc.id ? (
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={editingNotesText}
                            onChange={(e) => setEditingNotesText(e.target.value)}
                            placeholder="Resolution / root cause notes..."
                            className="flex-1 px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveNotes(inc)}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg cursor-pointer"
                          >
                            Save Notes
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingNotesId(null)}
                            className="px-2.5 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3 text-xs bg-slate-50 border border-slate-200/70 rounded-lg px-3 py-2">
                          <span className="text-slate-600">
                            {inc.notes ? inc.notes : 'No resolution notes recorded yet.'}
                          </span>
                          {canTransition && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingNotesId(inc.id);
                                setEditingNotesText(inc.notes || '');
                              }}
                              className="text-blue-600 hover:underline shrink-0 cursor-pointer"
                            >
                              Edit Notes
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">
              Server Audit Log
            </h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
            {auditLogs.map((log) => (
              <div key={log.id} className="px-5 py-3 space-y-1 text-xs">
                <div className="flex items-center justify-between text-slate-400 font-mono tabular-nums">
                  <span>
                    {log.role.toUpperCase()}
                    {log.actor ? ` · ${log.actor}` : ''}
                  </span>
                  <span>{log.timestamp}</span>
                </div>
                <p className="text-slate-700 leading-relaxed">{log.message}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
