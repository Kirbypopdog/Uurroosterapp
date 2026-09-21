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
    welcome: true,
    // #323: de resetmail hing aan het type 'welcome'. Wie de welkomstmail
    // uitzette, zette daarmee ongemerkt ook de resetmail uit, terwijl de app
    // ondertussen meldde dat de medewerker een mail zou krijgen.
    password_reset: true
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

/**
 * Verstuurt één mail en geeft altijd een resultaat terug. Gooit nooit.
 *
 * #195: de Resend-bibliotheek gooit géén fout wanneer het versturen mislukt,
 * ze geeft een object { data, error } terug. Het catch-blok hieronder ving dus
 * alleen echte crashes op, zoals een netwerkfout. Een geweigerd adres, een
 * domein dat nog niet geverifieerd is, een verlopen API-sleutel of een rate
 * limit kwam netjes als `error` binnen en werd nergens gelezen. Zo'n mail
 * verdween spoorloos: geen regel in de logs, geen signaal in de app.
 *
 * @returns {Promise<{ok: boolean, id?: string, error?: string, skipped?: boolean}>}
 */
async function sendEmail(to, subject, html) {
  if (!resend) {
    return { ok: false, skipped: true, error: 'E-mail is niet geconfigureerd (RESEND_API_KEY ontbreekt).' };
  }
  try {
    const result = await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
    if (result && result.error) {
      const message = result.error.message || JSON.stringify(result.error);
      console.error(`Email send failed to ${to}: ${message}`);
      return { ok: false, error: message };
    }
    return { ok: true, id: result && result.data ? result.data.id : undefined };
  } catch (err) {
    console.error(`Email send failed to ${to}:`, err.message);
    return { ok: false, error: err.message || 'Onbekende fout' };
  }
}

/**
 * Fire-and-forget: blokkeert de aanroeper niet.
 * Een mislukking wordt binnen sendEmail gelogd, want hier is niemand meer die
 * op het antwoord wacht. sendEmail gooit niet, dus dit kan geen unhandled
 * rejection opleveren.
 */
function sendEmailAsync(to, subject, html) {
  if (!resend) return;
  sendEmail(to, subject, html);
}

/**
 * Verstuurt dezelfde mail naar een reeks ontvangers.
 *
 * #324: hier stond in elke notificatiefunctie een lus die per teamlid
 * sendEmailAsync aanriep zonder await. Alle verzoeken naar Resend vertrokken
 * dus tegelijk, terwijl Resend een limiet per seconde hanteert (op het gratis
 * plan twee per seconde). Bij een team van meer dan een handvol mensen kreeg
 * een willekeurig deel een 429 terug en dus geen mail.
 *
 * resend.batch.send is precies hiervoor bedoeld: één API-aanroep voor de hele
 * lijst, tot honderd mails per keer, zodat er geen limiet per seconde in beeld
 * komt. Lukt dat niet, dan valt deze functie terug op één voor één versturen
 * met een pauze ertussen, zodat de mails alsnog aankomen in plaats van stil te
 * verdwijnen.
 *
 * @param {Array} ontvangers  gebruikers met email en email_notifications_enabled
 * @param {string} onderwerp
 * @param {string} html
 * @param {number} [uitgezonderdId]  wie de aanleiding was en dus zelf niets hoeft
 */
const BATCHGROOTTE = 100;
const PAUZE_MS = 600;   // ruim onder twee per seconde

function _pauze(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verstuurReeks(ontvangers, onderwerp, html, uitgezonderdId) {
  if (!resend) return { verstuurd: 0, overgeslagen: 0 };
  const lijst = (ontvangers || []).filter(o =>
    o && o.email && o.email_notifications_enabled !== false && o.id !== uitgezonderdId);
  if (lijst.length === 0) return { verstuurd: 0, overgeslagen: 0 };

  let verstuurd = 0;
  for (let i = 0; i < lijst.length; i += BATCHGROOTTE) {
    const groep = lijst.slice(i, i + BATCHGROOTTE);
    const payload = groep.map(o => ({ from: EMAIL_FROM, to: o.email, subject: onderwerp, html }));
    let gelukt = false;
    try {
      const result = await resend.batch.send(payload);
      if (result && result.error) {
        console.error(`Batch email failed (${groep.length} ontvangers): ${result.error.message || JSON.stringify(result.error)}`);
      } else {
        verstuurd += groep.length;
        gelukt = true;
      }
    } catch (err) {
      console.error(`Batch email failed (${groep.length} ontvangers):`, err.message);
    }
    if (!gelukt) {
      // Terugval: één voor één, met een pauze zodat de limiet per seconde niet
      // alsnog toeslaat. sendEmail logt elke mislukking apart.
      for (const o of groep) {
        const r = await sendEmail(o.email, onderwerp, html);
        if (r.ok) verstuurd++;
        await _pauze(PAUZE_MS);
      }
    }
  }
  return { verstuurd, overgeslagen: (ontvangers || []).length - lijst.length };
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
  // Ondersteunt zowel Date objecten (van PostgreSQL) als strings (YYYY-MM-DD of ISO)
  let datePart;
  if (dateStr instanceof Date) {
    // #326: hier stond toISOString(). De pg-driver levert een DATE-kolom af als
    // een Date op LOKALE middernacht, en toISOString rekent naar UTC. Onder
    // Europe/Brussels werd 15 juli 2026 dan 2026-07-14T22:00:00Z en dus
    // 14 juli in de mail. Vandaag valt dat niet op omdat Render op UTC staat,
    // maar wie ooit TZ=Europe/Brussels zet, zou alle datums in de mails een dag
    // terugzetten zonder dat iets dat meldt. De lokale onderdelen uitlezen geeft
    // altijd de dag die de databank bedoelde.
    const jaar = dateStr.getFullYear();
    const maand = String(dateStr.getMonth() + 1).padStart(2, '0');
    const dag = String(dateStr.getDate()).padStart(2, '0');
    datePart = `${jaar}-${maand}-${dag}`;
  } else {
    datePart = String(dateStr).slice(0, 10);
  }
  const d = new Date(datePart + 'T00:00:00');
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
  // #325: een onderwerpregel is geen HTML. escapeHtml maakte van
  // "Sofie D'Hondt" letterlijk "Sofie D&#39;Hondt" in de inbox.
  sendEmailAsync(targetUser.email, `Ruilverzoek van ${requester.name}`, html);
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
  await verstuurReeks(teamMembers, `Dienst beschikbaar: ${formatDate(shift.date)}`, html, requester.id);
}

/**
 * 2b. Meerdere diensten in één keer beschikbaar → teamleden
 *
 * #225: een ziekmelding of verlofmelding met automatische overnameverzoeken
 * verwittigde alleen de beheerders. De collega's hoorden niets, terwijl dat
 * precies het moment is waarop er snel een vervanger nodig is.
 *
 * Bewust één samenvattende mail en niet notifyTakeoverAvailable per dienst:
 * een week ziekte is al gauw vijf diensten, en vijf losse mails over hetzelfde
 * leest als spam en verbergt het geheel.
 */
async function notifyTakeoverBatchAvailable(teamMembers, requester, shifts, reden) {
  if (!await isTypeEnabled('takeover_available')) return;
  if (!shifts || shifts.length === 0) return;

  const aanleiding = reden === 'ziek' ? 'is ziek gemeld' : 'heeft verlof';
  const lijst = shifts.map(sh => `<li><strong>${formatDate(sh.date)}</strong> &middot; ${formatTime(sh.start_time)} – ${formatTime(sh.end_time)}${sh.team ? ` &middot; ${escapeHtml(sh.team)}` : ''}</li>`).join('');
  const aantal = shifts.length;
  const html = baseTemplate('Diensten beschikbaar', `
    <h2>${aantal} dienst${aantal !== 1 ? 'en' : ''} beschikbaar voor overname</h2>
    <p>${escapeHtml(requester.name)} ${aanleiding}. De volgende dienst${aantal !== 1 ? 'en staan' : ' staat'} open voor overname:</p>
    <ul>${lijst}</ul>
    <p>Kun je er een overnemen? Bekijk de verzoeken in de app bij Ruilen.</p>
  `);
  const onderwerp = aantal === 1
    ? `Dienst beschikbaar: ${formatDate(shifts[0].date)}`
    : `${aantal} diensten beschikbaar voor overname`;

  await verstuurReeks(teamMembers, onderwerp, html, requester.id);
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
  await verstuurReeks(managers, `Ziekmelding: ${employee.name}`, html);
}

/**
 * 4/6. Ruil goedgekeurd → aanvrager + doelmedewerker (gepersonaliseerd)
 */
async function notifySwapApproved(recipients, approverName, requesterShift, targetShift, requesterUser, targetUser) {
  if (!await isTypeEnabled('swap_approved')) return;

  // Email voor de aanvrager
  if (requesterUser?.email_notifications_enabled) {
    const html = baseTemplate('Ruil goedgekeurd', `
      <h2>Jouw ruilverzoek is goedgekeurd!</h2>
      <p>De diensten zijn gewisseld.</p>
      ${requesterShift ? `<p class="detail-label" style="margin-top:16px">Jouw nieuwe dienst</p>${shiftDetailBox(targetShift)}` : ''}
      ${targetShift ? `<p class="detail-label">Dienst die je afstaat</p>${shiftDetailBox(requesterShift)}` : ''}
    `);
    sendEmailAsync(requesterUser.email, 'Jouw ruilverzoek is goedgekeurd', html);
  }

  // Email voor de doelmedewerker
  if (targetUser?.email_notifications_enabled) {
    const html = baseTemplate('Ruil geaccepteerd', `
      <h2>Je hebt het ruilverzoek geaccepteerd.</h2>
      <p>De diensten zijn gewisseld.</p>
      ${targetShift ? `<p class="detail-label" style="margin-top:16px">Jouw nieuwe dienst</p>${shiftDetailBox(requesterShift)}` : ''}
      ${requesterShift ? `<p class="detail-label">Dienst die je afstaat</p>${shiftDetailBox(targetShift)}` : ''}
    `);
    sendEmailAsync(targetUser.email, 'Je hebt het ruilverzoek geaccepteerd', html);
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
  await verstuurReeks(recipients, 'Ruilverzoek afgewezen', html);
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
  sendEmailAsync(originalOwner.email, `Dienst overgenomen door ${acceptor.name}`, html);
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
  await verstuurReeks(recipients, 'Ruilverzoek geannuleerd', html);
}

/**
 * 10. Welkomst-email bij account aanmaken
 */
async function notifyWelcome(newUser) {
  if (!await isTypeEnabled('welcome')) return;
  const html = baseTemplate('Welkom bij Het Vlot', `
    <h2>Welkom, ${escapeHtml(newUser.name)}!</h2>
    <p>Er is een account voor je aangemaakt bij Het Vlot Roosterplanning.</p>
    <div class="detail-box">
      <p class="detail-label">Inloggegevens</p>
      <p><strong>Email:</strong> ${escapeHtml(newUser.email)}</p>
      <p>Je ontvangt je tijdelijk wachtwoord apart van de administrator.</p>
    </div>
    <p>Wijzig je wachtwoord na je eerste login via je profiel.</p>
  `);
  sendEmailAsync(newUser.email, 'Welkom bij Het Vlot Roosterplanning', html);
}

/**
 * 11. Wachtwoord reset email
 */
// #322: geeft nu terug of er effectief een mail de deur uit is gegaan, zodat de
// route en de melding in de app niets beloven wat niet gebeurt.
async function notifyPasswordReset(user, opties = {}) {
  if (!user || !user.email) return false;
  if (!await isTypeEnabled('password_reset')) return false;
  // #154: bij een reset wordt ook de agendalink ingetrokken. De medewerker
  // staat er op dat moment niet bij, dus zonder deze zin merkt hij alleen dat
  // zijn agenda stilletjes niet meer bijwerkt, zonder te weten waarom.
  const agendaZin = opties.agendalinkIngetrokken
    ? '<p>Je persoonlijke agendalink is uit voorzorg ingetrokken. Je diensten lopen daardoor niet meer door naar je agenda-app. Activeer de koppeling opnieuw via je profiel wanneer je ze weer nodig hebt.</p>'
    : '';
  const html = baseTemplate('Wachtwoord gereset', `
    <h2>Wachtwoord gereset</h2>
    <p>Hallo ${escapeHtml(user.name)},</p>
    <p>Je wachtwoord is gereset door een administrator.</p>
    <p>De administrator deelt je tijdelijk wachtwoord persoonlijk mee. Wijzig het daarna via je profiel.</p>
    ${agendaZin}
  `);
  sendEmailAsync(user.email, 'Wachtwoord gereset — Het Vlot Rooster', html);
  return true;
}

/**
 * Test email — stuur een verificatiemails naar de beheerder
 */
async function notifyTestEmail(user) {
  const html = baseTemplate('Testmail', `
    <h2>Testmail</h2>
    <p>Dag ${escapeHtml(user.name)},</p>
    <p>Dit is een testmail vanuit Het Vlot Roosterplanning. Als je dit bericht ontvangt, werkt de e-mailconfiguratie correct.</p>
    <p style="color:#666;font-size:13px">Verstuurd op: ${new Date().toLocaleString('nl-NL')}</p>
  `);
  return sendEmail(user.email, 'Testmail — Het Vlot Roosterplanning', html);
}

module.exports = {
  sendEmail,
  sendEmailAsync,
  notifySwapRequest,
  notifyTakeoverAvailable,
  notifyTakeoverBatchAvailable,
  notifySickLeave,
  notifySwapApproved,
  notifySwapRejected,
  notifyTakeoverAccepted,
  notifyRequestCancelled,
  notifyWelcome,
  notifyPasswordReset,
  notifyTestEmail,
  verstuurReeks,
  // Exported for unit testing only
  _helpers: { escapeHtml, formatDate, formatTime, shiftDetailBox, baseTemplate },
  // De instellingen worden 60 seconden gecachet. Tests die de schakelaars
  // omzetten moeten die cache tussendoor kunnen leegmaken.
  _resetSettingsCache: () => { _cachedSettings = null; _cacheExpiry = 0; }
};
