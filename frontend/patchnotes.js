// HET VLOT ROOSTERPLANNING - "WAT IS ER NIEUW"
//
// Na een update krijgt iedereen één keer een venster met wat er veranderd is,
// de eerste keer dat hij de app opent. Daarna niet meer, tot er een nieuwe
// versie bijkomt. Via "Wat is er nieuw" onderaan de zijbalk is het altijd
// terug te lezen.
//
// EEN NIEUWE VERSIE TOEVOEGEN: zet hem BOVENAAN in PATCH_NOTES, met een nieuwe
// `versie`. Dat is alles — wie de vorige al zag, krijgt de nieuwe vanzelf.
// Schrijf voor collega's, niet voor ontwikkelaars: wat ze zien en wat ze
// ermee kunnen, geen issuenummers.
//
// Wat gezien is, staat in localStorage per GEBRUIKER: twee collega's op een
// gedeelde laptop hebben elk hun eigen browserprofiel (#159), maar ook op
// hetzelfde profiel ziet de tweede het venster dan nog. Is localStorage
// geblokkeerd, dan verschijnt het venster telkens; dat is de veilige kant.

const PATCH_NOTES = [
    {
        versie: '2026-11',
        titel: 'Nieuw in het rooster',
        datum: 'november 2026',
        secties: [
            {
                kop: 'Zie meteen wie afwezig is',
                punten: [
                    'Heeft een collega verlof of is hij ziek, dan staat dat als een rood lintje op zijn dienst. Je hoeft er niet meer met de muis op te gaan staan.',
                    'Ook op een dag zonder dienst zie je in de planning dat iemand afwezig is.',
                    'Een dag zonder dienst heet nu gewoon "Vrij". Het groene "Beschikbaar" is weg, omdat de app niet kan weten of je echt kan werken.',
                    'Bij afwezigheid kies je nu uit Verlof, Ziekte, Overuren opnemen of Andere.',
                ],
            },
            {
                kop: 'Activiteiten in je dienst',
                punten: [
                    'Een vergadering of overleg staat als een wit pilletje in je dienst, met een pictogram en de uren (bv. 13–16u).',
                    'In de dagweergave staat het pilletje op de juiste uren, met de omschrijving erbij.',
                    'De uren van een dienst worden niet meer afgeknipt.',
                    'Een activiteit kan nu in één keer voor meerdere collega\'s aangemaakt worden, gegroepeerd per team.',
                    'Een vergadering verschijnt niet meer dubbel nadat het rooster opnieuw is toegepast.',
                ],
            },
            {
                kop: 'Activiteit voor iedereen',
                punten: [
                    'Een brandoefening, teamdag of kerstfeest staat nu bovenaan de dag in de planning, op je beginscherm en in je gekoppelde agenda.',
                ],
            },
            {
                kop: 'Een dienst overnemen',
                punten: [
                    'Druk je op "Overnemen", dan zie je eerst je hele week: je andere diensten, hoeveel uur je dan werkt en hoeveel rust je hebt voor en na. Pas daarna bevestig je.',
                ],
            },
            {
                kop: 'Je agenda (Outlook, Google, telefoon)',
                punten: [
                    'Een gewijzigde dienst wordt nu ook in je agenda bijgewerkt. Vroeger bleven soms de oude uren staan.',
                    'Je activiteiten staan ook in je agenda. Wil je er de omschrijving bij, zet dat aan in je profiel.',
                    'Een dienst op een dag waarop je verlof hebt of ziek bent, verdwijnt uit je agenda.',
                    'Je agenda-app haalt dit pas na een paar uur op.',
                ],
            },
        ],
        voetnoot: 'Reageert de app niet na een update? Herlaad de pagina één keer (Ctrl+Shift+R, of op je telefoon de app sluiten en opnieuw openen).',
    },
];

function patchNotesSleutel(gebruikerId) {
    return `hetvlot_patchnotes_gezien_${gebruikerId}`;
}

/** Moet het venster verschijnen? Puur, zodat het te toetsen is. */
function moetPatchNotesTonen(notes, gezienVersie) {
    if (!notes || !notes.length) return false;
    return gezienVersie !== notes[0].versie;
}

function patchNotesHtml(notes) {
    const esc = (t) => (typeof escapeHtml === 'function' ? escapeHtml(t) : String(t));
    const n = notes[0];
    const secties = n.secties.map(s => `
        <section class="patchnotes-sectie">
            <h3>${esc(s.kop)}</h3>
            <ul>${s.punten.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
        </section>`).join('');
    return `
        <p class="patchnotes-datum">${esc(n.datum)}</p>
        ${secties}
        ${n.voetnoot ? `<p class="patchnotes-voetnoot">${esc(n.voetnoot)}</p>` : ''}`;
}

function leesGezienVersie(gebruikerId) {
    try { return localStorage.getItem(patchNotesSleutel(gebruikerId)); } catch (e) { return null; }
}

function bewaarGezienVersie(gebruikerId, versie) {
    try { localStorage.setItem(patchNotesSleutel(gebruikerId), versie); } catch (e) { /* zie bovenaan */ }
}

/**
 * Toont het venster. `altijd` = ook als deze versie al gezien is (via de knop
 * in de zijbalk). Sluiten — met de knop, Escape of buiten het venster klikken —
 * telt als gezien.
 */
function toonPatchNotes(altijd = false) {
    const modal = document.getElementById('patchnotes-modal');
    const inhoud = document.getElementById('patchnotes-inhoud');
    const ik = (typeof AppState !== 'undefined' && AppState.currentUser) ? AppState.currentUser.id : null;
    if (!modal || !inhoud || ik == null || !PATCH_NOTES.length) return;
    if (!altijd && !moetPatchNotesTonen(PATCH_NOTES, leesGezienVersie(ik))) return;

    document.getElementById('patchnotes-titel').textContent = PATCH_NOTES[0].titel;
    inhoud.innerHTML = patchNotesHtml(PATCH_NOTES);
    inhoud.scrollTop = 0;
    toonModal(modal);
    const ok = document.getElementById('patchnotes-ok');
    setTimeout(() => ok && ok.focus(), 50);

    const sluit = () => {
        bewaarGezienVersie(ik, PATCH_NOTES[0].versie);
        verbergModal(modal);
        ok.removeEventListener('click', sluit);
        modal.removeEventListener('mousedown', bijAchtergrond);
        document.removeEventListener('keydown', bijToets);
    };
    const bijAchtergrond = (e) => { if (e.target === modal) sluit(); };
    const bijToets = (e) => { if (e.key === 'Escape') sluit(); };
    ok.addEventListener('click', sluit);
    modal.addEventListener('mousedown', bijAchtergrond);
    document.addEventListener('keydown', bijToets);
}

// De knop in de zijbalk hangt HIER en niet in setupEventListeners (#412).
if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('#patchnotes-btn')) {
            toonPatchNotes(true);
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PATCH_NOTES, moetPatchNotesTonen, patchNotesHtml, patchNotesSleutel };
}
