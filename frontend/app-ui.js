// HET VLOT ROOSTERPLANNING - UI HELPERS (modals, toast, tooltips, overlays)

// ===== MODAL FOCUS TRAP =====
const FocusTrap = {
    _activeModal: null,
    _handler: null,
    _previousFocus: null,

    activate(modal) {
        this.deactivate();
        this._activeModal = modal;
        this._previousFocus = document.activeElement;

        this._handler = (e) => {
            // #191: de FocusTrap ving alleen Tab af. Escape deed nergens iets,
            // en omdat de sluitknop van sommige vensters een span is en dus
            // geen tabstop, kon je met het toetsenbord niet meer uit een
            // geopend venster komen. Dat gold voor elk venster in de app: de
            // meldingenmodal, de dienstmodal, het medewerkersvenster, het
            // accountvenster en het afwezigheidsvenster.
            //
            // We klikken de eigen sluitknop van het venster aan in plaats van
            // het gewoon te verbergen, zodat de opruimlogica van dat venster
            // draait (formulier leegmaken, state terugzetten).
            if (e.key === 'Escape') {
                e.preventDefault();
                const closer = modal.querySelector('.modal-close')
                    || [...modal.querySelectorAll('button')]
                        .find(b => /annul/i.test(b.textContent || ''));
                if (closer) {
                    closer.click();
                } else {
                    modal.classList.add('hidden');
                    this.deactivate();
                }
                return;
            }

            if (e.key === 'Tab') {
                const focusable = modal.querySelectorAll(
                    'button:not([disabled]):not(.hidden), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
                );
                const visible = [...focusable].filter(el => el.offsetParent !== null);
                if (visible.length === 0) return;

                const first = visible[0];
                const last = visible[visible.length - 1];

                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };
        document.addEventListener('keydown', this._handler);

        // Focus first focusable element
        const firstFocusable = modal.querySelector('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])');
        if (firstFocusable) setTimeout(() => firstFocusable.focus(), 50);
    },

    deactivate() {
        if (this._handler) {
            document.removeEventListener('keydown', this._handler);
            this._handler = null;
        }
        // #362: het venster wordt vaak geopend door op een div te klikken die
        // zelf geen focus kan krijgen, dus _previousFocus was document.body en
        // de tabvolgorde begon daarna weer helemaal vooraan. Sinds die kaarten
        // en cellen focusbaar zijn (#274, #275, #277, #190) klopt dit meestal
        // vanzelf; blijft er toch niets bruikbaars over, dan zetten we de focus
        // op het eerste element van de zichtbare view in plaats van op body.
        //
        // activate() roept deactivate() eerst aan om een eventuele vorige val
        // op te ruimen. Stond er op dat moment geen val open, dan mag hier
        // niets met de focus gebeuren. Anders verspringt de focus bij het
        // openen van elk venster naar het eerste element van de view, en wordt
        // dat meteen het punt waar we na het sluiten naartoe terugkeren.
        const hadVal = !!this._activeModal;
        const terug = this._previousFocus;
        if (!hadVal) { this._previousFocus = null; return; }
        const bruikbaar = terug && terug.focus && terug !== document.body && terug.isConnected;
        try {
            if (bruikbaar) {
                terug.focus();
            } else {
                const view = document.querySelector('.view.active');
                const eerste = view?.querySelector(
                    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
                );
                if (eerste) eerste.focus();
            }
        } catch (e) { /* element may be gone */ }
        this._activeModal = null;
        this._previousFocus = null;
    }
};

// #269: de vensters die in index.html staan worden door de app hergebruikt en
// mogen dus alleen verborgen worden, niet verwijderd. Ze staan er allemaal bij
// het opstarten, dus één momentopname volstaat om ze te onderscheiden van de
// vensters die JavaScript later invoegt.
const VASTE_VENSTERS = new Set();

// Auto-activate focus trap when modals become visible
function initModalFocusTrap() {
    document.querySelectorAll('.modal').forEach(m => VASTE_VENSTERS.add(m));

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            // #239: een venster dat later door JavaScript wordt ingevoegd is
            // meteen zichtbaar; er komt geen class-wijziging meer achteraan.
            // Zonder deze tak bleven de ongeveer twaalf JS-vensters (verlof,
            // instellingen, concepten, medewerkers) volledig onbewaakt en liep
            // de focus er bij het tabben achterlangs de pagina in.
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    const modals = node.classList?.contains('modal')
                        ? [node]
                        : [...(node.querySelectorAll?.('.modal') || [])];
                    modals.forEach(modal => {
                        observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
                        if (!modal.classList.contains('hidden')) FocusTrap.activate(modal);
                    });
                });
                mutation.removedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    if (FocusTrap._activeModal &&
                        (node === FocusTrap._activeModal || node.contains?.(FocusTrap._activeModal))) {
                        FocusTrap.deactivate();
                    }
                });
                continue;
            }

            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                const el = mutation.target;
                if (!el.classList.contains('modal')) continue;
                if (el.classList.contains('hidden')) {
                    if (FocusTrap._activeModal === el) FocusTrap.deactivate();
                } else {
                    FocusTrap.activate(el);
                }
            }
        }
    });

    document.querySelectorAll('.modal').forEach(modal => {
        observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });

    // #239: en de body in de gaten houden voor vensters die er later bij komen.
    observer.observe(document.body, { childList: true, subtree: true });
}

// ===== KLIKBARE DIVS TOETSENBORDBEDIENBAAR =====
//
// Grote delen van de app renderen klikbare elementen als div met een
// click-listener: dienstblokken en lege dagcellen in de planning, cellen in
// het afwezigheidsraster, medewerkerskaarten, verlofrondekaarten en de
// uitklapkoppen in Ruilen. Een div staat niet in de tabvolgorde en reageert
// niet op Enter of spatie, dus met het toetsenbord was daar niet bij te komen
// (#190, #274, #275, #277, #367).
//
// Die render-plekken geven nu `role="button"` en `tabindex="0"` mee. Deze ene
// gedelegeerde handler maakt Enter en spatie daar gelijk aan een klik, voor
// alle huidige én toekomstige plekken tegelijk. Echte buttons en links doen
// dit zelf al, die slaan we over.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = e.target.closest?.('[role="button"]');
    if (!el) return;
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT') return;
    // Spatie scrollt de pagina; Enter kan een formulier indienen.
    e.preventDefault();
    el.click();
});

// ===== TOAST NOTIFICATION SYSTEM =====
const ToastManager = {
    container: null,
    toasts: [],
    maxToasts: 5,

    init() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'toast-container';
            // #276: de meldingen stonden in geen enkele live region, dus een
            // schermlezer kreeg niet te horen of het opslaan van een dienst
            // gelukt of mislukt was. De stapel is nu zelf een beleefde live
            // region: nieuwe meldingen worden voorgelezen zodra de gebruiker
            // uitgesproken is. Fouten en waarschuwingen krijgen in render()
            // role="alert" op de melding zelf, wat ze dringend maakt.
            this.container.setAttribute('role', 'status');
            this.container.setAttribute('aria-live', 'polite');
            this.container.setAttribute('aria-relevant', 'additions');
            this.container.setAttribute('aria-atomic', 'false');
            document.body.appendChild(this.container);
        }
    },

    show(message, type = 'info', duration = null) {
        this.init();

        // Auto-duration based on type.
        //
        // #271: dit stond op `[type] || 4000`. Voor 'error' geeft de lookup
        // 0 terug (bedoeld als "nooit automatisch sluiten"), maar 0 is falsy
        // in JS, dus `0 || 4000` viel terug op 4000. Elke error-toast in de
        // hele app verdween daardoor na vier seconden, ondanks de comment
        // hieronder en ondanks dat de gebruiker hem nooit zelf wegklikte.
        // ?? in plaats van || behoudt 0 als geldige waarde en valt alleen
        // terug op 4000 wanneer het type echt onbekend is (undefined).
        if (duration === null) {
            duration = {
                'success': 3000,
                'info': 4000,
                'warning': 5000,
                'error': 0 // Don't auto-dismiss errors
            }[type] ?? 4000;
        }

        // Remove oldest if at max
        if (this.toasts.length >= this.maxToasts) {
            const oldest = this.toasts.shift();
            this.remove(oldest.id);
        }

        const id = Date.now() + Math.random();
        const toast = { id, message, type, duration };
        this.toasts.push(toast);

        this.render(toast);

        // Auto-dismiss if duration > 0
        if (duration > 0) {
            setTimeout(() => this.remove(id), duration);
        }

        return id;
    },

    render(toast) {
        const iconMap = {
            success: ICONS.success,
            error: ICONS.error,
            warning: ICONS.warning,
            info: ICONS.info
        };

        const el = document.createElement('div');
        el.className = `toast toast-${toast.type}`;
        el.dataset.toastId = toast.id;
        // Een fout of waarschuwing onderbreekt wat de schermlezer aan het
        // voorlezen is; een bevestiging of tip wacht netjes haar beurt af.
        const dringend = toast.type === 'error' || toast.type === 'warning';
        el.setAttribute('role', dringend ? 'alert' : 'status');
        // De icoontjes zijn puur decoratief en zouden anders als "afbeelding"
        // tussen de meldingstekst door worden voorgelezen.
        el.innerHTML = `
            <span class="toast-icon" aria-hidden="true">${IconHelper.html(iconMap[toast.type], 'sm')}</span>
            <span class="toast-message">${escapeHtml(toast.message)}</span>
            <button type="button" class="toast-close" aria-label="Melding sluiten" onclick="ToastManager.remove(${toast.id})">${IconHelper.html(ICONS.close, 'xs')}</button>
        `;

        this.container.appendChild(el);
        IconHelper.init(el);

        // Trigger animation
        setTimeout(() => el.classList.add('toast-show'), 10);
    },

    remove(id) {
        const el = this.container.querySelector(`[data-toast-id="${id}"]`);
        if (el) {
            el.classList.remove('toast-show');
            el.classList.add('toast-hide');
            setTimeout(() => {
                el.remove();
                this.toasts = this.toasts.filter(t => t.id !== id);
            }, 300);
        }
    }
};

// Global helper function
function showToast(message, type = 'info', duration = null) {
    return ToastManager.show(message, type, duration);
}

// ===== USER-FRIENDLY ERROR MESSAGES =====
function getUserFriendlyError(err) {
    if (!err) return 'Er is een onbekende fout opgetreden.';
    const msg = err.message || err.error || String(err);
    if (msg.includes('constraint')) return 'Dit kan niet worden opgeslagen. Controleer de gegevens.';
    if (msg.includes('duplicate')) return 'Deze waarde bestaat al.';
    if (msg.includes('not found') || msg.includes('404')) return 'Dit item werd niet gevonden.';
    if (msg.includes('unauthorized') || msg.includes('401')) return 'Je bent niet gemachtigd voor deze actie.';
    // #341: de backend antwoordt op een 403 met de kale Engelse tekst
    // "Forbidden", die zo in een toast belandde. Onvertaald en zonder uitleg
    // wat de gebruiker dan wél kan doen.
    if (msg === 'Forbidden' || msg.includes('Forbidden') || msg.includes('403')) {
        return 'Je hebt geen rechten voor deze actie. Alleen een beheerder kan dit.';
    }
    if (msg.includes('Onvoldoende rechten')) return msg;
    // #360: de backend antwoordt bij een onverwachte fout met de kale tekst
    // "Server error", die zo in de dienstmodal belandde. Onvertaald, en zonder
    // te zeggen wat de gebruiker dan kan doen.
    if (msg === 'Server error' || msg === 'Internal server error' || msg.includes('500')) {
        return 'De server kon dit niet verwerken. Probeer het opnieuw; blijft het misgaan, meld het dan.';
    }
    if (msg.includes('Onverwacht antwoord')) return msg;
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('Failed to fetch')) return 'Verbindingsfout. Controleer je internetverbinding.';
    if (msg.includes('Te veel verzoeken')) return msg;
    return msg;
}

// ===== DATA LOADING OVERLAY =====
function showDataLoading(message = 'Bezig met opslaan...') {
    const overlay = document.getElementById('data-loading-overlay');
    if (overlay) {
        const textEl = overlay.querySelector('.data-loading-text');
        if (textEl) textEl.textContent = message;
        overlay.classList.remove('hidden');
    }
}

function hideDataLoading() {
    const overlay = document.getElementById('data-loading-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}

function showSectionLoading(viewId, message) {
    const overlay = document.querySelector(`#${viewId} .section-loading-overlay`);
    if (overlay) {
        const text = overlay.querySelector('.section-loading-text');
        if (text) text.textContent = message;
        overlay.classList.remove('hidden');
    }
}

function hideSectionLoading(viewId) {
    const overlay = document.querySelector(`#${viewId} .section-loading-overlay`);
    if (overlay) overlay.classList.add('hidden');
}

// ===== CONFIRMATION DIALOG SYSTEM =====
function showConfirm(message, title = 'Bevestig actie', options = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        // Set content
        titleEl.textContent = title;
        messageEl.textContent = message;

        // Danger styling
        if (options.danger) {
            okBtn.classList.add('btn-danger');
        } else {
            okBtn.classList.remove('btn-danger');
        }

        // Custom button text
        okBtn.textContent = options.confirmText || 'OK';
        cancelBtn.textContent = options.cancelText || 'Annuleren';
        cancelBtn.style.display = options.hideCancel ? 'none' : '';

        // Show modal
        modal.classList.remove('hidden');

        // Handle OK
        const handleOk = () => {
            cleanup();
            resolve(true);
        };

        // Handle Cancel
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        // Cleanup function
        const cleanup = () => {
            modal.classList.add('hidden');
            cancelBtn.style.display = '';
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('mousedown', handleBackdropClick);
            document.removeEventListener('keydown', handleEscape);
        };

        // Handle backdrop click — mousedown i.p.v. click: anders sluit de modal
        // als je tekst selecteert en de muis buiten het kader loslaat.
        const handleBackdropClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };

        // Handle Escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Add event listeners
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('mousedown', handleBackdropClick);
        document.addEventListener('keydown', handleEscape);
    });
}

// #371: beide promptvensters kregen een titel mee en deden er niets mee.
// Zet hem, of verberg de kop als er geen titel is.
function zetPromptTitel(titel) {
    const el = document.getElementById('input-prompt-title');
    if (!el) return;
    el.textContent = titel || '';
    el.classList.toggle('hidden', !titel);
}

// #348: okText erbij, zodat de knop de actie kan benoemen in plaats van "OK"
// te blijven bij een venster dat een dienst op je naam zet.
function showInputPrompt(message, title = 'Invoer', defaultValue = '', okText = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('input-prompt-modal');
        const messageEl = document.getElementById('input-prompt-message');
        const inputEl = document.getElementById('input-prompt-value');
        const okBtn = document.getElementById('input-prompt-ok');
        const cancelBtn = document.getElementById('input-prompt-cancel');

        zetPromptTitel(title);
        messageEl.textContent = message;
        inputEl.value = defaultValue;
        okBtn.textContent = okText || 'OK';
        modal.classList.remove('hidden');
        setTimeout(() => inputEl.focus(), 50);

        const handleOk = () => { cleanup(); resolve(inputEl.value.trim()); };
        const handleCancel = () => { cleanup(); resolve(null); };
        const cleanup = () => {
            modal.classList.add('hidden');
            okBtn.textContent = 'OK';
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('mousedown', handleBackdropClick);
            document.removeEventListener('keydown', handleKeys);
        };
        // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
        // en de muis buiten het kader loslaat.
        const handleBackdropClick = (e) => { if (e.target === modal) handleCancel(); };
        const handleKeys = (e) => {
            if (e.key === 'Escape') handleCancel();
            if (e.key === 'Enter') handleOk();
        };
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('mousedown', handleBackdropClick);
        document.addEventListener('keydown', handleKeys);
    });
}

function showSelectPrompt(message, title, options) {
    return new Promise((resolve) => {
        const modal = document.getElementById('input-prompt-modal');
        const messageEl = document.getElementById('input-prompt-message');
        const inputEl = document.getElementById('input-prompt-value');
        const okBtn = document.getElementById('input-prompt-ok');
        const cancelBtn = document.getElementById('input-prompt-cancel');

        zetPromptTitel(title);
        messageEl.textContent = message;

        // Replace input with select temporarily
        const selectEl = document.createElement('select');
        selectEl.className = inputEl.className;
        selectEl.id = 'input-prompt-select';
        options.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            selectEl.appendChild(o);
        });
        inputEl.replaceWith(selectEl);
        modal.classList.remove('hidden');
        setTimeout(() => selectEl.focus(), 50);

        const handleOk = () => { cleanup(); resolve(selectEl.value); };
        const handleCancel = () => { cleanup(); resolve(null); };
        const cleanup = () => {
            modal.classList.add('hidden');
            selectEl.replaceWith(inputEl);
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('mousedown', handleBackdropClick);
            document.removeEventListener('keydown', handleKeys);
        };
        // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
        // en de muis buiten het kader loslaat.
        const handleBackdropClick = (e) => { if (e.target === modal) handleCancel(); };
        const handleKeys = (e) => {
            if (e.key === 'Escape') handleCancel();
            if (e.key === 'Enter') handleOk();
        };
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('mousedown', handleBackdropClick);
        document.addEventListener('keydown', handleKeys);
    });
}

// ===== KLEUR HELPERS =====

// Donkere tekstkleur op een gekleurd vlak. Bewust bijna zwart en niet
// --text-primary: dit staat op een teamkleur, niet op de paginaachtergrond, en
// moet in beide thema's hetzelfde blijven.
const TEKST_OP_LICHT = '#14110c';

function _hexNaarRgb(hexColor) {
    if (typeof hexColor !== 'string') return null;
    const hex = hexColor.replace('#', '');
    const genormaliseerd = hex.length === 3
        ? hex.split('').map(ch => ch + ch).join('')
        : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(genormaliseerd)) return null;
    return [0, 2, 4].map(i => parseInt(genormaliseerd.slice(i, i + 2), 16));
}

// Relatieve helderheid volgens WCAG. De vorige versie nam de kanalen recht uit
// de hex zonder gammacorrectie, waardoor de uitkomst niets met het werkelijke
// contrast te maken had.
function _relatieveHelderheid(rgb) {
    const c = rgb.map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function _contrast(rgbA, rgbB) {
    const a = _relatieveHelderheid(rgbA), b = _relatieveHelderheid(rgbB);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Meng een kleur met wit, zoals color-mix(in srgb, kleur X%, white) in de CSS.
function mengMetWit(hexColor, percentageKleur) {
    const rgb = _hexNaarRgb(hexColor);
    if (!rgb) return '#ffffff';
    const f = Math.max(0, Math.min(100, percentageKleur)) / 100;
    return '#' + rgb.map(v => Math.round(v * f + 255 * (1 - f)).toString(16).padStart(2, '0')).join('');
}

// Kies wit of bijna zwart, afhankelijk van welke van de twee het meeste
// contrast geeft op deze achtergrond.
//
// Dit stond er al, maar werd nergens gebruikt: applyTeamColors() zette overal
// hardcoded wit. Bij de standaard teamkleuren haalde wit op zes van de tien
// kleuren de eis van 4,5 niet. Op #f59e0b (oranje) kwam het zelfs op 2,15 uit.
// Omdat de teamkleuren door de beheerder zelf worden gekozen, is meten de enige
// manier die blijft kloppen.
function getContrastColor(hexColor) {
    const rgb = _hexNaarRgb(hexColor);
    if (!rgb) return '#ffffff';
    const opWit = _contrast(rgb, [255, 255, 255]);
    const opDonker = _contrast(rgb, _hexNaarRgb(TEKST_OP_LICHT));
    return opDonker > opWit ? TEKST_OP_LICHT : '#ffffff';
}

function applyTeamColors() {
    const styleId = 'team-color-overrides';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
    }

    const teams = DataStore.settings.teams || {};
    let css = '';
    Object.entries(teams).forEach(([teamId, team]) => {
        const color = team.color || '#64748b';
        const textColor = getContrastColor(color);
        // Het tijdlijnblok is een verloop dat links op 78 procent kleur met wit
        // staat. Die lichtere helft bepaalt of de tekst leesbaar is, dus daar
        // wordt de tekstkleur op gekozen.
        const textColorVerloop = getContrastColor(mengMetWit(color, 78));
        css += `
.team-toggle.active[data-team="${teamId}"] { background: ${color} !important; color: ${textColor} !important; border-color: transparent !important; }
.team-badge.${teamId} { background: ${color} !important; color: ${textColor} !important; }
.team-badge-mini.${teamId} { background: ${color} !important; color: ${textColor} !important; }
.shift-block.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.timeline-block.team-${teamId} { background: linear-gradient(135deg, color-mix(in srgb, ${color} 78%, white) 0%, ${color} 100%) !important; color: ${textColorVerloop} !important; }
.shift-badge.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.shift-team-badge.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.timeline-team-header.team-${teamId} { --team-dot-color: ${color}; }
.team-tab.active.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
`;
    });
    styleEl.textContent = css;
}

// ===== TOOLTIP SYSTEEM =====
let tooltipElement = null;

function createTooltipElement() {
    tooltipElement = document.createElement('div');
    tooltipElement.className = 'custom-tooltip';
    tooltipElement.style.display = 'none';
    document.body.appendChild(tooltipElement);

    // Event delegation voor tooltips
    document.addEventListener('mouseover', handleTooltipShow);
    document.addEventListener('mouseout', handleTooltipHide);
    document.addEventListener('scroll', handleTooltipHide, true);
}

function handleTooltipShow(e) {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;

    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    tooltipElement.textContent = text;
    tooltipElement.style.display = 'block';

    // Positie berekenen
    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const pos = target.getAttribute('data-tooltip-pos') || 'top';

    let top, left;

    switch (pos) {
        case 'bottom':
            top = rect.bottom + 8;
            left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
            break;
        case 'left':
            top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
            left = rect.left - tooltipRect.width - 8;
            break;
        case 'right':
            top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
            left = rect.right + 8;
            break;
        default: // top
            top = rect.top - tooltipRect.height - 8;
            left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
    }

    // Zorg dat tooltip binnen viewport blijft
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
        left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top < 10) {
        // Flip naar bottom als top niet past
        top = rect.bottom + 8;
    }
    if (top + tooltipRect.height > window.innerHeight - 10) {
        // Flip naar top als bottom niet past
        top = rect.top - tooltipRect.height - 8;
        if (top < 10) top = 10;
    }

    tooltipElement.style.top = `${top}px`;
    tooltipElement.style.left = `${left}px`;
}

function handleTooltipHide(e) {
    if (e.type === 'scroll' || !e.relatedTarget?.closest('[data-tooltip]')) {
        tooltipElement.style.display = 'none';
    }
}
