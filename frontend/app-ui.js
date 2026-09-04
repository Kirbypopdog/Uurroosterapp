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
        if (this._previousFocus && this._previousFocus.focus) {
            try { this._previousFocus.focus(); } catch (e) { /* element may be gone */ }
        }
        this._activeModal = null;
        this._previousFocus = null;
    }
};

// Auto-activate focus trap when modals become visible
function initModalFocusTrap() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
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
}

// ===== TOAST NOTIFICATION SYSTEM =====
const ToastManager = {
    container: null,
    toasts: [],
    maxToasts: 5,

    init() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    },

    show(message, type = 'info', duration = null) {
        this.init();

        // Auto-duration based on type
        if (duration === null) {
            duration = {
                'success': 3000,
                'info': 4000,
                'warning': 5000,
                'error': 0 // Don't auto-dismiss errors
            }[type] || 4000;
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
        el.innerHTML = `
            <span class="toast-icon">${IconHelper.html(iconMap[toast.type], 'sm')}</span>
            <span class="toast-message">${escapeHtml(toast.message)}</span>
            <button class="toast-close" onclick="ToastManager.remove(${toast.id})">${IconHelper.html(ICONS.close, 'xs')}</button>
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

function showInputPrompt(message, title = 'Invoer', defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('input-prompt-modal');
        const messageEl = document.getElementById('input-prompt-message');
        const inputEl = document.getElementById('input-prompt-value');
        const okBtn = document.getElementById('input-prompt-ok');
        const cancelBtn = document.getElementById('input-prompt-cancel');

        messageEl.textContent = message;
        inputEl.value = defaultValue;
        modal.classList.remove('hidden');
        setTimeout(() => inputEl.focus(), 50);

        const handleOk = () => { cleanup(); resolve(inputEl.value.trim()); };
        const handleCancel = () => { cleanup(); resolve(null); };
        const cleanup = () => {
            modal.classList.add('hidden');
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
function getContrastColor(hexColor) {
    if (typeof hexColor !== 'string') return '#ffffff';
    const hex = hexColor.replace('#', '');
    const normalized = hex.length === 3
        ? hex.split('').map(ch => ch + ch).join('')
        : hex;
    if (normalized.length !== 6) return '#ffffff';
    const r = parseInt(normalized.slice(0, 2), 16) / 255;
    const g = parseInt(normalized.slice(2, 4), 16) / 255;
    const b = parseInt(normalized.slice(4, 6), 16) / 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.6 ? '#1f2933' : '#ffffff';
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
        const textColor = '#ffffff';
        css += `
.team-toggle.active[data-team="${teamId}"] { background: ${color} !important; color: ${textColor} !important; border-color: transparent !important; }
.team-badge.${teamId} { background: ${color} !important; color: ${textColor} !important; }
.team-badge-mini.${teamId} { background: ${color} !important; color: ${textColor} !important; }
.shift-block.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.timeline-block.team-${teamId} { background: linear-gradient(135deg, color-mix(in srgb, ${color} 78%, white) 0%, ${color} 100%) !important; color: ${textColor} !important; }
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
