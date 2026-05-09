const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const emailService = require('./email');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
// Validate critical env vars (all environments)
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required (stel in via .env voor lokale ontwikkeling)');
  process.exit(1);
}
if (!process.env.DEFAULT_RESET_PASSWORD) {
  console.error('FATAL: DEFAULT_RESET_PASSWORD env var is required (stel in via .env voor lokale ontwikkeling)');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is required (stel in via .env voor lokale ontwikkeling)');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_RESET_PASSWORD = process.env.DEFAULT_RESET_PASSWORD;