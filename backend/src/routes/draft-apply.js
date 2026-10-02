// #157: een concept toepassen op een datumbereik, uit server.js gehaald. Dit
// is met afstand de langste route van de app: alles gebeurt in een transactie,
// want half toegepast is erger dan niet toegepast.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { getMonday, formatDateYYYYMMDD, parseLocalDate } = require('../utils');

const router = maakRouter();

router.post('/schedule-drafts/:id/apply', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const draftId = req.params.id;
  const { clearBlocks = true, applyStartDate = null, applyEndDate = null } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load draft with FOR UPDATE lock
    const draftResult = await client.query(
      `SELECT id, name, week_number, team_filter, grid, created_by, valid_from, valid_until, type, holiday_period_id,
              last_applied_from::text AS last_applied_from
       FROM schedule_drafts WHERE id = $1 FOR UPDATE`,
      [draftId]
    );

    if (draftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }

    const draft = draftResult.rows[0];
    const rawGrid = draft.grid || {};
    const isMultiWeek = !!rawGrid._multiWeek;

    // Build list of weeks to apply
    const weeksToApply = [];
    if (isMultiWeek) {
      for (const [key, weekGrid] of Object.entries(rawGrid)) {
        if (key.startsWith('_')) continue; // skip _multiWeek, _pattern, _rotation metadata
        weeksToApply.push({ weekNumber: Number(key), grid: weekGrid });
      }
    } else {
      weeksToApply.push({ weekNumber: draft.week_number || 1, grid: rawGrid });
    }

    // Check if this is a future-scheduled draft
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (draft.valid_from) {
      const validFromDate = parseLocalDate(draft.valid_from);
      if (validFromDate && validFromDate > today) {
        // Future draft: save as "ingepland" without applying
        await client.query(
          `UPDATE schedule_drafts SET updated_at = NOW() WHERE id = $1`,
          [draftId]
        );
        await client.query('COMMIT');
        await logAudit(req, 'UPDATE', 'settings', draftId, {
          type: 'draft_schedule',
          draftName: draft.name,
          validFrom: draft.valid_from,
          validUntil: draft.valid_until
        });
        return res.json({
          scheduled: true,
          validFrom: draft.valid_from,
          validUntil: draft.valid_until,
          draftName: draft.name
        });
      }
    }

    // Determine effective date range for shift generation
    let effectiveStartDate = applyStartDate || null;
    let effectiveEndDate = applyEndDate || null;
    const isVakantie = draft.type === 'vakantie';

    // Vakantieconcept: force date-range mode from holiday period dates
    if (isVakantie) {
      if (!draft.holiday_period_id) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({ error: 'Vakantieconcept heeft geen gekoppelde vakantieperiode' });
      }
      const hpResult = await client.query(`SELECT value FROM settings WHERE key = 'holidayPeriods'`);
      const holidayPeriods = hpResult.rows.length > 0 ? (hpResult.rows[0].value || []) : [];
      const linkedPeriod = holidayPeriods.find(p => String(p.id) === String(draft.holiday_period_id));
      if (!linkedPeriod) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({ error: 'Gekoppelde vakantieperiode niet gevonden' });
      }
      effectiveStartDate = linkedPeriod.startDate;
      effectiveEndDate = linkedPeriod.endDate;
    }

    // Date range is verplicht — concepten hebben altijd een van/tot datum
    if (!effectiveStartDate || !effectiveEndDate) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Start- en einddatum zijn verplicht bij concept toepassen' });
    }

    // Validate date range
    if (effectiveStartDate >= effectiveEndDate) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Startdatum moet voor einddatum liggen' });
    }

    const { confirmOverlap = false, confirmOverwrite = null } = req.body || {};

    // Vakantieconcepten overschrijven altijd alle shifts (auto + manual):
    // vakantie is een expliciete beslissing — niets uit het basisrooster mag blijven staan.
    const effectiveConfirmOverwrite = isVakantie ? true : confirmOverwrite;

    // 2a. Overlap detectie — zoek actieve niet-vakantie concepten die overlappen
    if (!isVakantie && !confirmOverlap) {
      const overlapping = await client.query(
        `SELECT id, name, last_applied_from, last_applied_until
         FROM schedule_drafts
         WHERE id != $1 AND last_applied_at IS NOT NULL
         AND type IS DISTINCT FROM 'vakantie'
         AND last_applied_from IS NOT NULL AND last_applied_until IS NOT NULL
         AND last_applied_from < $3 AND last_applied_until > $2`,
        [draftId, effectiveStartDate, effectiveEndDate]
      );
      if (overlapping.rows.length > 0) {
        await client.query('ROLLBACK').catch(() => {});
        return res.json({
          needsOverlapConfirmation: true,
          overlappingDrafts: overlapping.rows.map(d => ({
            id: d.id,
            name: d.name,
            from: d.last_applied_from,
            until: d.last_applied_until
          })),
          newStartDate: effectiveStartDate
        });
      }
    }

    // 2b. Tel manuele shifts in het bereik voor het succesrapport.
    //     Manuele shifts worden standaard NIET verwijderd (enkel source='auto'),
    //     dus er is geen bevestigingsvraag meer nodig — de teller gaat mee
    //     in het eindresultaat zodat de gebruiker ziet wat bewaard is (#146).
    let preservedManualCount = 0;
    if (!isVakantie) {
      const manualResult = await client.query(
        `SELECT COUNT(*)::int as count FROM shifts WHERE source = 'manual'
         AND date >= $1::date AND date <= $2::date`,
        [effectiveStartDate, effectiveEndDate]
      );
      preservedManualCount = manualResult.rows[0].count;
    }

    // 2c. Bij bevestiging overlap: inkorten overlappende concepten
    if (confirmOverlap && !isVakantie) {
      const overlapping = await client.query(
        `SELECT id, name, last_applied_from, last_applied_until
         FROM schedule_drafts
         WHERE id != $1 AND last_applied_at IS NOT NULL
         AND type IS DISTINCT FROM 'vakantie'
         AND last_applied_from IS NOT NULL AND last_applied_until IS NOT NULL
         AND last_applied_from < $3 AND last_applied_until > $2`,
        [draftId, effectiveStartDate, effectiveEndDate]
      );
      for (const overlap of overlapping.rows) {
        // Kort het overlappende concept in tot de dag vóór de nieuwe startdatum
        const newEndDate = new Date(parseLocalDate(effectiveStartDate));
        newEndDate.setDate(newEndDate.getDate() - 1);
        const newEndStr = formatDateYYYYMMDD(newEndDate);

        if (newEndStr >= overlap.last_applied_from) {
          // Concept A nog geldig voor periode vóór B → inkorten
          await client.query(
            `UPDATE schedule_drafts SET last_applied_until = $1, updated_at = NOW() WHERE id = $2`,
            [newEndStr, overlap.id]
          );
        } else {
          // Concept A volledig overschreven → markeer als verlopen
          await client.query(
            `UPDATE schedule_drafts SET last_applied_until = last_applied_from, updated_at = NOW() WHERE id = $1`,
            [overlap.id]
          );
        }

        // Verwijder de diensten van het oude concept in de overlappende periode.
        //
        // #187: deze DELETE liep van de startdatum van het NIEUWE concept tot de
        // einddatum van het OUDE, zonder filter op concept of team. Alles voorbij
        // het bereik van het nieuwe concept werd dus gewist en nooit opnieuw
        // gevuld, en teams waar het nieuwe concept niets mee te maken heeft
        // gingen mee. De gebruiker bevestigde het inkorten van een concept, niet
        // het leegmaken van maanden rooster voor de hele organisatie.
        //
        // Nu: alleen de diensten van dít oude concept, en alleen binnen het
        // bereik dat het nieuwe concept daadwerkelijk gaat vullen. Wat daarbuiten
        // valt blijft staan en blijft via draft_id beheerbaar met 'uitplannen'.
        // Oude diensten zonder draft_id raken we hier bewust niet aan: de gewone
        // bulk-delete verderop dekt het bereik van het nieuwe concept al af, voor
        // precies de medewerkers en teams die het betreft.
        await client.query(
          `DELETE FROM shifts
           WHERE draft_id = $1
             AND date >= $2::date AND date <= $3::date`,
          [overlap.id, effectiveStartDate, effectiveEndDate]
        );
      }
    }

    // 3. Read cycle settings — prefer draft's embedded pattern over global settings
    let cycleLength = 2;
    let referenceDate = '2025-01-06';
    if (rawGrid._pattern && rawGrid._pattern.cycleLength) {
      cycleLength = rawGrid._pattern.cycleLength;
      referenceDate = rawGrid._pattern.referenceDate || referenceDate;
    } else {
      const patternResult = await client.query(`SELECT value FROM settings WHERE key = 'schedule_pattern'`);
      if (patternResult.rows.length > 0 && patternResult.rows[0].value) {
        if (patternResult.rows[0].value.cycleLength) cycleLength = patternResult.rows[0].value.cycleLength;
        if (patternResult.rows[0].value.referenceDate) referenceDate = patternResult.rows[0].value.referenceDate;
      }
    }

    // #211: de backend genereerde vanaf het anker in het concept, en de
    // frontend zette daarna het globale anker op de maandag van de startdatum.
    // Die twee liepen uiteen, en of het misging hing zuiver aan de pariteit van
    // het aantal weken ertussen. Bij een tweewekelijkse cyclus was dat de helft
    // van de gevallen, en dan stond het hele rooster een cycluspositie
    // verschoven ten opzichte van wat de bouwer en de planning toonden.
    //
    // Eén anker dus. Bij de EERSTE toepassing wordt dat de maandag van de
    // startdatum, want dat is wat de bouwer belooft: de week waar je begint is
    // week 1. Bij een volgende toepassing blijft het staande anker gelden, ook
    // als je maar een deel van de periode opnieuw toepast, zodat de fase niet
    // verspringt ten opzichte van wat er al gepland staat.
    //
    // Vakantieconcepten hebben hier niets mee te maken: die nummeren
    // vakantie-relatief en schrijven bewust geen schedulePattern weg.
    if (!isVakantie) {
      const eerdersToegepast = !!draft.last_applied_from;
      if (!eerdersToegepast) {
        referenceDate = formatDateYYYYMMDD(getMonday(parseLocalDate(effectiveStartDate)));
      }
      // Vastleggen in het concept, zodat het anker niet meer kan wegdrijven en
      // de frontend precies dit kan publiceren in plaats van zelf te rekenen.
      if (rawGrid._pattern && rawGrid._pattern.referenceDate !== referenceDate) {
        await client.query(
          `UPDATE schedule_drafts
              SET grid = jsonb_set(grid, '{_pattern,referenceDate}', to_jsonb($1::text), true),
                  updated_at = NOW()
            WHERE id = $2`,
          [referenceDate, draftId]
        );
        rawGrid._pattern.referenceDate = referenceDate;
      }
    }

    // Gesloten dagen per week uit het patroon van het concept (0=zo … 6=za)
    const patternClosedDays = {};
    Object.entries(rawGrid._pattern?.weeks || {}).forEach(([w, cfg]) => {
      if (Array.isArray(cfg?.closedDays)) patternClosedDays[w] = cfg.closedDays;
    });
    let closedDaySkips = 0;
    let conceptClosedCount = 0;

    let appliedCount = 0;
    let totalCreated = 0;
    let totalDeleted = 0;

    // Load all active employees, optionally filtered by team
    let employeeQuery = `SELECT id, name, email, main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedules as "weekSchedules",
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2"
         FROM users WHERE active = true`;
    const employeeParams = [];
    if (draft.team_filter) {
      employeeQuery += ` AND main_team = $1`;
      employeeParams.push(draft.team_filter);
    }
    const allEmployeesResult = await client.query(employeeQuery, employeeParams);

    // Build a grid lookup by week number (indexed by weekNumber -> employeeId -> dayIndex -> assignment)
    const gridByWeek = {};
    for (const { weekNumber, grid } of weeksToApply) {
      gridByWeek[weekNumber] = grid;
    }

    // Wie er echt in het conceptraster staat. Wordt in het blok hieronder gevuld
    // en daarna hergebruikt door de week_schedules-sync (#186).
    let empsInDraftForSync = [];

    // ===== GENERATE SHIFTS FROM DRAFT GRID =====
    {
      const rangeStart = parseLocalDate(effectiveStartDate);
      const rangeEnd = parseLocalDate(effectiveEndDate);
      const refDate = parseLocalDate(referenceDate);
      const refMonday = getMonday(refDate);

      // Load manually closed dates to skip
      let closedDatesSet = new Set();
      try {
        const cdResult = await client.query(`SELECT value FROM settings WHERE key = 'closedDates'`);
        closedDatesSet = new Set((cdResult.rows[0]?.value || []).map(d => d.date));
      } catch (e) {
        console.log('Warning: could not load closedDates for draft apply:', e.message);
      }

      // For non-vakantie drafts: load active vakantieperiode date ranges to skip
      // (vakantieconcepten mogen wel in vakantieperiodes schrijven, normale niet)
      const vakantieSkipRanges = [];
      if (!isVakantie) {
        try {
          const vakDrafts = await client.query(
            `SELECT holiday_period_id FROM schedule_drafts
             WHERE type = 'vakantie' AND last_applied_at IS NOT NULL
             AND (last_applied_until IS NULL OR last_applied_until >= $1::date)`,
            [effectiveStartDate]
          );
          if (vakDrafts.rows.length > 0) {
            const hpResult = await client.query(`SELECT value FROM settings WHERE key = 'holidayPeriods'`);
            const holidayPeriods = hpResult.rows.length > 0 ? (hpResult.rows[0].value || []) : [];
            for (const row of vakDrafts.rows) {
              const hp = holidayPeriods.find(p => String(p.id) === String(row.holiday_period_id));
              if (hp && hp.startDate && hp.endDate) {
                if (hp.endDate >= effectiveStartDate && hp.startDate <= effectiveEndDate) {
                  vakantieSkipRanges.push({ start: hp.startDate, end: hp.endDate });
                }
              }
            }
          }
        } catch (e) {
          console.log('Warning: could not load vakantie ranges for draft apply:', e.message);
        }
      }

      const startStr = formatDateYYYYMMDD(rangeStart);
      const endStr = formatDateYYYYMMDD(rangeEnd);

      // Split employees: in draft vs not in draft
      const empsInDraft = allEmployeesResult.rows.filter(emp =>
        Object.values(gridByWeek).some(weekGrid =>
          weekGrid && (weekGrid[String(emp.id)] || weekGrid[emp.id])
        )
      );
      const empsNotInDraft = allEmployeesResult.rows.filter(emp =>
        !Object.values(gridByWeek).some(weekGrid =>
          weekGrid && (weekGrid[String(emp.id)] || weekGrid[emp.id])
        )
      );
      empsInDraftForSync = empsInDraft;

      // ===== BULK DELETE: employees IN draft =====
      if (empsInDraft.length > 0) {
        const empIds = empsInDraft.map(e => e.id);
        const sourceFilter = effectiveConfirmOverwrite === true ? '' : ` AND source = 'auto'`;
        let bulkDeleteQuery = `DELETE FROM shifts WHERE user_id = ANY($1::int[])${sourceFilter} AND date >= $2::date AND date <= $3::date`;
        const bulkDeleteParams = [empIds, startStr, endStr];
        if (vakantieSkipRanges.length > 0) {
          vakantieSkipRanges.forEach((r) => {
            bulkDeleteQuery += ` AND NOT (date >= $${bulkDeleteParams.length + 1}::date AND date <= $${bulkDeleteParams.length + 2}::date)`;
            bulkDeleteParams.push(r.start, r.end);
          });
        }
        const bulkDeleteResult = await client.query(bulkDeleteQuery, bulkDeleteParams);
        totalDeleted += bulkDeleteResult.rowCount;

        // Bij een expliciete "overschrijf alles" (incl. vakantie) wist de
        // gebruiker bewust het hele venster terug naar het concept — dan
        // vervallen ook de manuele leegmakingen (#146). In de veilige
        // standaardmodus blijven blocks staan zodat manuele intentie wint.
        if (effectiveConfirmOverwrite === true) {
          let blockDelQuery = `DELETE FROM shift_blocks WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date`;
          const blockDelParams = [empIds, startStr, endStr];
          if (vakantieSkipRanges.length > 0) {
            vakantieSkipRanges.forEach((r) => {
              blockDelQuery += ` AND NOT (date >= $${blockDelParams.length + 1}::date AND date <= $${blockDelParams.length + 2}::date)`;
              blockDelParams.push(r.start, r.end);
            });
          }
          await client.query(blockDelQuery, blockDelParams);
        }
      }

      // ===== BULK SELECT: occupied dates, absences and blocks for employees IN draft =====
      const occupiedByEmp = {};
      const absencesByEmp = {};
      const blockedByEmp = {};
      if (empsInDraft.length > 0) {
        const empIds = empsInDraft.map(e => e.id);
        const occupiedResult = await client.query(
          `SELECT user_id, date::text as date FROM shifts WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date`,
          [empIds, startStr, endStr]
        );
        for (const row of occupiedResult.rows) {
          if (!occupiedByEmp[row.user_id]) occupiedByEmp[row.user_id] = new Set();
          occupiedByEmp[row.user_id].add(row.date);
        }
        const absencesResult = await client.query(
          `SELECT user_id, date::text as date FROM availability WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date AND type IS NOT NULL AND type != ''`,
          [empIds, startStr, endStr]
        );
        for (const row of absencesResult.rows) {
          if (!absencesByEmp[row.user_id]) absencesByEmp[row.user_id] = new Set();
          absencesByEmp[row.user_id].add(row.date);
        }
        // Manueel leeggemaakte cellen (#146): een block betekent "mens koos
        // bewust om deze dag leeg te laten" → concept vult hem niet opnieuw.
        const blocksResult = await client.query(
          `SELECT user_id, date::text as date FROM shift_blocks WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date`,
          [empIds, startStr, endStr]
        );
        for (const row of blocksResult.rows) {
          if (!blockedByEmp[row.user_id]) blockedByEmp[row.user_id] = new Set();
          blockedByEmp[row.user_id].add(row.date);
        }
      }

      // ===== COMPUTE SHIFTS TO INSERT (pure JS, no DB calls) =====
      const insertRows = [];
      for (const emp of empsInDraft) {
        const occupiedDates = occupiedByEmp[emp.id] || new Set();
        const absenceDates = absencesByEmp[emp.id] || new Set();
        const blockedDates = blockedByEmp[emp.id] || new Set();
        let createdCount = 0;

        for (let d = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
             d <= rangeEnd;
             d.setDate(d.getDate() + 1)) {
          const dateStr = formatDateYYYYMMDD(d);

          if (occupiedDates.has(dateStr)) continue;
          if (absenceDates.has(dateStr)) continue;
          if (blockedDates.has(dateStr)) continue;
          if (closedDatesSet.has(dateStr)) continue;
          if (vakantieSkipRanges.some(r => dateStr >= r.start && dateStr <= r.end)) continue;

          // Calculate cycle week number for this date.
          //
          // Een vakantieconcept telt zijn weken vanaf de eerste maandag van de
          // vakantie — dat is wat de bouwer toont en wat de mens aanklikt
          // (getBuilderVakantieWeekStart). De modulo-berekening hieronder gaat
          // uit van een doorlopende cyclus vanaf een globale referentiedatum,
          // en die erft een vakantieconcept bij aanmaak. Daardoor kreeg week 1
          // van bv. de paasvakantie het rooster van week 2, en bij de zomer
          // schoof het hele rooster op. Basisroosters houden de cyclus.
          const currMonday = getMonday(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
          const ankerMonday = isVakantie ? getMonday(rangeStart) : refMonday;
          const diffMs = currMonday.getTime() - ankerMonday.getTime();
          const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
          const weekNumber = isVakantie
            ? diffWeeks + 1
            : ((diffWeeks % cycleLength) < 0 ? (diffWeeks % cycleLength) + cycleLength : (diffWeeks % cycleLength)) + 1;

          const weekGrid = gridByWeek[weekNumber];
          if (!weekGrid) continue;

          const empGrid = weekGrid[String(emp.id)] || weekGrid[emp.id];
          if (!empGrid) continue;

          // Map JS dayOfWeek (0=Sun) to grid dayIndex (0=Mon..6=Sun)
          const jsDow = d.getDay();
          const dayIndex = jsDow === 0 ? 6 : jsDow - 1;
          const assignment = empGrid[String(dayIndex)] || empGrid[dayIndex];
          if (!assignment) continue;

          // Een dag die in de bouwer gesloten is levert geen shift op. Je kan
          // zo'n dag daar niet invullen, dus een resterende gridcel komt van
          // vóór het sluiten en is onzichtbaar geworden — die mag niet alsnog
          // een dienst opleveren. Pas hier tellen, na de cel: anders telt de
          // teller gesloten dagen in plaats van onderdrukte diensten.
          if ((patternClosedDays[String(weekNumber)] || []).includes(jsDow)) {
            closedDaySkips++;
            continue;
          }

          insertRows.push({
            userId: emp.id,
            date: dateStr,
            startTime: assignment.startTime,
            endTime: assignment.endTime,
            team: assignment.team || emp.mainTeam,
            isReserve: !!assignment.isReserve
          });
          createdCount++;
        }

        if (createdCount > 0) {
          appliedCount++;
          totalCreated += createdCount;
        }
      }

      // ===== BULK INSERT =====
      // draft_id legt vast uit welk concept elke dienst komt, zodat uitplannen
      // en overlap-inkorting precies weten wat ze mogen verwijderen (#185, #187).
      // Postgres bindt maximaal 65.535 parameters per query, dus in blokken:
      // een volledig schooljaar met veertig medewerkers zit daar dicht tegenaan.
      if (insertRows.length > 0) {
        const COLS = 7;
        const CHUNK = Math.floor(60000 / COLS);
        for (let offset = 0; offset < insertRows.length; offset += CHUNK) {
          const chunk = insertRows.slice(offset, offset + CHUNK);
          const values = chunk.map((_, i) =>
            `($${i * COLS + 1}, $${i * COLS + 2}, $${i * COLS + 3}, $${i * COLS + 4}, $${i * COLS + 5}, 'auto', $${i * COLS + 6}, $${i * COLS + 7})`
          ).join(', ');
          const params = chunk.flatMap(r => [
            r.userId, r.date, r.startTime, r.endTime, r.team, r.isReserve, draftId
          ]);
          await client.query(
            `INSERT INTO shifts (user_id, date, start_time, end_time, team, source, is_reserve, draft_id) VALUES ${values}`,
            params
          );
        }
      }

      // ===== BULK DELETE: employees NOT in draft (auto-shifts only) =====
      // If an employee has no entry in the concept, clear their auto-shifts for this period.
      if (empsNotInDraft.length > 0) {
        const empIdsNotInDraft = empsNotInDraft.map(e => e.id);
        let delNotInDraftQuery = `DELETE FROM shifts WHERE user_id = ANY($1::int[]) AND source = 'auto' AND date >= $2::date AND date <= $3::date`;
        const delNotInDraftParams = [empIdsNotInDraft, startStr, endStr];
        if (vakantieSkipRanges.length > 0) {
          vakantieSkipRanges.forEach((r) => {
            delNotInDraftQuery += ` AND NOT (date >= $${delNotInDraftParams.length + 1}::date AND date <= $${delNotInDraftParams.length + 2}::date)`;
            delNotInDraftParams.push(r.start, r.end);
          });
        }
        const delNotInDraftResult = await client.query(delNotInDraftQuery, delNotInDraftParams);
        totalDeleted += delNotInDraftResult.rowCount;
        if (delNotInDraftResult.rowCount > 0) appliedCount++;
      }

    }

    // 3. Sync week_schedules op users vanuit het concept grid (read-only weergave voor medewerkers)
    //
    // #186: dit liep over ALLE actieve medewerkers en keek niet naar het soort
    // concept. Een vakantieconcept toepassen verving daardoor het vaste
    // jaarpatroon van iedereen door het vakantiepatroon, en wie niet in dat
    // vakantieraster stond raakte zijn basisrooster helemaal kwijt. De oude
    // waarde stond daarna nergens meer.
    //
    // Een vakantieconcept beschrijft een uitzondering van enkele weken, geen
    // weekpatroon, dus het hoort het basisrooster niet aan te raken. En ook een
    // basisconcept raakt alleen nog de medewerkers die er echt in staan: wie er
    // niet in voorkomt houdt wat hij had.
    const employeesToSync = isVakantie ? [] : empsInDraftForSync;
    for (const emp of employeesToSync) {
      const allWeeks = [];
      for (let weekNumber = 1; weekNumber <= cycleLength; weekNumber++) {
        const weekGrid = gridByWeek[weekNumber];
        const empGrid = weekGrid ? (weekGrid[String(emp.id)] || weekGrid[emp.id]) : null;
        const entries = [];
        if (empGrid) {
          for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const assignment = empGrid[String(dayIndex)] || empGrid[dayIndex];
            if (assignment) {
              const jsDayOfWeek = dayIndex === 6 ? 0 : dayIndex + 1;
              entries.push({
                dayOfWeek: jsDayOfWeek,
                enabled: true,
                startTime: assignment.startTime,
                endTime: assignment.endTime,
                team: assignment.team || emp.mainTeam
              });
            }
          }
        }
        allWeeks.push(entries);
      }
      await client.query(
        `UPDATE users SET week_schedules = $1::jsonb,
         week_schedule_week1 = $2::jsonb, week_schedule_week2 = $3::jsonb WHERE id = $4`,
        [JSON.stringify(allWeeks), JSON.stringify(allWeeks[0] || []),
         JSON.stringify(allWeeks[1] || []), emp.id]
      );
    }

    // 4. Auto-create vergadering activities from _teamMeetings
    const teamMeetings = rawGrid._teamMeetings || {};

    // Altijd de eigen vergaderingen van dit concept opruimen in dit bereik, ook
    // als het nieuwe concept er geen meer heeft (zomerconcept).
    //
    // #376: hier stond `DELETE ... WHERE type = 'vergadering' AND date BETWEEN`,
    // zonder filter op concept, team of medewerker. Dat wiste ook vergaderingen
    // die iemand met de hand had ingevoerd (dat type staat gewoon in de
    // keuzelijst van de activiteitenmodal) en die van teams waar het concept
    // niets mee te maken heeft. Vaak kwam er niets voor terug, want de
    // regeneratie draait alleen als het concept _teamMeetings heeft.
    //
    // Sinds migratie 038 draagt elke gegenereerde vergadering een draft_id, en
    // daar begrenzen we op. Niets anders wordt aangeraakt.
    //
    // Vergaderingen van vóór die migratie hebben geen draft_id, en er is geen
    // betrouwbare manier om te zien of zo'n rij door een concept is gemaakt of
    // door iemand met de hand: beide krijgen een shift_id en een vrije
    // omschrijving. Gokken op de omschrijving zou handmatig werk kunnen wissen,
    // en dat is precies het probleem dat hier wordt opgelost.
    //
    // Gevolg: vergaderingen die vóór deze migratie door een concept zijn
    // aangemaakt blijven staan, en bij een concept met teamvergaderingen kan er
    // daardoor één keer een dubbele verschijnen. Die is zichtbaar en met de
    // hand te verwijderen. Vanaf de eerstvolgende toepassing klopt het vanzelf.
    await client.query(
      `DELETE FROM shift_activities
        WHERE type = 'vergadering'
          AND draft_id = $3
          AND date >= $1::date AND date <= $2::date`,
      [effectiveStartDate, effectiveEndDate, draftId]
    );

    if (Object.keys(teamMeetings).length > 0) {

      // Check once if shift_id column exists (migration 020 might not have run yet)
      const shiftIdCheck = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'shift_activities' AND column_name = 'shift_id'`
      );
      const shiftIdExists = shiftIdCheck.rows.length > 0;

      // Find all auto-shifts just created in this range
      //
      // #334: dit haalde élke automatische dienst in het bereik op, ook de
      // dagen waarop geen enkel team vergadert. Bij een volledig schooljaar
      // zijn dat er duizenden waarvan de lus er de meeste meteen weer weggooit.
      // De weekdagen waarop wél een vergadering staat zijn hier al bekend, dus
      // die filter hoort in de query.
      //
      // teamMeetings gebruikt dayIndex met 0 = maandag; EXTRACT(DOW) van
      // Postgres gebruikt 0 = zondag. Vandaar de omrekening.
      const vergaderDagen = [...new Set(
        Object.values(teamMeetings).flat().map(m => (Number(m.day) + 1) % 7)
      )].filter(d => Number.isInteger(d));

      const newShiftsResult = vergaderDagen.length === 0 ? { rows: [] } : await client.query(
        `SELECT s.id, s.user_id, s.date::text as date, s.start_time, s.end_time, u.main_team
         FROM shifts s JOIN users u ON s.user_id = u.id
         WHERE s.source = 'auto' AND s.date >= $1::date AND s.date <= $2::date
           AND EXTRACT(DOW FROM s.date)::int = ANY($3::int[])`,
        [effectiveStartDate, effectiveEndDate, vergaderDagen]
      );

      // #334: de activiteiten werden per dienst rij voor rij ingevoegd, binnen
      // een transactie die honderden regels lang openstaat en intussen een
      // schrijfslot op die diensten houdt. Ze worden nu eerst verzameld en
      // daarna in één opdracht weggeschreven.
      const teSchrijvenActiviteiten = [];

      for (const shift of newShiftsResult.rows) {
        const meetings = teamMeetings[shift.main_team] || [];
        if (meetings.length === 0) continue;

        const shiftDate = parseLocalDate(shift.date);
        if (!shiftDate) continue;
        const jsDow = shiftDate.getDay();
        const dayIndex = jsDow === 0 ? 6 : jsDow - 1; // Convert to builder dayIndex (0=ma..6=zo)

        // Parse shift times to decimal
        const [ssh, ssm] = shift.start_time.split(':').map(Number);
        const [seh, sem] = shift.end_time.split(':').map(Number);
        const shiftStartDec = ssh + ssm / 60;
        const shiftEndDec = seh + sem / 60;

        for (const m of meetings) {
          if (m.day !== dayIndex) continue;

          // Check overlap (meeting time vs shift time)
          const mFrom = m.from, mTo = m.to;
          let overlaps = false;
          if (shiftEndDec <= shiftStartDec) {
            // Night shift — meetings are always during day so check start portion
            overlaps = mFrom < 24 && mTo > shiftStartDec;
          } else {
            overlaps = mFrom < shiftEndDec && mTo > shiftStartDec;
          }

          if (overlaps) {
            const fromH = Math.floor(mFrom);
            const fromM = Math.round((mFrom - fromH) * 60);
            const toH = Math.floor(mTo);
            const toM = Math.round((mTo - toH) * 60);
            const fromTime = `${String(fromH).padStart(2, '0')}:${String(fromM).padStart(2, '0')}`;
            const toTime = `${String(toH).padStart(2, '0')}:${String(toM).padStart(2, '0')}`;

            // draft_id legt vast dat deze vergadering uit dit concept komt,
            // zodat de opruiming hierboven hem later kan onderscheiden van een
            // handmatig ingevoerde (#376).
            teSchrijvenActiviteiten.push({
              userId: shift.user_id, shiftId: shift.id, date: shift.date,
              from: fromTime, to: toTime
            });
          }
        }
      }

      if (teSchrijvenActiviteiten.length > 0) {
        // shift_id bestaat pas na migratie 020; zonder die kolom valt de
        // koppeling weg en blijft alleen de dag over.
        if (shiftIdExists) {
          await client.query(
            `INSERT INTO shift_activities (user_id, shift_id, date, start_time, end_time, type, description, draft_id)
             SELECT u, sid, d::date, f, t, 'vergadering', 'Teamvergadering', $6
             FROM unnest($1::int[], $2::int[], $3::date[], $4::text[], $5::text[]) AS x(u, sid, d, f, t)`,
            [
              teSchrijvenActiviteiten.map(a => a.userId),
              teSchrijvenActiviteiten.map(a => a.shiftId),
              teSchrijvenActiviteiten.map(a => a.date),
              teSchrijvenActiviteiten.map(a => a.from),
              teSchrijvenActiviteiten.map(a => a.to),
              draftId
            ]
          );
        } else {
          await client.query(
            `INSERT INTO shift_activities (user_id, date, start_time, end_time, type, description, draft_id)
             SELECT u, d::date, f, t, 'vergadering', 'Teamvergadering', $5
             FROM unnest($1::int[], $2::date[], $3::text[], $4::text[]) AS x(u, d, f, t)`,
            [
              teSchrijvenActiviteiten.map(a => a.userId),
              teSchrijvenActiviteiten.map(a => a.date),
              teSchrijvenActiviteiten.map(a => a.from),
              teSchrijvenActiviteiten.map(a => a.to),
              draftId
            ]
          );
        }
      }
    }

    // 3b. Gesloten dagen van een VAKANTIEconcept vastleggen als absolute datums.
    //
    // Een basisrooster schrijft zijn patroon naar settings.schedule_pattern en
    // dan weet isDayClosed() ervan. Een vakantieconcept doet dat bewust niet —
    // zijn cyclus is vakantie-relatief en zou het jaarpatroon verzieken. Zonder
    // deze stap wist de planning dus niets van een gesloten vakantiedag: hij
    // werd niet gearceerd en je kon er gewoon shifts in zetten.
    //
    // Ze staan apart van settings.closedDates (dat blijft van de gebruiker):
    // deze horen bij hun concept en worden bij elke toepassing vervangen.
    if (isVakantie) {
      const uitConcept = [];
      const vakStart = parseLocalDate(effectiveStartDate);
      const vakEind = parseLocalDate(effectiveEndDate);
      const vakMonday = getMonday(vakStart);
      for (let d = new Date(vakStart.getFullYear(), vakStart.getMonth(), vakStart.getDate());
           d <= vakEind; d.setDate(d.getDate() + 1)) {
        const currMonday = getMonday(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
        const diffWeeks = Math.round((currMonday.getTime() - vakMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
        if ((patternClosedDays[String(diffWeeks + 1)] || []).includes(d.getDay())) {
          uitConcept.push({ date: formatDateYYYYMMDD(d), reason: draft.name, draftId });
        }
      }
      const huidigRes = await client.query(`SELECT value FROM settings WHERE key = 'conceptClosedDates'`);
      const behouden = (huidigRes.rows[0]?.value || []).filter(c => String(c.draftId) !== String(draftId));
      const nieuweLijst = [...behouden, ...uitConcept].sort((a, b) => a.date.localeCompare(b.date));
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('conceptClosedDates', $1::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(nieuweLijst)]
      );
      conceptClosedCount = uitConcept.length;
    }

    // 4. Mark draft as applied (including the date range that was applied)
    await client.query(
      `UPDATE schedule_drafts SET last_applied_at = NOW(), last_applied_by = $1,
       last_applied_from = $2, last_applied_until = $3, updated_at = NOW() WHERE id = $4`,
      [req.user.name, effectiveStartDate || null, effectiveEndDate || null, draftId]
    );

    await client.query('COMMIT');

    // Audit log (outside transaction)
    const appliedWeekNumbers = weeksToApply.map(w => w.weekNumber);
    await logAudit(req, 'UPDATE', 'settings', draftId, {
      type: 'draft_apply',
      draftName: draft.name,
      weekNumbers: appliedWeekNumbers,
      employeesApplied: appliedCount,
      shiftsCreated: totalCreated,
      shiftsDeleted: totalDeleted,
      closedDaySkips,
      clearBlocks
    });

    res.json({
      applied: appliedCount,
      shifts: { created: totalCreated, deleted: totalDeleted },
      draftName: draft.name,
      weekNumbers: appliedWeekNumbers,
      manualShiftsPreserved: preservedManualCount,
      // Aantal keer dat een gridcel niet is uitgevoerd omdat die dag in het
      // concept gesloten staat. Zichtbaar maken, niet stil overslaan.
      closedDaySkips,
      conceptClosedCount,
      // #211: het anker waarmee de diensten daadwerkelijk gegenereerd zijn.
      // De frontend publiceert dit in schedule_pattern in plaats van er zelf
      // een te berekenen, zodat rooster en weergave dezelfde fase aanhouden.
      referenceDate,
      cycleLength
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /schedule-drafts/:id/apply error:', err);
    res.status(500).json({ error: 'Server error bij concept toepassen', detail: err.message, code: err.code });
  } finally {
    client.release();
  }
});

module.exports = router;
