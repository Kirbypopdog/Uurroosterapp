import 'dotenv/config';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
        body: JSON.stringify({
            email: process.env.ADMIN_EMAIL,
            password: process.env.ADMIN_PASSWORD
        })
    });

    if (!res.ok) throw new Error(`Login mislukt: ${res.status}`);
    const data = await res.json();
    cachedToken = data.token;
    tokenExpiry = Date.now() + 6 * 24 * 60 * 60 * 1000; // 6 dagen (JWT geldig 7)
    return cachedToken;
}

async function apiFetch(path, options = {}) {
    const token = await getToken();
    const res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...(options.headers || {})
        }
    });

    if (res.status === 401) {
        cachedToken = null;
        return apiFetch(path, options); // één retry na opnieuw inloggen
    }

    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ===== DB (debug tools) =====

let dbPool = null;
function getDb() {
    if (!dbPool && process.env.DATABASE_URL) {
        dbPool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
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

// ===== TOOL DEFINITIES =====

const TOOLS = [
    // --- Planning ---
    {
        name: 'get_shifts',
        description: 'Haal shifts op voor een datumbereik. Optioneel filteren op team.',
        inputSchema: {
            type: 'object',
            properties: {
                start_date: { type: 'string', description: 'Startdatum YYYY-MM-DD' },
                end_date: { type: 'string', description: 'Einddatum YYYY-MM-DD' },
                team: { type: 'string', description: 'Team naam (optioneel)' }
            },
            required: ['start_date', 'end_date']
        }
    },
    {
        name: 'get_employees',
        description: 'Haal alle medewerkers op. Optioneel filteren op team of enkel actieve medewerkers.',
        inputSchema: {
            type: 'object',
            properties: {
                team: { type: 'string', description: 'Team naam filter (optioneel)' },
                active_only: { type: 'boolean', description: 'Alleen actieve medewerkers (standaard true)' }
            }
        }
    },
    {
        name: 'get_availability',
        description: 'Haal beschikbaarheidsdata op voor een periode. Optioneel voor één medewerker.',
        inputSchema: {
            type: 'object',
            properties: {
                start_date: { type: 'string', description: 'Startdatum YYYY-MM-DD' },
                end_date: { type: 'string', description: 'Einddatum YYYY-MM-DD' },
                employee_id: { type: 'number', description: 'Medewerker ID (optioneel)' }
            },
            required: ['start_date', 'end_date']
        }
    },
    {
        name: 'find_available_employees',
        description: 'Zoek medewerkers die beschikbaar zijn op een datum maar nog geen shift hebben. Handig bij onderbezetting of ziekmelding.',
        inputSchema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Datum YYYY-MM-DD' },
                team: { type: 'string', description: 'Team filter (optioneel)' }
            },
            required: ['date']
        }
    },
    {
        name: 'get_staffing_overview',
        description: 'Overzicht van de bezetting op een datum: wie werkt er, hoeveel per uurblok, is er onderbezetting?',
        inputSchema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Datum YYYY-MM-DD' },
                team: { type: 'string', description: 'Team filter (optioneel)' }
            },
            required: ['date']
        }
    },
    {
        name: 'create_shift',
        description: 'Maak een nieuwe shift aan voor een medewerker.',
        inputSchema: {
            type: 'object',
            properties: {
                employee_id: { type: 'number', description: 'Medewerker ID' },
                date: { type: 'string', description: 'Datum YYYY-MM-DD' },
                start_time: { type: 'string', description: 'Starttijd HH:MM' },
                end_time: { type: 'string', description: 'Eindtijd HH:MM' },
                team: { type: 'string', description: 'Team naam' },
                notes: { type: 'string', description: 'Optionele notitie' }
            },
            required: ['employee_id', 'date', 'start_time', 'end_time', 'team']
        }
    },
    {
        name: 'update_shift',
        description: 'Wijzig een bestaande shift (tijden of notitie).',
        inputSchema: {
            type: 'object',
            properties: {
                shift_id: { type: 'number', description: 'Shift ID' },
                start_time: { type: 'string', description: 'Nieuwe starttijd HH:MM (optioneel)' },
                end_time: { type: 'string', description: 'Nieuwe eindtijd HH:MM (optioneel)' },
                notes: { type: 'string', description: 'Nieuwe notitie (optioneel)' }
            },
            required: ['shift_id']
        }
    },
    {
        name: 'delete_shift',
        description: 'Verwijder een shift. Gebruik met zorg.',
        inputSchema: {
            type: 'object',
            properties: {
                shift_id: { type: 'number', description: 'Shift ID' },
                reason: { type: 'string', description: 'Reden voor verwijdering (optioneel, voor context)' }
            },
            required: ['shift_id']
        }
    },
    {
        name: 'get_swap_requests',
        description: 'Haal ruilverzoeken op. Optioneel filteren op status.',
        inputSchema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Status filter (optioneel)' },
                limit: { type: 'number', description: 'Max aantal resultaten (standaard 20)' }
            }
        }
    },
    {
        name: 'get_schedule_drafts',
        description: 'Haal alle roosterconcepten op (basisrooster en vakantieconcepten).',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'get_hours_report',
        description: 'Rapport van ingeplande uren vs. contracturen per medewerker voor een periode.',
        inputSchema: {
            type: 'object',
            properties: {
                start_date: { type: 'string', description: 'Startdatum YYYY-MM-DD' },
                end_date: { type: 'string', description: 'Einddatum YYYY-MM-DD' },
                team: { type: 'string', description: 'Team filter (optioneel)' }
            },
            required: ['start_date', 'end_date']
        }
    },
    // --- Debug ---
    {
        name: 'query_database',
        description: 'Voer een read-only SQL query uit op de database. Alleen SELECT statements toegestaan. Handig voor debugging en data-inspectie.',
        inputSchema: {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'SQL SELECT query' },
                limit: { type: 'number', description: 'Max rijen (standaard 50)' }
            },
            required: ['sql']
        }
    },
    {
        name: 'get_audit_log',
        description: 'Haal recente audit log entries op. Optioneel filteren op medewerker of resource type.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Aantal entries (standaard 20)' },
                actor_id: { type: 'number', description: 'Filter op medewerker ID (optioneel)' },
                resource_type: { type: 'string', description: 'Filter op type: shift, user, availability, swap_request (optioneel)' }
            }
        }
    },
    {
        name: 'get_api_health',
        description: 'Controleer of de Uurroosterapp API bereikbaar is en retourneer de status.',
        inputSchema: { type: 'object', properties: {} }
    }
];

// ===== TOOL IMPLEMENTATIES =====

async function handleTool(name, args) {
    switch (name) {

        case 'get_shifts': {
            const qs = `?startDate=${args.start_date}&endDate=${args.end_date}`;
            const { ok, data } = await apiFetch(`/shifts${qs}`);
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let shifts = data.shifts || [];
            if (args.team) shifts = shifts.filter(s => s.team === args.team);
            if (shifts.length === 0) return 'Geen shifts gevonden voor dit bereik.';
            return shifts.map(s =>
                `ID ${s.id} | ${s.date} ${s.startTime}–${s.endTime} | Medewerker ID: ${s.userId} | Team: ${s.team}${s.notes ? ` | Notitie: ${s.notes}` : ''}`
            ).join('\n') + `\n\nTotaal: ${shifts.length} shifts`;
        }

        case 'get_employees': {
            const { ok, data } = await apiFetch('/users');
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let employees = data.users || [];
            const activeOnly = args.active_only !== false;
            if (activeOnly) employees = employees.filter(e => e.active !== false);
            if (args.team) employees = employees.filter(e => e.mainTeam === args.team || e.team === args.team);
            if (employees.length === 0) return 'Geen medewerkers gevonden.';
            return employees.map(e =>
                `ID ${e.id} | ${e.name} | ${e.role} | Team: ${e.mainTeam || e.team || '—'} | Contract: ${e.contractHours || '?'}u/week | Email: ${e.email || '—'}`
            ).join('\n') + `\n\nTotaal: ${employees.length} medewerkers`;
        }

        case 'get_availability': {
            const qs = `?start=${args.start_date}&end=${args.end_date}`;
            const { ok, data } = await apiFetch(`/availability${qs}`);
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let avail = data.availability || [];
            if (args.employee_id) avail = avail.filter(a => a.userId === args.employee_id);
            if (avail.length === 0) return 'Geen beschikbaarheidsdata gevonden.';
            return avail.map(a =>
                `${a.date} | Medewerker ID: ${a.userId} | Type: ${a.type}${a.note ? ` | Notitie: ${a.note}` : ''}`
            ).join('\n') + `\n\nTotaal: ${avail.length} entries`;
        }

        case 'find_available_employees': {
            const [shiftsRes, availRes, usersRes] = await Promise.all([
                apiFetch(`/shifts?startDate=${args.date}&endDate=${args.date}`),
                apiFetch(`/availability?start=${args.date}&end=${args.date}`),
                apiFetch('/users')
            ]);
            if (!shiftsRes.ok || !usersRes.ok) return 'Fout bij ophalen data.';

            const scheduledIds = new Set((shiftsRes.data.shifts || []).map(s => s.userId));
            const absentIds = new Set(
                (availRes.data.availability || [])
                    .filter(a => ['absent', 'sick', 'vacation'].includes(a.type))
                    .map(a => a.userId)
            );

            let employees = (usersRes.data.users || []).filter(e => e.active !== false);
            if (args.team) employees = employees.filter(e => e.mainTeam === args.team || e.team === args.team);

            const available = employees.filter(e => !scheduledIds.has(e.id) && !absentIds.has(e.id));

            if (available.length === 0) return `Geen beschikbare medewerkers gevonden op ${args.date}.`;
            return `Beschikbaar op ${args.date} (geen shift, niet afwezig):\n` +
                available.map(e => `  • ${e.name} (ID ${e.id}) — Team: ${e.mainTeam || '—'}, ${e.contractHours || '?'}u/week`).join('\n');
        }

        case 'get_staffing_overview': {
            const { ok, data } = await apiFetch(`/shifts?startDate=${args.date}&endDate=${args.date}`);
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let shifts = data.shifts || [];
            if (args.team) shifts = shifts.filter(s => s.team === args.team);

            if (shifts.length === 0) return `Geen shifts op ${args.date}.`;

            const byTeam = {};
            for (const s of shifts) {
                if (!byTeam[s.team]) byTeam[s.team] = [];
                byTeam[s.team].push(s);
            }

            const lines = [`Bezetting op ${args.date}:`];
            for (const [team, teamShifts] of Object.entries(byTeam)) {
                lines.push(`\nTeam ${team} (${teamShifts.length} shift${teamShifts.length !== 1 ? 's' : ''}):`);
                for (const s of teamShifts) {
                    lines.push(`  • Medewerker ${s.userId}: ${s.startTime}–${s.endTime}`);
                }
            }
            return lines.join('\n');
        }

        case 'create_shift': {
            const { ok, data } = await apiFetch('/shifts', {
                method: 'POST',
                body: JSON.stringify({
                    userId: args.employee_id,
                    date: args.date,
                    startTime: args.start_time,
                    endTime: args.end_time,
                    team: args.team,
                    notes: args.notes || '',
                    source: 'manual'
                })
            });
            if (!ok) return `Fout bij aanmaken shift: ${data.error || JSON.stringify(data)}`;
            const s = data.shift || data;
            return `Shift aangemaakt: ID ${s.id} | ${s.date} ${s.startTime}–${s.endTime} | Medewerker ${s.userId} | Team: ${s.team}`;
        }

        case 'update_shift': {
            const current = await apiFetch(`/shifts?startDate=2020-01-01&endDate=2030-12-31`);
            const existing = (current.data.shifts || []).find(s => s.id === args.shift_id);
            if (!existing) return `Shift ID ${args.shift_id} niet gevonden.`;

            const { ok, data } = await apiFetch(`/shifts/${args.shift_id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    userId: existing.userId,
                    team: existing.team,
                    date: existing.date,
                    startTime: args.start_time || existing.startTime,
                    endTime: args.end_time || existing.endTime,
                    notes: args.notes !== undefined ? args.notes : existing.notes
                })
            });
            if (!ok) return `Fout bij updaten shift: ${data.error || JSON.stringify(data)}`;
            return `Shift ${args.shift_id} bijgewerkt.`;
        }

        case 'delete_shift': {
            const { ok, data } = await apiFetch(`/shifts/${args.shift_id}`, { method: 'DELETE' });
            if (!ok) return `Fout bij verwijderen shift: ${data.error || JSON.stringify(data)}`;
            return `Shift ${args.shift_id} verwijderd.${args.reason ? ` Reden: ${args.reason}` : ''}`;
        }

        case 'get_swap_requests': {
            const { ok, data } = await apiFetch('/swap-requests');
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            let requests = data.requests || data.swapRequests || [];
            if (args.status) requests = requests.filter(r => r.status === args.status);
            const limit = args.limit || 20;
            requests = requests.slice(0, limit);
            if (requests.length === 0) return 'Geen ruilverzoeken gevonden.';
            return requests.map(r =>
                `ID ${r.id} | Status: ${r.status} | Aanvrager: ${r.requesterUserId} → ${r.targetUserId} | ${r.createdAt?.substring(0, 10) || '?'}`
            ).join('\n') + `\n\nTotaal getoond: ${requests.length}`;
        }

        case 'get_schedule_drafts': {
            const { ok, data } = await apiFetch('/schedule-drafts');
            if (!ok) return `Fout: ${JSON.stringify(data)}`;
            const drafts = data.drafts || [];
            if (drafts.length === 0) return 'Geen concepten gevonden.';
            return drafts.map(d =>
                `ID ${d.id} | "${d.name}" | Type: ${d.type} | Actief: ${d.isActive ? 'ja' : 'nee'} | Van: ${d.lastAppliedFrom || '—'} Tot: ${d.lastAppliedUntil || '—'}`
            ).join('\n');
        }

        case 'get_hours_report': {
            const [shiftsRes, usersRes] = await Promise.all([
                apiFetch(`/shifts?startDate=${args.start_date}&endDate=${args.end_date}`),
                apiFetch('/users')
            ]);
            if (!shiftsRes.ok || !usersRes.ok) return 'Fout bij ophalen data.';

            let employees = (usersRes.data.users || []).filter(e => e.active !== false);
            if (args.team) employees = employees.filter(e => e.mainTeam === args.team || e.team === args.team);

            let shifts = shiftsRes.data.shifts || [];

            function shiftHours(s) {
                const [sh, sm] = s.startTime.split(':').map(Number);
                const [eh, em] = s.endTime.split(':').map(Number);
                let start = sh * 60 + sm, end = eh * 60 + em;
                if (end <= start) end += 24 * 60;
                return (end - start) / 60;
            }

            const lines = [`Uren rapport ${args.start_date} → ${args.end_date}:\n`];
            lines.push('Medewerker                | Ingepland | Contract/w | Verschil');
            lines.push('--------------------------|-----------|------------|--------');

            for (const emp of employees.sort((a, b) => a.name.localeCompare(b.name))) {
                const empShifts = shifts.filter(s => s.userId === emp.id);
                const planned = empShifts.reduce((sum, s) => sum + shiftHours(s), 0);
                const contract = emp.contractHours || 0;
                const diff = planned - contract;
                const sign = diff >= 0 ? '+' : '';
                lines.push(
                    `${emp.name.padEnd(25)} | ${String(planned.toFixed(1) + 'u').padEnd(9)} | ${String((contract + 'u/w')).padEnd(10)} | ${sign}${diff.toFixed(1)}u`
                );
            }

            return lines.join('\n');
        }

        // --- Debug tools ---

        case 'query_database': {
            const db = getDb();
            if (!db) return 'DATABASE_URL niet geconfigureerd in .env';
            const sql = args.sql.trim();
            if (!/^SELECT\b/i.test(sql)) return 'Alleen SELECT queries zijn toegestaan.';
            const limit = Math.min(args.limit || 50, 200);
            const limitedSql = /\bLIMIT\b/i.test(sql) ? sql : `${sql} LIMIT ${limit}`;
            try {
                const result = await db.query(limitedSql);
                return formatTable(result.rows);
            } catch (err) {
                return `SQL fout: ${err.message}`;
            }
        }

        case 'get_audit_log': {
            const db = getDb();
            if (!db) return 'DATABASE_URL niet geconfigureerd in .env';
            const limit = Math.min(args.limit || 20, 100);
            let sql = 'SELECT created_at, actor_name, action, resource_type, resource_id, details FROM audit_log WHERE 1=1';
            const params = [];
            if (args.actor_id) { params.push(args.actor_id); sql += ` AND actor_id = $${params.length}`; }
            if (args.resource_type) { params.push(args.resource_type); sql += ` AND resource_type = $${params.length}`; }
            sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
            try {
                const result = await db.query(sql, params);
                return formatTable(result.rows);
            } catch (err) {
                return `Fout: ${err.message}`;
            }
        }

        case 'get_api_health': {
            try {
                const start = Date.now();
                const res = await fetch(`${API_URL.replace('/api/v1', '')}/api/v1/health`);
                const ms = Date.now() - start;
                const data = await res.json().catch(() => ({}));
                return `API status: ${res.status} ${res.ok ? '✓' : '✗'} | Reactietijd: ${ms}ms | ${JSON.stringify(data)}`;
            } catch (err) {
                return `API niet bereikbaar: ${err.message}`;
            }
        }

        default:
            return `Onbekende tool: ${name}`;
    }
}

// ===== SERVER FACTORY =====

function createMcpServer() {
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

    return server;
}

// ===== EXPRESS / STREAMABLE HTTP =====

const app = express();
app.use(express.json());

const MCP_API_KEY = process.env.MCP_API_KEY;

function checkAuth(req, res, next) {
    if (!MCP_API_KEY) return next();
    const auth = req.headers['authorization'] || req.query.api_key;
    if (auth === `Bearer ${MCP_API_KEY}` || auth === MCP_API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// Streamable HTTP: alle MCP-communicatie via één /mcp endpoint
app.all('/mcp', checkAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
    });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'uurroosterapp-mcp' }));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Uurroosterapp MCP server draait op poort ${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    if (!MCP_API_KEY) console.warn('Waarschuwing: MCP_API_KEY niet ingesteld — endpoint is openbaar');
});
