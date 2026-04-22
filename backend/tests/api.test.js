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

// ===== GET /health =====

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeTruthy();
  });
});

// ===== requireAuth middleware =====

describe('requireAuth middleware', () => {
  test('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/me');
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
    const res = await request(app).get('/teams');
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
    const res = await request(app).get('/shifts');
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
});

// ===== DELETE /shifts/:id =====

describe('DELETE /shifts/:id', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).delete('/shifts/1');
    expect(res.status).toBe(401);
  });
});

// ===== GET /availability =====

describe('GET /availability', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/availability');
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
    const res = await request(app).get('/swap-requests');
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

// ===== GET /settings (role restricted) =====

describe('GET /settings', () => {
  test('returns 401 without authentication', async () => {
    const res = await request(app).get('/settings');
    expect(res.status).toBe(401);
  });

  test('returns 403 for medewerker role', async () => {
    mockActiveUser();
    const token = makeToken({ id: 5, role: 'medewerker', name: 'User', team_id: 'team1' });
    const res = await request(app)
      .get('/settings')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
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

