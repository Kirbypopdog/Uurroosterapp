const { Resend } = require('resend');
const { pool } = require('./db');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || 'Het Vlot Rooster <onboarding@resend.dev>';
const APP_URL = process.env.FRONTEND_URL || 'https://uurrooster-frontend.onrender.com';

if (!resend) {
  console.warn('RESEND_API_KEY not set — email notifications disabled');
}

// ===== GLOBAL EMAIL SETTINGS (cached from DB) =====

const DEFAULT_EMAIL_SETTINGS = {
  globalEnabled: true,
  types: {
    swap_request: true,
    takeover_available: true,
    sick_leave: true,
    swap_approved: true,
    swap_rejected: true,
    takeover_accepted: true,
    request_cancelled: true,
    welcome: true
  }
};

let _cachedSettings = null;
let _cacheExpiry = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

async function getEmailSettings() {
  const now = Date.now();
  if (_cachedSettings && now < _cacheExpiry) return _cachedSettings;
  try {
    const result = await pool.query(
      `SELECT value FROM settings WHERE key = 'email_notifications'`
    );
    _cachedSettings = result.rows.length > 0 ? result.rows[0].value : DEFAULT_EMAIL_SETTINGS;
    _cacheExpiry = now + CACHE_TTL;
    return _cachedSettings;
  } catch (e) {
    console.error('Failed to load email settings:', e.message);
    return DEFAULT_EMAIL_SETTINGS;
  }
}

/** Check if a specific email type is enabled globally */
async function isTypeEnabled(type) {
  if (!resend) return false;
  const settings = await getEmailSettings();
  if (!settings.globalEnabled) return false;
  return settings.types?.[type] !== false;
}

// ===== BASE TEMPLATE =====

function baseTemplate(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { margin:0; padding:0; background:#f4f5f7; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .container { max-width:560px; margin:24px auto; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
  .header { background:#1a73e8; padding:20px 24px; color:#fff; }
  .header h1 { margin:0; font-size:18px; font-weight:600; }
  .body { padding:24px; color:#333; line-height:1.6; }
  .body h2 { margin:0 0 16px; font-size:16px; color:#1a73e8; }
  .detail-box { background:#f8f9fa; border-left:3px solid #1a73e8; padding:12px 16px; margin:16px 0; border-radius:0 4px 4px 0; }
  .detail-box p { margin:4px 0; font-size:14px; }
  .detail-label { color:#666; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; }
  .btn { display:inline-block; background:#1a73e8; color:#fff; text-decoration:none; padding:10px 24px; border-radius:6px; font-size:14px; font-weight:500; margin-top:16px; }
  .footer { padding:16px 24px; background:#f8f9fa; font-size:12px; color:#888; text-align:center; }
  .footer a { color:#1a73e8; text-decoration:none; }
</style>
</head>
<body>
<div class="container">
  <div class="header"><h1>Het Vlot Roosterplanning</h1></div>
  <div class="body">
    ${bodyContent}
    <a href="${APP_URL}" class="btn">Bekijk in de app</a>
  </div>
  <div class="footer">
    Je ontvangt deze mail omdat je een account hebt bij Het Vlot Roosterplanning.<br>
    <a href="${APP_URL}">Email voorkeuren aanpassen</a> in je profiel.
  </div>
</div>
</body></html>`;
}

// ===== CORE SEND FUNCTION =====

async function sendEmail(to, subject, html) {
  if (!resend) return;
  try {
    await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
  } catch (err) {
    console.error(`Email send failed to ${to}:`, err.message);
  }
}

/** Fire-and-forget: does not block caller */
function sendEmailAsync(to, subject, html) {
  if (!resend) return;
  sendEmail(to, subject, html);
}

// ===== HELPERS =====

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(t) {
  return t ? t.slice(0, 5) : '';
}

function shiftDetailBox(shift) {
  return `<div class="detail-box">
    <p class="detail-label">Dienst</p>
    <p><strong>${formatDate(shift.date)}</strong></p>
    <p>${formatTime(shift.start_time)} – ${formatTime(shift.end_time)}${shift.team ? ` &middot; ${escapeHtml(shift.team)}` : ''}</p>
  </div>`;
}

// ===== NOTIFICATION FUNCTIONS =====

/**
 * 1. Ruilverzoek aangemaakt → target employee
 */
async function notifySwapRequest(targetUser, requester, requesterShift, targetShift) {
  if (!await isTypeEnabled('swap_request')) return;
  if (!targetUser.email_notifications_enabled) return;
  const html = baseTemplate('Nieuw ruilverzoek', `
    <h2>Ruilverzoek van ${escapeHtml(requester.name)}</h2>
    <p>${escapeHtml(requester.name)} wil graag van dienst ruilen met jou.</p>
    <p class="detail-label" style="margin-top:16px">Hun dienst (die jij zou krijgen)</p>
    ${shiftDetailBox(requesterShift)}
    <p class="detail-label">Jouw dienst (die zij zouden krijgen)</p>
    ${shiftDetailBox(targetShift)}
  `);
  sendEmailAsync(targetUser.email, `Ruilverzoek van ${escapeHtml(requester.name)}`, html);
}

/**
 * 2. Overnameverzoek aangemaakt → teamleden
 */
async function notifyTakeoverAvailable(teamMembers, requester, shift) {
  if (!await isTypeEnabled('takeover_available')) return;
  const html = baseTemplate('Dienst beschikbaar', `
    <h2>Dienst beschikbaar voor overname</h2>
    <p>${escapeHtml(requester.name)} heeft een dienst beschikbaar gesteld voor overname.</p>
    ${shiftDetailBox(shift)}
    <p>Heb je interesse? Bekijk het verzoek in de app.</p>
  `);
  for (const member of teamMembers) {
    if (!member.email_notifications_enabled) continue;
    if (member.id === requester.id) continue;
    sendEmailAsync(member.email, `Dienst beschikbaar: ${formatDate(shift.date)}`, html);
  }
}

/**
 * 3. Ziekmelding → roosterverantwoordelijken
 */
async function notifySickLeave(managers, employee, startDate, endDate, shiftCount) {
  if (!await isTypeEnabled('sick_leave')) return;
  const dateRange = startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} t/m ${formatDate(endDate)}`;
  const html = baseTemplate('Ziekmelding', `
    <h2>Ziekmelding: ${escapeHtml(employee.name)}</h2>
    <div class="detail-box">
      <p class="detail-label">Periode</p>
      <p><strong>${dateRange}</strong></p>
      ${shiftCount > 0 ? `<p>${shiftCount} dienst${shiftCount > 1 ? 'en' : ''} getroffen</p>` : ''}
    </div>
    <p>Bekijk de planning om eventuele vervanging te regelen.</p>
  `);
  for (const mgr of managers) {
    if (!mgr.email_notifications_enabled) continue;
    sendEmailAsync(mgr.email, `Ziekmelding: ${escapeHtml(employee.name)}`, html);
  }
}

/**
 * 4/6. Ruil goedgekeurd → betrokkenen
 */
async function notifySwapApproved(recipients, approverName, requesterShift, targetShift) {
  if (!await isTypeEnabled('swap_approved')) return;
  const html = baseTemplate('Ruil goedgekeurd', `
    <h2>Ruilverzoek goedgekeurd</h2>
    <p>${escapeHtml(approverName)} heeft het ruilverzoek goedgekeurd. De diensten zijn gewisseld.</p>
    ${requesterShift ? `<p class="detail-label" style="margin-top:16px">Dienst 1</p>${shiftDetailBox(requesterShift)}` : ''}
    ${targetShift ? `<p class="detail-label">Dienst 2</p>${shiftDetailBox(targetShift)}` : ''}
  `);
  for (const user of recipients) {
    if (!user.email_notifications_enabled) continue;
    sendEmailAsync(user.email, 'Ruilverzoek goedgekeurd', html);
  }
}

/**
 * 5/7. Ruil afgewezen → betrokkenen
 */
async function notifySwapRejected(recipients, rejectorName, reason) {
  if (!await isTypeEnabled('swap_rejected')) return;
  const html = baseTemplate('Ruil afgewezen', `
    <h2>Ruilverzoek afgewezen</h2>
    <p>${escapeHtml(rejectorName)} heeft het ruilverzoek afgewezen.</p>
    ${reason ? `<div class="detail-box"><p class="detail-label">Reden</p><p>${escapeHtml(reason)}</p></div>` : ''}
  `);
  for (const user of recipients) {
    if (!user.email_notifications_enabled) continue;
    sendEmailAsync(user.email, 'Ruilverzoek afgewezen', html);
  }
}

/**
 * 8. Overname geaccepteerd → original owner
 */
async function notifyTakeoverAccepted(originalOwner, acceptor, shift) {
  if (!await isTypeEnabled('takeover_accepted')) return;
  if (!originalOwner.email_notifications_enabled) return;
  const html = baseTemplate('Dienst overgenomen', `
    <h2>Je dienst is overgenomen</h2>
    <p>${escapeHtml(acceptor.name)} heeft je dienst overgenomen.</p>
    ${shiftDetailBox(shift)}
  `);
  sendEmailAsync(originalOwner.email, `Dienst overgenomen door ${escapeHtml(acceptor.name)}`, html);
}

/**
 * 9. Verzoek geannuleerd → betrokkenen
 */
async function notifyRequestCancelled(recipients, cancellerName, shift) {
  if (!await isTypeEnabled('request_cancelled')) return;
  const html = baseTemplate('Verzoek geannuleerd', `
    <h2>Verzoek geannuleerd</h2>
    <p>${escapeHtml(cancellerName)} heeft het ruilverzoek geannuleerd.</p>
    ${shift ? shiftDetailBox(shift) : ''}
  `);
  for (const user of recipients) {
    if (!user.email_notifications_enabled) continue;
    sendEmailAsync(user.email, 'Ruilverzoek geannuleerd', html);
  }
}

/**
 * 10. Welkomst-email bij account aanmaken
 */
async function notifyWelcome(newUser, password) {
  if (!await isTypeEnabled('welcome')) return;
  const html = baseTemplate('Welkom bij Het Vlot', `
    <h2>Welkom, ${escapeHtml(newUser.name)}!</h2>
    <p>Er is een account voor je aangemaakt bij Het Vlot Roosterplanning.</p>
    <div class="detail-box">
      <p class="detail-label">Inloggegevens</p>
      <p><strong>Email:</strong> ${newUser.email}</p>
      <p><strong>Wachtwoord:</strong> ${password}</p>
    </div>
    <p>Wijzig je wachtwoord na je eerste login via je profiel.</p>
  `);
  sendEmailAsync(newUser.email, 'Welkom bij Het Vlot Roosterplanning', html);
}

/**
 * 11. Wachtwoord reset email
 */
async function notifyPasswordReset(user, newPassword) {
  if (!await isTypeEnabled('welcome')) return;
  const html = baseTemplate('Wachtwoord gereset', `
    <h2>Wachtwoord gereset</h2>
    <p>Hallo ${escapeHtml(user.name)},</p>
    <p>Je wachtwoord is gereset door een administrator.</p>
    <div class="detail-box">
      <p class="detail-label">Nieuw wachtwoord</p>
      <p><strong>${newPassword}</strong></p>
    </div>
    <p>Wijzig je wachtwoord na je eerste login via je profiel.</p>
  `);
  sendEmailAsync(user.email, 'Wachtwoord gereset — Het Vlot Rooster', html);
}

module.exports = {
  sendEmail,
  sendEmailAsync,
  notifySwapRequest,
  notifyTakeoverAvailable,
  notifySickLeave,
  notifySwapApproved,
  notifySwapRejected,
  notifyTakeoverAccepted,
  notifyRequestCancelled,
  notifyWelcome,
  notifyPasswordReset
};
