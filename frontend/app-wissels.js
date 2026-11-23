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
//  - verschijnt het voorbeeld VANZELF zodra elke stap ingevuld is, en toont het
//    per persoon en per week wat er gebeurt; per botsing beslis je per dag;
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
    bezig: false,
    gewijzigdNaVoorbeeld: true,
};
let _wisselTimer = null;
let _wisselVolgnummer = 0;

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

/** Is een stap volledig genoeg om een voorbeeld te berekenen? Puur. */
function wisselStapKlaar(s) {
    return !!(s && s.van && s.naar && s.vanaf && String(s.van) !== String(s.naar));
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
    return u ? u.name : '';
}
function wisselTeam(teamId) {
    // Kort: "Vlot 1 (Begeleiding)" wordt "Vlot 1". In de urentabel staat dit
    // onder de naam, en op een telefoon maakte de volle naam die kolom te breed.
    const naam = (DataStore.settings.teams || {})[teamId]?.name || teamId || '–';
    return String(naam).replace(/\s*\([^)]*\)\s*$/, '');
}
function wisselUren(u) {
    return u == null ? '–' : `${Number.isInteger(u) ? u : u.toFixed(1)}u`;
}
function wisselKortDatum(iso) {
    return parseDateOnly(iso).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
}
const W_ICOON = (naam, maat = 'sm') => (typeof IconHelper !== 'undefined' ? IconHelper.html(naam, maat) : '');

// ===== LIJST =====

const WISSEL_STATUS = {
    concept: ['Concept', 'wissel-status--concept'],
    bevestigd: ['Bevestigd', 'wissel-status--bevestigd'],
    uitgevoerd: ['Uitgevoerd', 'wissel-status--uitgevoerd'],
    teruggedraaid: ['Teruggedraaid', 'wissel-status--teruggedraaid'],
};

async function renderSettingsWissels(container) {
    if (WisselState.scherm === 'bewerken') return renderWisselBewerken(container);

    container.innerHTML = `
        <div class="settings-card wissel-kaart">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Personeelswissels</h3>
                    <p class="settings-card-subtitle">Iemand vertrekt of wisselt van team, en een ander neemt zijn rooster over.</p>
                </div>
                <button type="button" class="btn btn-primary" id="wissel-nieuw">${W_ICOON('plus', 'xs')} Nieuwe wissel</button>
            </div>
            <div class="settings-card-body" id="wissel-lijst"><p class="text-muted">Laden…</p></div>
        </div>`;
    IconHelper.init(container);
    container.querySelector('#wissel-nieuw').addEventListener('click', () => {
        wisselOpenNieuw();
        renderSettingsWissels(container);
    });

    const lijstEl = container.querySelector('#wissel-lijst');
    let data;
    try {
        data = await dataApiFetch('/personeelswissels');
    } catch (e) {
        lijstEl.innerHTML = `<div class="alert alert-error">${W_ICOON(ICONS.error)}<div>Kon de personeelswissels niet laden: ${escapeHtml(e.message)}</div></div>`;
        IconHelper.init(lijstEl);
        return;
    }
    const wissels = data.wissels || [];
    const los = data.losseOvernames || [];

    if (!wissels.length && !los.length) {
        lijstEl.innerHTML = `
            <div class="wissel-leeg">
                <div class="wissel-leeg-icoon">${W_ICOON('users', 'md')}</div>
                <p><strong>Nog geen personeelswissels.</strong></p>
                <ol class="wissel-uitleg">
                    <li><strong>Invullen</strong> — wie geeft zijn rooster door, aan wie, en vanaf wanneer. Meerdere mensen tegelijk mag.</li>
                    <li><strong>Controleren</strong> — je ziet per persoon en per week wat er verandert, en beslist bij elke botsing.</li>
                    <li><strong>Bevestigen</strong> — tot de eerste ingangsdatum kan je alles terugdraaien.</li>
                </ol>
            </div>`;
        IconHelper.init(lijstEl);
        return;
    }

    const stapRegel = (s) => `
        <li>
            <span class="wissel-persoon">${escapeHtml(s.vanNaam || wisselNaam(s.van))}</span>
            ${W_ICOON('arrow-right', 'xs')}
            <span class="wissel-persoon">${escapeHtml(s.naarNaam || wisselNaam(s.naar))}</span>
            <span class="text-muted">vanaf ${formatDateShortMetJaar(s.vanaf)}${s.blijftInDienst ? ` · ${escapeHtml(s.vanNaam || wisselNaam(s.van))} blijft in dienst` : ''}</span>
        </li>`;

    lijstEl.innerHTML = `
        ${wissels.map(w => {
            const [label, klasse] = WISSEL_STATUS[w.status] || WISSEL_STATUS.concept;
            const titel = w.omschrijving || 'Personeelswissel';
            const knoppen = w.status === 'concept'
                ? `<button type="button" class="btn btn-sm btn-secondary" data-wissel-weg="${w.id}" aria-label="Concept verwijderen">${W_ICOON('trash-2', 'xs')}</button>
                   <button type="button" class="btn btn-sm btn-primary" data-wissel-open="${w.id}">Verder bewerken</button>`
                : (w.kanTerugdraaien
                    ? `<button type="button" class="btn btn-sm btn-secondary" data-wissel-terug="${w.id}">${W_ICOON('undo-2', 'xs')} Terugdraaien</button>`
                    : '');
            const meta = w.status === 'concept'
                ? `Concept van ${escapeHtml(w.aangemaaktDoor || '')} — er is nog niets gewijzigd.`
                : w.status === 'uitgevoerd'
                    ? 'Uitgevoerd.'
                    : w.status === 'teruggedraaid'
                        ? 'Teruggedraaid.'
                        : `Bevestigd door ${escapeHtml(w.bevestigdDoor || '')}.${w.kanTerugdraaien ? ' Terug te draaien tot de eerste ingangsdatum.' : ''}`;
            return `<article class="wissel-item wissel-item--${w.status}">
                <div class="wissel-item-kop">
                    <h4>${escapeHtml(titel)}</h4>
                    <span class="wissel-status ${klasse}">${label}</span>
                </div>
                <ul class="wissel-stappen">${(w.stappen || []).map(stapRegel).join('')}</ul>
                <div class="wissel-item-voet">
                    <span class="text-muted text-xs">${meta}</span>
                    <span class="wissel-knoppen">${knoppen}</span>
                </div>
            </article>`;
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
        if (!await showConfirm('Deze personeelswissel volledig terugdraaien?\n\nDe diensten, activiteiten, concepten en verantwoordelijkheden gaan terug zoals ze waren, en er gebeurt niets op de ingangsdata. Wat iemand intussen zelf gewijzigd heeft, blijft staan.', 'Wissel terugdraaien', { danger: true, confirmText: 'Terugdraaien' })) return;
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
        bezig: false, gewijzigdNaVoorbeeld: true,
        stappen: [{ van: vanId ? String(vanId) : '', naar: '', vanaf: '', blijftInDienst: false }],
    });
}

function wisselOpenConcept(w) {
    Object.assign(WisselState, {
        scherm: 'bewerken', id: w.id, omschrijving: w.omschrijving || '', keuzes: w.keuzes || {},
        voorbeeld: null, voorbeeldFout: null, bezig: false, gewijzigdNaVoorbeeld: true,
        stappen: (w.stappen || []).map(s => ({ van: String(s.van), naar: String(s.naar), vanaf: s.vanaf, blijftInDienst: !!s.blijftInDienst })),
    });
}

/** Vanuit een account: een wissel starten met die persoon als vertrekker. */
function startPersoneelswisselVoor(gebruikerId) {
    wisselOpenNieuw(gebruikerId);
    if (typeof switchView === 'function') switchView('settings');
    if (typeof switchSettingsTab === 'function') switchSettingsTab('wissels');
}

// ===== BEWERKEN =====

function wisselStapUitleg(s) {
    const naam = wisselNaam(s.van);
    if (!naam) return 'Kies eerst wie zijn rooster doorgeeft.';
    const wanneer = s.vanaf ? ` op ${formatDateShortMetJaar(s.vanaf)}` : ' op de ingangsdatum';
    return s.blijftInDienst
        ? `${naam} blijft in dienst en wisselt van team of functie.`
        : `${naam} gaat uit dienst${wanneer}.`;
}

function renderWisselBewerken(container) {
    const mensen = getAllEmployees(true).slice().sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    const opties = (gekozen, leeg) => `<option value="">${leeg}</option>` + mensen.map(m =>
        `<option value="${m.id}" ${String(m.id) === String(gekozen) ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('');
    const vandaag = formatDateYYYYMMDD(new Date());

    container.innerHTML = `
        <div class="settings-card wissel-kaart">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <button type="button" class="wissel-terugknop" id="wissel-terug">${W_ICOON('chevron-left', 'xs')} Alle personeelswissels</button>
                    <h3>${WisselState.id ? 'Personeelswissel bewerken' : 'Nieuwe personeelswissel'}</h3>
                </div>
            </div>
            <div class="settings-card-body">
                <ol class="wissel-stappenbalk" aria-label="Voortgang">
                    <li class="actief" data-fase="1"><span>1</span> Invullen</li>
                    <li data-fase="2"><span>2</span> Controleren</li>
                    <li data-fase="3"><span>3</span> Bevestigen</li>
                </ol>

                <div class="form-group">
                    <label for="wissel-omschrijving">Naam van deze wissel <span class="text-muted">(optioneel)</span></label>
                    <input type="text" id="wissel-omschrijving" class="form-input" maxlength="200"
                        placeholder="bv. Teamwissel januari" value="${escapeHtml(WisselState.omschrijving)}">
                </div>

                <div class="wissel-stappen-invoer">
                    ${WisselState.stappen.map((s, i) => `
                        <section class="wissel-stap" data-i="${i}" aria-label="Stap ${i + 1}">
                            <div class="wissel-stap-kop">
                                <span class="wissel-stap-nr">Stap ${i + 1}</span>
                                ${WisselState.stappen.length > 1 ? `<button type="button" class="btn-icon-only wissel-stap-weg" data-i="${i}" aria-label="Stap ${i + 1} verwijderen" data-tooltip="Stap verwijderen">${W_ICOON('trash-2', 'sm')}</button>` : ''}
                            </div>
                            <div class="wissel-stap-velden">
                                <label class="wissel-veld">
                                    <span>Geeft rooster door</span>
                                    <select class="form-input" data-veld="van">${opties(s.van, 'Kies iemand')}</select>
                                </label>
                                <span class="wissel-pijl" aria-hidden="true">${W_ICOON('arrow-right', 'sm')}</span>
                                <label class="wissel-veld">
                                    <span>Neemt het over</span>
                                    <select class="form-input" data-veld="naar">${opties(s.naar, 'Kies iemand')}</select>
                                </label>
                                <label class="wissel-veld wissel-veld--datum">
                                    <span>Vanaf</span>
                                    <input type="date" class="form-input" data-veld="vanaf" value="${s.vanaf || ''}" min="${vandaag}">
                                </label>
                            </div>
                            <div class="wissel-blijft">
                                <label class="toggle-switch flex-shrink-0">
                                    <input type="checkbox" id="wissel-blijft-${i}" data-veld="blijftInDienst" ${s.blijftInDienst ? 'checked' : ''}>
                                    <span class="toggle-slider"></span>
                                </label>
                                <label for="wissel-blijft-${i}" class="cursor-pointer">
                                    Blijft in dienst
                                    <span class="wissel-blijft-uitleg text-muted" data-uitleg="${i}">${escapeHtml(wisselStapUitleg(s))}</span>
                                </label>
                            </div>
                        </section>`).join('')}
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="wissel-stap-erbij">${W_ICOON('plus', 'xs')} Nog iemand</button>

                <div id="wissel-voorbeeld-uit" class="wissel-voorbeeld-zone">${wisselVoorbeeldHtml()}</div>
            </div>
            <div class="wissel-actiebalk">
                <span class="wissel-actiebalk-tekst text-muted text-xs">Er verandert niets in de planning tot je bevestigt.</span>
                <div class="wissel-actiebalk-knoppen">
                    <button type="button" class="btn btn-secondary wissel-opslaan">Opslaan als concept</button>
                    <button type="button" class="btn btn-primary wissel-bevestig">Bevestigen</button>
                </div>
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
            const uitleg = container.querySelector(`[data-uitleg="${i}"]`);
            if (uitleg) uitleg.textContent = wisselStapUitleg(WisselState.stappen[i]);
            wisselPlanVoorbeeld(container);
        }));
    });
    container.querySelectorAll('.wissel-stap-weg').forEach(k => k.addEventListener('click', () => {
        WisselState.stappen.splice(Number(k.dataset.i), 1);
        renderWisselBewerken(container);
        wisselPlanVoorbeeld(container);
    }));
    container.querySelector('#wissel-stap-erbij').addEventListener('click', () => {
        WisselState.stappen.push({ van: '', naar: '', vanaf: WisselState.stappen.slice(-1)[0]?.vanaf || '', blijftInDienst: false });
        renderWisselBewerken(container);
        const nieuw = container.querySelector(`.wissel-stap[data-i="${WisselState.stappen.length - 1}"] select`);
        if (nieuw) nieuw.focus();
    });
    container.querySelector('.wissel-opslaan').addEventListener('click', () => wisselOpslaan(container));
    container.querySelector('.wissel-bevestig').addEventListener('click', () => wisselBevestig(container));
    wisselBindVoorbeeld(container);
    wisselZetFase(container);
    // Een geopend concept: meteen het voorbeeld tonen.
    if (!WisselState.voorbeeld && WisselState.stappen.every(wisselStapKlaar)) wisselPlanVoorbeeld(container, 0);
}

/** Stapbalk en knoppen volgen de toestand: bevestigen kan pas met een actueel voorbeeld. */
function wisselZetFase(container) {
    const klaar = WisselState.stappen.length > 0 && WisselState.stappen.every(wisselStapKlaar);
    const actueel = !!WisselState.voorbeeld && !WisselState.gewijzigdNaVoorbeeld && !WisselState.bezig;
    const fase = actueel ? 3 : (klaar ? 2 : 1);
    container.querySelectorAll('.wissel-stappenbalk li').forEach(li => {
        const f = Number(li.dataset.fase);
        li.classList.toggle('actief', f === fase);
        li.classList.toggle('klaar', f < fase);
    });
    const bevestig = container.querySelector('.wissel-bevestig');
    const opslaan = container.querySelector('.wissel-opslaan');
    if (bevestig) bevestig.disabled = !actueel;
    if (opslaan) opslaan.disabled = !klaar || WisselState.bezig;
    const tekst = container.querySelector('.wissel-actiebalk-tekst');
    if (tekst) {
        tekst.textContent = !klaar
            ? 'Vul elke stap volledig in: wie, aan wie en vanaf wanneer.'
            : (WisselState.bezig ? 'Voorbeeld wordt berekend…'
                : (WisselState.voorbeeldFout ? 'Los eerst het probleem hierboven op.'
                    : 'Er verandert niets in de planning tot je bevestigt.'));
    }
}

/** Het voorbeeld opnieuw berekenen, kort na de laatste wijziging. */
function wisselPlanVoorbeeld(container, wacht = 450) {
    WisselState.gewijzigdNaVoorbeeld = true;
    clearTimeout(_wisselTimer);
    const uit = container.querySelector('#wissel-voorbeeld-uit');
    if (!WisselState.stappen.length || !WisselState.stappen.every(wisselStapKlaar)) {
        WisselState.voorbeeld = null;
        WisselState.voorbeeldFout = null;
        if (uit) uit.innerHTML = wisselVoorbeeldHtml();
        wisselZetFase(container);
        return;
    }
    WisselState.bezig = true;
    if (uit) uit.classList.add('wissel-voorbeeld-zone--bezig');
    wisselZetFase(container);
    _wisselTimer = setTimeout(() => wisselHaalVoorbeeld(container), wacht);
}

async function wisselHaalVoorbeeld(container) {
    const nummer = ++_wisselVolgnummer;
    const uit = container.querySelector('#wissel-voorbeeld-uit');
    try {
        const v = await dataApiFetch('/personeelswissels/voorbeeld', {
            method: 'POST',
            body: JSON.stringify({ stappen: WisselState.stappen, keuzes: WisselState.keuzes }),
        });
        if (nummer !== _wisselVolgnummer) return; // een nieuwere aanvraag is onderweg
        WisselState.voorbeeld = v;
        WisselState.voorbeeldFout = null;
        WisselState.gewijzigdNaVoorbeeld = false;
    } catch (e) {
        if (nummer !== _wisselVolgnummer) return;
        WisselState.voorbeeld = null;
        WisselState.voorbeeldFout = e.message;
    }
    WisselState.bezig = false;
    if (uit) {
        uit.classList.remove('wissel-voorbeeld-zone--bezig');
        uit.innerHTML = wisselVoorbeeldHtml();
        IconHelper.init(uit);
    }
    wisselBindVoorbeeld(container);
    wisselZetFase(container);
}

// ===== VOORBEELD =====

function wisselVoorbeeldHtml() {
    if (WisselState.voorbeeldFout) {
        return `<div class="alert alert-error">${W_ICOON(ICONS.error)}<div>${escapeHtml(WisselState.voorbeeldFout)}</div></div>`;
    }
    const v = WisselState.voorbeeld;
    if (!v) {
        return WisselState.bezig
            ? '<p class="text-muted wissel-wacht">Voorbeeld wordt berekend…</p>'
            : '<p class="text-muted wissel-wacht">Het voorbeeld verschijnt hier zodra elke stap ingevuld is.</p>';
    }

    const totaal = v.volgorde.reduce((n, s) => n + s.verhuisd, 0);
    const botsingen = v.volgorde.reduce((n, s) => n + s.botsingen.length, 0);
    const waarschuwingen = v.volgorde.reduce((n, s) => n + (s.leeggemaakteDagen > 0 ? 1 : 0) + (s.onmiddellijk ? 1 : 0) + ((s.afwezigOp || []).length ? 1 : 0), 0);
    const pil = (tekst, soort = '') => `<span class="wissel-pil ${soort}">${tekst}</span>`;
    const samenvatting = [
        pil(`${totaal} ${totaal === 1 ? 'dienst verhuist' : 'diensten verhuizen'}`),
        botsingen ? pil(`${botsingen} ${botsingen === 1 ? 'botsing' : 'botsingen'} om te beslissen`, 'wissel-pil--let-op') : '',
        waarschuwingen ? pil(`${waarschuwingen} ${waarschuwingen === 1 ? 'waarschuwing' : 'waarschuwingen'}`, 'wissel-pil--let-op') : '',
    ].join('');

    const stappen = v.volgorde.map((s, i) => {
        const meldingen = [];
        if (s.leeggemaakteDagen > 0) {
            meldingen.push(`<div class="alert alert-warning">${W_ICOON(ICONS.warning)}<div><strong>${escapeHtml(s.van.naam)} heeft ${s.leeggemaakteDagen} ${s.leeggemaakteDagen === 1 ? 'dag' : 'dagen'} met de hand leeggemaakt</strong> vanaf ${formatDateShortMetJaar(s.vanaf)}. Die blijven ook bij ${escapeHtml(s.naar.naam)} leeg: plan die zelf in.</div></div>`);
        }
        if (s.afwezigOp && s.afwezigOp.length) {
            const n = s.afwezigOp.length;
            const datums = s.afwezigOp.slice(0, 6).map(d => wisselKortDatum(d)).join(', ') + (n > 6 ? ` en nog ${n - 6}` : '');
            meldingen.push(`<div class="alert alert-warning">${W_ICOON(ICONS.warning)}<div><strong>${escapeHtml(s.naar.naam)} is afwezig op ${n} ${n === 1 ? 'dag' : 'dagen'}</strong> waarop ${n === 1 ? 'een dienst' : 'diensten'} van ${escapeHtml(s.van.naam)} naar ${escapeHtml(s.naar.naam)} ${n === 1 ? 'gaat' : 'gaan'}: ${datums}. Iedereen houdt zijn eigen verlof, dus ${n === 1 ? 'die dienst staat' : 'die diensten staan'} straks met het verloflint in de planning: zoek er iemand voor.</div></div>`);
        }
        if (s.onmiddellijk) {
            meldingen.push(`<div class="alert alert-warning">${W_ICOON(ICONS.warning)}<div>Deze stap gaat <strong>meteen</strong> in en kan na bevestigen niet meer teruggedraaid worden.</div></div>`);
        }
        const botsingLijst = s.botsingen.length ? `
            <div class="wissel-botsingen">
                <p class="wissel-botsingen-titel">${s.botsingen.length === 1 ? 'Eén dag' : `${s.botsingen.length} dagen`} waarop ${escapeHtml(s.naar.naam)} al zelf werkt:</p>
                ${s.botsingen.map(b => `
                    <div class="wissel-botsing">
                        <div class="wissel-botsing-dag">
                            <strong>${formatDateShortMetJaar(b.datum)}</strong>
                            <span class="text-muted">${escapeHtml(s.naar.naam)} ${escapeHtml(b.eigen)} · ${escapeHtml(s.van.naam)} ${escapeHtml(b.overgenomen)}</span>
                        </div>
                        <div class="wissel-keuze" role="radiogroup" aria-label="Botsing op ${formatDate(b.datum)}">
                            <label class="wissel-keuze-optie"><input type="radio" name="keuze-${escapeHtml(b.sleutel)}" value="overnemen" data-sleutel="${escapeHtml(b.sleutel)}" ${b.keuze !== 'eigen' ? 'checked' : ''}><span>Dienst van ${escapeHtml(s.van.naam)}</span></label>
                            <label class="wissel-keuze-optie"><input type="radio" name="keuze-${escapeHtml(b.sleutel)}" value="eigen" data-sleutel="${escapeHtml(b.sleutel)}" ${b.keuze === 'eigen' ? 'checked' : ''}><span>Eigen dienst houden</span></label>
                        </div>
                    </div>`).join('')}
            </div>` : '';
        return `<li class="wissel-vb-stap">
            <span class="wissel-vb-nr" aria-hidden="true">${i + 1}</span>
            <div class="wissel-vb-inhoud">
                <p class="wissel-vb-zin"><strong>${escapeHtml(s.naar.naam)}</strong> neemt het rooster van <strong>${escapeHtml(s.van.naam)}</strong> over vanaf ${formatDateShortMetJaar(s.vanaf)}</p>
                <p class="wissel-vb-meta text-muted">${s.verhuisd} ${s.verhuisd === 1 ? 'dienst' : 'diensten'} · ${s.blijftInDienst ? `${escapeHtml(s.van.naam)} blijft in dienst` : `${escapeHtml(s.van.naam)} gaat uit dienst`}</p>
                ${meldingen.join('')}
                ${botsingLijst}
            </div>
        </li>`;
    }).join('');

    const maandagen = wisselMaandagen(v.venster.van, 6);
    const urenVan = (d) => (typeof calculateShiftHours === 'function' ? calculateShiftHours(d) : 0);
    const rijen = v.personen.map(p => {
        const voor = wisselWeekUren(v.diensten.voor[p.id], maandagen, urenVan);
        const na = wisselWeekUren(v.diensten.na[p.id], maandagen, urenVan);
        const wijzig = [];
        if (p.teamVoor !== p.teamNa) wijzig.push(`${escapeHtml(wisselTeam(p.teamVoor))} → ${escapeHtml(wisselTeam(p.teamNa))}`);
        else wijzig.push(escapeHtml(wisselTeam(p.teamNa)));
        if (p.urenVoor !== p.urenNa) wijzig.push(`${wisselUren(p.urenVoor)} → ${wisselUren(p.urenNa)}`);
        else wijzig.push(wisselUren(p.urenNa));
        if (p.uitDienst) wijzig.push(`uit dienst ${wisselKortDatum(p.vanaf)}`);
        const norm = p.urenNa;
        return `<tr>
            <th scope="row">
                <span class="wissel-tabel-naam">${escapeHtml(p.naam)}</span>
                <span class="wissel-tabel-sub">${wijzig.join(' · ')}</span>
            </th>
            ${voor.map((u, i) => {
                const n = na[i];
                const leeg = n === 0 && !p.uitDienst && u > 0;
                const klasse = u === n ? '' : (leeg ? 'wissel-cel--leeg' : 'wissel-cel--anders');
                return `<td class="${klasse}" ${leeg ? 'data-tooltip="Geen diensten die week"' : ''}>${u === n ? `${u}u` : `<span class="wissel-oud">${u}</span> <strong>${n}u</strong>`}</td>`;
            }).join('')}
        </tr>`;
    }).join('');

    return `
        <section class="wissel-voorbeeld" aria-label="Voorbeeld">
            <div class="wissel-voorbeeld-kop">
                <h4>Zo ziet het eruit</h4>
                <div class="wissel-samenvatting">${samenvatting}</div>
            </div>
            <p class="text-muted text-sm">In deze volgorde, ook als je de stappen anders ingaf:</p>
            <ol class="wissel-volgorde">${stappen}</ol>
            <h5 class="wissel-tabel-titel">Uren per week in de planning</h5>
            <div class="wissel-tabel-wrap">
                <table class="wissel-tabel">
                    <thead><tr><th scope="col">Wie</th>${maandagen.map(m => `<th scope="col">${wisselKortDatum(m)}</th>`).join('')}</tr></thead>
                    <tbody>${rijen}</tbody>
                </table>
            </div>
            <p class="text-muted text-xs">Doorgestreept = ervoor, vet = erna. Team en contract gaan over op de ingangsdatum. Rollen veranderen niet.</p>
        </section>`;
}

function wisselBindVoorbeeld(container) {
    const uit = container.querySelector('#wissel-voorbeeld-uit');
    if (!uit) return;
    uit.querySelectorAll('input[type="radio"][data-sleutel]').forEach(r => r.addEventListener('change', () => {
        WisselState.keuzes[r.dataset.sleutel] = r.value;
        // De uren hangen van de keuze af: opnieuw rekenen.
        wisselPlanVoorbeeld(container, 0);
    }));
}

async function wisselOpslaan(container) {
    try {
        await wisselBewaar();
        showToast('Concept bewaard. Er is nog niets gewijzigd in de planning.', 'success');
        WisselState.scherm = 'lijst';
        renderSettingsWissels(container);
    } catch (e) { showToast(`Bewaren mislukt: ${e.message}`, 'error'); }
}

async function wisselBevestig(container) {
    const v = WisselState.voorbeeld;
    if (!v || WisselState.gewijzigdNaVoorbeeld) return;
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
    module.exports = { wisselWeekUren, wisselStapKlaar };
}
