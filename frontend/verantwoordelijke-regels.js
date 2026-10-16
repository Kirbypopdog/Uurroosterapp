/**
 * Wie is er weekend- of vakantieverantwoordelijke?
 *
 * Deze regels stonden in `data.js` en waren daarmee alleen in de BROWSER
 * beschikbaar. Zodra de server een herinnering moet versturen, moet hij
 * hetzelfde antwoord kunnen geven — en twee kopieën van deze logica is precies
 * de fout die CLAUDE.md bij de foutmonitoring beschrijft: ze lopen uiteen en
 * niemand merkt het.
 *
 * Daarom staat het hier één keer, als PURE functies. Geen DataStore, geen
 * globals, geen fetch. De aanroeper geeft expliciet mee wat de regels nodig
 * hebben:
 *
 *   bepaalVerantwoordelijke({
 *     weekStart,              // 'YYYY-MM-DD', de maandag van de week
 *     medewerkers,            // [{id, name, mainTeam, role, active}]
 *     rotatie,                // settings.responsibleRotation
 *     vakantieperiodes,       // settings.holidayPeriods
 *     roosterpatroon,         // settings.schedulePattern
 *     referentieDatumTweewekelijks // settings.biWeeklyReferenceDate (terugval)
 *   })
 *
 * Dat is met opzet omslachtig. De frontend noemt dit veld `schedulePattern` en
 * de database `schedule_pattern`; wie een settings-blob doorgeeft en de
 * verkeerde naam gebruikt, krijgt stilletjes de STANDAARD terug — een
 * omgekeerde weekendcyclus, zonder één foutmelding. Door de velden hier bij
 * naam te vragen moet elke aanroeper die vertaling zelf en bewust doen.
 *
 * De volgorde van de regels: handmatige toewijzing → vakantieweek → open
 * weekend → rotatie. Zie CLAUDE.md voor waaróm een vakantieweek uitgepraat is
 * en niet terugvalt op de rotatie.
 */
(function (root) {
    'use strict';

    const DAG_MS = 86400000;
    const WEEK_MS = 7 * DAG_MS;

    // ===== datumhulp, bewust eigen kopieën =====
    // Klein, puur en zonder afhankelijkheden, zodat dit bestand in een browser
    // én in Node werkt zonder dat er eerst iets anders geladen moet zijn.

    function alsDatum(waarde) {
        if (waarde instanceof Date) {
            const d = new Date(waarde.getTime());
            d.setHours(0, 0, 0, 0);
            return d;
        }
        const tekst = String(waarde).split('T')[0];
        const [j, m, d] = tekst.split('-').map(Number);
        if (!j || !m || !d) return null;
        return new Date(j, m - 1, d, 0, 0, 0, 0);
    }

    function alsTekst(datum) {
        const d = alsDatum(datum);
        if (!d) return null;
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
    }

    function maandagVan(datum) {
        const d = alsDatum(datum);
        if (!d) return null;
        // getDay(): 0 = zondag. Een zondag hoort bij de week die de maandag
        // ervóór begon, vandaar de -6.
        const verschuiving = d.getDay() === 0 ? -6 : 1 - d.getDay();
        d.setDate(d.getDate() + verschuiving);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function plusDagen(datum, aantal) {
        const d = alsDatum(datum);
        d.setDate(d.getDate() + aantal);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // Hele weken uit een verschil in milliseconden: AFRONDEN, niet afkappen.
    // Twee lokale middernachten liggen over de overgang naar zomertijd 6,958
    // dagen uit elkaar in plaats van 7, en Math.floor telt daar een week te
    // weinig. Zie CLAUDE.md, "Uurwisseling en vandaag".
    function helenWeken(vanaf, tot) {
        return Math.round((alsDatum(tot).getTime() - alsDatum(vanaf).getTime()) / WEEK_MS);
    }

    // ===== de regels =====

    function vakantieOp(datum, vakantieperiodes) {
        const d = alsDatum(datum);
        if (!d) return null;
        return (vakantieperiodes || []).find(p => {
            const start = alsDatum(p.startDate);
            const eind = alsDatum(p.endDate);
            return start && eind && d >= start && d <= eind;
        }) || null;
    }

    /** Het patroon dat op die datum GOLD; een nieuw patroon kan later ingaan. */
    function patroonOp(datum, roosterpatroon, referentieDatumTweewekelijks) {
        if (roosterpatroon && roosterpatroon.cycleLength) {
            if (datum && roosterpatroon.effectiveFrom && roosterpatroon.previousPattern) {
                if (alsDatum(datum) < alsDatum(roosterpatroon.effectiveFrom)) {
                    return roosterpatroon.previousPattern;
                }
            }
            return roosterpatroon;
        }
        // Terugval op de oude tweewekelijkse opzet.
        return {
            cycleLength: 2,
            referenceDate: referentieDatumTweewekelijks || '2025-01-06',
            weeks: {
                '1': { closedDays: [6, 0] },
                '2': { closedDays: [] }
            }
        };
    }

    function weeknummerInCyclus(datum, roosterpatroon, referentieDatumTweewekelijks) {
        const patroon = patroonOp(datum, roosterpatroon, referentieDatumTweewekelijks);
        const cyclus = patroon.cycleLength || 2;
        const refMaandag = maandagVan(patroon.referenceDate || referentieDatumTweewekelijks || '2025-01-06');
        const ditMaandag = maandagVan(datum);
        const rest = helenWeken(refMaandag, ditMaandag) % cyclus;
        return (rest < 0 ? rest + cyclus : rest) + 1;
    }

    function geslotenDagenVanWeek(datum, roosterpatroon, referentieDatumTweewekelijks) {
        const patroon = patroonOp(datum, roosterpatroon, referentieDatumTweewekelijks);
        const nr = weeknummerInCyclus(datum, roosterpatroon, referentieDatumTweewekelijks);
        return (patroon.weeks && patroon.weeks[String(nr)] && patroon.weeks[String(nr)].closedDays) || [];
    }

    /** Staat het weekend van deze week OPEN? (zaterdag noch zondag gesloten) */
    function weekendIsOpen(weekStart, ctx) {
        const dicht = geslotenDagenVanWeek(weekStart, ctx.roosterpatroon, ctx.referentieDatumTweewekelijks);
        return !dicht.includes(6) && !dicht.includes(0);
    }

    /** Valt er ergens in deze week een vakantiedag? */
    function weekRaaktVakantie(weekStart, ctx) {
        for (let i = 0; i < 7; i++) {
            if (vakantieOp(plusDagen(weekStart, i), ctx.vakantieperiodes)) return true;
        }
        return false;
    }

    /**
     * Een week telt mee voor de rotatie als er iets te verantwoorden valt:
     * een open weekend, of een vakantie. Dit is de oude
     * `isWeekendOrHolidayWeek`.
     */
    function weekHeeftVerantwoordelijke(weekStart, ctx) {
        return weekendIsOpen(weekStart, ctx) || weekRaaktVakantie(weekStart, ctx);
    }

    /**
     * Vergelijk id's ALS TEKST. Een id komt als getal uit de API maar als
     * string uit elke <select>, en `assignments` en `weeklyResponsibles`
     * bewaren precies zo'n keuze. `120 === "120"` is false, en dat liet de
     * vakantie-override zonder een spoor terugvallen op de rotatie.
     */
    function zoekMedewerker(id, medewerkers) {
        if (id === null || id === undefined || id === '') return null;
        const gezocht = String(id);
        return (medewerkers || []).find(m => String(m.id) === gezocht) || null;
    }

    /** Wie mag er in de rotatie meedraaien: actief, geen admin, juiste team. */
    function rotatieKandidaten(ctx) {
        const teams = (ctx.rotatie && ctx.rotatie.eligibleTeams) || ['vlot1', 'vlot2', 'cargo'];
        return (ctx.medewerkers || [])
            .filter(m => m.role !== 'admin' && m.active !== false && teams.includes(m.mainTeam))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    function handmatigToegewezen(weekStart, ctx) {
        const toewijzingen = (ctx.rotatie && ctx.rotatie.assignments) || {};
        const sleutel = alsTekst(weekStart);
        if (!sleutel || !toewijzingen[sleutel]) return null;
        return zoekMedewerker(toewijzingen[sleutel], ctx.medewerkers);
    }

    /**
     * Tijdens een vakantie staat de verantwoordelijke PER WEEK, aangeduid in de
     * roosterbouwer. Een vakantieweek is daarmee UITGEPRAAT: staat er niemand,
     * dan is er niemand, en valt dit bewust NIET terug op de rotatie.
     *
     * Geeft {gevonden: true, persoon} zodra de week in een vakantie valt, ook
     * als `persoon` null is — want dat verschil is precies de uitspraak.
     */
    function vakantieVerantwoordelijke(weekStart, ctx) {
        for (let i = 0; i < 7; i++) {
            const dag = plusDagen(weekStart, i);
            const periode = vakantieOp(dag, ctx.vakantieperiodes);
            if (!periode) continue;

            if (periode.weeklyResponsibles) {
                const weekNr = helenWeken(maandagVan(periode.startDate), maandagVan(dag)) + 1;
                const id = periode.weeklyResponsibles[String(weekNr)];
                return { gevonden: true, persoon: id ? zoekMedewerker(id, ctx.medewerkers) : null, periode, weekNr };
            }
            if (periode.responsibleId) {
                // Ouder model: één persoon voor de hele periode.
                return { gevonden: true, persoon: zoekMedewerker(periode.responsibleId, ctx.medewerkers), periode };
            }
            return { gevonden: true, persoon: null, periode };
        }
        return { gevonden: false, persoon: null, periode: null };
    }

    function rotatieVerantwoordelijke(weekStart, ctx) {
        const rotatie = ctx.rotatie;
        if (!rotatie) return null;

        // Een nieuwe rotatie kan op een datum ingaan; daarvóór geldt de oude.
        let actief = rotatie;
        if (rotatie.effectiveFrom && rotatie.previousRotation) {
            if (alsDatum(weekStart) < alsDatum(rotatie.effectiveFrom)) {
                actief = Object.assign({}, rotatie, rotatie.previousRotation);
            }
        }
        if (!actief.rotationStart || !actief.rotationStartEmployee) return null;

        const kandidaten = rotatieKandidaten(ctx);
        if (kandidaten.length === 0) return null;

        const startIndex = kandidaten.findIndex(m => String(m.id) === String(actief.rotationStartEmployee));
        if (startIndex === -1) return kandidaten[0];

        const start = alsDatum(actief.rotationStart);
        const doel = alsDatum(weekStart);
        if (doel < start) return null;

        // Een vakantieweek verbruikt geen beurt: na de vakantie gaat de rotatie
        // verder waar hij gebleven was.
        let beurten = 0;
        let loop = new Date(start.getTime());
        while (loop.getTime() < doel.getTime()) {
            if (!weekRaaktVakantie(loop, ctx) && weekHeeftVerantwoordelijke(loop, ctx)) beurten++;
            loop = plusDagen(loop, 7);
        }
        return kandidaten[(startIndex + beurten) % kandidaten.length];
    }

    /**
     * De enige functie die je nodig hebt. Geeft de medewerker terug, of null.
     * `uitleg()` hieronder geeft hetzelfde antwoord mét de reden, voor een mail
     * die moet kunnen zeggen waaróm er niemand is.
     */
    function bepaalVerantwoordelijke(ctx) {
        return uitleg(ctx).persoon;
    }

    function uitleg(ctx) {
        const weekStart = maandagVan(ctx.weekStart);
        if (!weekStart) return { persoon: null, reden: 'ongeldige-week' };
        const basis = {
            weekStart: ctx.weekStart,
            medewerkers: ctx.medewerkers,
            rotatie: ctx.rotatie,
            vakantieperiodes: ctx.vakantieperiodes,
            roosterpatroon: ctx.roosterpatroon,
            referentieDatumTweewekelijks: ctx.referentieDatumTweewekelijks
        };

        const handmatig = handmatigToegewezen(weekStart, basis);
        if (handmatig) return { persoon: handmatig, reden: 'handmatig' };

        const vakantie = vakantieVerantwoordelijke(weekStart, basis);
        if (vakantie.gevonden) {
            return {
                persoon: vakantie.persoon,
                reden: vakantie.persoon ? 'vakantieweek' : 'vakantieweek-niemand-aangeduid',
                vakantie: vakantie.periode ? vakantie.periode.name : null,
                vakantieWeek: vakantie.weekNr || null
            };
        }

        if (!weekendIsOpen(weekStart, basis)) {
            return { persoon: null, reden: 'weekend-gesloten' };
        }

        const uitRotatie = rotatieVerantwoordelijke(weekStart, basis);
        return {
            persoon: uitRotatie,
            reden: uitRotatie ? 'rotatie' : 'rotatie-levert-niemand'
        };
    }

    const api = {
        bepaalVerantwoordelijke,
        uitleg,
        weekHeeftVerantwoordelijke,
        weekendIsOpen,
        weekRaaktVakantie,
        rotatieKandidaten,
        maandagVan,
        alsTekst
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.VerantwoordelijkeRegels = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
