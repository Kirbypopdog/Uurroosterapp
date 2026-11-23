// HET VLOT ROOSTERPLANNING - PERSONEELSWISSELS
//
// Een tab in Instellingen, voor admin en roosterverantwoordelijke. Een
// personeelswissel beschrijft een hele situatie in één keer — wie gaat weg, wie
// neemt wiens rooster over, vanaf wanneer — in plaats van losse vervangingen
// per account.
//
// Waarom (23 november 2026): twee losse vervangingen in de verkeerde volgorde,
// één globale knop "Verwijderen", geen voorbeeld vooraf. 121 diensten van Bryan
// verdwenen in plaats van naar Justine te gaan.
//
// Hier:
//  - zoekt de app de volgorde zelf (backend: `ordenStappen`);
//  - toont het voorbeeld per persoon en per week wat er gebeurt, en beslis je
//    per botsing, per dag;
//  - staat alles eerst als CONCEPT. Pas "Bevestigen" verhuist diensten, en tot
//    de eerste ingangsdatum is dat volledig terug te draaien.
//
// Rollen gaan NIET mee: die staan bewust los van een wissel.

const WisselState = {
    scherm: 'lijst',      // 'lijst' | 'bewerken'
    id: null,             // id van het concept dat open staat, of null bij een nieuw
    omschrijving: '',
    stappen: [],          // [{van, naar, vanaf, blijftInDienst}]
    keuzes: {},           // { sleutel: 'overnemen' | 'eigen' }
    voorbeeld: null,
    voorbeeldFout: null,
    gewijzigdNaVoorbeeld: true,
};

/**
 * Uren per week, per persoon, uit een lijst diensten. Puur, zodat het te
 * toetsen is. `maandagen` zijn ISO-datums; `urenVan` rekent één dienst om
 * (in de app: calculateShiftHours).
 */
function wisselWeekUren(diensten, maandagen, urenVan) {
    const uit = maandagen.map(() => 0);
    // De week ná de laatste maandag eindigt zeven dagen later, niet "nooit".
    const plusZeven = (iso) => {
        const d = new Date(`${iso}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 7);
        return d.toISOString().slice(0, 10);
    };
    for (const d of (diensten || [])) {
        for (let i = maandagen.length - 1; i >= 0; i--) {
            if (d.date >= maandagen[i]) {
                const einde = i + 1 < maandagen.length ? maandagen[i + 1] : plusZeven(maandagen[i]);
                if (d.date < einde) uit[i] += urenVan(d);
                break;
            }
        }
    }
    return uit.map(u => Math.round(u * 10) / 10);
}

function wisselMaandagen(van, weken) {
    const start = getMonday(parseDateOnly(van));
    const uit = [];
    for (let i = 0; i < weken; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i * 7);
        uit.push(formatDateYYYYMMDD(d));
    }
    return uit;
}

function wisselNaam(id) {
    const u = (DataStore.users || []).find(x => String(x.id) === String(id));
    return u ? u.name : `#${id}`;
}
function wisselTeam(teamId) {
    return (DataStore.settings.teams || {})[teamId]?.name || teamId || '–';
}
function wisselUren(u) {
    return u == null ? '–' : `${Number.isInteger(u) ? u : u.toFixed(1)}u`;
}

// ===== LIJST =====

async function renderSettingsWissels(container) {
    if (WisselState.scherm === 'bewerken') return renderWisselBewerken(container);

    container.innerHTML = `
        <div class="settings-card wissel-kaart">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Personeelswissels</h3>
                    <p class="settings-card-subtitle">Wie vertrekt, wie neemt wiens rooster over, en vanaf wanneer. Alles samen, eerst als concept.</p>
                </div>
                <button type="button" class="btn btn-primary" id="wissel-nieuw">+ Nieuwe personeelswissel</button>
            </div>
            <div class="settings-card-body" id="wissel-lijst"><p class="text-muted">Laden…</p></div>
        </div>`;
    container.querySelector('#wissel-nieuw').addEventListener('click', () => {
        wisselOpenNieuw();
        renderSettingsWissels(container);
    });

    const lijstEl = container.querySelector('#wissel-lijst');
    let data;
    try {
        data = await dataApiFetch('/personeelswissels');
    } catch (e) {
        lijstEl.innerHTML = `<div class="alert alert-error">Kon de personeelswissels niet laden: ${escapeHtml(e.message)}</div>`;
        return;
    }
    const wissels = data.wissels || [];
    const los = data.losseOvernames || [];
    const STATUS = {
        concept: ['Concept', 'wissel-status--concept'],
        bevestigd: ['Bevestigd', 'wissel-status--bevestigd'],
        uitgevoerd: ['Uitgevoerd', 'wissel-status--uitgevoerd'],
        teruggedraaid: ['Teruggedraaid', 'wissel-status--teruggedraaid'],
    };
    const stapTekst = (s) => `${escapeHtml(s.naarNaam || wisselNaam(s.naar))} neemt het rooster van ${escapeHtml(s.vanNaam || wisselNaam(s.van))} over vanaf ${formatDateShortMetJaar(s.vanaf)}${s.blijftInDienst ? ` <span class="text-muted">(${escapeHtml(s.vanNaam || wisselNaam(s.van))} blijft in dienst)</span>` : ''}`;

    if (!wissels.length && !los.length) {
        lijstEl.innerHTML = '<p class="text-muted">Er is nog geen personeelswissel. Begin er een met de knop hierboven.</p>';
        return;
    }
    lijstEl.innerHTML = `
        ${wissels.map(w => {
            const [label, klasse] = STATUS[w.status] || STATUS.concept;
            const titel = w.omschrijving || (w.stappen || []).map(s => `${s.vanNaam} → ${s.naarNaam}`).join(', ');
            const knoppen = w.status === 'concept'
                ? `<button type="button" class="btn btn-sm btn-primary" data-wissel-open="${w.id}">Openen</button>
                   <button type="button" class="btn btn-sm btn-secondary" data-wissel-weg="${w.id}">Verwijderen</button>`
                : (w.kanTerugdraaien
                    ? `<button type="button" class="btn btn-sm btn-secondary" data-wissel-terug="${w.id}">Terugdraaien</button>`
                    : '');
            return `<div class="wissel-item">
                <div class="wissel-item-kop">
                    <strong>${escapeHtml(titel)}</strong>
                    <span class="wissel-status ${klasse}">${label}</span>
                </div>
                <ul class="wissel-stappen">${(w.stappen || []).map(s => `<li>${stapTekst(s)}</li>`).join('')}</ul>
                <div class="wissel-item-voet">
                    <span class="text-muted text-xs">${w.status === 'concept'
                        ? `Concept van ${escapeHtml(w.aangemaaktDoor || '')}. Er is nog niets gewijzigd.`
                        : `Bevestigd door ${escapeHtml(w.bevestigdDoor || '')}${w.kanTerugdraaien ? '. Terug te draaien tot de eerste ingangsdatum.' : ''}`}</span>
                    <span class="wissel-knoppen">${knoppen}</span>
                </div>
            </div>`;
        }).join('')}
        ${los.length && typeof geplandeOvernamesHtml === 'function'
            ? `<div id="wissel-los" class="mt-md">${geplandeOvernamesHtml(los.map(o => ({
                id: o.id, oudeNaam: o.vanNaam, nieuweNaam: o.naarNaam, ingangsdatum: o.vanaf,
                vertrekkerBlijftActief: o.blijftInDienst, kanTerugdraaien: o.kanTerugdraaien,
            })), 'Losse geplande overnames (van vóór de personeelswissels)')}</div>`
            : ''}`;
    IconHelper.init(lijstEl);

    lijstEl.querySelectorAll('[data-wissel-open]').forEach(k => k.addEventListener('click', () => {
        const w = wissels.find(x => String(x.id) === k.dataset.wisselOpen);
        wisselOpenConcept(w);
        renderSettingsWissels(container);
    }));
    lijstEl.querySelectorAll('[data-wissel-weg]').forEach(k => k.addEventListener('click', async () => {
        if (!await showConfirm('Dit concept verwijderen? Er was nog niets gewijzigd, dus er gaat niets verloren in de planning.', 'Concept verwijderen', { danger: true, confirmText: 'Verwijderen' })) return;
        try {
            await dataApiFetch(`/personeelswissels/${k.dataset.wisselWeg}`, { method: 'DELETE' });
            showToast('Concept verwijderd', 'success');
        } catch (e) { showToast(`Verwijderen mislukt: ${e.message}`, 'error'); }
        renderSettingsWissels(container);
    }));
    lijstEl.querySelectorAll('[data-wissel-terug]').forEach(k => k.addEventListener('click', async () => {
        if (!await showConfirm('Deze personeelswissel volledig terugdraaien?\n\nDe diensten, activiteiten, concepten en verantwoordelijkheden gaan terug zoals ze waren, en niets gebeurt op de ingangsdata. Wat iemand intussen zelf gewijzigd heeft, blijft staan.', 'Wissel terugdraaien', { danger: true, confirmText: 'Terugdraaien' })) return;
        try {
            const r = await dataApiFetch(`/personeelswissels/${k.dataset.wisselTerug}/terugdraaien`, { method: 'POST' });
            await wisselVerversData();
            showToast(`Teruggedraaid: ${r.dienstenTerug} diensten terug${r.verwijderdTeruggezet ? `, ${r.verwijderdTeruggezet} vervallen diensten teruggezet` : ''}`, 'success');
            const niet = [];
            if (r.dienstenNietTerug) niet.push(`${r.dienstenNietTerug} diensten bleven staan omdat er intussen iets anders op dat uur staat`);
            if (r.conceptenNietHersteld?.length) niet.push(`concept ${r.conceptenNietHersteld.join(', ')} is intussen gewijzigd en niet teruggezet`);
            if (r.instellingenNietHersteld?.length) niet.push('de weekend- of vakantieverantwoordelijken zijn intussen gewijzigd en niet teruggezet');
            if (niet.length) showToast(`Kijk dit zelf na: ${niet.join('; ')}.`, 'warning', 12000);
        } catch (e) { showToast(`Terugdraaien mislukt: ${e.message}`, 'error'); }
        renderSettingsWissels(container);
    }));
    const losEl = lijstEl.querySelector('#wissel-los');
    if (losEl && typeof bindGeplandeOvernameKnoppen === 'function') {
        bindGeplandeOvernameKnoppen(losEl, async () => renderSettingsWissels(container));
    }
}

async function wisselVerversData() {
    const taken = [];
    if (typeof refreshUsers === 'function') taken.push(refreshUsers());
    if (typeof refreshShifts === 'function') taken.push(refreshShifts());
    if (typeof refreshActivities === 'function') taken.push(refreshActivities());
    if (typeof refreshDrafts === 'function') taken.push(refreshDrafts());
    if (typeof refreshSettings === 'function') taken.push(refreshSettings());
    if (typeof refreshGeplandeOvernames === 'function') taken.push(refreshGeplandeOvernames());
    await Promise.all(taken.map(p => p.catch(() => {})));
}

function wisselOpenNieuw(vanId = null) {
    Object.assign(WisselState, {
        scherm: 'bewerken', id: null, omschrijving: '', keuzes: {}, voorbeeld: null, voorbeeldFout: null,
        gewijzigdNaVoorbeeld: true,
        stappen: [{ van: vanId ? String(vanId) : '', naar: '', vanaf: '', blijftInDienst: false }],
    });
}

function wisselOpenConcept(w) {
    Object.assign(WisselState, {
        scherm: 'bewerken', id: w.id, omschrijving: w.omschrijving || '', keuzes: w.keuzes || {},
        voorbeeld: null, voorbeeldFout: null, gewijzigdNaVoorbeeld: true,
        stappen: (w.stappen || []).map(s => ({ van: String(s.van), naar: String(s.naar), vanaf: s.vanaf, blijftInDienst: !!s.blijftInDienst })),
    });
}

/** Vanuit een account: een wissel starten met die persoon als vertrekker. */
function startPersoneelswisselVoor(gebruikerId) {
    wisselOpenNieuw(gebruikerId);
    if (typeof switchView === 'function') switchView('settings');
    if (typeof switchSettingsTab === 'function') switchSettingsTab('wissels');
}

// ===== BEWERKEN + VOORBEELD =====

function renderWisselBewerken(container) {
    const mensen = getAllEmployees(true).slice().sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    const opties = (gekozen) => `<option value="">-- Kies --</option>` + mensen.map(m =>
        `<option value="${m.id}" ${String(m.id) === String(gekozen) ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('');
    const vandaag = formatDateYYYYMMDD(new Date());

    container.innerHTML = `
        <div class="settings-card wissel-kaart">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>${WisselState.id ? 'Personeelswissel (concept)' : 'Nieuwe personeelswissel'}</h3>
                    <p class="settings-card-subtitle">Zet alle stappen samen. De volgorde zoekt de app zelf. Er verandert niets tot je bevestigt.</p>
                </div>
                <button type="button" class="btn btn-secondary" id="wissel-terug">Terug naar overzicht</button>
            </div>
            <div class="settings-card-body">
                <div class="form-group">
                    <label for="wissel-omschrijving">Omschrijving (optioneel)</label>
                    <input type="text" id="wissel-omschrijving" class="form-input" maxlength="200"
                        placeholder="bv. Teamwissel januari" value="${escapeHtml(WisselState.omschrijving)}">
                </div>
                <div class="wissel-stappen-invoer">
                    ${WisselState.stappen.map((s, i) => `
                        <div class="wissel-stap" data-i="${i}">
                            <div class="wissel-stap-velden">
                                <label>Wie geeft zijn rooster door
                                    <select class="form-input" data-veld="van">${opties(s.van)}</select></label>
                                <label>Wie neemt het over
                                    <select class="form-input" data-veld="naar">${opties(s.naar)}</select></label>
                                <label>Vanaf
                                    <input type="date" class="form-input" data-veld="vanaf" value="${s.vanaf || ''}" min="${vandaag}"></label>
                            </div>
                            <label class="wissel-blijft"><input type="checkbox" data-veld="blijftInDienst" ${s.blijftInDienst ? 'checked' : ''}>
                                Blijft in dienst (wisselt van team of functie). Zonder vinkje gaat deze persoon op de ingangsdatum uit dienst.</label>
                            ${WisselState.stappen.length > 1 ? `<button type="button" class="btn btn-sm btn-secondary wissel-stap-weg" data-i="${i}">Stap verwijderen</button>` : ''}
                        </div>`).join('')}
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="wissel-stap-erbij">+ Stap toevoegen</button>
                <div class="wissel-acties">
                    <button type="button" class="btn btn-primary" id="wissel-voorbeeld">Voorbeeld bekijken</button>
                </div>
                <div id="wissel-voorbeeld-uit">${wisselVoorbeeldHtml()}</div>
            </div>
        </div>`;
    IconHelper.init(container);

    container.querySelector('#wissel-terug').addEventListener('click', () => {
        WisselState.scherm = 'lijst';
        renderSettingsWissels(container);
    });
    container.querySelector('#wissel-omschrijving').addEventListener('input', (e) => { WisselState.omschrijving = e.target.value; });
    container.querySelectorAll('.wissel-stap').forEach(rij => {
        const i = Number(rij.dataset.i);
        rij.querySelectorAll('[data-veld]').forEach(veld => veld.addEventListener('change', () => {
            WisselState.stappen[i][veld.dataset.veld] = veld.type === 'checkbox' ? veld.checked : veld.value;
            WisselState.gewijzigdNaVoorbeeld = true;
            wisselToonVoorbeeldVerouderd(container);
        }));
    });
    container.querySelectorAll('.wissel-stap-weg').forEach(k => k.addEventListener('click', () => {
        WisselState.stappen.splice(Number(k.dataset.i), 1);
        WisselState.voorbeeld = null;
        WisselState.gewijzigdNaVoorbeeld = true;
        renderWisselBewerken(container);
    }));
    container.querySelector('#wissel-stap-erbij').addEventListener('click', () => {
        WisselState.stappen.push({ van: '', naar: '', vanaf: WisselState.stappen.slice(-1)[0]?.vanaf || '', blijftInDienst: false });
        WisselState.gewijzigdNaVoorbeeld = true;
        renderWisselBewerken(container);
    });
    container.querySelector('#wissel-voorbeeld').addEventListener('click', () => wisselHaalVoorbeeld(container));
    wisselBindVoorbeeld(container);
}

function wisselToonVoorbeeldVerouderd(container) {
    const el = container.querySelector('#wissel-voorbeeld-uit');
    if (el && WisselState.voorbeeld) {
        el.querySelectorAll('.wissel-bevestig, .wissel-opslaan').forEach(k => { k.disabled = true; });
        const melding = el.querySelector('.wissel-verouderd');
        if (melding) melding.classList.remove('hidden');
    }
}

async function wisselHaalVoorbeeld(container) {
    const uit = container.querySelector('#wissel-voorbeeld-uit');
    uit.innerHTML = '<p class="text-muted">Voorbeeld berekenen…</p>';
    try {
        WisselState.voorbeeld = await dataApiFetch('/personeelswissels/voorbeeld', {
            method: 'POST',
            body: JSON.stringify({ stappen: WisselState.stappen, keuzes: WisselState.keuzes }),
        });
        WisselState.voorbeeldFout = null;
        WisselState.gewijzigdNaVoorbeeld = false;
    } catch (e) {
        WisselState.voorbeeld = null;
        WisselState.voorbeeldFout = e.message;
    }
    uit.innerHTML = wisselVoorbeeldHtml();
    IconHelper.init(uit);
    wisselBindVoorbeeld(container);
}

function wisselVoorbeeldHtml() {
    if (WisselState.voorbeeldFout) {
        return `<div class="alert alert-error mt-md">${IconHelper.html(ICONS.error, 'sm')}<div>${escapeHtml(WisselState.voorbeeldFout)}</div></div>`;
    }
    const v = WisselState.voorbeeld;
    if (!v) return '';

    const stappen = v.volgorde.map((s, i) => {
        const meldingen = [];
        if (s.leeggemaakteDagen > 0) {
            meldingen.push(`<div class="alert alert-warning">${IconHelper.html(ICONS.warning || 'alert-triangle', 'sm')}<div>${escapeHtml(s.van.naam)} heeft vanaf ${formatDateShortMetJaar(s.vanaf)} <strong>${s.leeggemaakteDagen} ${s.leeggemaakteDagen === 1 ? 'dag' : 'dagen'} met de hand leeggemaakt</strong>. Die blijven ook bij ${escapeHtml(s.naar.naam)} leeg: plan die zelf in.</div></div>`);
        }
        if (s.onmiddellijk) {
            meldingen.push(`<div class="alert alert-warning">${IconHelper.html(ICONS.warning || 'alert-triangle', 'sm')}<div>Deze stap gaat <strong>meteen</strong> in. Hij kan na bevestigen niet meer teruggedraaid worden.</div></div>`);
        }
        const botsingen = s.botsingen.length ? `
            <table class="wissel-botsingen">
                <thead><tr><th>Dag</th><th>Botsing</th><th>Wat moet er gebeuren?</th></tr></thead>
                <tbody>${s.botsingen.map(b => `
                    <tr>
                        <td>${formatDateShortMetJaar(b.datum)}</td>
                        <td>${escapeHtml(s.naar.naam)} heeft zelf ${escapeHtml(b.eigen)}, ${escapeHtml(s.van.naam)} heeft ${escapeHtml(b.overgenomen)}</td>
                        <td>
                            <label class="radio-label"><input type="radio" name="keuze-${escapeHtml(b.sleutel)}" value="overnemen" data-sleutel="${escapeHtml(b.sleutel)}" ${b.keuze !== 'eigen' ? 'checked' : ''}> Rooster van ${escapeHtml(s.van.naam)} overnemen</label>
                            <label class="radio-label"><input type="radio" name="keuze-${escapeHtml(b.sleutel)}" value="eigen" data-sleutel="${escapeHtml(b.sleutel)}" ${b.keuze === 'eigen' ? 'checked' : ''}> Eigen dienst van ${escapeHtml(s.naar.naam)} houden</label>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>` : '';
        return `<li class="wissel-vb-stap">
            <div><strong>${escapeHtml(s.naar.naam)}</strong> neemt het rooster van <strong>${escapeHtml(s.van.naam)}</strong> over vanaf ${formatDateShortMetJaar(s.vanaf)}: ${s.verhuisd} ${s.verhuisd === 1 ? 'dienst' : 'diensten'}${s.botsingen.length ? `, ${s.botsingen.length} ${s.botsingen.length === 1 ? 'botsing' : 'botsingen'}` : ''}.
            ${s.blijftInDienst ? `${escapeHtml(s.van.naam)} blijft in dienst.` : `${escapeHtml(s.van.naam)} gaat uit dienst op ${formatDateShortMetJaar(s.vanaf)}.`}</div>
            ${meldingen.join('')}
            ${botsingen}
        </li>`;
    }).join('');

    const maandagen = wisselMaandagen(v.venster.van, 6);
    const urenVan = (d) => (typeof calculateShiftHours === 'function' ? calculateShiftHours(d) : 0);
    const rijen = v.personen.map(p => {
        const voor = wisselWeekUren(v.diensten.voor[p.id], maandagen, urenVan);
        const na = wisselWeekUren(v.diensten.na[p.id], maandagen, urenVan);
        const team = p.teamVoor === p.teamNa ? escapeHtml(wisselTeam(p.teamNa)) : `${escapeHtml(wisselTeam(p.teamVoor))} → <strong>${escapeHtml(wisselTeam(p.teamNa))}</strong>`;
        const contract = p.urenVoor === p.urenNa ? wisselUren(p.urenNa) : `${wisselUren(p.urenVoor)} → <strong>${wisselUren(p.urenNa)}</strong>`;
        return `<tr>
            <th scope="row">${escapeHtml(p.naam)}${p.uitDienst ? `<div class="text-xs text-muted">uit dienst vanaf ${formatDateShortMetJaar(p.vanaf)}</div>` : ''}</th>
            <td>${team}</td><td>${contract}</td>
            ${voor.map((u, i) => `<td class="${u !== na[i] ? 'wissel-anders' : ''}">${u === na[i] ? `${u}u` : `${u} → <strong>${na[i]}u</strong>`}</td>`).join('')}
        </tr>`;
    }).join('');

    return `
        <div class="wissel-voorbeeld mt-md">
            <h4>Voorbeeld</h4>
            <div class="alert alert-info wissel-verouderd hidden">${IconHelper.html(ICONS.info || 'info', 'sm')}<div>Je hebt iets gewijzigd. Bekijk het voorbeeld opnieuw voor je bewaart of bevestigt.</div></div>
            <p class="text-muted text-sm">In deze volgorde, ook als je de stappen anders ingaf:</p>
            <ol class="wissel-volgorde">${stappen}</ol>
            <div class="wissel-tabel-wrap">
                <table class="wissel-tabel">
                    <thead><tr><th>Wie</th><th>Team</th><th>Contract</th>${maandagen.map(m => `<th>week van ${parseDateOnly(m).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })}</th>`).join('')}</tr></thead>
                    <tbody>${rijen}</tbody>
                </table>
            </div>
            <p class="text-muted text-xs">Uren in de planning: ervoor → erna. Team en contract gaan over op de ingangsdatum. Rollen veranderen niet.</p>
            <div class="wissel-acties">
                <button type="button" class="btn btn-secondary wissel-opslaan">Opslaan als concept</button>
                <button type="button" class="btn btn-primary wissel-bevestig">Bevestigen</button>
            </div>
        </div>`;
}

function wisselBindVoorbeeld(container) {
    const uit = container.querySelector('#wissel-voorbeeld-uit');
    if (!uit) return;
    uit.querySelectorAll('input[type="radio"][data-sleutel]').forEach(r => r.addEventListener('change', () => {
        WisselState.keuzes[r.dataset.sleutel] = r.value;
        // De uren hangen van de keuze af: opnieuw rekenen.
        wisselHaalVoorbeeld(container);
    }));
    const opslaan = uit.querySelector('.wissel-opslaan');
    if (opslaan) opslaan.addEventListener('click', async () => {
        try {
            await wisselBewaar();
            showToast('Concept bewaard. Er is nog niets gewijzigd in de planning.', 'success');
            WisselState.scherm = 'lijst';
            renderSettingsWissels(container);
        } catch (e) { showToast(`Bewaren mislukt: ${e.message}`, 'error'); }
    });
    const bevestig = uit.querySelector('.wissel-bevestig');
    if (bevestig) bevestig.addEventListener('click', async () => {
        const v = WisselState.voorbeeld;
        const totaal = v.volgorde.reduce((n, s) => n + s.verhuisd, 0);
        const ok = await showConfirm(
            `Personeelswissel bevestigen?\n\n${totaal} diensten verhuizen nu. Team, contracturen en uit dienst gaan op de ingangsdatum.${v.volgorde.some(s => s.onmiddellijk) ? '\n\nLet op: minstens één stap gaat meteen in en kan niet teruggedraaid worden.' : '\n\nTot de eerste ingangsdatum kan je alles terugdraaien.'}`,
            'Bevestigen', { confirmText: 'Bevestigen' });
        if (!ok) return;
        try {
            const id = await wisselBewaar();
            await dataApiFetch(`/personeelswissels/${id}/bevestigen`, { method: 'POST' });
            await wisselVerversData();
            showToast('Personeelswissel bevestigd', 'success');
            WisselState.scherm = 'lijst';
            renderSettingsWissels(container);
        } catch (e) { showToast(`Bevestigen mislukt: ${e.message}`, 'error', 10000); }
    });
}

async function wisselBewaar() {
    const body = JSON.stringify({ omschrijving: WisselState.omschrijving, stappen: WisselState.stappen, keuzes: WisselState.keuzes });
    if (WisselState.id) {
        await dataApiFetch(`/personeelswissels/${WisselState.id}`, { method: 'PUT', body });
        return WisselState.id;
    }
    const r = await dataApiFetch('/personeelswissels', { method: 'POST', body });
    WisselState.id = r.id;
    return r.id;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { wisselWeekUren };
}
