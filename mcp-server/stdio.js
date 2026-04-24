import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';

const { Pool } = pg;
const API_URL = process.env.API_URL || 'http://localhost:3001/api/v1';

// ===== AUTH =====
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
    });
    if (!res.ok) throw new Error(`Login mislukt: ${res.status}`);
    const data = await res.json();
    cachedToken = data.token;
    tokenExpiry = Date.now() + 6 * 24 * 60 * 60 * 1000;
    return cachedToken;
}

async function apiFetch(path, options = {}) {
    const token = await getToken();
    const res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) }
    });
    if (res.status === 401) { cachedToken = null; return apiFetch(path, options); }
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ===== DB =====
let dbPool = null;
function getDb() {
    if (!dbPool && process.env.DATABASE_URL) dbPool = new Pool({ connectionString: process.env.DATABASE_URL });
    return dbPool;
}

function formatTable(rows) {
    if (!rows || rows.length === 0) return '(geen resultaten)';
    const keys = Object.keys(rows[0]);
    const widths = keys.map(k => Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)));
    const header = keys.map((k, i) => k.padEnd(widths[i])).join(' | ');
    const divider = widths.map(w => '-'.repeat(w)).join('-+-');
    const body = rows.map(r => keys.map((k, i) => String(r[k] ?? '').padEnd(widths[i])).join(' | ')).join('\n');
    return `${header}\n${divider}\n${body}\n(${rows.length} rij${rows.length !== 1 ? 'en' : ''})`;
}

// ===== TOOLS =====
const TOOLS = [
    { name: 'get_shifts', description: 'Haal shifts op voor een datumbereik.', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' }, team: { type: 'string' } }, required: ['start_date', 'end_date'] } },
    { name: 'get_employees', description: 'Haal alle medewerkers op.', inputSchema: { type: 'object', properties: { team: { type: 'string' }, active_only: { type: 'boolean' } } } },
    { name: 'get_availability', description: 'Haal beschikbaarheidsdata op.', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' }, employee_id: { type: 'number' } }, required: ['start_date', 'end_date'] } },
    { name: 'find_available_employees', description: 'Zoek medewerkers beschikbaar op een datum zonder shift.', inputSchema: { type: 'object', properties: { date: { type: 'string' }, team: { type: 'string' } }, required: ['date'] } },
    { name: 'get_staffing_overview', description: 'Bezettingsoverzicht op een datum.', inputSchema: { type: 'object', properties: { date: { type: 'string' }, team: { type: 'string' } }, required: ['date'] } },
    { name: 'create_shift', description: 'Maak een nieuwe shift aan.', inputSchema: { type: 'object', properties: { employee_id: { type: 'number' }, date: { type: 'string' }, start_time: { type: 'string' }, end_time: { type: 'string' }, team: { type: 'string' }, notes: { type: 'string' } }, required: ['employee_id', 'date', 'start_time', 'end_time', 'team'] } },
    { name: 'update_shift', description: 'Wijzig een bestaande shift.', inputSchema: { type: 'object', properties: { shift_id: { type: 'number' }, start_time: { type: 'string' }, end_time: { type: 'string' }, notes: { type: 'string' } }, required: ['shift_id'] } },
    { name: 'delete_shift', description: 'Verwijder een shift.', inputSchema: { type: 'object', properties: { shift_id: { type: 'number' }, reason: { type: 'string' } }, required: ['shift_id'] } },
    { name: 'get_swap_requests', description: 'Haal ruilverzoeken op.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, limit: { type: 'number' } } } },
    { name: 'get_schedule_drafts', description: 'Haal roosterconcepten op.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_hours_report', description: 'Uren rapport per medewerker.', inputSchema: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' }, team: { type: 'string' } }, required: ['start_date', 'end_date'] } },
    { name: 'query_database', description: 'Read-only SQL query op de database.', inputSchema: { type: 'object', properties: { sql: { type: 'string' }, limit: { type: 'number' } }, required: ['sql'] } },
    { name: 'get_audit_log', description: 'Haal audit log op.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, actor_id: { type: 'number' }, resource_type: { type: 'string' } } } },
    { name: 'get_api_health', description: 'Test API bereikbaarheid en login.', inputSchema: { type: 'object', properties: {} } }
];

async function handleTool(name, args) {
    switch (name) {
        case 'get_shifts': {
            const { ok, data } = await apiFetch(`/shifts?startDate=${args.start_date}&endDate=${args.end_date}`);
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let shifts = data.shifts || [];
            if (args.team) shifts = shifts.filter(s => s.team === args.team);
            if (shifts.length === 0) return 'Geen shifts gevonden.';
            return shifts.map(s => `ID ${s.id} | ${s.date} ${s.startTime}–${s.endTime} | Medewerker ID: ${s.userId} | Team: ${s.team}${s.notes ? ` | ${s.notes}` : ''}`).join('\n') + `\n\nTotaal: ${shifts.length}`;
        }
        case 'get_employees': {
            const { ok, data } = await apiFetch('/users');
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let employees = data.users || [];
            if (args.active_only !== false) employees = employees.filter(e => e.active !== false);
            if (args.team) employees = employees.filter(e => e.mainTeam === args.team || e.team === args.team);
            if (employees.length === 0) return 'Geen medewerkers gevonden.';
            return employees.map(e => `ID ${e.id} | ${e.name} | ${e.role} | Team: ${e.mainTeam || '—'} | ${e.contractHours || '?'}u/w`).join('\n') + `\n\nTotaal: ${employees.length}`;
        }
        case 'get_availability': {
            const { ok, data } = await apiFetch(`/availability?start=${args.start_date}&end=${args.end_date}`);
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let avail = data.availability || [];
            if (args.employee_id) avail = avail.filter(a => a.userId === args.employee_id);
            if (avail.length === 0) return 'Geen data gevonden.';
            return avail.map(a => `${a.date} | Medewerker ${a.userId} | ${a.type}${a.note ? ` | ${a.note}` : ''}`).join('\n');
        }
        case 'find_available_employees': {
            const [shiftsRes, availRes, usersRes] = await Promise.all([
                apiFetch(`/shifts?startDate=${args.date}&endDate=${args.date}`),
                apiFetch(`/availability?start=${args.date}&end=${args.date}`),
                apiFetch('/users')
            ]);
            if (!shiftsRes.ok || !usersRes.ok) return 'Fout bij ophalen data.';
            const scheduledIds = new Set((shiftsRes.data.shifts || []).map(s => s.userId));
            const absentIds = new Set((availRes.data.availability || []).filter(a => ['absent', 'sick', 'vacation'].includes(a.type)).map(a => a.userId));
            let employees = (usersRes.data.users || []).filter(e => e.active !== false);
            if (args.team) employees = employees.filter(e => e.mainTeam === args.team || e.team === args.team);
            const available = employees.filter(e => !scheduledIds.has(e.id) && !absentIds.has(e.id));
            if (available.length === 0) return `Geen beschikbare medewerkers op ${args.date}.`;
            return `Beschikbaar op ${args.date}:\n` + available.map(e => `  • ${e.name} (ID ${e.id}) — ${e.mainTeam || '—'}`).join('\n');
        }
        case 'get_staffing_overview': {
            const { ok, data } = await apiFetch(`/shifts?startDate=${args.date}&endDate=${args.date}`);
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let shifts = data.shifts || [];
            if (args.team) shifts = shifts.filter(s => s.team === args.team);
            if (shifts.length === 0) return `Geen shifts op ${args.date}.`;
            const byTeam = {};
            for (const s of shifts) { if (!byTeam[s.team]) byTeam[s.team] = []; byTeam[s.team].push(s); }
            const lines = [`Bezetting op ${args.date}:`];
            for (const [team, ts] of Object.entries(byTeam)) {
                lines.push(`\nTeam ${team} (${ts.length} shifts):`);
                for (const s of ts) lines.push(`  • Medewerker ${s.userId}: ${s.startTime}–${s.endTime}`);
            }
            return lines.join('\n');
        }
        case 'create_shift': {
            const { ok, data } = await apiFetch('/shifts', { method: 'POST', body: JSON.stringify({ userId: args.employee_id, date: args.date, startTime: args.start_time, endTime: args.end_time, team: args.team, notes: args.notes || '', source: 'manual' }) });
            if (!ok) return `Fout: ${data.error || JSON.stringify(data)}`;
            const s = data.shift || data;
            return `Shift aangemaakt: ID ${s.id} | ${s.date} ${s.startTime}–${s.endTime} | Medewerker ${s.userId}`;
        }
        case 'update_shift': {
            const current = await apiFetch(`/shifts?startDate=2020-01-01&endDate=2030-12-31`);
            const existing = (current.data.shifts || []).find(s => s.id === args.shift_id);
            if (!existing) return `Shift ID ${args.shift_id} niet gevonden.`;
            const { ok, data } = await apiFetch(`/shifts/${args.shift_id}`, { method: 'PUT', body: JSON.stringify({ userId: existing.userId, team: existing.team, date: existing.date, startTime: args.start_time || existing.startTime, endTime: args.end_time || existing.endTime, notes: args.notes !== undefined ? args.notes : existing.notes }) });
            if (!ok) return `Fout: ${data.error || JSON.stringify(data)}`;
            return `Shift ${args.shift_id} bijgewerkt.`;
        }
        case 'delete_shift': {
            const { ok, data } = await apiFetch(`/shifts/${args.shift_id}`, { method: 'DELETE' });
            if (!ok) return `Fout: ${data.error || JSON.stringify(data)}`;
            return `Shift ${args.shift_id} verwijderd.`;
        }
        case 'get_swap_requests': {
            const { ok, data } = await apiFetch('/swap-requests');
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let requests = data.requests || data.swapRequests || [];
            if (args.status) requests = requests.filter(r => r.status === args.status);
            requests = requests.slice(0, args.limit || 20);
            if (requests.length === 0) return 'Geen ruilverzoeken.';
            return requests.map(r => `ID ${r.id} | ${r.status} | ${r.requesterUserId} → ${r.targetUserId}`).join('\n');
        }
        case 'get_schedule_drafts': {
            const { ok, data } = await apiFetch('/schedule-drafts');
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            const drafts = data.drafts || [];
            if (drafts.length === 0) return 'Geen concepten.';
            return drafts.map(d => `ID ${d.id} | "${d.name}" | ${d.type} | Van: ${d.lastAppliedFrom || '—'} Tot: ${d.lastAppliedUntil || '—'}`).join('\n');
        }
        case 'get_hours_report': {
            const [shiftsRes, usersRes] = await Promise.all([apiFetch(`/shifts?startDate=${args.start_date}&endDate=${args.end_date}`), apiFetch('/users')]);
            if (!shiftsRes.ok || !usersRes.ok) return 'Fout bij ophalen data.';
            let employees = (usersRes.data.users || []).filter(e => e.active !== false);
            if (args.team) employees = employees.filter(e => e.mainTeam === args.team || e.team === args.team);
            const shifts = shiftsRes.data.shifts || [];
            function shiftHours(s) { const [sh, sm] = s.startTime.split(':').map(Number); const [eh, em] = s.endTime.split(':').map(Number); let start = sh * 60 + sm, end = eh * 60 + em; if (end <= start) end += 1440; return (end - start) / 60; }
            const lines = [`Uren rapport ${args.start_date} → ${args.end_date}:\n`, 'Medewerker                | Ingepland | Contract/w', '--------------------------|-----------|----------'];
            for (const emp of employees.sort((a, b) => a.name.localeCompare(b.name))) {
                const planned = shifts.filter(s => s.userId === emp.id).reduce((sum, s) => sum + shiftHours(s), 0);
                lines.push(`${emp.name.padEnd(25)} | ${(planned.toFixed(1) + 'u').padEnd(9)} | ${emp.contractHours || '?'}u/w`);
            }
            return lines.join('\n');
        }
        case 'query_database': {
            const db = getDb();
            if (!db) return 'DATABASE_URL niet ingesteld.';
            if (!/^SELECT\b/i.test(args.sql.trim())) return 'Alleen SELECT queries toegestaan.';
            const sql = /\bLIMIT\b/i.test(args.sql) ? args.sql : `${args.sql} LIMIT ${Math.min(args.limit || 50, 200)}`;
            try { return formatTable((await db.query(sql)).rows); }
            catch (err) { return `SQL fout: ${err.message}`; }
        }
        case 'get_audit_log': {
            const db = getDb();
            if (!db) return 'DATABASE_URL niet ingesteld.';
            let sql = 'SELECT created_at, actor_name, action, resource_type, resource_id FROM audit_log WHERE 1=1';
            const params = [];
            if (args.actor_id) { params.push(args.actor_id); sql += ` AND actor_id = $${params.length}`; }
            if (args.resource_type) { params.push(args.resource_type); sql += ` AND resource_type = $${params.length}`; }
            sql += ` ORDER BY created_at DESC LIMIT ${Math.min(args.limit || 20, 100)}`;
            try { return formatTable((await db.query(sql, params)).rows); }
            catch (err) { return `Fout: ${err.message}`; }
        }
        case 'get_api_health': {
            const lines = [`API_URL: ${API_URL}`];
            try { const r = await fetch(`${API_URL}/health`); lines.push(`Bereikbaar: ${r.status} ${r.ok ? '✓' : '✗'}`); } catch (e) { lines.push(`Bereikbaar: NEEN — ${e.message}`); }
            try { cachedToken = null; await getToken(); lines.push('Login: OK ✓'); } catch (e) { lines.push(`Login: MISLUKT — ${e.message}`); }
            try { const { ok, status, data } = await apiFetch('/users'); lines.push(`/users: ${status} ${ok ? `✓ (${(data.users || []).length} medewerkers)` : `✗ — ${JSON.stringify(data)}`}`); } catch (e) { lines.push(`/users: FOUT — ${e.message}`); }
            return lines.join('\n');
        }
        default: return `Onbekende tool: ${name}`;
    }
}

// ===== STDIO SERVER =====
const server = new Server(
    { name: 'uurroosterapp', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        const result = await handleTool(name, args || {});
        return { content: [{ type: 'text', text: String(result) }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `Fout: ${err.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
