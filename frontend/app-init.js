


function initDOM() {
    DOM.loginContainer = document.getElementById('login-container');
    DOM.appContainer = document.getElementById('app-container');
    DOM.loginForm = document.getElementById('login-form');
    DOM.usernameInput = document.getElementById('username');
    DOM.passwordInput = document.getElementById('password');
    DOM.navButtons = document.querySelectorAll('.nav-center .nav-btn');
    DOM.logoutBtn = document.getElementById('logout-btn');
    DOM.homeView = document.getElementById('home-view');
    DOM.planningView = document.getElementById('planning-view');
    DOM.employeesView = document.getElementById('employees-view');
    DOM.profileView = document.getElementById('profile-view');
    DOM.profileContent = document.getElementById('profile-content');
    DOM.availabilityView = document.getElementById('availability-view');
    DOM.builderView = document.getElementById('builder-view');
    DOM.swapsView = document.getElementById('swaps-view');
    DOM.settingsView = document.getElementById('settings-view');
    DOM.addShiftBtn = document.getElementById('add-shift-btn');
    DOM.prevWeekBtn = document.getElementById('prev-week');
    DOM.nextWeekBtn = document.getElementById('next-week');
    DOM.todayBtn = document.getElementById('today-btn');
    DOM.currentPeriod = document.getElementById('current-period-text');
    DOM.viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
    DOM.rosterCalendar = document.getElementById('roster-calendar');
    DOM.validationAlerts = document.getElementById('validation-alerts');
    DOM.addEmployeeBtn = document.getElementById('add-employee-btn');
    DOM.employeesList = document.getElementById('employees-list');
    DOM.shiftModal = document.getElementById('shift-modal');
    DOM.shiftForm = document.getElementById('shift-form');
    DOM.shiftModalTitle = document.getElementById('shift-modal-title');
    DOM.shiftEmployee = document.getElementById('shift-employee');
    DOM.shiftTeam = document.getElementById('shift-team');
    DOM.shiftDate = document.getElementById('shift-date');
    DOM.shiftTemplate = document.getElementById('shift-template');
    DOM.shiftStart = document.getElementById('shift-start');
    DOM.shiftEnd = document.getElementById('shift-end');
    DOM.shiftNotes = document.getElementById('shift-notes');
    DOM.shiftValidationErrors = document.getElementById('shift-validation-errors');
    DOM.shiftCancelBtn = document.getElementById('shift-cancel-btn');
    DOM.shiftSubmitBtn = document.getElementById('shift-submit-btn');
    DOM.shiftDeleteBtn = document.getElementById('shift-delete-btn');
    DOM.employeeModal = document.getElementById('employee-modal');
    DOM.employeeForm = document.getElementById('employee-form');
    DOM.employeeModalTitle = document.getElementById('employee-modal-title');
    DOM.employeeName = document.getElementById('employee-name');
    DOM.employeeEmail = document.getElementById('employee-email');
    DOM.employeeMainTeam = document.getElementById('employee-main-team');
    DOM.employeeContract = document.getElementById('employee-contract');
    DOM.employeeActive = document.getElementById('employee-active');
    DOM.employeeCancelBtn = document.getElementById('employee-cancel-btn');
    DOM.employeeDeleteBtn = document.getElementById('employee-delete-btn');
    DOM.warningDetailsModal = document.getElementById('warning-details-modal');
    DOM.warningDetailsList = document.getElementById('warning-details-list');
    DOM.warningDetailsClose = document.getElementById('warning-details-close');
    DOM.errorDetailsModal = document.getElementById('error-details-modal');
    DOM.errorDetailsList = document.getElementById('error-details-list');
    DOM.errorDetailsClose = document.getElementById('error-details-close');

    // Mobile day navigation
    DOM.mobileDayNav = document.getElementById('mobile-day-nav');
    DOM.mobilePrevDay = document.getElementById('mobile-prev-day');
    DOM.mobileNextDay = document.getElementById('mobile-next-day');
    DOM.mobileDayDisplay = document.getElementById('mobile-day-display');

    // Create tooltip element
    createTooltipElement();
}


function init() {
    try {
        console.log('Het Vlot Roosterplanning start...');
        console.log('Data loaded:', DataStore);
        initDOM();
        initModalFocusTrap();
        applyTeamColors();
        console.log('DOM initialized');
        document.body.setAttribute('data-view-mode', AppState.viewMode);
        setCurrentWeek(new Date());
        // Set initial mobile day to today's day of the week
        const today = new Date();
        const dayOfWeek = today.getDay();
        AppState.mobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        console.log('Current week set');
        setupEventListeners();
        setupAvailabilityModal();
        console.log('Event listeners set up');
        checkSession();
        console.log('Session checked');
    } catch (error) {
        console.error('Error during initialization:', error);
        showToast('Er is een fout opgetreden bij het starten van de applicatie. Probeer de pagina te herladen.', 'error');
    }
}

function setupEventListeners() {
    DOM.loginForm.addEventListener('submit', handleLogin);
    DOM.logoutBtn.addEventListener('click', handleLogout);

    // Role switcher for admin testing
    const roleSwitchSelect = document.getElementById('role-switch-select');
    if (roleSwitchSelect) {
        roleSwitchSelect.addEventListener('change', (e) => {
            const newRole = e.target.value;
            // If admin is selected, clear the simulation
            AppState.simulatedRole = (newRole === 'admin') ? null : newRole;
            // Re-apply role visibility to update UI
            applyRoleVisibility();
            // Switch to planning view to avoid being stuck on hidden view
            switchView('planning');
            // Re-render current view
            renderPlanning();
            console.log(`[Test Mode] Nu werkend als: ${newRole}`);
        });
    }

    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const navMenu = document.getElementById('nav-menu');
    if (mobileMenuBtn && navMenu) {
        mobileMenuBtn.addEventListener('click', () => {
            mobileMenuBtn.classList.toggle('active');
            navMenu.classList.toggle('open');
        });
    }

    // Avatar trigger → navigeer direct naar profiel
    const userMenuTrigger = document.getElementById('user-menu-trigger');
    if (userMenuTrigger) {
        userMenuTrigger.addEventListener('click', () => switchView('profile'));
    }

    DOM.navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Close mobile menu on navigation
            if (mobileMenuBtn && navMenu) {
                mobileMenuBtn.classList.remove('active');
                navMenu.classList.remove('open');
            }
            switchView(btn.dataset.view);
        });
    });
    DOM.addShiftBtn.addEventListener('click', openAddShiftModal);
    DOM.prevWeekBtn.addEventListener('click', () => {
        if (AppState.viewMode === 'month') {
            changeMonth(-1);
        } else if (AppState.viewMode === 'day') {
            changeMobileDay(-1);
        } else {
            changeWeek(-1);
        }
    });
    DOM.nextWeekBtn.addEventListener('click', () => {
        if (AppState.viewMode === 'month') {
            changeMonth(1);
        } else if (AppState.viewMode === 'day') {
            changeMobileDay(1);
        } else {
            changeWeek(1);
        }
    });
    DOM.todayBtn.addEventListener('click', jumpToToday);

    // Week-jump date picker: click on period display to open
    const weekJumpInput = document.getElementById('week-jump-input');
    const periodContainer = document.getElementById('current-period');
    if (weekJumpInput && periodContainer) {
        periodContainer.addEventListener('click', () => {
            if (AppState.currentWeekStart) {
                weekJumpInput.value = formatDateYYYYMMDD(AppState.currentWeekStart);
            }
            if (weekJumpInput.showPicker) {
                weekJumpInput.showPicker();
            } else {
                weekJumpInput.click();
            }
        });
        weekJumpInput.addEventListener('change', (e) => {
            const parts = e.target.value.split('-');
            if (parts.length === 3) {
                const selected = new Date(+parts[0], +parts[1] - 1, +parts[2]);
                if (!isNaN(selected.getTime())) {
                    jumpToDate(selected);
                }
            }
        });
    }

    // Mobile day navigation
    if (DOM.mobilePrevDay) {
        DOM.mobilePrevDay.addEventListener('click', () => changeMobileDay(-1));
    }
    if (DOM.mobileNextDay) {
        DOM.mobileNextDay.addEventListener('click', () => changeMobileDay(1));
    }

    // Mobile date picker - jump to specific date
    const mobileDatePicker = document.getElementById('mobile-date-picker');
    if (mobileDatePicker) {
        mobileDatePicker.addEventListener('change', (e) => {
            const selectedDate = new Date(e.target.value);
            if (!isNaN(selectedDate.getTime())) {
                jumpToDate(selectedDate);
            }
        });
    }

    // Click on day display to open date picker
    if (DOM.mobileDayDisplay) {
        DOM.mobileDayDisplay.addEventListener('click', () => {
            const picker = document.getElementById('mobile-date-picker');
            if (picker) {
                if (picker.showPicker) {
                    picker.showPicker();
                } else {
                    picker.click();
                    picker.focus();
                }
            }
        });
    }

    DOM.viewToggleBtns.forEach(btn => {
        btn.addEventListener('click', () => changeViewMode(btn.dataset.mode));
    });

    // Team toggle buttons for planning view — attached dynamically via renderTeamToggles()

    // Team toggle buttons for employees view — attached dynamically via renderEmployeeTeamToggles()

    DOM.addEmployeeBtn.addEventListener('click', openAddEmployeeModal);
    DOM.shiftForm.addEventListener('submit', handleShiftSubmit);
    DOM.shiftForm.addEventListener('input', () => {
        if (AppState._shiftForceOverride) {
            resetShiftSubmitBtn();
            DOM.shiftValidationErrors.innerHTML = '';
        }
    });
    DOM.shiftForm.addEventListener('change', () => {
        if (AppState._shiftForceOverride) {
            resetShiftSubmitBtn();
            DOM.shiftValidationErrors.innerHTML = '';
        }
    });
    DOM.shiftCancelBtn.addEventListener('click', closeShiftModal);
    DOM.shiftDeleteBtn.addEventListener('click', handleShiftDelete);
    DOM.shiftTemplate.addEventListener('change', handleShiftTemplateChange);
    document.querySelectorAll('#shift-modal .modal-close').forEach(btn => {
        btn.addEventListener('click', closeShiftModal);
    });
    DOM.employeeForm.addEventListener('submit', handleEmployeeSubmit);
    DOM.employeeCancelBtn.addEventListener('click', closeEmployeeModal);
    DOM.employeeDeleteBtn.addEventListener('click', handleEmployeeDelete);
    document.querySelectorAll('#employee-modal .modal-close').forEach(btn => {
        btn.addEventListener('click', closeEmployeeModal);
    });
    DOM.warningDetailsClose.addEventListener('click', closeWarningDetailsModal);
    DOM.warningDetailsModal.addEventListener('click', (e) => {
        if (e.target === DOM.warningDetailsModal) closeWarningDetailsModal();
    });
    DOM.errorDetailsClose.addEventListener('click', closeErrorDetailsModal);
    DOM.errorDetailsModal.addEventListener('click', (e) => {
        if (e.target === DOM.errorDetailsModal) closeErrorDetailsModal();
    });
    DOM.shiftModal.addEventListener('click', (e) => {
        if (e.target === DOM.shiftModal) closeShiftModal();
    });
    DOM.employeeModal.addEventListener('click', (e) => {
        if (e.target === DOM.employeeModal) closeEmployeeModal();
    });

    // Swap request modal event listeners
    document.getElementById('swap-request-modal-close').addEventListener('click', closeSwapRequestModal);
    document.getElementById('swap-request-cancel-btn').addEventListener('click', closeSwapRequestModal);
    document.getElementById('swap-request-submit-btn').addEventListener('click', handleSwapRequestSubmit);
    document.getElementById('swap-target-employee').addEventListener('change', handleSwapTargetEmployeeChange);
    document.getElementById('swap-target-shift').addEventListener('change', handleSwapTargetShiftChange);
    document.getElementById('swap-request-modal').addEventListener('click', (e) => {
        if (e.target.id === 'swap-request-modal') closeSwapRequestModal();
    });

    // Takeover request modal event listeners
    document.getElementById('takeover-request-modal-close').addEventListener('click', closeTakeoverRequestModal);
    document.getElementById('takeover-request-cancel-btn').addEventListener('click', closeTakeoverRequestModal);
    document.getElementById('takeover-request-submit-btn').addEventListener('click', handleTakeoverRequestSubmit);
    document.getElementById('takeover-request-modal').addEventListener('click', (e) => {
        if (e.target.id === 'takeover-request-modal') closeTakeoverRequestModal();
    });

    // Shift afstaan choice modal event listeners
    document.getElementById('shift-afstaan-choice-close').addEventListener('click', closeShiftAfstaanChoiceModal);
    document.getElementById('shift-afstaan-choice-cancel').addEventListener('click', closeShiftAfstaanChoiceModal);
    document.getElementById('shift-afstaan-choice-modal').addEventListener('click', (e) => {
        if (e.target.id === 'shift-afstaan-choice-modal') closeShiftAfstaanChoiceModal();
    });

    // Week tabs (static in HTML)
    document.querySelectorAll('.week-tab').forEach(tab => {
        tab.addEventListener('click', () => switchWeekTab(parseInt(tab.dataset.week)));
    });

    DOM.validationAlerts.addEventListener('click', (event) => {
        const chip = event.target.closest('.validation-chip');
        if (chip) openValidationDetailsModal(chip.dataset.rule || null);
    });

    // Planning controls collapse toggle (only hides filters row, not date nav)
    const planningControlsToggle = document.getElementById('planning-controls-toggle');
    if (planningControlsToggle) {
        planningControlsToggle.addEventListener('click', () => {
            AppState.planningControlsCollapsed = !AppState.planningControlsCollapsed;
            planningControlsToggle.classList.toggle('active', AppState.planningControlsCollapsed);
            const filtersRow = document.getElementById('planning-filters-row');
            const heatmap = document.getElementById('coverage-heatmap-container');
            const alerts = document.getElementById('validation-alerts');
            if (filtersRow) filtersRow.classList.toggle('hidden', AppState.planningControlsCollapsed);
            if (heatmap) heatmap.classList.toggle('hidden', AppState.planningControlsCollapsed);
            if (alerts) alerts.classList.toggle('hidden', AppState.planningControlsCollapsed);
        });
    }

    // Heatmap toggle
    const heatmapToggle = document.getElementById('heatmap-toggle-btn');
    if (heatmapToggle) {
        heatmapToggle.addEventListener('click', () => {
            AppState.showHeatmap = !AppState.showHeatmap;
            heatmapToggle.classList.toggle('active', AppState.showHeatmap);
            const container = document.getElementById('coverage-heatmap-container');
            if (container) {
                container.innerHTML = AppState.showHeatmap ? renderCoverageHeatmap() : '';
                if (AppState.showHeatmap) IconHelper.init(container);
            }
        });
    }

    // Filter toggle: show only employees with shifts (toggle switch)
    const filterToggle = document.getElementById('filter-shifts-toggle');
    if (filterToggle) {
        filterToggle.addEventListener('change', () => {
            AppState.filterOnlyWithShifts = filterToggle.checked;
            renderPlanning();
        });
    }

    // Activity modal
    const activityForm = document.getElementById('activity-form');
    if (activityForm) {
        activityForm.addEventListener('submit', handleActivitySubmit);
    }
    document.getElementById('activity-cancel-btn')?.addEventListener('click', closeActivityModal);
    document.getElementById('activity-delete-btn')?.addEventListener('click', handleActivityDelete);
    document.querySelectorAll('#activity-modal .modal-close').forEach(btn => {
        btn.addEventListener('click', closeActivityModal);
    });
    document.getElementById('activity-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'activity-modal') closeActivityModal();
    });

    // Copy-week modal (builder)
    const closeModal = () => document.getElementById('copy-week-modal')?.classList.add('hidden');
    document.getElementById('copy-week-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('copy-week-cancel')?.addEventListener('click', closeModal);
    document.getElementById('copy-week-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'copy-week-modal') closeModal();
    });
    document.getElementById('copy-week-confirm')?.addEventListener('click', executeCopyWeek);
    document.getElementById('copy-week-source')?.addEventListener('change', updateCopyWeekConflictWarning);
    document.getElementById('copy-week-target')?.addEventListener('change', updateCopyWeekConflictWarning);

    // Draft diff modal
    const closeDiff = () => document.getElementById('draft-diff-modal')?.classList.add('hidden');
    document.getElementById('draft-diff-modal-close')?.addEventListener('click', closeDiff);
    document.getElementById('draft-diff-close')?.addEventListener('click', closeDiff);
    document.getElementById('draft-diff-modal')?.addEventListener('click', (e) => { if (e.target.id === 'draft-diff-modal') closeDiff(); });
    document.getElementById('draft-diff-run')?.addEventListener('click', runDraftDiff);

    // Undo/Redo buttons
    document.getElementById('undo-btn')?.addEventListener('click', () => UndoManager.undo());
    document.getElementById('redo-btn')?.addEventListener('click', () => UndoManager.redo());

    // Undo/Redo keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (document.querySelector('.modal:not(.hidden)')) return;

        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            UndoManager.undo();
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            UndoManager.redo();
        }
    });

    // Event delegation for inline delete buttons on shift cards
    document.addEventListener('click', async (e) => {
        if (e.target.classList.contains('shift-delete-btn')) {
            e.stopPropagation(); // Prevent opening the shift modal
            const shiftId = parseInt(e.target.dataset.shiftId, 10);
            if (!shiftId) return;

            const shift = getShift(shiftId);
            if (!shift) return;

            // Check permissions before allowing delete
            if (!canUserEditShift(shift)) {
                showToast('Je hebt geen rechten om deze dienst te verwijderen', 'warning');
                return;
            }

            // Call handleShiftDelete with the shift ID and wait for completion
            await handleShiftDelete(shiftId);
        }

        // Activity chip/badge click → edit activity
        const activityEl = e.target.closest('.activity-chip, .activity-badge');
        if (activityEl) {
            e.stopPropagation();
            const activityId = activityEl.dataset.activityId;
            if (activityId) openEditActivityModal(parseInt(activityId, 10));
        }

        // Add activity button click
        const addActivityBtn = e.target.closest('.add-activity-btn');
        if (addActivityBtn) {
            e.stopPropagation();
            const { userId, date, shiftStart, shiftEnd, shiftId } = addActivityBtn.dataset;
            if (userId && date) openAddActivityModal(parseInt(userId, 10), date, shiftStart, shiftEnd, shiftId ? parseInt(shiftId, 10) : null);
        }
    });
}



document.addEventListener('DOMContentLoaded', () => {
    init();
    // Aria-labels op icon-only knoppen (accessibility)
    document.querySelectorAll('.modal-close:not([aria-label])').forEach(el => {
        el.setAttribute('aria-label', 'Sluiten');
        el.setAttribute('role', 'button');
    });
    console.log('Het Vlot Roosterplanning is gestart!');
});
