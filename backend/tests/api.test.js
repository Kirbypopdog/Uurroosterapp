'use strict';

// Mock DB and env vars before any module is loaded
jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn()
  }
}));

process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.DEFAULT_RESET_PASSWORD = 'test-reset-password';
process.env.DATABASE_URL = 'postgresql://localhost/test_db';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { pool } = require('../src/db');

let app;
beforeAll(() => {
  // Suppress console output during server startup
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  // Mock pool.connect used by ensureSchema()
  pool.connect.mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  });

  app = require('../src/server');
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Reset pool.query mock before each test so mock values don't bleed between tests.
// Default: return empty result set (safe no-op for most queries).
beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// Helper: create a signed JWT for a given user payload
function makeToken(payload) {
  return jwt.sign(payload, 'test-secret-key-for-unit-tests');
}

// Helper: mock the requireAuth active-check query (first pool.query call for authenticated endpoints)
function mockActiveUser() {
  pool.query.mockResolvedValueOnce({ rows: [{ active: true }] });
}

// Helper: datum in de toekomst (YYYY-MM-DD). Gebruik dit i.p.v. hardgecodeerde datums
// voor tests die afhangen van "vandaag" (bv. swap-requests weigeren shifts in het verleden),
// zodat ze niet verouderen wanneer de echte kalender voorbij een vaste datum kruipt.

// Helper: PUT /leave-rounds/:id/entries gebruikt pool.connect() i.p.v. pool.query,
// dus de ronde-lookup moet op de CLIENT gemockt worden.
function mockLeaveRoundClient(round) {
  const client = {
    query: jest.fn().mockImplementation((sql) => {
      if (/FROM leave_rounds/i.test(sql)) return Promise.resolve({ rows: round ? [round] : [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: jest.fn()
  };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

function futureDate(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// ===== GET /health =====

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeTruthy();
  });
});

// ===== requireAuth middleware =====

describe('requireAuth middleware', () => {
  test('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing token');
  });

  test('returns 401 for a malformed Bearer token', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('returns 401 for a token signed with the wrong secret', async () => {
    const badToken = jwt.sign({ id: 1, role: 'admin' }, 'wrong-secret');
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${badToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('returns 401 for an expired token', async () => {
    const expiredToken = jwt.sign(
      { id: 1, role: 'admin', name: 'Test' },
      'test-secret-key-for-unit-tests',
      { expiresIn: '-1s' }
    );
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  test('returns 401 when user account is deactivated', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ active: false }] });
    const token = makeToken({ id: 99, role: 'medewerker', name: 'Inactive User', team_id: 'team1' });
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Account is gedeactiveerd');
  });

  test('returns 401 when user is not found in active check', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // no row returned
    const token = makeToken({ id: 999, role: 'medewerker', name: 'Ghost', team_id: 'team1' });
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Account is gedeactiveerd');
  });
});

// ===== requireAdmin middleware =====

describe('requireAdmin middleware', () => {
  test('returns 403 when authenticated user is not an admin', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'Regular User', team_id: 'team1' });
    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  test('returns 403 when role is roosterverantwoordelijke', async () => {
    mockActiveUser();
    const token = makeToken({ id: 3, role: 'roosterverantwoordelijke', name: 'Lead', team_id: 'team1' });
    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('allows admin to access admin endpoints', async () => {
    mockActiveUser();
    // /admin/users returns 200 with empty rows
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin User', team_id: null });
    const res = await request(app)
      .get('/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });
});

// ===== POST /auth/login =====

describe('POST /auth/login', () => {
  test('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ password: 'secret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing fields');
  });

  test('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing fields');
  });

  test('returns 400 when both fields are missing', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 401 when user does not exist', async () => {
    // Login queries DB once (new schema); default mock returns { rows: [] }
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'pass' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('returns 401 when password is incorrect', async () => {
    const hash = await bcrypt.hash('correct-password', 12);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, name: 'Jan', email: 'jan@example.com',
        password_hash: hash, role: 'medewerker', team_id: 'team1',
        active: true
      }]
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'jan@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('returns 403 when account is deactivated despite correct password', async () => {
    const hash = await bcrypt.hash('correct-password', 12);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, name: 'Jan', email: 'jan@example.com',
        password_hash: hash, role: 'medewerker', team_id: 'team1',
        active: false
      }]
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'jan@example.com', password: 'correct-password' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Account is gedeactiveerd');
    expect(res.body.token).toBeUndefined();
  });

  test('returns 200 with token and user on valid credentials', async () => {
    const hash = await bcrypt.hash('correct-password', 12);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, name: 'Jan', email: 'jan@example.com',
        password_hash: hash, role: 'medewerker', team_id: 'team1',
        active: true, mainTeam: 'team1', extraTeams: [], contractHours: 36,
        weekScheduleWeek1: [], weekScheduleWeek2: [], weekSchedules: []
      }]
    });
    // logAudit also calls pool.query — default mock handles it

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'JAN@EXAMPLE.COM', password: 'correct-password' }); // uppercase email
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.password_hash).toBeUndefined(); // must not expose hash
    expect(res.body.user.email).toBe('jan@example.com');
  });

  test('normalises email to lowercase before lookup', async () => {
    const hash = await bcrypt.hash('pw', 12);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 2, name: 'Anna', email: 'anna@example.com',
        password_hash: hash, role: 'medewerker', team_id: 'team1', active: true
      }]
    });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'ANNA@EXAMPLE.COM', password: 'pw' });
    expect(res.status).toBe(200);
  });
});

// ===== POST /auth/register =====

describe('POST /auth/register', () => {
  function adminToken() {
    return makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
  }

  test('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ name: 'Test', email: 'test@test.com', password: 'pass' });
    expect(res.status).toBe(401);
  });

  test('returns 403 for non-admin user', async () => {
    mockActiveUser();
    const token = makeToken({ id: 2, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .post('/auth/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New', email: 'new@test.com', password: 'pass' });
    expect(res.status).toBe(403);
  });

  test('returns 400 when fields are missing', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/auth/register')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Test' }); // missing email & password
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing fields');
  });

  test('returns 409 when email already exists', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // existing user check
    const res = await request(app)
      .post('/auth/register')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Dup', email: 'dup@example.com', password: 'pass123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Email already exists');
  });
});

// ===== GET /teams =====

describe('GET /teams', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/teams');
    expect(res.status).toBe(401);
  });

  test('returns teams list when authenticated', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 'vlot1', name: 'Vlot 1', color: '#3b82f6' },
        { id: 'vlot2', name: 'Vlot 2', color: '#8b5cf6' }
      ]
    });
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .get('/teams')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.teams)).toBe(true);
    expect(res.body.teams).toHaveLength(2);
    expect(res.body.teams[0].id).toBe('vlot1');
  });
});

// ===== GET /shifts =====

describe('GET /shifts', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/shifts');
    expect(res.status).toBe(401);
  });

  test('returns shifts array when authenticated', async () => {
    mockActiveUser();
    // shifts query returns empty
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .get('/shifts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.shifts)).toBe(true);
  });

  test('returns shifts filtered by date range', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, userId: 5, employeeId: 5, team: 'vlot1',
        date: '2026-04-15', startTime: '08:00', endTime: '16:00',
        notes: '', source: 'manual'
      }]
    });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .get('/shifts?startDate=2026-04-15&endDate=2026-04-15')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(1);
  });
});

// ===== POST /teams (role restriction) =====

describe('POST /teams', () => {
  test('returns 403 for medewerker role', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'Medewerker', team_id: 'team1' });
    const res = await request(app)
      .post('/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'new_team', name: 'New Team', color: '#ff0000' });
    expect(res.status).toBe(403);
  });

  test('returns 400 for missing required fields', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Incomplete' }); // missing id and color
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid team ID format', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'Invalid Team ID!', name: 'Test', color: '#000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Team ID');
  });
});

// ===== PUT /me/email-preferences =====

describe('PUT /me/email-preferences', () => {
  test('returns 400 when emailNotificationsEnabled is not boolean', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .put('/me/email-preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ emailNotificationsEnabled: 'yes' }); // string, not boolean
    expect(res.status).toBe(400);
  });

  test('succeeds with valid boolean value (false)', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ emailNotificationsEnabled: false }] });
    // logAudit will use the default mock
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .put('/me/email-preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ emailNotificationsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.emailNotificationsEnabled).toBe(false);
  });

  test('succeeds with valid boolean value (true)', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ emailNotificationsEnabled: true }] });
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .put('/me/email-preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ emailNotificationsEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.emailNotificationsEnabled).toBe(true);
  });
});

// ===== POST /shifts =====

describe('POST /shifts', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/shifts')
      .send({ userId: 1, date: '2026-04-15', startTime: '09:00', endTime: '17:00' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when required fields are missing', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 1, date: '2026-04-15' }); // missing startTime and endTime
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Verplichte velden');
  });

  test('returns 403 when medewerker tries to create shift for another user', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 99, date: '2026-04-15', startTime: '09:00', endTime: '17:00' });
    expect(res.status).toBe(403);
  });

  test('allows medewerker to create their own shift', async () => {
    mockActiveUser();
    const newShift = { id: 10, userId: 5, employeeId: 5, team: null, date: '2026-04-15', startTime: '09:00', endTime: '17:00', notes: '', source: 'manual' };
    pool.query
      .mockResolvedValueOnce({ rows: [] })         // closedDates check
      .mockResolvedValueOnce({ rows: [] })         // validateShiftRules: geen conflicten
      .mockResolvedValueOnce({ rows: [newShift] }) // INSERT
      .mockResolvedValueOnce({ rows: [] })         // DELETE shift_blocks
      .mockResolvedValueOnce({ rows: [] });         // logAudit
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 5, date: '2026-04-15', startTime: '09:00', endTime: '17:00' });
    expect(res.status).toBe(201);
    expect(res.body.shift).toBeTruthy();
    expect(res.body.shift.source).toBe('manual');
  });

  test('returns 422 when new shift overlaps an existing shift', async () => {
    mockActiveUser();
    const conflictShift = { id: 1, date: '2026-04-15', start_time: '08:00', end_time: '14:00' };
    pool.query
      .mockResolvedValueOnce({ rows: [] })               // closedDates check
      .mockResolvedValueOnce({ rows: [conflictShift] }); // validateShiftRules: overlap
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 5, date: '2026-04-15', startTime: '10:00', endTime: '17:00' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Overlap');
  });

  test('returns 422 when 11-hour rest rule is violated', async () => {
    mockActiveUser();
    // Shift eindigde om 22:00 de dag ervoor → slechts 9u rust voor 07:00 shift
    const prevShift = { id: 2, date: '2026-04-14', start_time: '14:00', end_time: '22:00' };
    pool.query
      .mockResolvedValueOnce({ rows: [] })              // closedDates check
      .mockResolvedValueOnce({ rows: [prevShift] });    // validateShiftRules: te weinig rust
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 5, date: '2026-04-15', startTime: '07:00', endTime: '15:00' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('11-uur');
  });

  test('returns 400 when startTime has invalid format', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 1, date: '2026-04-15', startTime: '9:00', endTime: '17:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HH:MM');
  });

  test('returns 400 when endTime has invalid format', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 1, date: '2026-04-15', startTime: '09:00', endTime: '17.00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HH:MM');
  });
});

// ===== PUT /shifts/:id =====

describe('PUT /shifts/:id', () => {
  test('returns 400 when startTime has invalid format', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .put('/shifts/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ startTime: '9:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HH:MM');
  });

  test('returns 400 when endTime has invalid format', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .put('/shifts/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ endTime: '1700' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HH:MM');
  });

  test('allows PUT without time fields (partial update)', async () => {
    mockActiveUser();
    const shift = { id: 1, userId: 1, employeeId: 1, team: null, date: '2026-04-15', startTime: '09:00', endTime: '17:00', notes: 'updated', source: 'manual', isReserve: false };
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 1 }] })                // medewerker permission check
      .mockResolvedValueOnce({ rows: [shift] })                          // fetch old shift
      .mockResolvedValueOnce({ rows: [shift] })                          // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] });                               // logAudit
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .put('/shifts/1')
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.shift).toBeTruthy();
  });

  // Regressie #262: het teamveld bleef bewerkbaar voor de eigenaar van de
  // dienst en de UPDATE liet team en user_id ongecontroleerd door. Een
  // medewerker kon zich zo in een ander team schrijven of zijn dienst aan
  // een collega toewijzen.
  const eigenDienst = {
    id: 20, userId: 6, employeeId: 6, team: 'vlot1', date: '2026-12-09',
    startTime: '14:00', endTime: '22:00', notes: '', source: 'manual', isReserve: false
  };

  test('medewerker cannot change the team of their own shift (#262)', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 6 }] })   // eigenaarscontrole
      .mockResolvedValueOnce({ rows: [eigenDienst] });     // oude dienst ophalen
    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .put('/shifts/20')
      .set('Authorization', `Bearer ${token}`)
      .send({ team: 'cargo' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/team van een dienst niet wijzigen/i);
  });

  test('medewerker cannot reassign their own shift to a colleague (#262)', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 6 }] })
      .mockResolvedValueOnce({ rows: [eigenDienst] });
    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .put('/shifts/20')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 8 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Dienst afstaan/i);
  });

  // Keerzijde: de eigen tijden aanpassen blijft toegestaan. Dat is een
  // bewuste keuze en staat zo in de rollentabel.
  test('medewerker can still edit the times of their own shift (#262)', async () => {
    mockActiveUser();
    const bijgewerkt = { ...eigenDienst, startTime: '15:00', endTime: '23:00' };
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 6 }] })   // eigenaarscontrole
      .mockResolvedValueOnce({ rows: [eigenDienst] })      // oude dienst ophalen
      .mockResolvedValueOnce({ rows: [] })                 // validateShiftRules: buurdiensten
      .mockResolvedValueOnce({ rows: [bijgewerkt] })       // UPDATE RETURNING
      .mockResolvedValue({ rows: [] });                    // logAudit
    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .put('/shifts/20')
      .set('Authorization', `Bearer ${token}`)
      .send({ startTime: '15:00', endTime: '23:00' });
    expect(res.status).toBe(200);
  });
});

// ===== DELETE /shifts/:id =====

describe('DELETE /shifts/:id', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).delete('/api/v1/shifts/1');
    expect(res.status).toBe(401);
  });

  // Regressie #146 (lek 2): een manuele verwijdering moet een shift_block
  // aanmaken zodat een concept de dag niet opnieuw vult.
  test('creates a shift_block on manual delete (#146)', async () => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] }); // requireAuth
    pool.query.mockResolvedValue({ rows: [] });                     // logAudit

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                                                   // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 50, user_id: 9, team: 'vlot1', source: 'manual', date: '2026-06-15' }] }) // SELECT shift
      .mockResolvedValueOnce({ rows: [] })                                                                   // DELETE shift
      .mockResolvedValueOnce({ rows: [] })                                                                   // INSERT shift_block
      .mockResolvedValueOnce({ rows: [] });                                                                  // COMMIT

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .delete('/api/v1/shifts/50')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const blockInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO shift_blocks')
    );
    expect(blockInsert).toBeTruthy();
    expect(blockInsert[1]).toEqual([9, '2026-06-15', 1]); // user_id, date, created_by
  });

  // Regressie #146: systeemopkuis (skipBlock=true) mag GEEN block aanmaken.
  test('skips block creation when skipBlock=true (#146)', async () => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] });
    pool.query.mockResolvedValue({ rows: [] });

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                                                   // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 51, user_id: 9, team: 'vlot1', source: 'auto', date: '2026-06-15' }] }) // SELECT shift
      .mockResolvedValueOnce({ rows: [] })                                                                   // DELETE shift
      .mockResolvedValueOnce({ rows: [] });                                                                  // COMMIT

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .delete('/api/v1/shifts/51?skipBlock=true')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const blockInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO shift_blocks')
    );
    expect(blockInsert).toBeUndefined();
  });

  // Regressie #184: de rolcontrole werd overgeslagen zodra source='auto',
  // waardoor elke medewerker de auto-dienst van eender welke collega kon
  // verwijderen — en er bleef een shift_block achter dat de dag permanent
  // leeg hield.
  test('medewerker cannot delete an auto shift of a colleague (#184)', async () => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] });
    pool.query.mockResolvedValue({ rows: [] });

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                                                    // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 52, user_id: 8, team: 'cargo', source: 'auto', date: '2026-09-17' }] }) // SELECT shift (van iemand anders)
      .mockResolvedValueOnce({ rows: [] });                                                                   // ROLLBACK

    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .delete('/api/v1/shifts/52')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/eigen diensten/i);
    // De dienst mag niet verwijderd zijn en er mag geen blokkade achterblijven
    const del = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('DELETE FROM shifts')
    );
    expect(del).toBeUndefined();
    const blockInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO shift_blocks')
    );
    expect(blockInsert).toBeUndefined();
  });

  // Keerzijde van #184: zijn eigen dienst mag een medewerker wel verwijderen.
  // Dat is een bewuste keuze (rollentabel in CLAUDE.md) en moet blijven werken.
  test('medewerker can still delete their own auto shift (#184)', async () => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] });
    pool.query.mockResolvedValue({ rows: [] });

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                                                    // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 53, user_id: 6, team: 'vlot1', source: 'auto', date: '2026-09-17' }] }) // SELECT shift (eigen)
      .mockResolvedValueOnce({ rows: [] })                                                                    // DELETE shift
      .mockResolvedValueOnce({ rows: [] })                                                                    // INSERT shift_block
      .mockResolvedValueOnce({ rows: [] });                                                                   // COMMIT

    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .delete('/api/v1/shifts/53')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const del = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('DELETE FROM shifts')
    );
    expect(del).toBeTruthy();
  });
});

// ===== GET /availability =====

describe('GET /availability', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/availability');
    expect(res.status).toBe(401);
  });

  test('returns availability array when authenticated', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .get('/availability')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.availability)).toBe(true);
  });
});

// ===== GET /swap-requests =====

describe('GET /swap-requests', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/swap-requests');
    expect(res.status).toBe(401);
  });

  test('returns swap-requests when authenticated', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .get('/swap-requests')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.swapRequests)).toBe(true);
  });
});

// ===== GET /settings =====

describe('GET /settings', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/settings');
    expect(res.status).toBe(401);
  });

  test('returns settings for medewerker role', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .get('/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.settings).toBeTruthy();
  });

  test('returns settings for admin', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .get('/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.settings).toBeTruthy();
  });
});

// ===== GET /shift-activities =====

describe('GET /shift-activities', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/shift-activities');
    expect(res.status).toBe(401);
  });

  test('returns activities array when authenticated', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .get('/shift-activities')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.activities)).toBe(true);
  });

  test('returns activities filtered by date range', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, userId: 5, shiftId: 10, date: '2026-05-01', startTime: '09:00', endTime: '10:00', type: 'vergadering', description: 'Teamoverleg' }]
    });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .get('/shift-activities?startDate=2026-05-01&endDate=2026-05-07')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.activities).toHaveLength(1);
    expect(res.body.activities[0].type).toBe('vergadering');
  });
});

// ===== POST /shift-activities =====

describe('POST /shift-activities', () => {
  test('returns 400 when required fields are missing', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/shift-activities')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 1, date: '2026-05-01' }); // missing startTime, endTime, type
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Verplichte velden');
  });

  test('returns 403 when medewerker creates activity for another user', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/shift-activities')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 99, date: '2026-05-01', startTime: '09:00', endTime: '10:00', type: 'vergadering' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('jezelf');
  });

  test('creates activity for own user (medewerker)', async () => {
    mockActiveUser();
    const newActivity = { id: 1, userId: 5, shiftId: null, date: '2026-05-01', startTime: '09:00', endTime: '10:00', type: 'vergadering', description: '' };
    pool.query
      .mockResolvedValueOnce({ rows: [newActivity] }) // INSERT
      .mockResolvedValueOnce({ rows: [] });            // logAudit
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/shift-activities')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 5, date: '2026-05-01', startTime: '09:00', endTime: '10:00', type: 'vergadering' });
    expect(res.status).toBe(201);
    expect(res.body.activity).toBeTruthy();
    expect(res.body.activity.type).toBe('vergadering');
  });

  test('admin can create activity for any user', async () => {
    mockActiveUser();
    const newActivity = { id: 2, userId: 10, shiftId: 5, date: '2026-05-02', startTime: '10:00', endTime: '11:00', type: 'opleiding', description: 'Training' };
    pool.query
      .mockResolvedValueOnce({ rows: [newActivity] })
      .mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/shift-activities')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 10, shiftId: 5, date: '2026-05-02', startTime: '10:00', endTime: '11:00', type: 'opleiding', description: 'Training' });
    expect(res.status).toBe(201);
    expect(res.body.activity.userId).toBe(10);
  });
});

// ===== DELETE /shift-activities/:id =====

describe('DELETE /shift-activities/:id', () => {
  test('returns 403 when medewerker deletes another user\'s activity', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ user_id: 99 }] }); // ownership check
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .delete('/shift-activities/42')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('returns 404 when activity does not exist', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [] })  // ownership check: no row → allow admin path
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE returns nothing
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .delete('/shift-activities/999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('deletes own activity (medewerker)', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 5 }] })  // ownership check
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })        // DELETE RETURNING
      .mockResolvedValueOnce({ rows: [] });                  // logAudit
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .delete('/shift-activities/7')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ===== POST /availability =====

describe('POST /availability', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/api/v1/availability')
      .send({ userId: 1, date: '2026-05-01', type: 'beschikbaar' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when required fields are missing', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 1, date: '2026-05-01' }); // missing type
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Verplichte velden');
  });

  test('returns 403 when medewerker sets availability for another user', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 99, date: '2026-05-01', type: 'beschikbaar' });
    expect(res.status).toBe(403);
  });

  test('upserts availability for own user (201)', async () => {
    mockActiveUser();
    const avail = { id: 1, userId: 5, date: '2026-05-01', type: 'beschikbaar', reason: '', updatedAt: new Date().toISOString() };
    pool.query
      .mockResolvedValueOnce({ rows: [avail] }) // INSERT ON CONFLICT
      .mockResolvedValueOnce({ rows: [] });      // logAudit
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 5, date: '2026-05-01', type: 'beschikbaar' });
    expect(res.status).toBe(201);
    expect(res.body.availability.type).toBe('beschikbaar');
  });
});

// ===== DELETE /availability =====

describe('DELETE /availability', () => {
  test('returns 403 when medewerker deletes another user\'s availability', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .delete('/availability?userId=99&date=2026-05-01')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('deletes own availability (medewerker)', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [] }); // logAudit
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .delete('/availability?userId=5&date=2026-05-01')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ===== POST /swap-requests =====

describe('POST /swap-requests', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/v1/swap-requests').send({});
    expect(res.status).toBe(401);
  });

  test('returns 400 when required fields are missing', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/swap-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requesterShiftId: 1 }); // missing targetShiftId
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('verplicht');
  });

  test('returns 404 when one of the shifts is not found', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 5, date: '2026-06-01' }] }); // only 1 of 2 shifts
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/swap-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requesterShiftId: 1, targetShiftId: 999 });
    expect(res.status).toBe(404);
  });

  test('returns 403 when requester does not own the requester shift', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, user_id: 99, date: '2026-06-01' }, // belongs to user 99, not user 5
        { id: 2, user_id: 10, date: '2026-06-02' }
      ]
    });
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/swap-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requesterShiftId: 1, targetShiftId: 2 });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('eigen shifts');
  });

  test('returns 400 when trying to swap with yourself', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, user_id: 5, date: '2026-06-01' },
        { id: 2, user_id: 5, date: '2026-06-02' } // same user
      ]
    });
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/swap-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requesterShiftId: 1, targetShiftId: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('jezelf');
  });

  test('creates swap request successfully', async () => {
    mockActiveUser();
    const swapRow = { id: 10, requester_user_id: 5, target_user_id: 20, requester_shift_id: 1, target_shift_id: 2, status: 'pending', message: null };
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 5, date: futureDate(7) }, { id: 2, user_id: 20, date: futureDate(8) }] }) // shifts check
      .mockResolvedValueOnce({ rows: [swapRow] })  // INSERT
      .mockResolvedValueOnce({ rows: [] });          // logAudit
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/swap-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requesterShiftId: 1, targetShiftId: 2 });
    expect(res.status).toBe(201);
    expect(res.body.swapRequest.status).toBe('pending');
  });
});

// ===== PUT /shift-requests/:id/takeover-accept =====

describe('PUT /shift-requests/:id/takeover-accept', () => {
  // Basis voor een geldig, openstaand overnameverzoek van gebruiker 4 op
  // dienst 135. Per test passen we alleen aan wat ertoe doet.
  const baseRequest = {
    id: 7,
    request_type: 'takeover',
    status: 'pending',
    requester_user_id: 4,
    requester_shift_id: 135,
    current_shift_owner: 4,
    date: '2099-01-15',
    start_time: '07:00',
    end_time: '15:00',
    team: 'vlot1'
  };

  function arrange(requestRow) {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] }); // requireAuth
    pool.query.mockResolvedValue({ rows: [] });                     // logAudit, mail
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })              // BEGIN
      .mockResolvedValueOnce({ rows: [requestRow] })    // SELECT verzoek + dienst
      .mockResolvedValue({ rows: [] });                 // al de rest
    return mockClient;
  }

  // Regressie #188: current_shift_owner werd geselecteerd maar nooit gebruikt.
  // Een oud verzoek kon daardoor de dienst afpakken van wie hem intussen had.
  test('rejects a takeover when the shift was reassigned in the meantime (#188)', async () => {
    // De dienst staat nu op gebruiker 8, niet meer op de aanvrager (4)
    const mockClient = arrange({ ...baseRequest, current_shift_owner: 8 });

    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .put('/api/v1/shift-requests/7/takeover-accept')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inmiddels aan iemand anders toegewezen/i);
    // De dienst mag niet zijn overgezet
    const assign = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE shifts SET user_id')
    );
    expect(assign).toBeUndefined();
    // Het verzoek gaat naar een eindstatus, zodat het niet eeuwig onder
    // 'Actie vereist' blijft staan en bij elke klik dezelfde fout geeft (#316)
    const expire = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes("status = 'expired'")
    );
    expect(expire).toBeTruthy();
  });

  // Keerzijde: een verzoek waarvan de dienst nog gewoon bij de aanvrager
  // staat, moet blijven werken.
  test('accepts a takeover when the shift is still with the requester (#188)', async () => {
    const mockClient = arrange({ ...baseRequest });

    const token = makeToken({ id: 6, role: 'medewerker', name: 'Bram', team_id: 'vlot1' });
    const res = await request(app)
      .put('/api/v1/shift-requests/7/takeover-accept')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    const assign = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE shifts SET user_id')
    );
    expect(assign).toBeTruthy();
    expect(assign[1]).toEqual([6, 135]); // dienst 135 gaat naar gebruiker 6
  });
});

// ===== GET /schedule-drafts =====

describe('GET /schedule-drafts', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/schedule-drafts');
    expect(res.status).toBe(401);
  });

  test('returns 403 for medewerker role', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .get('/schedule-drafts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('returns drafts array for admin', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'draft_1', name: 'Basisrooster', type: 'basis', weekNumber: 1 }]
    });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .get('/schedule-drafts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.drafts)).toBe(true);
    expect(res.body.drafts).toHaveLength(1);
  });

  test('returns drafts for roosterverantwoordelijke role', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 3, role: 'roosterverantwoordelijke', name: 'Lead', team_id: 'vlot1' });
    const res = await request(app)
      .get('/schedule-drafts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ===== POST /schedule-drafts =====

describe('POST /schedule-drafts', () => {
  test('returns 403 for medewerker role', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/schedule-drafts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test', type: 'basis' });
    expect(res.status).toBe(403);
  });

  test('returns 400 for vakantie type without holidayPeriodId', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/schedule-drafts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Zomervakantie', type: 'vakantie' }); // missing holidayPeriodId
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('vakantieperiode');
  });

  test('creates a basis draft successfully', async () => {
    mockActiveUser();
    const newDraft = { id: 'draft_abc', name: 'Nieuw rooster', type: 'basis', weekNumber: 1, grid: {} };
    pool.query
      .mockResolvedValueOnce({ rows: [newDraft] }) // INSERT
      .mockResolvedValueOnce({ rows: [] });          // logAudit
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/schedule-drafts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nieuw rooster', type: 'basis', grid: {} });
    expect(res.status).toBe(200);
    expect(res.body.draft.name).toBe('Nieuw rooster');
  });
});

// ===== POST /admin/users =====

describe('POST /admin/users', () => {
  function adminToken() {
    return makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
  }

  test('returns 400 when name is missing', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'medewerker' }); // missing name
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('verplicht');
  });

  test('returns 400 when email already exists', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // existing email check
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Test', email: 'exists@example.com', role: 'medewerker' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Email bestaat al');
  });

  test('creates user without email (no email check query)', async () => {
    mockActiveUser();
    const newUser = { id: 5, name: 'Piet', email: null, role: 'medewerker', team_id: null, mainTeam: null, extraTeams: null, contractHours: 0, active: true, weekScheduleWeek1: [], weekScheduleWeek2: [], weekSchedules: [] };
    pool.query
      .mockResolvedValueOnce({ rows: [newUser] }) // INSERT
      .mockResolvedValueOnce({ rows: [] });         // logAudit
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Piet', role: 'medewerker' }); // no email
    expect(res.status).toBe(201);
    expect(res.body.user.name).toBe('Piet');
    expect(res.body.user.email).toBeNull();
  });

  test('creates user with email (normalises to lowercase)', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] }); // no existing email
    const newUser = { id: 6, name: 'Mieke', email: 'mieke@example.com', role: 'medewerker', team_id: 'vlot1', mainTeam: 'vlot1', extraTeams: null, contractHours: 36, active: true, weekScheduleWeek1: [], weekScheduleWeek2: [], weekSchedules: [] };
    pool.query
      .mockResolvedValueOnce({ rows: [newUser] }) // INSERT
      .mockResolvedValueOnce({ rows: [] });         // logAudit
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Mieke', email: 'MIEKE@EXAMPLE.COM', role: 'medewerker', mainTeam: 'vlot1', contractHours: 36 });
    expect(res.status).toBe(201);
    expect(res.body.user.name).toBe('Mieke');
  });
});

// ===== POST /admin/users/:id/reset-password =====

describe('POST /admin/users/:id/reset-password', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/v1/admin/users/1/reset-password');
    expect(res.status).toBe(401);
  });

  test('returns 403 for non-admin user', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'vlot1' });
    const res = await request(app)
      .post('/admin/users/1/reset-password')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('does not expose newPassword when user has email (email is sent instead)', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [] })                                         // UPDATE password_hash
      .mockResolvedValueOnce({ rows: [] })                                         // logAudit
      .mockResolvedValueOnce({ rows: [{ name: 'Jan', email: 'jan@test.be' }] }); // user fetch
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/admin/users/5/reset-password')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // #170: password must NOT be in response when an email exists
    expect(res.body.newPassword).toBeUndefined();
  });

  test('exposes newPassword in response when user has no email', async () => {
    mockActiveUser();
    pool.query
      .mockResolvedValueOnce({ rows: [] })                               // UPDATE password_hash
      .mockResolvedValueOnce({ rows: [] })                               // logAudit
      .mockResolvedValueOnce({ rows: [{ name: 'Jan', email: null }] }); // user fetch — no email
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/admin/users/5/reset-password')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Must include password so admin can hand it over manually
    expect(res.body.newPassword).toBeTruthy();
  });
});

// ===== PATCH /admin/users/:id =====

describe('PATCH /admin/users/:id', () => {
  test('returns 400 when role is missing', async () => {
    mockActiveUser();
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .patch('/admin/users/5')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Name' }); // missing role
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing fields');
  });

  test('updates user data successfully', async () => {
    mockActiveUser();
    const oldUser = { email: 'old@example.com' };
    const updatedUser = { id: 5, name: 'Updated', email: 'old@example.com', role: 'medewerker', team_id: 'vlot1', active: true, mainTeam: 'vlot1', extraTeams: null, contractHours: 38, weekScheduleWeek1: [], weekScheduleWeek2: [], weekSchedules: [], emailNotificationsEnabled: true };
    pool.query
      .mockResolvedValueOnce({ rows: [oldUser] })     // SELECT old email
      .mockResolvedValueOnce({ rows: [updatedUser] }) // UPDATE users
      .mockResolvedValueOnce({ rows: [] });             // logAudit
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .patch('/admin/users/5')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'medewerker', name: 'Updated', contractHours: 38, active: true });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeTruthy();
  });

  test('deactivating a user sets active to false', async () => {
    mockActiveUser();
    const oldUser = { email: 'jan@example.com' };
    const deactivatedUser = { id: 5, name: 'Jan', email: 'jan@example.com', role: 'medewerker', team_id: 'vlot1', active: false, mainTeam: 'vlot1', extraTeams: null, contractHours: 36, weekScheduleWeek1: [], weekScheduleWeek2: [], weekSchedules: [], emailNotificationsEnabled: true };
    pool.query
      .mockResolvedValueOnce({ rows: [oldUser] })
      .mockResolvedValueOnce({ rows: [deactivatedUser] })
      .mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .patch('/admin/users/5')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'medewerker', active: false });
    expect(res.status).toBe(200);
    expect(res.body.user.active).toBe(false);
  });

  // Regressie #168: een PATCH zonder team-velden mag team_id niet op NULL zetten.
  test('does not overwrite team_id when no team fields are sent (#168)', async () => {
    mockActiveUser();
    const oldUser = { email: 'jan@example.com' };
    const updatedUser = { id: 5, name: 'Jan', email: 'jan@example.com', role: 'medewerker', team_id: 'vlot1', active: false, mainTeam: 'vlot1', extraTeams: null, contractHours: 36, weekScheduleWeek1: [], weekScheduleWeek2: [], weekSchedules: [], emailNotificationsEnabled: true };
    pool.query
      .mockResolvedValueOnce({ rows: [oldUser] })
      .mockResolvedValueOnce({ rows: [updatedUser] })
      .mockResolvedValueOnce({ rows: [] });
    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .patch('/admin/users/5')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'medewerker', active: false }); // geen team_id, geen mainTeam
    expect(res.status).toBe(200);

    // De UPDATE-query moet team_id via COALESCE behouden, en $2 moet null zijn
    // zodat de bestaande team_id-waarde blijft staan.
    const updateCall = pool.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users') && c[0].includes('SET role')
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[0]).toContain('team_id = COALESCE($2, team_id)');
    expect(updateCall[1][1]).toBeNull(); // $2 (team_id || mainTeam || null) === null
  });
});

// ===== GET /calendar/:token.ics (iCal feed) =====

describe('GET /calendar/:token.ics', () => {
  test('includes a VTIMEZONE block and TZID-prefixed times (#172)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Karen Claes' }] }) // user by token
      .mockResolvedValueOnce({ rows: [{ id: 100, date: '2026-06-15', start_time: '12:00', end_time: '20:00', team: 'vlot1', notes: null, team_name: 'Vlot 1' }] }) // shifts
      .mockResolvedValueOnce({ rows: [{ value: { vlot1: { name: 'Vlot 1' } } }] }); // settings.teams

    const res = await request(app).get('/api/v1/calendar/some-token.ics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');

    const body = res.text;
    // VTIMEZONE-component met CET/CEST-regels aanwezig
    expect(body).toContain('BEGIN:VTIMEZONE');
    expect(body).toContain('TZID:Europe/Brussels');
    expect(body).toContain('TZNAME:CEST');
    expect(body).toContain('TZNAME:CET');
    // Tijden expliciet aan de tijdzone gekoppeld (niet kaal/floating)
    expect(body).toContain('DTSTART;TZID=Europe/Brussels:20260615T120000');
    expect(body).toContain('DTEND;TZID=Europe/Brussels:20260615T200000');
  });

  test('returns 404 for an unknown token', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/calendar/nope.ics');
    expect(res.status).toBe(404);
  });
});

// ===== POST /schedule-drafts/:id/deactivate =====

describe('POST /schedule-drafts/:id/deactivate', () => {
  function arrange(grid, extra = {}) {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] }); // requireAuth
    pool.query.mockResolvedValue({ rows: [] });                     // logAudit
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                          // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: 'c1', name: 'Concept', grid, team_filter: null,
        lastAppliedFrom: null, lastAppliedUntil: null, ...extra
      }] })
      .mockResolvedValue({ rows: [], rowCount: 0 });                // UPDATE, DELETEs, COMMIT
    return mockClient;
  }

  // Regressie #213: bij een single-week raster staan de medewerkers op het
  // BOVENSTE niveau en de dagnummers eronder. De oude code nam blind het
  // tweede niveau, en wiste zo de diensten van "gebruikers" 0 tot 6.
  test('reads employee ids from the top level for a single-week grid (#213)', async () => {
    const singleWeek = {
      _pattern: { cycleLength: 2 },
      '42': { '0': { startTime: '08:00', endTime: '16:00' } },
      '43': { '3': { startTime: '09:00', endTime: '17:00' } }
    };
    const mockClient = arrange(singleWeek, {
      lastAppliedFrom: '2026-01-01', lastAppliedUntil: '2026-12-31'
    });

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/api/v1/schedule-drafts/c1/deactivate')
      .set('Authorization', `Bearer ${token}`)
      .send({ endDate: '2026-06-30' });
    expect(res.status).toBe(200);

    const legacy = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('draft_id IS NULL')
    );
    expect(legacy).toBeTruthy();
    // De medewerkers, niet de dagnummers 0 en 3
    expect(legacy[1][0].sort()).toEqual([42, 43]);
  });

  test('reads employee ids from the second level for a multi-week grid (#213)', async () => {
    const multiWeek = {
      _multiWeek: true,
      '1': { '42': { '0': { startTime: '08:00', endTime: '16:00' } } },
      '2': { '43': { '3': { startTime: '09:00', endTime: '17:00' } } }
    };
    const mockClient = arrange(multiWeek, {
      lastAppliedFrom: '2026-01-01', lastAppliedUntil: '2026-12-31'
    });

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/api/v1/schedule-drafts/c1/deactivate')
      .set('Authorization', `Bearer ${token}`)
      .send({ endDate: '2026-06-30' });
    expect(res.status).toBe(200);

    const legacy = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('draft_id IS NULL')
    );
    expect(legacy).toBeTruthy();
    expect(legacy[1][0].sort()).toEqual([42, 43]);
  });

  // Regressie #185: de verwijdering hoort begrensd te zijn op het concept en
  // op zijn toepassingsbereik, niet op 'alles na endDate'.
  test('deletes by draft_id and bounds legacy shifts to the applied range (#185)', async () => {
    const mockClient = arrange(
      { _multiWeek: true, '1': { '42': {} } },
      { lastAppliedFrom: '2027-04-05', lastAppliedUntil: '2027-04-18' }
    );

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    await request(app)
      .post('/api/v1/schedule-drafts/c1/deactivate')
      .set('Authorization', `Bearer ${token}`)
      .send({ endDate: '2026-08-31' });

    const byDraft = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('DELETE FROM shifts WHERE draft_id = $1')
    );
    expect(byDraft).toBeTruthy();
    expect(byDraft[1]).toEqual(['c1', '2026-08-31']);

    const legacy = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('draft_id IS NULL')
    );
    // Onder- en bovengrens uit het toepassingsbereik van het concept
    expect(legacy[1]).toEqual([[42], '2026-08-31', '2027-04-05', '2027-04-18']);
  });

  // Een concept dat nooit is toegepast heeft niets gegenereerd, dus de
  // opruiming van oude diensten mag daar helemaal niet draaien.
  test('does not touch legacy shifts when the draft was never applied (#185)', async () => {
    const mockClient = arrange({ _multiWeek: true, '1': { '42': {} } });

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    await request(app)
      .post('/api/v1/schedule-drafts/c1/deactivate')
      .set('Authorization', `Bearer ${token}`)
      .send({ endDate: '2026-08-31' });

    const legacy = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('draft_id IS NULL')
    );
    expect(legacy).toBeUndefined();
  });
});

// ===== POST /schedule-drafts/:id/apply =====

describe('POST /api/v1/schedule-drafts/:id/apply', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/v1/schedule-drafts/1/apply');
    expect(res.status).toBe(401);
  });

  test('returns 403 for medewerker role', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .post('/api/v1/schedule-drafts/1/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({ startDate: '2026-05-05', endDate: '2026-05-11' });
    expect(res.status).toBe(403);
  });

  test('applies draft and creates shifts via bulk insert', async () => {
    // All 7 days assigned — guarantees at least one shift regardless of weekday
    const empId = 42;
    const dayAssignment = { startTime: '08:00', endTime: '16:00', team: 'vlot1' };
    const draftGrid = {
      [String(empId)]: { '0': dayAssignment, '1': dayAssignment, '2': dayAssignment, '3': dayAssignment, '4': dayAssignment, '5': dayAssignment, '6': dayAssignment },
      _pattern: { cycleLength: 1, referenceDate: '2026-05-04' }
    };
    const draft = {
      id: 1, name: 'Testconcept', type: 'basis', team_filter: null,
      week_number: 1, valid_from: null, valid_until: null, holiday_period_id: null,
      grid: draftGrid
    };
    const employee = {
      id: empId, name: 'Jan', email: 'jan@test.be', mainTeam: 'vlot1',
      extraTeams: [], contractHours: 38, active: true,
      weekSchedules: null, weekScheduleWeek1: null, weekScheduleWeek2: null
    };

    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] }); // requireAuth

    // Transaction query sequence (in order of execution):
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [draft] })               // draft lookup FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })                    // overlap check
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })        // manual shifts count (step 2b)
      .mockResolvedValueOnce({ rows: [employee] })            // employees
      .mockResolvedValueOnce({ rows: [] })                    // closedDates
      .mockResolvedValueOnce({ rows: [] })                    // vakantie skip ranges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })       // bulk DELETE in-draft
      .mockResolvedValueOnce({ rows: [] })                    // bulk SELECT occupied shifts
      .mockResolvedValueOnce({ rows: [] })                    // bulk SELECT absences
      .mockResolvedValueOnce({ rows: [] })                    // bulk SELECT blocks (#146)
      .mockResolvedValueOnce({ rows: [], rowCount: 7 })       // bulk INSERT shifts (7 days)
      .mockResolvedValueOnce({ rows: [] })                    // week_schedules UPDATE
      .mockResolvedValueOnce({ rows: [] })                    // DELETE shift_activities vergadering cleanup
      .mockResolvedValueOnce({ rows: [] })                    // draft UPDATE (last_applied_at)
      .mockResolvedValueOnce({ rows: [] });                   // COMMIT

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/api/v1/schedule-drafts/1/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({ applyStartDate: '2026-05-04', applyEndDate: '2026-05-10' });

    expect(res.status).toBe(200);
    expect(res.body.draftName).toBe('Testconcept');
    expect(typeof res.body.applied).toBe('number');
    expect(typeof res.body.shifts).toBe('object');

    // Verify one bulk INSERT was used (not per-row individual inserts)
    const insertCalls = mockClient.query.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('INSERT INTO shifts')
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][0]).toMatch(/VALUES \(\$1/); // bulk VALUES syntax
  });

  // Regressie #146: een dag met een shift_block (manuele leegmaking) wordt
  // NIET opnieuw gevuld bij het toepassen van het concept.
  test('skips dates that have a shift_block (#146)', async () => {
    const empId = 42;
    const dayAssignment = { startTime: '08:00', endTime: '16:00', team: 'vlot1' };
    const draftGrid = {
      [String(empId)]: { '0': dayAssignment, '1': dayAssignment, '2': dayAssignment, '3': dayAssignment, '4': dayAssignment, '5': dayAssignment, '6': dayAssignment },
      _pattern: { cycleLength: 1, referenceDate: '2026-05-04' }
    };
    const draft = {
      id: 1, name: 'Testconcept', type: 'basis', team_filter: null,
      week_number: 1, valid_from: null, valid_until: null, holiday_period_id: null,
      grid: draftGrid
    };
    const employee = {
      id: empId, name: 'Jan', email: 'jan@test.be', mainTeam: 'vlot1',
      extraTeams: [], contractHours: 38, active: true,
      weekSchedules: null, weekScheduleWeek1: null, weekScheduleWeek2: null
    };

    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] }); // requireAuth

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [draft] })               // draft lookup FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })                    // overlap check
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })        // manual shifts count
      .mockResolvedValueOnce({ rows: [employee] })            // employees
      .mockResolvedValueOnce({ rows: [] })                    // closedDates
      .mockResolvedValueOnce({ rows: [] })                    // vakantie skip ranges
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })       // bulk DELETE in-draft
      .mockResolvedValueOnce({ rows: [] })                    // bulk SELECT occupied shifts
      .mockResolvedValueOnce({ rows: [] })                    // bulk SELECT absences
      .mockResolvedValueOnce({ rows: [{ user_id: empId, date: '2026-05-06' }] }) // bulk SELECT blocks → 1 geblokkeerde dag
      .mockResolvedValueOnce({ rows: [], rowCount: 6 })       // bulk INSERT shifts (6 i.p.v. 7)
      .mockResolvedValueOnce({ rows: [] })                    // week_schedules UPDATE
      .mockResolvedValueOnce({ rows: [] })                    // vergadering cleanup
      .mockResolvedValueOnce({ rows: [] })                    // draft UPDATE
      .mockResolvedValueOnce({ rows: [] });                   // COMMIT

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post('/api/v1/schedule-drafts/1/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({ applyStartDate: '2026-05-04', applyEndDate: '2026-05-10' }); // 7 dagen
    expect(res.status).toBe(200);

    const insertCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO shifts')
    );
    expect(insertCall).toBeTruthy();
    // 6 shifts × 7 params = 42 (de geblokkeerde dag is overgeslagen).
    // Sinds #185 draagt elke rij ook draft_id, vandaar 7 in plaats van 6.
    expect(insertCall[1]).toHaveLength(42);
    // De geblokkeerde datum mag niet in de insert-params voorkomen
    expect(insertCall[1]).not.toContain('2026-05-06');
    // Elke rij krijgt het id van het toegepaste concept mee
    expect(insertCall[0]).toContain('draft_id');
    expect(insertCall[1].filter(p => p === '1')).toHaveLength(6);
  });
});

// ===== POST /admin/users/:id/replace =====

describe('POST /admin/users/:id/replace', () => {
  // Regressie #141: bij een lage medewerker-ID (bv. 3) mag de grid-remap enkel
  // de medewerker-sleutel hernoemen, niet de dag-van-de-week-index "3".
  test('remaps employee key without corrupting day-of-week indices (#141)', async () => {
    const oldId = 3;   // botst met dagindex donderdag ("3")
    const newId = 42;
    const dayAssignment = { startTime: '08:00', endTime: '16:00', team: 'vlot1' };
    // Medewerker 3 staat als sleutel; medewerker 9 heeft een shift op dag "3" (do)
    const grid = {
      '3': { '0': dayAssignment, '3': dayAssignment },
      '9': { '3': dayAssignment }
    };

    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] }); // requireAuth
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });        // logAudit etc.

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                                 // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: oldId, name: 'Oud', week_schedules: [], week_schedule_week1: [], week_schedule_week2: [] }] }) // old user FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: newId, name: 'Nieuw', active: false }] })      // new user FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })                                                 // copy week_schedules
      .mockResolvedValueOnce({ rows: [] })                                                 // deactivate old
      .mockResolvedValueOnce({ rows: [{ id: 1, grid }] })                                  // SELECT drafts FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })                                                 // UPDATE schedule_drafts
      .mockResolvedValueOnce({ rows: [] });                                                // COMMIT

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post(`/api/v1/admin/users/${oldId}/replace`)
      .set('Authorization', `Bearer ${token}`)
      .send({ replacementUserId: newId }); // geen transferShiftsFrom
    expect(res.status).toBe(200);
    expect(res.body.draftsUpdated).toBe(1);

    // Inspecteer het weggeschreven grid
    const updateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE schedule_drafts SET grid')
    );
    expect(updateCall).toBeTruthy();
    const writtenGrid = JSON.parse(updateCall[1][0]);

    // Medewerker-sleutel hernoemd: "3" weg, "42" aanwezig met dezelfde inhoud
    expect(writtenGrid['3']).toBeUndefined();
    expect(writtenGrid['42']).toEqual({ '0': dayAssignment, '3': dayAssignment });
    // Dagindex "3" van medewerker 9 ONGEMOEID
    expect(writtenGrid['9']).toEqual({ '3': dayAssignment });
  });

  test('skips drafts where the old ID only appears as a day index (#141)', async () => {
    const oldId = 3;
    const newId = 42;
    const dayAssignment = { startTime: '08:00', endTime: '16:00', team: 'vlot1' };
    // Medewerker 3 komt NIET voor als sleutel, enkel dagindex "3" bij medewerker 9
    const grid = { '9': { '3': dayAssignment } };

    const mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);
    pool.query.mockResolvedValueOnce({ rows: [{ active: true }] });
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                                 // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: oldId, name: 'Oud', week_schedules: [], week_schedule_week1: [], week_schedule_week2: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: newId, name: 'Nieuw', active: false }] })
      .mockResolvedValueOnce({ rows: [] })                                                 // copy week_schedules
      .mockResolvedValueOnce({ rows: [] })                                                 // deactivate old
      .mockResolvedValueOnce({ rows: [{ id: 1, grid }] })                                  // SELECT drafts (prefilter LIKE matcht dagindex)
      .mockResolvedValueOnce({ rows: [] });                                                // COMMIT (geen UPDATE schedule_drafts)

    const token = makeToken({ id: 1, role: 'admin', name: 'Admin', team_id: null });
    const res = await request(app)
      .post(`/api/v1/admin/users/${oldId}/replace`)
      .set('Authorization', `Bearer ${token}`)
      .send({ replacementUserId: newId });
    expect(res.status).toBe(200);
    expect(res.body.draftsUpdated).toBe(0);

    const updateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE schedule_drafts SET grid')
    );
    expect(updateCall).toBeUndefined(); // niets weggeschreven
  });
});


// ===== Verlofplanning (verlofrondes) =====

describe('Verlofrondes', () => {
  const medewerker = { id: 3, name: 'Eva', role: 'medewerker', team_id: 'vlot2' };
  const beheerder  = { id: 1, name: 'Admin', role: 'admin', team_id: null };

  test('POST /leave-rounds weigert een medewerker', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ name: 'Zomer', startDate: '2026-06-29', endDate: '2026-08-30' });
    expect(res.status).toBe(403);
  });

  test('POST /leave-rounds vereist een naam', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ blocks: [{ name: 'Zomer', startDate: '2026-06-29', endDate: '2026-08-30' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verplicht/i);
  });

  test('POST /leave-rounds vereist minstens één vakantieblok', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Schooljaar 2026' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vakantieperiode/i);
  });

  test('POST /leave-rounds weigert een einddatum vóór de startdatum', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Zomer', blocks: [{ name: 'Zomer', startDate: '2026-08-30', endDate: '2026-06-29' }] });
    expect(res.status).toBe(400);
  });

  test('POST /leave-rounds weigert een onbekende modus', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Zomer', blocks: [{ name: 'Zomer', mode: 'onzin', startDate: '2026-06-29', endDate: '2026-08-30' }] });
    expect(res.status).toBe(400);
  });

  // ===== Weekends uit het roosterconcept =====

  test('POST /leave-rounds weigert een gesloten dag buiten het blok', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Schooljaar', blocks: [{
        name: 'Kerst', startDate: '2026-12-21', endDate: '2027-01-03',
        closedDates: ['2026-11-01']
      }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/buiten/i);
  });

  test('POST /leave-rounds weigert gesloten dagen die geen lijst zijn', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Schooljaar', blocks: [{
        name: 'Kerst', startDate: '2026-12-21', endDate: '2027-01-03',
        closedDates: '2026-12-26'
      }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lijst/i);
  });

  test('POST /leave-rounds weigert een ongeldig datumformaat bij gesloten dagen', async () => {
    mockActiveUser();
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Schooljaar', blocks: [{
        name: 'Kerst', startDate: '2026-12-21', endDate: '2027-01-03',
        closedDates: ['26-12-2026']
      }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ongeldige gesloten dag/i);
  });

  // Een ronde zonder gekoppeld concept moet gewoon kunnen: closedDates blijft
  // dan weg en betekent "onbekend", niet "alles open".
  test('POST /leave-rounds accepteert een blok zonder gesloten dagen', async () => {
    mockActiveUser();
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/INSERT INTO leave_rounds/i.test(sql)) return Promise.resolve({ rows: [{ id: 7, name: 'Schooljaar' }] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .post('/api/v1/leave-rounds')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ name: 'Schooljaar', blocks: [{
        name: 'Kerst', startDate: '2026-12-21', endDate: '2027-01-03'
      }] });
    expect(res.status).toBe(200);
    const insert = client.query.mock.calls.find(c => /INSERT INTO leave_round_blocks/i.test(c[0]));
    expect(insert).toBeTruthy();
    expect(insert[1][7]).toBeNull();
  });

  test('PUT blocks weigert een medewerker', async () => {
    mockActiveUser();
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ closedDates: [] });
    expect(res.status).toBe(403);
  });

  test('PUT blocks geeft 404 als het blok niet bij de ronde hoort', async () => {
    mockActiveUser();
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/999')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ closedDates: [] });
    expect(res.status).toBe(404);
  });

  test('PUT blocks geeft 409 op een gesloten ronde zonder force', async () => {
    mockActiveUser();
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{
        id: 2, name: 'Kerst', startDate: '2026-12-21', endDate: '2027-01-03',
        closedDates: null, status: 'gesloten'
      }], rowCount: 1 }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ closedDates: ['2026-12-26'] });
    expect(res.status).toBe(409);
  });

  // Invulling op een dag die nu dicht is moet weg, anders zet apply daar
  // alsnog verlof op.
  test('PUT blocks verwijdert entries op nieuw gesloten dagen', async () => {
    mockActiveUser();
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/FROM leave_round_blocks b JOIN leave_rounds/i.test(sql)) {
          return Promise.resolve({ rows: [{
            id: 2, name: 'Kerst', startDate: '2026-12-21', endDate: '2027-01-03',
            closedDates: null, status: 'open'
          }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 3 });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ closedDates: ['2026-12-26', '2026-12-27'] });
    expect(res.status).toBe(200);
    const del = client.query.mock.calls.find(c => /DELETE FROM leave_round_entries/i.test(c[0]));
    expect(del).toBeTruthy();
    expect(del[1][1]).toEqual(['2026-12-26', '2026-12-27']);
    expect(res.body.entriesRemoved).toBe(3);
  });

  // ===== Verdeling van een voorkeurblok =====

  test('PUT blocks/entries weigert een medewerker', async () => {
    mockActiveUser();
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2/entries')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ entries: [] });
    expect(res.status).toBe(403);
  });

  test('PUT blocks/entries geeft 404 als het blok bij een andere ronde hoort', async () => {
    mockActiveUser();
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/999/entries')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ entries: [] });
    expect(res.status).toBe(404);
  });

  // Bij een open ronde kunnen medewerkers hun invulling nog wijzigen; een
  // verdeling zou dan stil overschreven worden.
  test('PUT blocks/entries geeft 409 zolang de ronde niet gesloten is', async () => {
    mockActiveUser();
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{
        id: 2, name: 'Zomer', startDate: '2027-07-05', endDate: '2027-07-18', status: 'open'
      }], rowCount: 1 }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2/entries')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ entries: [{ userId: 3, date: '2027-07-05', status: 'verlof' }] });
    expect(res.status).toBe(409);
  });

  test('PUT blocks/entries weigert een datum buiten het blok', async () => {
    mockActiveUser();
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{
        id: 2, name: 'Zomer', startDate: '2027-07-05', endDate: '2027-07-18', status: 'gesloten'
      }], rowCount: 1 }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2/entries')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ entries: [{ userId: 3, date: '2026-12-25', status: 'verlof' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/buiten/i);
  });

  // De kern: de DELETE moet begrensd zijn op het blok én op de meegegeven
  // medewerkers, anders wist het vastleggen van de zomer de kleine vakanties.
  test('PUT blocks/entries wist alleen binnen het blok en voor de meegegeven mensen', async () => {
    mockActiveUser();
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/FROM leave_round_blocks b JOIN leave_rounds/i.test(sql)) {
          return Promise.resolve({ rows: [{
            id: 2, name: 'Zomer', startDate: '2027-07-05', endDate: '2027-07-18', status: 'gesloten'
          }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValueOnce(client);
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/blocks/2/entries')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ entries: [
        { userId: 3, date: '2027-07-05', status: 'verlof' },
        { userId: 4, date: '2027-07-05', status: 'werken' }
      ] });
    expect(res.status).toBe(200);
    const del = client.query.mock.calls.find(c => /DELETE FROM leave_round_entries/i.test(c[0]));
    expect(del[0]).toMatch(/date BETWEEN/i);
    expect(del[1]).toEqual(['1', [3, 4], '2027-07-05', '2027-07-18']);
    expect(res.body.saved).toBe(2);
    expect(res.body.medewerkers).toBe(2);
  });

  test('PUT entries: medewerker mag niet voor iemand anders invullen', async () => {
    mockActiveUser();
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/entries')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ userId: 99, entries: [{ date: '2026-07-06', status: 'verlof' }] });
    expect(res.status).toBe(403);
  });

  test('PUT entries weigert een datum buiten de ronde', async () => {
    mockActiveUser();
    mockLeaveRoundClient({ status: 'open', start_date: '2026-06-29', end_date: '2026-08-30' });
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/entries')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ entries: [{ date: '2026-01-05', status: 'verlof' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/buiten de ronde/i);
  });

  test('PUT entries weigert een onbekende status', async () => {
    mockActiveUser();
    mockLeaveRoundClient({ status: 'open', start_date: '2026-06-29', end_date: '2026-08-30' });
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/entries')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ entries: [{ date: '2026-07-06', status: 'vakantie' }] });
    expect(res.status).toBe(400);
  });

  test('PUT entries blokkeert een medewerker bij een gesloten ronde', async () => {
    mockActiveUser();
    mockLeaveRoundClient({ status: 'gesloten', start_date: '2026-06-29', end_date: '2026-08-30' });
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/entries')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`)
      .send({ entries: [{ date: '2026-07-06', status: 'verlof' }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/gesloten/i);
  });

  test('POST submit blokkeert bij een gesloten ronde', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'gesloten' }] });
    const res = await request(app)
      .post('/api/v1/leave-rounds/1/submit')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`);
    expect(res.status).toBe(403);
  });

  test('PUT submissions vereist een boolean approved', async () => {
    mockActiveUser();
    const res = await request(app)
      .put('/api/v1/leave-rounds/1/submissions/3')
      .set('Authorization', `Bearer ${makeToken(beheerder)}`)
      .send({ approved: 'ja' });
    expect(res.status).toBe(400);
  });

  test('GET /leave-rounds/:id verbergt een concept voor medewerkers', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Zomer', status: 'concept' }] });
    const res = await request(app)
      .get('/api/v1/leave-rounds/1')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`);
    expect(res.status).toBe(403);
  });

  test('GET /leave-rounds/:id geeft 404 voor een onbekende ronde', async () => {
    mockActiveUser();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/v1/leave-rounds/999')
      .set('Authorization', `Bearer ${makeToken(medewerker)}`);
    expect(res.status).toBe(404);
  });
});
