// HET VLOT ROOSTERPLANNING - INSTELLINGEN

function renderSettings() {
    const role = getEffectiveRole();
    const allowedTabs = SETTINGS_TAB_CONFIG.filter(t => t.roles.includes(role));

    // If current tab is not allowed for this role, reset to first allowed
    if (!allowedTabs.find(t => t.id === AppState.activeSettingsTab)) {
        AppState.activeSettingsTab = allowedTabs[0]?.id || 'teams';
    }

    // Dynamically render tab buttons
    const tabsContainer = document.getElementById('settings-tabs');
    if (tabsContainer) {
        tabsContainer.innerHTML = allowedTabs.map(t =>
            `<button class="settings-tab ${t.id === AppState.activeSettingsTab ? 'active' : ''}" data-settings-tab="${t.id}">${t.label}</button>`
        ).join('');
    }

    // Setup tab click listeners
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => switchSettingsTab(tab.dataset.settingsTab);
    });

    // Update view title
    const activeTabConfig = allowedTabs.find(t => t.id === AppState.activeSettingsTab);
    const titleEl = document.getElementById('settings-view-title');
    if (titleEl && activeTabConfig) titleEl.textContent = activeTabConfig.label;

    // Scroll active tab into view
    const activeTab = document.querySelector('.settings-tab.active');
    if (activeTab) {
        setTimeout(() => {
            activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }, 100);
    }

    // Render the active tab content
    renderSettingsTabContent(AppState.activeSettingsTab);
}

async function switchSettingsTab(tabName) {
    if (AppState.settingsDirty && tabName !== AppState.activeSettingsTab) {
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in deze tab. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        AppState.settingsDirty = false;
    }
    AppState.activeSettingsTab = tabName;

    // Track onboarding: mark planning tab as visited
    if (tabName === 'planning' && AppState.currentUser && !AppState.currentUser.onboardingFlags?.planning_visited) {
        // #171: via dataApiFetch, zoals CLAUDE.md regel 9 voorschrijft. Die
        // zet de Authorization-header, de tijdslimiet en de 401-afhandeling zelf.
        dataApiFetch('/me/onboarding-flags', {
            method: 'PUT',
            body: JSON.stringify({ planning_visited: true })
        }).catch(e => console.error('Onboardingvlag opslaan mislukt:', e));
        if (!AppState.currentUser.onboardingFlags) AppState.currentUser.onboardingFlags = {};
        AppState.currentUser.onboardingFlags.planning_visited = true;
    }

    document.querySelectorAll('.settings-tab').forEach(tab => {
        const isActive = tab.dataset.settingsTab === tabName;
        tab.classList.toggle('active', isActive);
        if (isActive) {
            tab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    });

    // Update view title
    const activeTabConfig = SETTINGS_TAB_CONFIG.find(t => t.id === tabName);
    const titleEl = document.getElementById('settings-view-title');
    if (titleEl && activeTabConfig) titleEl.textContent = activeTabConfig.label;

    renderSettingsTabContent(tabName);
}

function renderSettingsTabContent(tabName) {
    const content = document.getElementById('settings-tab-content');
    if (!content) return;

    switch (tabName) {
        case 'accounts':
            renderSettingsAccounts(content);
            break;
        case 'planning':
            renderSettingsPlanning(content);
            break;
        case 'teams':
            renderSettingsTeams(content);
            break;
        case 'communicatie':
            renderSettingsEmail(content);
            break;
        case 'beheer':
            renderSettingsBeheer(content);
            break;
        default:
            content.innerHTML = '<p>Ongeldige tab</p>';
    }
    IconHelper.init(content);
    // Track unsaved changes for all settings tabs with form inputs
    if (['planning', 'teams', 'communicatie'].includes(tabName)) {
        trackSettingsDirty(content);
    }
}

function getRoleDescription(role) {
    const descriptions = {
        'medewerker': 'Kan eigen rooster bekijken, diensten ruilen en verlof aanvragen.',
        'roosterverantwoordelijke': 'Kan alle diensten, medewerkers en roosters van alle teams beheren.',
        'admin': 'Volledige toegang inclusief accountbeheer, instellingen en systeembeheer.'
    };
    return descriptions[role] || '';
}

function trackSettingsDirty(container) {
    AppState.settingsDirty = false;
    const markDirty = () => {
        AppState.settingsDirty = true;
        container.querySelectorAll('.settings-dirty-indicator').forEach(el => el.classList.remove('hidden'));
    };
    container.addEventListener('input', markDirty, true);
    container.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') markDirty();
    }, true);
}

// #273: het tegenovergestelde van markSettingsSaved. Nodig wanneer het opslaan
// mislukt: de waarden in DataStore gaan terug naar wat de server heeft, maar wat
// de gebruiker intikte blijft in het formulier staan zodat hij het opnieuw kan
// proberen zonder alles over te typen.
function markSettingsUnsaved() {
    AppState.settingsDirty = true;
    document.querySelectorAll('.settings-dirty-indicator').forEach(el => el.classList.remove('hidden'));
}

function markSettingsSaved() {
    AppState.settingsDirty = false;
    document.querySelectorAll('.settings-dirty-indicator').forEach(el => el.classList.add('hidden'));
}

// ===== SETTINGS TAB: ACCOUNTS =====
function renderSettingsAccounts(container) {
    const role = getEffectiveRole();

    if (role !== 'admin') {
        container.innerHTML = `
            <div class="settings-card">
                <div class="settings-card-body">
                    <div class="info-box neutral">
                        <p>Je hebt geen toegang tot accountbeheer.</p>
                        <p>Neem contact op met een administrator als je toegang nodig hebt.</p>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="settings-card" id="settings-accounts">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Accountbeheer</h3>
                    <p class="settings-card-subtitle">Gebruikers, rollen en reset wachtwoorden.</p>
                </div>
                <button type="button" class="btn btn-primary" id="add-user-btn">+ Nieuwe gebruiker</button>
            </div>
            <div class="settings-card-body">
                <div class="admin-users-intro">
                    <p>Beheer rollen en teams per gebruiker. Gebruik "Reset wachtwoord" enkel wanneer nodig.</p>
                </div>
                <!-- #366: deze drie velden hadden geen enkel opschrift. Bij
                     het zoekveld stond wel een placeholder, maar die verdwijnt
                     zodra je typt en telt sowieso niet als naam. -->
                <div class="admin-filter-bar">
                    <input type="text" id="admin-user-search" class="form-input" placeholder="Zoek op naam of email" aria-label="Zoek accounts op naam of e-mail" />
                    <select id="admin-team-filter" class="form-input" aria-label="Filter op team">
                        <option value="">Alle teams</option>
                    </select>
                    <select id="admin-status-filter" class="form-input" aria-label="Filter op status">
                        <option value="active" selected>Actief</option>
                        <option value="inactive">Inactief</option>
                        <option value="">Alle</option>
                    </select>
                </div>
                <div id="admin-users-list">Laden...</div>
            </div>
        </div>
    `;

    // Load and render admin users
    loadAdminUsers(container);
}

async function loadAdminUsers(container) {
    try {
        const teams = await ensureTeamsLoaded();
        const data = await dataApiFetch('/admin/users');
        const users = data.users || [];

        const teamOptions = ['<option value="">(geen team)</option>']
            .concat(teams.map(team => `<option value="${team.id}">${escapeHtml(team.name)}</option>`))
            .join('');

        const roleOptions = `
            <option value="admin">Admin</option>
            <option value="roosterverantwoordelijke">Roosterverantwoordelijke</option>
            <option value="medewerker">Medewerker</option>
        `;

        const rows = users.map(user => {
            const isInactive = user.active === false;
            return `
            <div class="admin-user-row${isInactive ? ' admin-user-inactive' : ''}" data-user-id="${user.id}" data-name="${escapeHtml(user.name)}" data-email="${escapeHtml(user.email || '')}" data-team="${user.team_id || ''}" data-role="${user.role}" data-active="${user.active !== false}">
                ${isInactive ? '<span class="status-badge inactive">Inactief</span>' : ''}
                <div class="admin-user-header">
                    <div>
                        <div class="admin-user-name">${escapeHtml(user.name)}</div>
                        <!-- #353: hier stond escapeHtml(user.email) zonder terugval, en
                             escapeHtml doet String(null), dus stond er letterlijk "null"
                             onder de naam van een account zonder e-mailadres. Het veld is
                             uitdrukkelijk optioneel, dus dat is een gewone toestand.
                             Dezelfde terugval als op de medewerkerskaart. -->
                        <div class="admin-user-email${user.email ? '' : ' admin-user-email-leeg'}">${user.email ? escapeHtml(user.email) : 'Geen e-mail'}</div>
                    </div>
                    <div class="admin-user-header-actions">
                        <div class="admin-user-role-pill">${escapeHtml(user.role)}</div>
                        <button type="button" class="btn btn-sm btn-secondary admin-edit-btn">Bewerken</button>
                    </div>
                </div>
            </div>`;
        }).join('');

        const list = container.querySelector('#admin-users-list');
        list.innerHTML = rows || '<p>Geen accounts gevonden.</p>';
        IconHelper.init(list);

        const teamFilter = container.querySelector('#admin-team-filter');
        if (teamFilter) {
            teamFilter.innerHTML = ['<option value="">Alle teams</option>']
                .concat(teams.map(team => `<option value="${team.id}">${escapeHtml(team.name)}</option>`))
                .join('');
        }

        // Setup event listeners for each user row
        container.querySelectorAll('.admin-user-row').forEach(row => {
            const userId = row.dataset.userId;
            const user = users.find(u => String(u.id) === String(userId));
            if (!user) return;

            // Edit button opens modal
            const editBtn = row.querySelector('.admin-edit-btn');
            if (editBtn) {
                editBtn.addEventListener('click', () => {
                    showEditAccountModal(user, teams, () => {
                        // Callback to refresh the list after save
                        renderSettingsAccounts(document.querySelector('#settings-tab-content'));
                    });
                });
            }
        });

        const applyFilters = () => {
            const searchValue = (container.querySelector('#admin-user-search')?.value || '').toLowerCase().trim();
            const teamValue = container.querySelector('#admin-team-filter')?.value || '';
            const statusValue = container.querySelector('#admin-status-filter')?.value || '';
            container.querySelectorAll('.admin-user-row').forEach(row => {
                const name = (row.dataset.name || '').toLowerCase();
                const email = (row.dataset.email || '').toLowerCase();
                const team = row.dataset.team || '';
                const isActive = row.dataset.active === 'true';
                const matchSearch = !searchValue || name.includes(searchValue) || email.includes(searchValue);
                const matchTeam = !teamValue || team === teamValue;
                const matchStatus = !statusValue || (statusValue === 'active' && isActive) || (statusValue === 'inactive' && !isActive);
                row.classList.toggle('is-hidden', !(matchSearch && matchTeam && matchStatus));
            });
        };

        const searchInput = container.querySelector('#admin-user-search');
        if (searchInput) {
            searchInput.addEventListener('input', applyFilters);
        }
        if (teamFilter) {
            teamFilter.addEventListener('change', applyFilters);
        }
        const statusFilter = container.querySelector('#admin-status-filter');
        if (statusFilter) {
            statusFilter.addEventListener('change', applyFilters);
        }
        // Apply filters on load to hide inactive users by default
        applyFilters();

        // Add user button
        const addUserBtn = container.querySelector('#add-user-btn');
        if (addUserBtn) {
            addUserBtn.addEventListener('click', () => showAddUserModal(teams));
        }
    } catch (error) {
        container.querySelector('#admin-users-list').textContent = `Fout: ${error.message}`;
    }
}

function showAddUserModal(teams) {
    const teamOptions = teams.map(team => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'add-user-modal';
    // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
    // en de muis buiten het kader loslaat.
    modal.onmousedown = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content modal-content--sm">
            <div class="modal-header">
                <h2>Nieuwe gebruiker</h2>
                <button type="button" class="modal-close" aria-label="Sluiten" onclick="document.getElementById('add-user-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <form id="add-user-form">
                    <div class="form-group">
                        <label for="new-user-name">Naam</label>
                        <input type="text" id="new-user-name" class="form-input" required />
                    </div>
                    <div class="form-group">
                        <label for="new-user-email">E-mail</label>
                        <input type="email" id="new-user-email" class="form-input" placeholder="Optioneel, welkomstmail wordt gestuurd bij invullen" />
                    </div>
                    <div class="form-group">
                        <label for="new-user-password">Wachtwoord</label>
                        <input type="password" id="new-user-password" class="form-input" placeholder="Laat leeg voor standaard wachtwoord" minlength="6" />
                    </div>
                    <div class="form-group">
                        <label for="new-user-password-confirm">Bevestig wachtwoord</label>
                        <input type="password" id="new-user-password-confirm" class="form-input" minlength="6" />
                    </div>
                    <div class="form-group">
                        <label for="new-user-role">Rol</label>
                        <select id="new-user-role" class="form-input" required>
                            <option value="medewerker">Medewerker</option>
                            <option value="roosterverantwoordelijke">Roosterverantwoordelijke</option>
                            <option value="admin">Admin</option>
                        </select>
                        <span class="form-hint role-hint" id="new-user-role-hint">${getRoleDescription('medewerker')}</span>
                    </div>
                    <div class="form-group">
                        <label for="new-user-team">Team</label>
                        <select id="new-user-team" class="form-input">
                            <option value="">(geen team)</option>
                            ${teamOptions}
                        </select>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('add-user-modal').remove()">Annuleren</button>
                        <button type="submit" class="btn btn-primary">Aanmaken</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    IconHelper.init(modal);

    // Update role description on change
    const roleSelect = modal.querySelector('#new-user-role');
    const roleHint = modal.querySelector('#new-user-role-hint');
    roleSelect.addEventListener('change', () => {
        roleHint.textContent = getRoleDescription(roleSelect.value);
    });

    const form = modal.querySelector('#add-user-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.querySelector('#new-user-name').value.trim();
        const email = form.querySelector('#new-user-email').value.trim() || null;
        const password = form.querySelector('#new-user-password').value;
        const passwordConfirm = form.querySelector('#new-user-password-confirm').value;
        const role = form.querySelector('#new-user-role').value;
        const team_id = form.querySelector('#new-user-team').value || null;

        // Validate passwords match (alleen als er een wachtwoord ingevuld is)
        if (password && password !== passwordConfirm) {
            showToast('Wachtwoorden komen niet overeen. Probeer opnieuw.', 'warning');
            return;
        }

        try {
            const response = await dataApiFetch('/admin/users', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    email,
                    password: password || undefined,
                    role,
                    team_id,
                    mainTeam: team_id,
                    employee_id: null
                })
            });
            // Add the new user to the local DataStore cache
            if (response.user) {
                DataStore.users.push(response.user);
            }
            modal.remove();
            showToast('Gebruiker aangemaakt', 'success');
            // Refresh accounts list
            renderSettingsAccounts(document.querySelector('#settings-tab-content'));
        } catch (err) {
            showToast('Fout bij aanmaken: ' + (err.message || 'Onbekende fout'), 'error');
        }
    });
}

function showEditAccountModal(user, teams, onSave) {
    const teamOptions = teams.map(team =>
        `<option value="${team.id}" ${user.team_id === team.id ? 'selected' : ''}>${escapeHtml(team.name)}</option>`
    ).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'edit-account-modal';
    // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
    // en de muis buiten het kader loslaat.
    modal.onmousedown = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content modal-content--md">
            <div class="modal-header">
                <h2>Account bewerken</h2>
                <button type="button" class="modal-close" aria-label="Sluiten" onclick="document.getElementById('edit-account-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body modal-body-sm">
                <form id="edit-account-form">
                    <div class="form-row d-flex gap-10">
                        <div class="form-group flex-1">
                            <label for="edit-user-name">Naam</label>
                            <input type="text" id="edit-user-name" class="form-input" value="${escapeHtml(user.name)}" required />
                        </div>
                        <div class="form-group flex-1">
                            <label for="edit-user-email">E-mail</label>
                            <input type="email" id="edit-user-email" class="form-input" value="${escapeHtml(user.email || '')}" placeholder="Optioneel, welkomstmail wordt gestuurd bij invullen" />
                        </div>
                    </div>
                    <div class="form-row d-flex gap-10">
                        <div class="form-group flex-1">
                            <label for="edit-user-role">Rol</label>
                            <select id="edit-user-role" class="form-input" required>
                                <option value="medewerker" ${user.role === 'medewerker' ? 'selected' : ''}>Medewerker</option>
                                <option value="roosterverantwoordelijke" ${user.role === 'roosterverantwoordelijke' ? 'selected' : ''}>Roosterverantw.</option>
                                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                            </select>
                            <span class="form-hint role-hint text-xs" id="edit-user-role-hint">${getRoleDescription(user.role)}</span>
                        </div>
                        <div class="form-group flex-1">
                            <label for="edit-user-team">Team</label>
                            <select id="edit-user-team" class="form-input">
                                <option value="">(geen team)</option>
                                ${teamOptions}
                            </select>
                        </div>
                    </div>
                    <div class="form-group form-row-inline mb-sm">
                        <label class="toggle-switch flex-shrink-0">
                            <input type="checkbox" id="edit-user-email-notif" ${user.emailNotificationsEnabled !== false ? 'checked' : ''} />
                            <span class="toggle-slider"></span>
                        </label>
                        <label for="edit-user-email-notif" class="text-xs cursor-pointer">E-mailmeldingen</label>
                    </div>
                    <div class="modal-actions modal-actions-split">
                        <div class="modal-actions-left">
                            <button type="button" class="btn btn-danger btn-sm" id="edit-account-delete-btn">${IconHelper.html('trash-2', 'xs')}</button>
                            <button type="button" class="btn btn-secondary btn-sm" id="edit-account-replace-btn">${IconHelper.html('user-round-plus', 'xs')} Vervang</button>
                            <button type="button" class="btn btn-secondary btn-sm" id="edit-account-reset-btn">${IconHelper.html('key-round', 'xs')} Reset ww</button>
                        </div>
                        <button type="submit" class="btn btn-primary btn-sm">Opslaan</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    IconHelper.init(modal);

    // Update role description on change
    const editRoleSelect = modal.querySelector('#edit-user-role');
    const editRoleHint = modal.querySelector('#edit-user-role-hint');
    editRoleSelect.addEventListener('change', () => {
        editRoleHint.textContent = getRoleDescription(editRoleSelect.value);
    });

    const form = modal.querySelector('#edit-account-form');

    // Save form
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newName = form.querySelector('#edit-user-name').value.trim();
        const newEmail = form.querySelector('#edit-user-email').value.trim();
        const newRole = form.querySelector('#edit-user-role').value;
        const newTeamId = form.querySelector('#edit-user-team').value || null;

        if (!newName) {
            showToast('Naam is verplicht', 'warning');
            return;
        }
        try {
            const emailNotif = form.querySelector('#edit-user-email-notif').checked;
            await dataApiFetch(`/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    name: newName,
                    email: newEmail || null,
                    role: newRole,
                    team_id: newTeamId,
                    mainTeam: newTeamId,
                    emailNotificationsEnabled: emailNotif
                })
            });

            // Update local DataStore cache
            const userIndex = DataStore.users.findIndex(u => String(u.id) === String(user.id));
            if (userIndex !== -1) {
                DataStore.users[userIndex] = {
                    ...DataStore.users[userIndex],
                    name: newName,
                    email: newEmail,
                    role: newRole,
                    team_id: newTeamId,
                    mainTeam: newTeamId
                };
            }

            modal.remove();
            showToast('Account bijgewerkt', 'success');
            if (onSave) onSave();
        } catch (error) {
            showToast(`Opslaan mislukt: ${error.message}`, 'error');
        }
    });

    // Reset password button
    modal.querySelector('#edit-account-reset-btn').addEventListener('click', async () => {
        if (!await showConfirm('Wachtwoord resetten naar standaard?')) return;
        try {
            const result = await dataApiFetch(`/admin/users/${user.id}/reset-password`, {
                method: 'POST'
            });
            // #322: hier werd het wachtwoord verzwegen zodra er een e-mailadres
            // was, met de belofte dat de medewerker het per mail zou krijgen.
            // Die mail bevat geen wachtwoord en verwijst juist terug naar de
            // beheerder. Het wachtwoord wordt nu altijd één keer getoond, en de
            // tekst zegt eerlijk of er daarnaast een bericht is vertrokken.
            if (result.newPassword) {
                const mailregel = result.emailSent
                    ? 'De medewerker krijgt een bericht dat het wachtwoord gereset is. Dat bericht bevat het wachtwoord niet, dus geef het hieronder persoonlijk door.'
                    : 'Er vertrekt geen bericht, dus geef het wachtwoord hieronder persoonlijk door.';
                // #154: een reset trekt ook de agendalink in. De medewerker
                // merkt dat anders pas als zijn agenda stilletjes achterloopt,
                // dus de beheerder hoort het te weten en te kunnen zeggen.
                const agendaregel = result.agendalinkIngetrokken
                    ? '\n\nZijn agendalink is uit voorzorg ingetrokken. Hij moet de koppeling opnieuw activeren via zijn profiel.'
                    : '';
                await showConfirm(
                    `Wachtwoord gereset.\n\n${mailregel}${agendaregel}\n\nNieuw wachtwoord:\n\n${result.newPassword}`,
                    'Wachtwoord gereset',
                    { confirmText: 'Begrepen', hideCancel: true }
                );
            } else {
                showToast('Wachtwoord gereset.', 'success');
            }
        } catch (error) {
            showToast(`Reset mislukt: ${error.message}`, 'error');
        }
    });

    // Delete button
    modal.querySelector('#edit-account-delete-btn').addEventListener('click', async () => {
        // Prevent deleting yourself
        if (String(user.id) === String(AppState.currentUser.id)) {
            showToast('Je kunt je eigen account niet verwijderen', 'warning');
            return;
        }

        const confirmMsg = `Weet je zeker dat je het account van "${user.name}" wilt verwijderen?\n\nDit verwijdert ook alle gekoppelde diensten en afwezigheden.\n\nDeze actie kan niet ongedaan worden gemaakt.`;

        if (!await showConfirm(confirmMsg, 'Account verwijderen', { danger: true, confirmText: 'Verwijderen' })) return;

        try {
            await deleteEmployee(Number(user.id));
            modal.remove();
            showToast('Account verwijderd', 'success');
            if (onSave) onSave();
        } catch (error) {
            showToast(`Verwijderen mislukt: ${error.message}`, 'error');
        }
    });

    // Replace button
    modal.querySelector('#edit-account-replace-btn').addEventListener('click', () => {
        modal.remove();
        showReplaceEmployeeModal(user, onSave);
    });
}

function showReplaceEmployeeModal(departingUser, onComplete) {
    const activeUsers = DataStore.users.filter(u =>
        u.active !== false && String(u.id) !== String(departingUser.id)
    );

    if (activeUsers.length === 0) {
        showToast('Geen andere actieve medewerkers beschikbaar', 'warning');
        return;
    }

    const userOptions = activeUsers.map(u =>
        `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>`
    ).join('');

    // #299: formatDateYYYYMMDD, niet toISOString. Tussen middernacht en 01:00
    // (winter) of 02:00 (zomer) geeft toISOString de datum van gisteren, en die
    // waarde wordt hier zowel value als min van het veld. De formuliervalidatie
    // blokkeert die te vroege datum dan niet, en er gaat een extra dag aan
    // diensten mee over naar de nieuwe medewerker.
    const today = formatDateYYYYMMDD(new Date());

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'replace-employee-modal';
    // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
    // en de muis buiten het kader loslaat.
    modal.onmousedown = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content modal-content--md">
            <div class="modal-header">
                <h2>${IconHelper.html('user-round-plus', 'md')} Medewerker vervangen</h2>
                <button type="button" class="modal-close" aria-label="Sluiten" onclick="document.getElementById('replace-employee-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <div class="info-box neutral mb-md">
                    <p><strong>${escapeHtml(departingUser.name)}</strong> wordt vervangen. Het basisrooster wordt gekopieerd naar de nieuwe medewerker en ${escapeHtml(departingUser.name)} wordt gedeactiveerd.</p>
                </div>
                <form id="replace-employee-form">
                    <div class="form-group">
                        <label for="replace-new-user">Nieuwe medewerker *</label>
                        <select id="replace-new-user" class="form-input" required>
                            <option value="">-- Kies medewerker --</option>
                            ${userOptions}
                        </select>
                    </div>
                    <div class="form-group form-row-inline">
                        <label class="toggle-switch flex-shrink-0">
                            <input type="checkbox" id="replace-transfer-shifts" />
                            <span class="toggle-slider"></span>
                        </label>
                        <label for="replace-transfer-shifts" class="cursor-pointer">Toekomstige diensten overnemen</label>
                    </div>
                    <div class="form-group hidden" id="replace-date-group">
                        <label for="replace-from-date">Overnemen vanaf *</label>
                        <input type="date" id="replace-from-date" class="form-input" value="${today}" min="${today}" />
                    </div>
                    <div id="replace-summary" class="hidden mt-sm"></div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('replace-employee-modal').remove()">Annuleren</button>
                        <button type="submit" class="btn btn-primary">Vervangen</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    IconHelper.init(modal);

    // Toggle date picker
    const transferCheckbox = modal.querySelector('#replace-transfer-shifts');
    const dateGroup = modal.querySelector('#replace-date-group');
    transferCheckbox.addEventListener('change', () => {
        dateGroup.classList.toggle('hidden', !transferCheckbox.checked);
        updateReplaceSummary();
    });

    // Update summary on changes
    modal.querySelector('#replace-new-user').addEventListener('change', updateReplaceSummary);
    modal.querySelector('#replace-from-date').addEventListener('change', updateReplaceSummary);

    function updateReplaceSummary() {
        const summaryEl = modal.querySelector('#replace-summary');
        const newUserId = modal.querySelector('#replace-new-user').value;
        const newUser = activeUsers.find(u => String(u.id) === String(newUserId));
        const transfer = transferCheckbox.checked;
        const fromDate = modal.querySelector('#replace-from-date').value;

        if (!newUser) {
            summaryEl.classList.add('hidden');
            return;
        }

        let summaryHtml = '<div class="info-box warning"><strong>Samenvatting:</strong><ul class="summary-list">';
        summaryHtml += `<li>Basisrooster van <strong>${escapeHtml(departingUser.name)}</strong> wordt gekopieerd naar <strong>${escapeHtml(newUser.name)}</strong></li>`;

        if (transfer && fromDate) {
            const futureShifts = DataStore.shifts.filter(s =>
                String(s.employeeId) === String(departingUser.id) && s.date >= fromDate
            );
            summaryHtml += `<li><strong>${futureShifts.length}</strong> toekomstige diensten worden overgedragen (vanaf ${fromDate})`;
            summaryHtml += `<br><small class="text-muted">Telling op basis van de geladen planning, het werkelijke aantal kan hoger zijn</small></li>`;
        } else {
            summaryHtml += `<li>Geen diensten overgedragen. Pas het actieve concept opnieuw toe via Rooster bouwen</li>`;
        }

        summaryHtml += `<li><strong>${escapeHtml(departingUser.name)}</strong> wordt gedeactiveerd</li>`;
        summaryHtml += '</ul></div>';

        summaryEl.innerHTML = summaryHtml;
        summaryEl.classList.remove('hidden');
    }

    // Submit handler
    modal.querySelector('#replace-employee-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const newUserId = modal.querySelector('#replace-new-user').value;
        if (!newUserId) {
            showToast('Selecteer een nieuwe medewerker', 'warning');
            return;
        }

        const transfer = transferCheckbox.checked;
        const fromDate = transfer ? modal.querySelector('#replace-from-date').value : null;

        if (transfer && !fromDate) {
            showToast('Selecteer een datum voor overname', 'warning');
            return;
        }

        const newUser = activeUsers.find(u => String(u.id) === String(newUserId));
        const confirmMsg = `Weet je zeker dat je ${departingUser.name} wilt vervangen door ${newUser.name}?\n\nDeze actie kan niet ongedaan worden gemaakt.`;

        if (!await showConfirm(confirmMsg, 'Medewerker vervangen', { danger: true, confirmText: 'Vervangen' })) return;

        try {
            const result = await replaceEmployee(Number(departingUser.id), Number(newUserId), fromDate);
            modal.remove();

            // Weekendverantwoordelijkheid overerven
            const rotation = DataStore.settings.responsibleRotation;
            if (rotation) {
                let rotationChanged = false;
                // Als vertrekkende medewerker de startpersoon was → vervanger overneemt
                if (String(rotation.rotationStartEmployee) === String(departingUser.id)) {
                    rotation.rotationStartEmployee = String(newUserId);
                    rotationChanged = true;
                }
                // Handmatige toewijzingen overzetten
                if (rotation.assignments) {
                    for (const [dateKey, assignedId] of Object.entries(rotation.assignments)) {
                        if (String(assignedId) === String(departingUser.id)) {
                            rotation.assignments[dateKey] = String(newUserId);
                            rotationChanged = true;
                        }
                    }
                }
                if (rotationChanged) {
                    await saveResponsibleRotationSettings();
                }
            }

            let msg = `${departingUser.name} vervangen door ${newUser.name}`;
            if (result.shiftsTransferred > 0) {
                msg += ` (${result.shiftsTransferred} diensten overgedragen)`;
            }
            if (result.draftsUpdated > 0) {
                msg += ` (${result.draftsUpdated} concept${result.draftsUpdated > 1 ? 'en' : ''} bijgewerkt)`;
            }
            showToast(msg, 'success');

            if (result.hint === 'apply_concept') {
                showToast(`${newUser.name} heeft nog geen diensten. Pas het actieve concept opnieuw toe via Rooster bouwen.`, 'info', 6000);
            }

            if (onComplete) onComplete();
        } catch (error) {
            showToast(`Vervanging mislukt: ${error.message}`, 'error');
        }
    });
}

// ===== SETTINGS TAB: PLANNING =====
function renderClosedDatesList() {
    const closedDates = DataStore.settings.closedDates || [];
    if (closedDates.length === 0) {
        return '<p class="empty-state-text text-sm text-muted">Geen manueel gesloten datums ingesteld.</p>';
    }
    const items = closedDates.map(cd => {
        const d = parseDateOnly(cd.date);
        const label = d.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const reasonHtml = cd.reason ? ' · ' + escapeHtml(cd.reason) : '';
        return `<li class="closed-date-item">
            <span>${IconHelper.html(ICONS.lock,'xs')} <strong>${escapeHtml(label)}</strong>${reasonHtml}</span>
            <button class="btn btn-sm btn-danger" onclick="handleRemoveClosedDate('${cd.date}')" title="Verwijder">
                ${IconHelper.html(ICONS.delete,'xs')}
            </button>
        </li>`;
    }).join('');
    return `<ul class="closed-dates-list">${items}</ul>`;
}

async function openAddClosedDateDialog() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
        <div class="quick-dialog">
            <div class="quick-dialog-title">Datum toevoegen</div>
            <div class="form-group">
                <label class="quick-dialog-label">Datum</label>
                <input type="date" id="_cd-date" class="form-input quick-dialog-input">
            </div>
            <div class="form-group mt-sm">
                <label class="quick-dialog-label">Reden (optioneel)</label>
                <input type="text" id="_cd-reason" class="form-input quick-dialog-input" placeholder="bijv. Brugdag" maxlength="80">
            </div>
            <div class="quick-dialog-actions">
                <button id="_cd-cancel" class="btn btn-secondary">Annuleer</button>
                <button id="_cd-ok" class="btn btn-primary">Toevoegen</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const dateInput = overlay.querySelector('#_cd-date');
    dateInput.focus();
    overlay.querySelector('#_cd-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#_cd-ok').addEventListener('click', async () => {
        const date = dateInput.value;
        if (!date) { showToast('Kies een datum', 'warning'); return; }
        const reason = overlay.querySelector('#_cd-reason').value.trim();
        overlay.remove();

        const shiftsOnDate = (DataStore.shifts || []).filter(s => (s.date || '').split('T')[0] === date);
        if (shiftsOnDate.length > 0) {
            const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' });
            const ok = await showConfirm(
                `Er staan ${shiftsOnDate.length} dienst(en) ingepland op ${dateLabel}. Deze worden verwijderd bij het sluiten.`,
                'Dag sluiten'
            );
            if (!ok) return;
        }

        // #189: zonder foutafhandeling waren de diensten weg terwijl de dag
        // niet gesloten raakte, en zag de gebruiker daar niets van.
        try {
            for (const shift of shiftsOnDate) {
                await deleteShift(shift.id, true);
            }
            await addClosedDate(date, reason);
            showToast('Dag gesloten', 'success');
        } catch (error) {
            showToast('Dag sluiten mislukt: ' + getUserFriendlyError(error), 'error');
        } finally {
            renderPlanning();
            const listEl = document.getElementById('closed-dates-list');
            if (listEl) { listEl.innerHTML = renderClosedDatesList(); IconHelper.init(listEl); }
        }
    });
}

async function handleRemoveClosedDate(dateStr) {
    await removeClosedDate(dateStr);
    renderPlanning();
    const listEl = document.getElementById('closed-dates-list');
    if (listEl) { listEl.innerHTML = renderClosedDatesList(); IconHelper.init(listEl); }
}

function renderSettingsPlanning(container) {
    const rules = DataStore.settings.rules;

    // Check if a holiday period is currently active or upcoming
    const today = new Date();
    // #299: idem. Rond middernacht toonde de banner "Vakantiewerking actief"
    // anders de vakantieperiode van gisteren.
    const todayStr = formatDateYYYYMMDD(today);
    const activeHoliday = getHolidayPeriod(todayStr);
    const upcomingHoliday = !activeHoliday ? (DataStore.settings.holidayPeriods || []).find(p => {
        const start = parseDateOnly(p.startDate);
        const diff = (start - today) / (1000 * 60 * 60 * 24);
        return diff > 0 && diff <= 14;
    }) : null;

    const holidayBanner = activeHoliday
        ? `<div class="holiday-status-banner active">
                <span class="holiday-status-icon">${IconHelper.html(ICONS.holiday, 'md')}</span>
                <div class="holiday-status-text">
                    <strong>Vakantiewerking actief: ${escapeHtml(activeHoliday.name)}</strong>
                    <span>${activeHoliday.startDate} t/m ${activeHoliday.endDate}</span>
                </div>
                <a href="#settings-holidays" class="btn btn-sm btn-secondary" onclick="document.getElementById('settings-holidays').scrollIntoView({behavior:'smooth'})">Instellingen</a>
           </div>`
        : upcomingHoliday
        ? `<div class="holiday-status-banner upcoming">
                <span class="holiday-status-icon">${IconHelper.html(ICONS.calendar, 'md')}</span>
                <div class="holiday-status-text">
                    <strong>Komende vakantie: ${escapeHtml(upcomingHoliday.name)}</strong>
                    <span>Start ${upcomingHoliday.startDate}</span>
                </div>
                <a href="#settings-holidays" class="btn btn-sm btn-secondary" onclick="document.getElementById('settings-holidays').scrollIntoView({behavior:'smooth'})">Instellingen</a>
           </div>`
        : '';

    container.innerHTML = `
        ${holidayBanner}
        <!-- Planningsregels -->
        <div class="settings-card mt-lg" id="settings-rules">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Planningsregels</h3>
                    <p class="settings-card-subtitle">Regels voor rust en minimale bezetting.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="form-group">
                    <label for="rule-min-hours">Minimum uren tussen diensten:</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-min-hours" class="form-input" value="${rules.minHoursBetweenShifts}" min="0" max="24" />
                        <span class="unit">uur</span>
                    </div>
                    <span class="form-hint">Wettelijk minimum is 11 uur</span>
                </div>
                <div class="form-group">
                    <label for="rule-max-consecutive">Max opeenvolgende werkdagen:</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-max-consecutive" class="form-input" value="${rules.maxConsecutiveDays || 6}" min="1" max="14" />
                        <span class="unit">dagen</span>
                    </div>
                    <span class="form-hint">Waarschuwing bij overschrijding in planning</span>
                </div>
                <div class="d-flex align-items-center gap-sm">
                    <button class="btn btn-primary" onclick="saveRules()">Regels opslaan</button>
                    <span class="settings-dirty-indicator hidden">● Niet opgeslagen</span>
                </div>
            </div>
        </div>

        <!-- Vakantiewerking -->
        <div class="settings-card mt-lg" id="settings-holidays">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Vakantiewerking</h3>
                    <p class="settings-card-subtitle">Regels en periodes voor vakantieplanning.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openAddHolidayModal()">+ Periode</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box info">
                    <p>Tijdens schoolvakanties: <strong>Vlot 1 en Vlot 2 worden samengevoegd</strong> tot 1 leefgroep. Begeleiders van beide teams werken samen.</p>
                </div>

                <div class="holiday-periods-section">
                    <h4>Vakantieperiodes</h4>
                    <div class="holiday-periods-list" id="holiday-periods-list">
                        ${renderHolidayPeriods()}
                    </div>
                </div>
            </div>
        </div>

        <!-- Manueel gesloten datums -->
        <div class="settings-card mt-lg" id="settings-closed-dates">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Manueel gesloten datums</h3>
                    <p class="settings-card-subtitle">Brugdagen en uitzonderlijke sluitingen. Op deze datums kunnen geen nieuwe diensten worden aangemaakt.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openAddClosedDateDialog()">+ Datum toevoegen</button>
                </div>
            </div>
            <div class="settings-card-body" id="closed-dates-list">
                ${renderClosedDatesList()}
            </div>
        </div>

    `;
}

// ===== SETTINGS TAB: ROOSTER =====
// #182: saveSchedulePattern is hier verwijderd. Hij werd nergens aangeroepen
// en las #schedule-cycle-length en #schedule-reference-date, twee velden die
// niet bestaan. Het roosterpatroon wordt nu via de roosterbouwer gezet.

// ===== SETTINGS TAB: TEAMS =====
function renderSettingsTeams(container) {
    container.innerHTML = `
        <!-- Teams configuratie -->
        <div class="settings-card" id="settings-teams">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Teams</h3>
                    <p class="settings-card-subtitle">Naam, kleur en opties per team.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" id="btn-add-team">+ Nieuw</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="team-legend">
                    <span class="team-legend-item">Bezetting = telt mee in bezettingsberekening</span>
                    <span class="team-legend-item">Weekend = draait mee in weekendverantwoordelijke rotatie</span>
                </div>
                <div class="teams-list" id="teams-config">
                    ${renderTeamsConfig()}
                </div>
            </div>
        </div>

        <!-- Dienstsjablonen -->
        <div class="settings-card mt-lg" id="settings-templates">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Dienstsjablonen</h3>
                    <p class="settings-card-subtitle">Standaard diensten voor snelle planning.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openAddTemplateModal()">+ Nieuw</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="templates-list" id="shift-templates-config">
                    ${renderTemplatesConfig()}
                </div>
            </div>
        </div>

        <!-- Weekendverantwoordelijke rotatie -->
        <div class="settings-card mt-lg" id="settings-weekend-responsible">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Weekendverantwoordelijke</h3>
                    <p class="settings-card-subtitle">Rotatie-instellingen en planning.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="rotation-form">
                    ${renderRotationSettingsCompact()}
                </div>
                <div class="upcoming-section mt-lg">
                    <h4 class="upcoming-section-title">Komende open weekenden</h4>
                    <div class="upcoming-responsibles">
                        ${renderUpcomingResponsibles()}
                    </div>
                </div>
            </div>
        </div>
    `;

    // Event listener for add team button
    document.getElementById('btn-add-team')?.addEventListener('click', openAddTeamModal);

    // Attach click listeners for weekend picker after DOM is set
    requestAnimationFrame(() => {
        const upcomingContainer = container.querySelector('.upcoming-responsibles');
        if (upcomingContainer) attachUpcomingWeekendListeners(upcomingContainer);
        initTeamDragSort();
    });
}

async function editTeam(teamId) {
    const team = DataStore.settings.teams[teamId];
    if (!team) return;

    const newName = await showInputPrompt('Nieuwe teamnaam:', 'Team bewerken', team.name);
    if (!newName || !newName.trim() || newName.trim() === team.name) return;

    const name = newName.trim();

    try {
        // Update settings (primary source of truth for frontend)
        DataStore.settings.teams[teamId].name = name;
        await saveSettings('teams', DataStore.settings.teams);
        applyTeamColors();
        AppState.apiTeams = null; // Invalidate cache

        // Also update teams DB table (for FK constraints)
        try {
            await dataApiFetch(`/teams/${teamId}`, {
                method: 'PUT',
                body: JSON.stringify({ name })
            });
        } catch (e) {
            console.warn('Teams DB update skipped:', e.message);
        }

        showToast(`Team "${name}" bijgewerkt`, 'success');
        renderSettings();
    } catch (error) {
        showToast(error.message || 'Fout bij bewerken team', 'error');
    }
}

async function deleteTeam(teamId) {
    const team = DataStore.settings.teams[teamId];
    if (!team) return;

    // Check if team still has members
    const members = DataStore.users.filter(u => u.main_team === teamId || u.team_id === teamId);
    if (members.length > 0) {
        const names = members.slice(0, 5).map(u => u.name).join(', ');
        const extra = members.length > 5 ? ` en ${members.length - 5} anderen` : '';
        showToast(`Kan team "${team.name}" niet verwijderen: ${members.length} medewerker(s) zitten nog in dit team (${names}${extra}). Verplaats ze eerst naar een ander team.`, 'error');
        return;
    }

    const confirmed = await showConfirm(`Weet je zeker dat je team "${team.name}" wilt verwijderen?`,
        'Team verwijderen', { danger: true, confirmText: 'Team verwijderen' });
    if (!confirmed) return;

    // #256: dit verwijderde het team eerst uit de instellingen en probeerde
    // pas daarna de rij in de teams-tabel weg te halen, met een leeg
    // catch-blok eromheen. Een team met historische diensten gaf daar een
    // FK-fout, die in de console verdween: het team was weg uit de
    // instellingen maar stond nog in de tabel, en oude diensten toonden
    // "Onbekend". Zelfde volgorde-fout als #221.
    //
    // De tabel is nu leidend. Lukt het daar niet, dan blijven de instellingen
    // staan en weet de gebruiker waarom.
    try {
        await dataApiFetch(`/teams/${teamId}`, { method: 'DELETE' });
    } catch (error) {
        showToast('Team niet verwijderd: ' + getUserFriendlyError(error), 'error');
        return;
    }

    try {
        delete DataStore.settings.teams[teamId];
        await saveSettings('teams', DataStore.settings.teams);
        applyTeamColors();
        AppState.apiTeams = null;
        syncTeamFilters();

        showToast(`Team "${team.name}" verwijderd`, 'success');
        renderSettings();
    } catch (error) {
        DataStore.settings.teams[teamId] = team;
        showToast('Team is uit de database verwijderd, maar de instellingen zijn niet bijgewerkt: '
            + getUserFriendlyError(error), 'error');
    }
}

async function openAddTeamModal() {
    const teamName = await showInputPrompt('Team naam:', 'Nieuw team aanmaken');
    if (!teamName || !teamName.trim()) return;

    const name = teamName.trim();
    const teamId = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

    if (!teamId) {
        showToast('Ongeldige teamnaam', 'error');
        return;
    }

    if (DataStore.settings.teams[teamId]) {
        showToast('Een team met dit ID bestaat al', 'error');
        return;
    }

    const color = '#64748b'; // Default gray

    try {
        // #221: hier stond eerst settings.teams geschreven en pas daarna de
        // teams-tabel, met de tweede schrijfactie in een eigen try die alleen
        // console.warn deed. Faalde die tweede, dan kreeg de gebruiker toch
        // "Team aangemaakt" te zien, terwijl het team in elk keuzemenu
        // verscheen zonder dat er iemand aan toe te wijzen was: PUT /users/:id
        // faalde dan met een kale 500 op de foreign key.
        //
        // De teams-tabel is de kant met de foreign key, dus die schrijven we
        // nu eerst. Faalt dat, dan raken settings.teams en de rest van de UI
        // niet aan en krijgt de gebruiker een echte foutmelding in plaats van
        // een valse succesmelding. Er is dan geen half aangemaakt team.
        await dataApiFetch('/teams', {
            method: 'POST',
            body: JSON.stringify({ id: teamId, name, color })
        });

        // Update settings (primary source of truth for frontend)
        const existingOrders = Object.values(DataStore.settings.teams).map(t => t.sort_order ?? 0);
        const nextOrder = existingOrders.length ? Math.max(...existingOrders) + 1 : 0;
        DataStore.settings.teams[teamId] = { name, color, sort_order: nextOrder };
        await saveSettings('teams', DataStore.settings.teams);

        // Auto-add to coverage teams
        const ct = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams);
        if (!ct.includes(teamId)) { ct.push(teamId); }
        DataStore.settings.coverageTeams = ct;
        await saveSettings('coverageTeams', ct);

        syncTeamFilters();
        applyTeamColors();
        AppState.apiTeams = null; // Invalidate cache

        showToast(`Team "${name}" aangemaakt`, 'success');
        renderSettings();
    } catch (error) {
        showToast('Team aanmaken mislukt: ' + getUserFriendlyError(error), 'error');
    }
}

// ===== SETTINGS TAB: EMAIL =====
function renderSettingsEmail(container) {
    const effectiveRole = getEffectiveRole();
    if (effectiveRole !== 'admin' && effectiveRole !== 'roosterverantwoordelijke') {
        container.innerHTML = '<p>Je hebt geen toegang tot deze instellingen.</p>';
        return;
    }

    const emailSettings = DataStore.settings.emailNotifications || {
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
            password_reset: true
        }
    };

    const emailTypes = [
        { key: 'swap_request', label: 'Ruilverzoek aangemaakt', desc: 'Collega ontvangt mail bij een nieuw ruilverzoek' },
        { key: 'takeover_available', label: 'Dienst beschikbaar voor overname', desc: 'Teamleden worden gemaild wanneer een dienst beschikbaar is' },
        { key: 'sick_leave', label: 'Ziekmelding', desc: 'Verantwoordelijken worden gemaild bij een ziekmelding' },
        { key: 'swap_approved', label: 'Ruil goedgekeurd', desc: 'Beide partijen worden gemaild na goedkeuring' },
        { key: 'swap_rejected', label: 'Ruil afgewezen', desc: 'Aanvrager wordt gemaild bij afwijzing' },
        { key: 'takeover_accepted', label: 'Dienst overgenomen', desc: 'Oorspronkelijke eigenaar wordt gemaild' },
        { key: 'request_cancelled', label: 'Verzoek geannuleerd', desc: 'Betrokkenen worden gemaild bij annulering' },
        { key: 'welcome', label: 'Welkomstmail', desc: 'Nieuwe medewerker ontvangt zijn inloggegevens per e-mail' },
        // #323: de resetmail hing aan de schakelaar hierboven. Wie de
        // welkomstmail uitzette, zette daarmee ongemerkt ook dit bericht uit.
        { key: 'password_reset', label: 'Wachtwoord gereset', desc: 'Medewerker krijgt bericht dat een beheerder het wachtwoord heeft gereset' }
    ];

    const typeToggles = emailTypes.map(t => `
        <div class="email-setting-row ${!emailSettings.globalEnabled ? 'email-disabled' : ''}" id="email-type-row-${t.key}">
            <div class="email-setting-info">
                <span class="email-setting-label">${t.label}</span>
                <span class="email-setting-desc">${t.desc}</span>
            </div>
            <!-- #366: het omhullende label bevat alleen het schuifje en dus geen
                 tekst, waardoor het vinkje geen naam had. -->
            <label class="toggle-switch">
                <input type="checkbox" data-email-type="${t.key}" aria-label="${escapeHtml(t.label)}" ${emailSettings.types?.[t.key] !== false ? 'checked' : ''} ${!emailSettings.globalEnabled ? 'disabled' : ''} />
                <span class="toggle-slider"></span>
            </label>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="settings-card">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>E-mail en meldingen</h3>
                    <p class="settings-card-subtitle">Beheer welke e-mails automatisch verstuurd worden.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="email-setting-row email-setting-global">
                    <div class="email-setting-info">
                        <span class="email-setting-label fw-600">Alle e-mailmeldingen</span>
                        <span class="email-setting-desc">Schakel alle e-mailmeldingen in of uit</span>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="email-global-toggle" aria-label="Alle e-mailmeldingen" ${emailSettings.globalEnabled ? 'checked' : ''} />
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <hr class="my-sm settings-divider" />
                ${typeToggles}
                <div class="form-actions mt-md d-flex align-items-center gap-sm">
                    <button type="button" class="btn btn-primary" id="email-settings-save-btn">Opslaan</button>
                    <span class="settings-dirty-indicator hidden">● Niet opgeslagen</span>
                </div>
                <div id="email-settings-message" class="form-message hidden mt-sm"></div>
            </div>
        </div>

        <div class="settings-card mt-lg">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>E-mailconfiguratie</h3>
                    <p class="settings-card-subtitle">Status van de e-mailservice en verificatie.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="d-flex align-items-center gap-sm mb-md">
                    <span class="text-sm text-muted">Status:</span>
                    <span id="email-status-badge" class="email-status-badge">Laden...</span>
                </div>
                <div class="form-group mb-md">
                    <label class="form-label" for="email-from-display">Afzenderadres</label>
                    <input type="text" id="email-from-display" class="form-input" readonly />
                    <span class="form-hint">Stel in via de <code>EMAIL_FROM</code> omgevingsvariabele op de server.</span>
                </div>
                <div class="d-flex align-items-center gap-sm">
                    <button type="button" class="btn btn-secondary" id="email-test-btn">Stuur testmail naar mij</button>
                    <span id="email-test-message" class="text-sm hidden"></span>
                </div>
            </div>
        </div>
    `;

    // Global toggle enables/disables individual toggles
    const globalToggle = container.querySelector('#email-global-toggle');
    const typeCheckboxes = container.querySelectorAll('[data-email-type]');

    globalToggle.addEventListener('change', () => {
        typeCheckboxes.forEach(cb => {
            cb.disabled = !globalToggle.checked;
        });
    });

    // Load email status
    dataApiFetch('/admin/email-status').then(data => {
        const badge = container.querySelector('#email-status-badge');
        const fromInput = container.querySelector('#email-from-display');
        const testBtn = container.querySelector('#email-test-btn');
        if (badge) {
            badge.textContent = data.configured ? '✓ Geconfigureerd' : '✗ Niet geconfigureerd';
            badge.className = `email-status-badge ${data.configured ? 'configured' : 'not-configured'}`;
        }
        if (fromInput) fromInput.value = data.from || '';
        if (testBtn) testBtn.disabled = !data.configured;
    }).catch(() => {
        const badge = container.querySelector('#email-status-badge');
        if (badge) {
            badge.textContent = 'Niet beschikbaar';
            badge.className = 'email-status-badge not-configured';
        }
    });

    // Test email button
    container.querySelector('#email-test-btn')?.addEventListener('click', async () => {
        const btn = container.querySelector('#email-test-btn');
        const msg = container.querySelector('#email-test-message');
        btn.disabled = true;
        btn.textContent = 'Versturen...';
        if (msg) { msg.className = 'text-sm hidden'; }
        try {
            const result = await dataApiFetch('/admin/test-email', { method: 'POST' });
            if (msg) {
                msg.textContent = `✓ Testmail verstuurd naar ${result.sentTo}`;
                msg.className = 'text-sm text-success';
                msg.classList.remove('hidden');
            }
        } catch (err) {
            if (msg) {
                msg.textContent = '✗ ' + (err.message || 'Versturen mislukt');
                msg.className = 'text-sm text-danger';
                msg.classList.remove('hidden');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = 'Stuur testmail naar mij';
        }
    });

    // Save button
    container.querySelector('#email-settings-save-btn').addEventListener('click', async () => {
        const saveBtn = container.querySelector('#email-settings-save-btn');
        const msg = container.querySelector('#email-settings-message');
        const settings = {
            globalEnabled: globalToggle.checked,
            types: {}
        };
        typeCheckboxes.forEach(cb => {
            settings.types[cb.dataset.emailType] = cb.checked;
        });

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Opslaan...';
            await saveSettings('email_notifications', settings);
            DataStore.settings.emailNotifications = settings;
            msg.textContent = 'E-mailinstellingen opgeslagen.';
            msg.className = 'form-message success';
            msg.classList.remove('hidden');
            markSettingsSaved();
            showToast('E-mailinstellingen opgeslagen', 'success');
        } catch (err) {
            msg.textContent = 'Opslaan mislukt: ' + (err.message || 'Onbekende fout');
            msg.className = 'form-message error';
            msg.classList.remove('hidden');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Opslaan';
        }
    });
}

// ===== SETTINGS TAB: SYSTEEM =====
function renderSettingsSystem(container) {
    const isAdmin = getEffectiveRole() === 'admin';

    container.innerHTML = `
        <!-- Databeheer -->
        <div class="settings-card" id="settings-data">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Databeheer</h3>
                    <p class="settings-card-subtitle">Backup, import en reset van de data.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box neutral">
                    <p>Alle data wordt opgeslagen in de PostgreSQL database.</p>
                    <p>Exporteer regelmatig een backup om dataverlies te voorkomen.</p>
                    <p class="text-muted">De backup bevat medewerkers, diensten, afwezigheden en instellingen. Roosterconcepten, verlofrondes en ruilverzoeken zitten er niet in.</p>
                </div>
                <div class="data-stats">
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.employees.length}</span>
                        <span class="stat-label">Medewerkers</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.shifts.length}</span>
                        <span class="stat-label">Diensten</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.availability.length}</span>
                        <span class="stat-label">Afwezigheden</span>
                    </div>
                </div>
                <div class="button-group">
                    <button class="btn btn-secondary" onclick="exportData()">Exporteren</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('import-file').click()">Importeren</button>
                    <input type="file" id="import-file" accept=".json" class="hidden" onchange="importData(event)">
                </div>
                ${isAdmin && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') ? `
                <div class="migration-zone">
                    <h4>Database migratie (dev)</h4>
                    <p>Voer database migraties uit om data te repareren (bijv. weekroosters fixen).</p>
                    <button class="btn btn-secondary" onclick="runMigration()">Database migreren</button>
                    <button class="btn btn-secondary ml-sm" onclick="seedTeams()">Teams aanmaken</button>
                    <button class="btn btn-secondary ml-sm" onclick="showDebugInfo()">Debug info</button>
                </div>
                ` : ''}
                ${isAdmin ? `
                <div class="danger-zone">
                    <h4>Gevarenzone</h4>
                    <p>Deze actie kan niet ongedaan worden gemaakt!</p>
                    <button class="btn btn-danger" onclick="resetData()">Alle data wissen</button>
                </div>
                ` : ''}
            </div>
        </div>

        <!-- App info -->
        <div class="settings-card mt-lg" id="settings-about">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Over de app</h3>
                    <p class="settings-card-subtitle">Versie en korte uitleg.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="app-info">
                    <div class="app-logo">Het Vlot</div>
                    <p class="app-subtitle">Roosterplanning Applicatie</p>
                    <div class="app-version">Versie 1.3.2</div>
                    <p class="app-description">
                        Een planning tool voor Het Vlot om diensten, medewerkers en beschikbaarheid te beheren.
                    </p>
                </div>
            </div>
        </div>
    `;
}

// ===== SETTINGS TAB: BEHEER (combined system + audit) =====
function renderSettingsBeheer(container) {
    const isAdmin = getEffectiveRole() === 'admin';
    if (!isAdmin) {
        container.innerHTML = `<div class="settings-card"><div class="settings-card-body">
            <div class="info-box neutral"><p>Je hebt geen toegang tot deze instellingen.</p></div>
        </div></div>`;
        return;
    }

    container.innerHTML = `
        <!-- Databeheer -->
        <div class="settings-card" id="settings-data">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Databeheer</h3>
                    <p class="settings-card-subtitle">Backup, import en reset van de data.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box neutral">
                    <p>Alle data wordt opgeslagen in de PostgreSQL database.</p>
                    <p>Exporteer regelmatig een backup om dataverlies te voorkomen.</p>
                    <p class="text-muted">De backup bevat medewerkers, diensten, afwezigheden en instellingen. Roosterconcepten, verlofrondes en ruilverzoeken zitten er niet in.</p>
                </div>
                <div class="data-stats">
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.employees.length}</span>
                        <span class="stat-label">Medewerkers</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.shifts.length}</span>
                        <span class="stat-label">Diensten</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.availability.length}</span>
                        <span class="stat-label">Afwezigheden</span>
                    </div>
                </div>
                <div class="button-group">
                    <button class="btn btn-secondary" onclick="exportData()">Exporteren</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('import-file').click()">Importeren</button>
                    <input type="file" id="import-file" accept=".json" class="hidden" onchange="importData(event)">
                </div>
            </div>
        </div>

        <!-- Audit log -->
        <div class="settings-card mt-lg">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Auditlog</h3>
                    <p class="settings-card-subtitle">Overzicht van alle wijzigingen in het systeem.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="audit-filters">
                    <div class="audit-filter-row">
                        <div class="form-group">
                            <!-- #366: deze labels stonden zonder for-attribuut en hoorden
                                 dus bij geen enkel veld. -->
                            <label for="audit-start-date">Van</label>
                            <input type="date" id="audit-start-date" class="form-input" value="${getDefaultAuditStartDate()}">
                        </div>
                        <div class="form-group">
                            <label for="audit-end-date">Tot</label>
                            <input type="date" id="audit-end-date" class="form-input" value="${formatDateYYYYMMDD(new Date())}">
                        </div>
                        <div class="form-group">
                            <label for="audit-action-filter">Actie</label>
                            <select id="audit-action-filter" class="form-input">
                                <option value="">Alle</option>
                                <option value="CREATE">Aangemaakt</option>
                                <option value="UPDATE">Bijgewerkt</option>
                                <option value="DELETE">Verwijderd</option>
                                <option value="APPROVE">Goedgekeurd</option>
                                <option value="REJECT">Afgewezen</option>
                                <option value="CANCEL">Geannuleerd</option>
                                <option value="REPLACE">Vervangen</option>
                                <option value="IMPORT">Geïmporteerd</option>
                                <option value="MIGRATE">Gemigreerd</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="audit-resource-filter">Type</label>
                            <select id="audit-resource-filter" class="form-input">
                                <option value="">Alle</option>
                                <option value="shift">Diensten</option>
                                <option value="availability">Afwezigheid</option>
                                <option value="swap_request">Ruilverzoek</option>
                                <option value="user">Gebruiker</option>
                                <option value="settings">Instellingen</option>
                            </select>
                        </div>
                        <div class="form-group self-end">
                            <button class="btn btn-primary" onclick="loadAuditLog(1)">Zoeken</button>
                            <button class="btn btn-secondary" onclick="exportAuditLog()">Exporteer CSV</button>
                        </div>
                    </div>
                    <label class="toggle-switch-label mt-sm">
                        <input type="checkbox" id="audit-show-system" class="toggle-switch-input" onchange="loadAuditLog(1)">
                        <span class="toggle-switch-slider"></span>
                        <span class="toggle-switch-text">Toon systeem-acties</span>
                    </label>
                </div>
                <div id="audit-log-results"></div>
                <div id="audit-log-pagination" class="audit-pagination"></div>
            </div>
        </div>

        <!-- Gevarenzone (collapsible, starts collapsed) -->
        <div class="settings-card collapsed mt-lg" id="settings-danger-zone">
            <div class="settings-card-header cursor-pointer" onclick="this.parentElement.classList.toggle('collapsed')">
                <div class="settings-card-title">
                    <h3>Gevarenzone</h3>
                    <p class="settings-card-subtitle">Onomkeerbare acties.</p>
                </div>
                <i data-lucide="chevron-down" class="lucide-sm collapse-indicator"></i>
            </div>
            <div class="settings-card-body">
                <div class="info-box info-box-danger">
                    <p class="text-danger fw-600">Let op: deze actie kan niet ongedaan worden gemaakt!</p>
                    <p>Kies wat je wilt verwijderen: alleen data, data + accounts, of alles behalve je eigen account.</p>
                </div>
                <button class="btn btn-danger" onclick="resetData()">Alle data wissen</button>
            </div>
        </div>
    `;

    loadAuditLog(1);
}

// #373: REPLACE, IMPORT en MIGRATE stonden wel in de keuzelijst maar niet
// hier, en verschenen dus als ruw REPLACE tussen Nederlandse deelwoorden.
// LOGIN stond er wél in, maar de backend logt die actie nergens: nagegaan
// met een inventaris van alle logAudit-aanroepen in server.js, en op de
// productiedatabank komt de actie niet voor. De optie is uit de keuzelijst
// gehaald, want ze gaf altijd nul resultaten.
const AUDIT_ACTION_LABELS = {
    CREATE: 'Aangemaakt',
    UPDATE: 'Bijgewerkt',
    DELETE: 'Verwijderd',
    APPROVE: 'Goedgekeurd',
    REJECT: 'Afgewezen',
    CANCEL: 'Geannuleerd',
    REPLACE: 'Vervangen',
    IMPORT: 'Geïmporteerd',
    MIGRATE: 'Gemigreerd'
};

// De backend logt ook system, shift_block en shift_activity. Die stonden hier
// niet en verschenen dus als ruwe tabelnaam.
const AUDIT_RESOURCE_LABELS = {
    shift: 'Dienst',
    availability: 'Afwezigheid',
    swap_request: 'Ruilverzoek',
    user: 'Gebruiker',
    settings: 'Instelling',
    shift_block: 'Geblokkeerde dag',
    shift_activity: 'Activiteit',
    system: 'Systeem'
};

const AUDIT_SYSTEM_ACTIONS = new Set(['MIGRATE', 'IMPORT']);

function getDefaultAuditStartDate() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return formatDateYYYYMMDD(d);
}

function getDateGroup(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() === today.getTime()) return 'Vandaag';
    if (d.getTime() === yesterday.getTime()) return 'Gisteren';
    if (d >= weekAgo) return 'Deze week';
    return 'Ouder';
}

async function loadAuditLog(page) {
    const resultsEl = document.getElementById('audit-log-results');
    const paginationEl = document.getElementById('audit-log-pagination');
    if (!resultsEl) return;

    resultsEl.innerHTML = '<p class="p-md text-muted">Laden...</p>';

    const filters = {
        page,
        limit: 30,
        action: document.getElementById('audit-action-filter')?.value || '',
        resourceType: document.getElementById('audit-resource-filter')?.value || '',
        startDate: document.getElementById('audit-start-date')?.value || '',
        endDate: document.getElementById('audit-end-date')?.value || ''
    };

    try {
        const data = await fetchAuditLog(filters);
        let logs = data.logs || [];

        // Filter system actions unless toggle is on
        const showSystem = document.getElementById('audit-show-system')?.checked;
        if (!showSystem) {
            logs = logs.filter(log => !AUDIT_SYSTEM_ACTIONS.has(log.action));
        }

        if (logs.length === 0) {
            resultsEl.innerHTML = '<div class="info-box neutral"><p>Geen resultaten gevonden.</p></div>';
            paginationEl.innerHTML = '';
            return;
        }

        // Group logs by date category
        const groups = {};
        const groupOrder = ['Vandaag', 'Gisteren', 'Deze week', 'Ouder'];
        logs.forEach(log => {
            const group = getDateGroup(log.created_at);
            if (!groups[group]) groups[group] = [];
            groups[group].push(log);
        });

        let html = '';
        groupOrder.forEach(groupName => {
            const groupLogs = groups[groupName];
            if (!groupLogs || groupLogs.length === 0) return;

            // #264: de tabel is bijna 800 pixels breed en de omhullende
            // settings-card heeft overflow: hidden. Op een telefoon vielen de
            // kolommen Type en Details daardoor buiten beeld zonder dat je er
            // met vegen bij kon. Dezelfde wikkel als de verlofmatrix gebruikt.
            html += `<div class="audit-date-group">
                <h4 class="audit-date-group-title">${groupName} <span class="text-muted fw-500">(${groupLogs.length})</span></h4>
                <div class="audit-log-scroll">
                <table class="audit-log-table"><thead><tr>
                    <th>Tijdstip</th><th>Gebruiker</th><th>Actie</th><th>Type</th><th>Details</th>
                </tr></thead><tbody>`;

            groupLogs.forEach(log => {
                const time = new Date(log.created_at);
                const timeStr = time.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });

                const actionLabel = AUDIT_ACTION_LABELS[log.action] || log.action;
                const resourceLabel = AUDIT_RESOURCE_LABELS[log.resource_type] || log.resource_type;
                const actionClass = log.action.toLowerCase();

                const detailStr = formatAuditDetails(log.details, log.resource_type);

                html += `<tr>
                    <td class="audit-time">${escapeHtml(timeStr)}</td>
                    <td>${escapeHtml(log.actor_name)}</td>
                    <td><span class="audit-action-badge audit-${actionClass}">${escapeHtml(actionLabel)}</span></td>
                    <td>${escapeHtml(resourceLabel)}</td>
                    <td class="audit-details">${escapeHtml(detailStr)}</td>
                </tr>`;
            });

            html += '</tbody></table></div></div>';
        });

        resultsEl.innerHTML = html;
        IconHelper.init(resultsEl);

        // Pagination
        const totalPages = Math.ceil(data.total / data.limit);
        if (totalPages > 1) {
            let pagHtml = '';
            if (page > 1) pagHtml += `<button class="btn btn-sm btn-secondary" onclick="loadAuditLog(${page - 1})">Vorige</button>`;
            pagHtml += `<span class="audit-page-info">Pagina ${page} van ${totalPages} (${data.total} resultaten)</span>`;
            if (page < totalPages) pagHtml += `<button class="btn btn-sm btn-secondary" onclick="loadAuditLog(${page + 1})">Volgende</button>`;
            paginationEl.innerHTML = pagHtml;
        } else {
            paginationEl.innerHTML = `<span class="audit-page-info">${data.total} resultaten</span>`;
        }
    } catch (err) {
        resultsEl.innerHTML = `<div class="info-box neutral"><p>Fout bij laden: ${escapeHtml(err.message)}</p></div>`;
    }
}

// #369: viel een logregel niet in een van de bekende vormen, dan zette de code
// Object.keys(details).join(', ') in de kolom en las de beheerder een rij
// Engelse variabelenamen: "type, userId, endDate, startDate, absenceType,
// daysCreated, conflictingShifts, takeoverRequestsCreated".
//
// De vormen hieronder zijn niet bedacht maar afgelezen uit de echte audit_log
// op productie, per combinatie van actie en resourcetype. Wat er dan nog
// overblijft valt terug op de oude lijst met sleutels, zodat een nieuwe vorm
// zichtbaar blijft in plaats van te verdwijnen.
function formatAuditDetails(details, resourceType) {
    if (!details || typeof details !== 'object') return '';

    // Een gewijzigde instelling. Staat vóór de diff hieronder, want sinds #328
    // draagt zo'n regel ook before en after, en die zijn hier vaak een lijst
    // waarvoor een veld-voor-veld-diff niets zegt.
    if (details.key) {
        const telOp = w => Array.isArray(w) ? `${w.length} ${w.length === 1 ? 'item' : 'items'}` : null;
        const voor = details.before, na = details.after;
        if (voor && voor.tekort) return `${details.key} gewijzigd (vorige waarde te groot om te bewaren)`;
        if (voor === null || voor === undefined) return `${details.key} voor het eerst ingesteld`;
        const vT = telOp(voor), nT = telOp(na);
        if (vT && nT) return vT === nT ? `${details.key}: ${nT}` : `${details.key}: ${vT} → ${nT}`;
        const diff = formatAuditDiff(voor, na);
        return diff ? `${details.key}: ${diff}` : `${details.key} gewijzigd`;
    }

    // Voor- en natoestand: de bestaande diff.
    if (details.before && details.after) return formatAuditDiff(details.before, details.after);

    // Eén dienst.
    if (details.shift) {
        const sh = details.shift;
        const van = sh.startTime || sh.start_time;
        const tot = sh.endTime || sh.end_time;
        const tijd = van && tot ? ` ${String(van).slice(0,5)} tot ${String(tot).slice(0,5)}` : '';
        return `${sh.date || ''}${tijd}`.trim();
    }

    // Eén activiteit binnen een dienst.
    if (details.activity) {
        const a = details.activity;
        const tijd = a.startTime && a.endTime
            ? ` ${String(a.startTime).slice(0,5)} tot ${String(a.endTime).slice(0,5)}` : '';
        return `${a.date || ''}${tijd}${a.description ? ` · ${a.description}` : ''}`.trim();
    }

    // Eén gebruiker.
    if (details.user) return details.user.name || details.user.email || '';

    // Een ruil of overname in een omhullend object.
    if (details.swap) return formatAuditDetails(details.swap, 'swap_request');

    // Ziek- of verlofmelding met automatische overnameverzoeken.
    if (details.type === 'bulk_sick_with_takeover') {
        const soort = details.absenceType === 'ziek' ? 'Ziekmelding' : 'Afwezigheid';
        const periode = details.startDate === details.endDate
            ? details.startDate
            : `${details.startDate} t/m ${details.endDate}`;
        const stukken = [`${soort} ${periode}`];
        if (details.daysCreated) stukken.push(`${details.daysCreated} ${details.daysCreated === 1 ? 'dag' : 'dagen'}`);
        if (details.takeoverRequestsCreated) {
            stukken.push(`${details.takeoverRequestsCreated} ${details.takeoverRequestsCreated === 1 ? 'dienst' : 'diensten'} aangeboden voor overname`);
        }
        return stukken.join(', ');
    }

    // Een concept toepassen op een datumbereik.
    if (details.type === 'draft_apply') {
        const stukken = [`Concept "${details.draftName || 'onbekend'}" toegepast`];
        if (Array.isArray(details.weekNumbers) && details.weekNumbers.length) {
            stukken.push(`week ${details.weekNumbers.join(' en ')}`);
        }
        if (details.employeesApplied) stukken.push(`${details.employeesApplied} medewerkers`);
        if (details.shiftsCreated || details.shiftsDeleted) {
            stukken.push(`${details.shiftsCreated || 0} diensten erbij, ${details.shiftsDeleted || 0} weg`);
        }
        return stukken.join(', ');
    }

    // Een basisrooster toepassen bij één medewerker.
    if (details.action === 'apply_schedule') {
        const stukken = [`Basisrooster toegepast op ${details.userName || 'medewerker'}`];
        const bereik = details.dateRange;
        if (bereik && bereik.start && bereik.end) stukken.push(`${bereik.start} t/m ${bereik.end}`);
        stukken.push(`${details.created || 0} diensten erbij, ${details.deleted || 0} weg`);
        return stukken.join(', ');
    }

    // Een concept: aangemaakt, hernoemd of verwijderd.
    if (details.type === 'schedule_draft') {
        const soort = details.draftType === 'vakantie' ? 'Vakantieconcept' : 'Concept';
        return `${soort} "${details.name || 'zonder naam'}"`;
    }

    // Een team bijwerken.
    if (details.action === 'update_team') {
        return `Team "${details.name || ''}"${details.color ? ` · kleur ${details.color}` : ''}`;
    }

    // Losse benoemde acties zonder verdere inhoud.
    const LOSSE_ACTIES = {
        password_reset: 'Wachtwoord gereset',
        ical_token_reset: 'Agenda-koppeling opnieuw ingesteld',
        reset_data: 'Gegevens gewist'
    };
    if (details.action && LOSSE_ACTIES[details.action]) {
        let tekst = LOSSE_ACTIES[details.action];
        if (Array.isArray(details.tables)) tekst += ` (${details.tables.length} tabellen)`;
        return tekst;
    }

    // Een ruil- of overnameverzoek.
    if (details.type === 'swap' || details.type === 'takeover') {
        return details.type === 'swap' ? 'Ruilverzoek' : 'Overnameverzoek';
    }

    // Een afwezigheid die verwijderd is.
    if (resourceType === 'availability' && details.date) {
        return `Afwezigheid ${details.date}`;
    }

    // Onbekende vorm: liever de ruwe sleutels dan niets, zodat een nieuwe vorm
    // opvalt in plaats van stil te verdwijnen.
    const sleutels = Object.keys(details);
    return sleutels.length > 0 ? sleutels.join(', ') : '';
}

// Leesbare namen voor de velden die in een voor- en natoestand voorkomen.
const AUDIT_VELD_LABELS = {
    date: 'datum', startTime: 'begint', endTime: 'eindigt', team: 'team',
    notes: 'notitie', userId: 'medewerker', employeeId: 'medewerker',
    isReserve: 'reserve', source: 'herkomst', name: 'naam', email: 'e-mail',
    role: 'rol', mainTeam: 'team', contractHours: 'contracturen'
};

function formatAuditDiff(before, after) {
    const changes = [];
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
        if (key === 'createdAt' || key === 'id') continue;
        // #369: hier stond alleen een vergelijking van de waarden, dus een veld
        // dat in het ene object ontbrak en in het andere false was, gaf
        // "isReserve: - -> -": een wijziging waarin niets wijzigt. Een veld dat
        // maar aan één kant bestaat is geen wijziging.
        const inVoor = Object.prototype.hasOwnProperty.call(before || {}, key);
        const inNa = Object.prototype.hasOwnProperty.call(after || {}, key);
        if (!inVoor || !inNa) continue;
        const oldVal = before[key];
        const newVal = after[key];
        if (String(oldVal) === String(newVal)) continue;
        const label = AUDIT_VELD_LABELS[key] || key;
        const toon = v => (v === null || v === undefined || v === '') ? 'leeg' : String(v);
        changes.push(`${label}: ${toon(oldVal)} → ${toon(newVal)}`);
    }
    return changes.slice(0, 3).join(', ');
}

// #369: de export gebruikt dezelfde vertaling als de tabel. Voordien stonden
// hier twee bijna gelijke lijsten die apart konden gaan afwijken.
function formatAuditDetailsForCSV(details, resourceType) {
    return formatAuditDetails(details, resourceType);
}

async function exportAuditLog() {
    showToast('Auditlog exporteren...', 'info');
    try {
        const filters = {
            page: 1,
            limit: 10000,
            action: document.getElementById('audit-action-filter')?.value || '',
            resourceType: document.getElementById('audit-resource-filter')?.value || '',
            startDate: document.getElementById('audit-start-date')?.value || '',
            endDate: document.getElementById('audit-end-date')?.value || ''
        };
        const data = await fetchAuditLog(filters);
        const logs = data.logs || [];
        if (logs.length === 0) {
            showToast('Geen resultaten om te exporteren', 'warning');
            return;
        }
        const rows = [['Tijdstip', 'Gebruiker', 'Actie', 'Type', 'Details']];
        logs.forEach(log => {
            rows.push([
                new Date(log.created_at).toLocaleString('nl-BE'),
                log.actor_name || '',
                AUDIT_ACTION_LABELS[log.action] || log.action,
                AUDIT_RESOURCE_LABELS[log.resource_type] || log.resource_type,
                formatAuditDetailsForCSV(log.details, log.resource_type)
            ]);
        });
        const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`${logs.length} regels geëxporteerd`, 'success');
    } catch (err) {
        showToast('Export mislukt: ' + (err.message || 'Onbekende fout'), 'error');
    }
}

async function ensureTeamsLoaded() {
    // Try loading from API, merge with settings teams
    try {
        const data = await dataApiFetch('/teams');
        AppState.apiTeams = data.teams || [];
    } catch (e) {
        AppState.apiTeams = AppState.apiTeams || [];
    }

    // Merge teams from settings that might not be in DB yet
    const settingsTeams = DataStore.settings.teams || {};
    const apiIds = new Set(AppState.apiTeams.map(t => t.id));
    Object.entries(settingsTeams).forEach(([id, team]) => {
        if (!apiIds.has(id)) {
            AppState.apiTeams.push({ id, name: team.name, color: team.color });
        }
    });

    // Also update names from settings (settings is source of truth for names)
    AppState.apiTeams.forEach(t => {
        if (settingsTeams[t.id]) {
            t.name = settingsTeams[t.id].name;
            t.color = settingsTeams[t.id].color;
        }
    });

    return AppState.apiTeams;
}

function renderTeamsConfig() {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const eligibleTeams = DataStore.settings.responsibleRotation?.eligibleTeams || [];
    const sortedTeamIds = getTeamOrder();
    let html = '';
    sortedTeamIds.forEach(teamId => {
        const team = DataStore.settings.teams[teamId];
        const teamName = escapeHtml(team.name);
        const inCoverage = coverageTeams.includes(teamId);
        const inWeekend = eligibleTeams.includes(teamId);
        html += `
        <div class="team-config-item" data-team-id="${teamId}" draggable="true">
            <span class="team-drag-handle" title="Versleep om volgorde te wijzigen">&#8942;</span>
            <div class="team-color-dot" style="background: ${team.color}"></div>
            <div class="team-info">
                <span class="team-name">${teamName}</span>
                <div class="settings-team-toggles">
                    <label class="team-toggle-label" title="Telt mee in bezettingsberekening">
                        <input type="checkbox" class="coverage-team-cb" data-team-id="${teamId}" ${inCoverage ? 'checked' : ''} onchange="saveTeamToggles()" />
                        <span>Bezetting</span>
                    </label>
                    <label class="team-toggle-label" title="Draait mee in weekendverantwoordelijke rotatie">
                        <input type="checkbox" class="eligible-team-cb" data-team-id="${teamId}" ${inWeekend ? 'checked' : ''} onchange="saveTeamToggles()" />
                        <span>Weekend</span>
                    </label>
                </div>
            </div>
            <div class="team-actions">
                <button type="button" class="btn-icon-only" onclick="editTeam('${teamId}')" title="Naam bewerken" aria-label="Naam van ${teamName} bewerken">${IconHelper.html(ICONS.edit, 'sm')}</button>
                <input type="color" class="color-picker" value="${team.color}"
                       onchange="updateTeamColor('${teamId}', this.value)" title="Kleur wijzigen" aria-label="Kleur van ${teamName} wijzigen"/>
                <button type="button" class="btn-icon-only danger" onclick="deleteTeam('${teamId}')" title="Verwijderen" aria-label="Team ${teamName} verwijderen">${IconHelper.html(ICONS.delete, 'sm')}</button>
            </div>
        </div>`;
    });
    return html;
}

function initTeamDragSort() {
    const list = document.getElementById('teams-config');
    if (!list) return;
    let dragSrc = null;

    list.querySelectorAll('.team-config-item[draggable]').forEach(item => {
        item.addEventListener('dragstart', e => {
            dragSrc = item;
            item.classList.add('team-dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => {
            dragSrc = null;
            list.querySelectorAll('.team-config-item').forEach(i => i.classList.remove('team-dragging', 'team-drag-over'));
        });
        item.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (item !== dragSrc) {
                list.querySelectorAll('.team-config-item').forEach(i => i.classList.remove('team-drag-over'));
                item.classList.add('team-drag-over');
            }
        });
        item.addEventListener('dragleave', () => item.classList.remove('team-drag-over'));
        item.addEventListener('drop', async e => {
            e.preventDefault();
            if (!dragSrc || dragSrc === item) return;
            item.classList.remove('team-drag-over');

            // Reorder DOM
            const items = [...list.querySelectorAll('.team-config-item')];
            const srcIdx = items.indexOf(dragSrc);
            const tgtIdx = items.indexOf(item);
            if (srcIdx < tgtIdx) list.insertBefore(dragSrc, item.nextSibling);
            else list.insertBefore(dragSrc, item);

            // Persist new sort_order
            const newOrder = [...list.querySelectorAll('.team-config-item')].map(i => i.dataset.teamId);
            newOrder.forEach((id, idx) => {
                if (DataStore.settings.teams[id]) DataStore.settings.teams[id].sort_order = idx;
            });
            try {
                await saveSettings('teams', DataStore.settings.teams);
                showToast('Teamvolgorde opgeslagen', 'success');
            } catch (_) {
                showToast('Fout bij opslaan volgorde', 'error');
            }
        });
    });
}

function renderTemplatesConfig() {
    let html = '';
    Object.keys(DataStore.settings.shiftTemplates).forEach(templateId => {
        const template = DataStore.settings.shiftTemplates[templateId];
        const duration = calculateTemplateDuration(template.start, template.end);
        const templateName = escapeHtml(template.name);
        html += `
        <div class="template-config-item" data-template-id="${templateId}">
            <div class="template-icon">${getTemplateIcon(templateId)}</div>
            <div class="template-info">
                <span class="template-name">${templateName}</span>
                <span class="template-times">${template.start} - ${template.end} (${duration})</span>
            </div>
            <div class="template-actions">
                <button type="button" class="btn-icon-only" onclick="editTemplate('${templateId}')" title="Bewerken" aria-label="Sjabloon ${templateName} bewerken">${IconHelper.html(ICONS.edit, 'sm')}</button>
                <button type="button" class="btn-icon-only danger" onclick="deleteTemplate('${templateId}')" title="Verwijderen" aria-label="Sjabloon ${templateName} verwijderen">${IconHelper.html(ICONS.delete, 'sm')}</button>
            </div>
        </div>`;
    });
    return html;
}

function getTemplateIcon(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (template?.icon) {
        return IconHelper.html(template.icon, 'sm');
    }
    // Fallback for legacy templates without icon property
    const iconMap = {
        'vroeg': ICONS.early,
        'laat': ICONS.late,
        'nacht': ICONS.night,
        'lang': ICONS.long
    };
    return IconHelper.html(iconMap[templateId] || ICONS.clock, 'sm');
}

function calculateTemplateDuration(start, end) {
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);

    let hours = endH - startH;
    let mins = endM - startM;

    if (hours < 0 || (hours === 0 && mins < 0)) {
        hours += 24;
    }
    if (mins < 0) {
        hours -= 1;
        mins += 60;
    }

    if (mins === 0) {
        return `${hours}u`;
    }
    return `${hours}u${mins}`;
}

async function updateTeamColor(teamId, color) {
    if (!DataStore.settings.teams[teamId]) return;

    // #273: de oude melding zei "lokaal opgeslagen maar backend sync mislukt,
    // vernieuw de pagina om te synchroniseren". Er werd niets lokaal bewaard
    // (saveToStorage is sinds de overstap naar de API een lege functie), en
    // vernieuwen was juist wat de wijziging weggooide. We zetten de kleur nu
    // terug zodra de server hem weigert, zodat het scherm niet iets anders
    // toont dan wat er opgeslagen staat.
    const vorigeKleur = DataStore.settings.teams[teamId].color;
    DataStore.settings.teams[teamId].color = color;
    applyTeamColors();

    try {
        await saveSettings('teams', DataStore.settings.teams);
        showToast('Teamkleur opgeslagen', 'success');
    } catch (error) {
        console.error('Error saving team color to backend:', error);
        DataStore.settings.teams[teamId].color = vorigeKleur;
        applyTeamColors();
        renderSettings();
        showToast('Teamkleur niet opgeslagen: ' + getUserFriendlyError(error), 'error');
    }
}

async function saveRules() {
    const minHours = parseInt(document.getElementById('rule-min-hours').value) || 11;
    const maxConsecutive = parseInt(document.getElementById('rule-max-consecutive')?.value) || 6;

    // #273: "Regels lokaal opgeslagen, maar sync naar server mislukt" was een
    // valse belofte: saveToStorage bewaart niets. Erger nog, zolang het tabblad
    // openbleef rekende de validatie met de nieuwe regel terwijl de server en
    // alle andere gebruikers de oude aanhielden. Bij een mislukking zetten we
    // de waarden nu terug en blijft de knop op "niet opgeslagen" staan.
    const vorigeRegels = { ...DataStore.settings.rules };
    DataStore.settings.rules.minHoursBetweenShifts = minHours;
    DataStore.settings.rules.maxConsecutiveDays = maxConsecutive;

    try {
        await saveSettings('rules', DataStore.settings.rules);
        markSettingsSaved();
        showToast('Planningsregels zijn opgeslagen', 'success');
    } catch (err) {
        console.error('Error saving rules to backend:', err);
        DataStore.settings.rules = vorigeRegels;
        markSettingsUnsaved();
        showToast('Regels niet opgeslagen: ' + getUserFriendlyError(err), 'error');
    }
}

// #182: handleSaveSchoolYear is hier verwijderd. Hij werd nergens
// aangeroepen en las #school-year-start-input, een veld dat niet bestaat,
// dus hij zou meteen zijn gestruikeld als iemand hem ooit had gebruikt.


function openAddTemplateModal() {
    openTemplateModal();
}

function editTemplate(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (template) {
        openTemplateModal(templateId, template);
    }
}

async function deleteTemplate(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (!template) return;

    if (await showConfirm(`Weet je zeker dat je de template "${template.name}" wilt verwijderen?`,
        'Sjabloon verwijderen', { danger: true, confirmText: 'Sjabloon verwijderen' })) {
        // #333: het sjabloon werd eerst lokaal verwijderd en de fout van het
        // opslaan verdween in een console.error. Het sjabloon was dus weg uit
        // de lijst maar stond er na een herlading weer, zonder dat iemand iets
        // te zien kreeg. Nu wordt de verwijdering teruggedraaid en gemeld,
        // zoals deleteTeam() dat al doet.
        delete DataStore.settings.shiftTemplates[templateId];
        try {
            await saveSettings('shiftTemplates', DataStore.settings.shiftTemplates);
        } catch (e) {
            console.error('Error saving templates:', e);
            DataStore.settings.shiftTemplates[templateId] = template;
            showToast(`Template "${template.name}" niet verwijderd: ${getUserFriendlyError(e)}`, 'error');
            renderSettings();
            return;
        }
        showToast(`Template "${template.name}" verwijderd`, 'success');
        renderSettings();
    }
}

function openTemplateModal(templateId = null, template = null) {
    const isEdit = templateId !== null;
    const title = isEdit ? 'Template bewerken' : 'Nieuwe template';
    const safeTemplateName = escapeHtml(template?.name || '');
    const currentIcon = template?.icon || '';

    const iconOptions = [
        { id: 'sunrise', label: 'Ochtend' },
        { id: 'sun', label: 'Middag' },
        { id: 'sunset', label: 'Avond' },
        { id: 'moon', label: 'Nacht' },
        { id: 'star', label: 'Weekend' },
        { id: 'clock', label: 'Standaard' },
        { id: 'coffee', label: 'Pauze' },
        { id: 'briefcase', label: 'Kantoor' },
        { id: 'graduation-cap', label: 'Vorming' },
        { id: 'users', label: 'Overleg' },
        { id: 'heart', label: 'Zorg' },
        { id: 'zap', label: 'Spoed' }
    ];

    let iconPickerHtml = '<div class="template-icon-picker">';
    iconOptions.forEach(opt => {
        const selected = currentIcon === opt.id ? 'selected' : '';
        iconPickerHtml += `<button type="button" class="template-icon-option ${selected}" data-icon="${opt.id}" title="${opt.label}" onclick="selectTemplateIcon(this)">
            ${IconHelper.html(opt.id, 'md')}
            <span class="template-icon-label">${opt.label}</span>
        </button>`;
    });
    iconPickerHtml += '</div>';

    const modalHtml = `
    <div class="modal" id="template-modal-overlay" onclick="closeTemplateModal()">
        <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2>${title}</h2>
                <button type="button" class="modal-close" aria-label="Sluiten" onclick="closeTemplateModal()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="template-id" value="${escapeHtml(templateId || '')}" />
                <div class="form-group">
                    <label for="template-name">Naam:</label>
                    <input type="text" id="template-name" class="form-input"
                           value="${safeTemplateName}"
                           placeholder="bv. Vroege dienst" />
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="template-start">Starttijd:</label>
                        <input type="time" id="template-start" class="form-input"
                               value="${template ? template.start : '09:00'}" />
                    </div>
                    <div class="form-group">
                        <label for="template-end">Eindtijd:</label>
                        <input type="time" id="template-end" class="form-input"
                               value="${template ? template.end : '17:00'}" />
                    </div>
                </div>
                <div class="form-group">
                    <label>Icoon:</label>
                    ${iconPickerHtml}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeTemplateModal()">Annuleren</button>
                <button class="btn btn-primary" onclick="saveTemplate('${templateId || ''}')">Opslaan</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    IconHelper.init(document.getElementById('template-modal-overlay'));
}

function selectTemplateIcon(btn) {
    btn.closest('.template-icon-picker').querySelectorAll('.template-icon-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function closeTemplateModal() {
    const modal = document.getElementById('template-modal-overlay');
    if (modal) modal.remove();
}


async function saveTemplate(originalId) {
    const name = document.getElementById('template-name').value.trim();
    const start = document.getElementById('template-start').value;
    const end = document.getElementById('template-end').value;
    const selectedIconBtn = document.querySelector('.template-icon-option.selected');
    const icon = selectedIconBtn ? selectedIconBtn.dataset.icon : '';

    if (!name || !start || !end) {
        showToast('Vul alle velden in', 'warning');
        return;
    }

    if (start === end) {
        showToast('Starttijd en eindtijd mogen niet gelijk zijn', 'warning');
        return;
    }

    // Auto-generate ID from name (slugify)
    let id = originalId || name.toLowerCase()
        .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
        .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
        .replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');

    if (!id) {
        showToast('Naam moet minstens één letter of cijfer bevatten', 'warning');
        return;
    }

    // Ensure unique ID for new templates
    if (!originalId && DataStore.settings.shiftTemplates[id]) {
        let suffix = 2;
        while (DataStore.settings.shiftTemplates[`${id}_${suffix}`]) suffix++;
        id = `${id}_${suffix}`;
    }

    if (originalId && originalId !== id) {
        delete DataStore.settings.shiftTemplates[originalId];
    }

    DataStore.settings.shiftTemplates[id] = { name, start, end, icon };
    try {
        await saveSettings('shiftTemplates', DataStore.settings.shiftTemplates);
    } catch (e) {
        console.error('Error saving templates:', e);
        showToast('Fout bij opslaan template', 'error');
        return;
    }

    closeTemplateModal();
    renderSettings();
}

// ===== VAKANTIE FUNCTIES =====

function renderHolidayPeriods() {
    const periods = DataStore.settings.holidayPeriods || [];

    if (periods.length === 0) {
        return '<p class="no-items-text">Nog geen vakantieperiodes ingesteld</p>';
    }

    // Sorteer op startdatum
    const sorted = [...periods].sort((a, b) => parseDateOnly(a.startDate) - parseDateOnly(b.startDate));

    return sorted.map(period => {
        const start = parseDateOnly(period.startDate);
        const end = parseDateOnly(period.endDate);
        const days = aantalDagenInclusief(start, end);
        const today = parseDateOnly(new Date());
        const isActive = today >= start && today <= end;
        const isPast = end < today;

        let statusClass = '';
        if (isPast) statusClass = 'past';
        else if (isActive) statusClass = 'active';

        // Calculate weeks in this period
        const periodMonday = getMondayOfWeek(start);
        const periodEndMonday = getMondayOfWeek(end);
        const totalWeeks = Math.floor((periodEndMonday - periodMonday) / (7 * 86400000)) + 1;

        return `
        <div class="holiday-period-item ${statusClass}">
            <div class="holiday-period-info">
                <span class="holiday-period-name">${escapeHtml(period.name)}</span>
                <span class="holiday-period-dates">
                    ${formatDateShortMetJaar(period.startDate)} - ${formatDateShortMetJaar(period.endDate)}
                    <span class="holiday-period-days">(${days} dagen, ${totalWeeks} ${totalWeeks === 1 ? 'week' : 'weken'})</span>
                </span>
            </div>
            <button type="button" class="btn-icon-only danger" onclick="deleteHolidayPeriod(${period.id})" title="Verwijderen" aria-label="Vakantieperiode ${escapeHtml(period.name || '')} verwijderen">${IconHelper.html(ICONS.delete, 'sm')}</button>
        </div>`;
    }).join('');
}

// #278 en #297: dit heette ook formatDateShort, net als de functie in
// app-nav.js, en omdat dit bestand later laadt won deze. Daardoor stond er een
// jaartal in de waarschuwingen op het startscherm, waar dat niet hoort. De twee
// verschillen echt: die in app-nav.js verwacht een Date en laat het jaar weg,
// deze verwacht een datumtekst en zet het jaar er wel bij. Een naam die zegt
// wat hij doet, want in een vakantieperiodelijst is dat jaartal juist nuttig.
function formatDateShortMetJaar(date) {
    const d = parseDateOnly(date);
    return d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function setHolidayResponsible(periodId, employeeId) {
    const periods = DataStore.settings.holidayPeriods || [];
    const period = periods.find(p => p.id === periodId || String(p.id) === String(periodId));
    if (!period) return;
    period.responsibleId = employeeId || null;
    await saveSettings('holidayPeriods', periods);
    showToast('Verantwoordelijke ingesteld', 'success');
}

async function setHolidayWeekResponsible(periodId, weekNum, employeeId) {
    const periods = DataStore.settings.holidayPeriods || [];
    const period = periods.find(p => p.id === periodId || String(p.id) === String(periodId));
    if (!period) return;
    if (!period.weeklyResponsibles) period.weeklyResponsibles = {};
    if (employeeId) {
        period.weeklyResponsibles[String(weekNum)] = employeeId;
    } else {
        delete period.weeklyResponsibles[String(weekNum)];
    }
    await saveSettings('holidayPeriods', periods);
    showToast(`Verantwoordelijke week ${weekNum} ingesteld`, 'success');
}

/**
 * De vijf Belgische schoolvakanties van één schooljaar, afgeleid uit het
 * startjaar en de paasdatum.
 *
 * #352: deze vijf stonden hard in de code met vaste datums. Herfst en Kerst
 * waren bijgewerkt naar 2026-2027, Krokus, Pasen en Zomer niet, en de kop
 * beloofde "schooljaar 2025-2026". Klikken op Zomer gaf 1 juli tot 31 augustus
 * 2026, dus het verleden. De vakantieperiodes zijn de basis van elke
 * verlofronde, en deze lijst verouderde elk jaar opnieuw.
 *
 * De regels volgen de Vlaamse vakantieregeling:
 *  - herfst: de maandag van de week waarin 1 november valt, één week. Valt
 *    1 november op een zaterdag of zondag, dan de maandag erna
 *  - kerst: idem rond 25 december, twee weken
 *  - krokus: de zevende week vóór Pasen, één week
 *  - pasen: twee weken vanaf de maandag na Paaszondag
 *  - zomer: 1 juli tot en met 31 augustus
 *
 * Nagerekend tegen de datums die hier eerder hard stonden en die klopten:
 * krokus 2026 (16 t/m 22 feb), pasen 2026 (6 t/m 19 apr), herfst 2026
 * (2 t/m 8 nov, want 1 november viel op een zondag) en kerst 2026
 * (21 dec t/m 3 jan). Alle vier komen ze hieruit.
 *
 * Bij een uitzonderlijk late Pasen kent de regeling een uitzondering die hier
 * niet in zit. De datums blijven zichtbaar en bewerkbaar vóór het opslaan, dus
 * dit is een voorzet en geen laatste woord.
 *
 * @param {number} startJaar   het jaar waarin het schooljaar begint
 * @param {string} paaszondag  'YYYY-MM-DD' van Pasen in startJaar + 1
 */
function belgischeSchoolvakanties(startJaar, paaszondag) {
    const eindJaar = startJaar + 1;
    const plus = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    const maandagVanWeek = (d) => plus(d, -((d.getDay() + 6) % 7));
    const maandagNa = (d) => { const r = plus(d, 1); return plus(r, (8 - r.getDay()) % 7); };
    const inWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
    // Een vakantie die "rond" een vaste dag ligt, begint op de maandag van die
    // week. Valt de ankerdag zelf in het weekend, dan schuift ze een week op.
    const startRond = (anker) => inWeekend(anker) ? maandagNa(anker) : maandagVanWeek(anker);

    // `kort` is het opschrift van de knop, `naam` wat er in het naamveld komt.
    const periode = (kort, naam, start, dagen) => ({
        kort,
        naam: `${naam} ${start.getFullYear()}`,
        start: formatDateYYYYMMDD(start),
        eind: formatDateYYYYMMDD(plus(start, dagen - 1)),
    });

    const paasmaandag = plus(parseDateOnly(paaszondag), 1);
    const zomerStart = new Date(eindJaar, 6, 1);

    return [
        periode('Herfst', 'Herfstvakantie', startRond(new Date(startJaar, 10, 1)), 7),
        periode('Kerst',  'Kerstvakantie',  startRond(new Date(startJaar, 11, 25)), 14),
        periode('Krokus', 'Krokusvakantie', plus(paasmaandag, -49), 7),
        periode('Pasen',  'Paasvakantie',   paasmaandag, 14),
        periode('Zomer',  'Zomervakantie',  zomerStart, 62),
    ];
}

/**
 * Haalt Paaszondag op voor een jaar. De backend rekent Pasen al uit voor de
 * feestdagenlijst, dus we leiden het daaruit af in plaats van de berekening
 * een tweede keer te schrijven.
 */
async function paaszondagVan(jaar) {
    const feestdagen = await fetchPublicHolidays(jaar);
    const paasmaandag = (feestdagen || []).find(h => h.name === 'Paasmaandag');
    if (!paasmaandag) return null;
    const d = parseDateOnly(paasmaandag.date);
    d.setDate(d.getDate() - 1);
    return formatDateYYYYMMDD(d);
}

async function openAddHolidayModal() {
    // #352: het schooljaar komt uit de instellingen in plaats van uit de code.
    // Loopt die instelling achter, dan nemen we het schooljaar waarin vandaag
    // valt, anders zijn alle vijf de knoppen verleden tijd. Staat de instelling
    // juist vooruit, dan volgen we die: de beheerder is dan al met volgend jaar
    // bezig.
    const nu = new Date();
    const schooljaarVanVandaag = nu.getMonth() >= 8 ? nu.getFullYear() : nu.getFullYear() - 1;
    const startJaar = Math.max(
        parseDateOnly(getSchoolYearStart()).getFullYear(),
        schooljaarVanVandaag
    );

    let vakanties = [];
    try {
        const paas = await paaszondagVan(startJaar + 1);
        if (paas) vakanties = belgischeSchoolvakanties(startJaar, paas);
    } catch (err) {
        // Zonder feestdagen geen krokus en pasen. Liever geen knoppen dan
        // knoppen met verkeerde datums.
        console.error('Schoolvakanties berekenen mislukt:', err);
    }

    const vandaag = formatDateYYYYMMDD(new Date());
    const snelleSelectie = vakanties.length === 0 ? '' : `
                <div class="quick-select-section">
                    <h4>Snelle selectie (schooljaar ${startJaar}-${startJaar + 1})</h4>
                    <div class="quick-select-buttons">
                        ${vakanties.map(v => `
                            <button type="button" class="btn btn-sm btn-outline"
                                title="${escapeHtml(v.start)} tot en met ${escapeHtml(v.eind)}"
                                onclick="prefillHoliday('${escapeHtml(v.naam)}', '${v.start}', '${v.eind}')">
                                ${escapeHtml(v.kort)}${v.eind < vandaag ? ' (voorbij)' : ''}
                            </button>`).join('')}
                    </div>
                </div>`;

    const modalHtml = `
    <div class="modal" id="holiday-modal" onclick="closeHolidayModal()">
        <div class="modal-content modal-content--sm" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2>Vakantieperiode toevoegen</h2>
                <button type="button" class="modal-close" aria-label="Sluiten" onclick="closeHolidayModal()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="holiday-name">Naam:</label>
                    <input type="text" id="holiday-name" class="form-input" placeholder="bv. Krokusvakantie 2026" />
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="holiday-start">Startdatum:</label>
                        <input type="date" id="holiday-start" class="form-input" />
                    </div>
                    <div class="form-group">
                        <label for="holiday-end">Einddatum:</label>
                        <input type="date" id="holiday-end" class="form-input" />
                    </div>
                </div>
                <div id="holiday-date-info" class="date-range-info"></div>

                <!-- Snelle selectie voor Belgische schoolvakanties (#352) -->
                ${snelleSelectie}
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeHolidayModal()">Annuleren</button>
                <button class="btn btn-primary" onclick="saveHolidayPeriod()">Toevoegen</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    IconHelper.init(document.getElementById('holiday-modal'));

    // Update info bij datum wijziging
    document.getElementById('holiday-start').addEventListener('change', updateHolidayDateInfo);
    document.getElementById('holiday-end').addEventListener('change', updateHolidayDateInfo);
}

function prefillHoliday(name, start, end) {
    document.getElementById('holiday-name').value = name;
    document.getElementById('holiday-start').value = start;
    document.getElementById('holiday-end').value = end;
    updateHolidayDateInfo();
}

function updateHolidayDateInfo() {
    const start = document.getElementById('holiday-start').value;
    const end = document.getElementById('holiday-end').value;
    const infoDiv = document.getElementById('holiday-date-info');

    if (start && end) {
        const startDate = parseDateOnly(start);
        const endDate = parseDateOnly(end);

        if (endDate >= startDate) {
            const days = aantalDagenInclusief(startDate, endDate);
            infoDiv.innerHTML = `<span class="info-badge">${days} dagen geselecteerd</span>`;
        } else {
            infoDiv.innerHTML = '<span class="error-text">Einddatum moet na startdatum liggen</span>';
        }
    } else {
        infoDiv.innerHTML = '';
    }
}

function closeHolidayModal() {
    const modal = document.getElementById('holiday-modal');
    if (modal) modal.remove();
}

function saveHolidayPeriod() {
    const name = document.getElementById('holiday-name').value.trim();
    const start = document.getElementById('holiday-start').value;
    const end = document.getElementById('holiday-end').value;

    if (!name || !start || !end) {
        showToast('Vul alle velden in', 'warning');
        return;
    }

    if (parseDateOnly(end) < parseDateOnly(start)) {
        showToast('Einddatum moet na startdatum liggen', 'warning');
        return;
    }

    addHolidayPeriod(name, start, end);
    closeHolidayModal();
    renderSettings();
}

async function deleteHolidayPeriod(id) {
    const linkedDrafts = (DataStore.settings.schedule_drafts || []).filter(d => d.type === 'vakantie' && String(d.holidayPeriodId) === String(id));
    const activeDrafts = linkedDrafts.filter(d => d.lastAppliedAt);
    const savedDrafts = linkedDrafts.filter(d => !d.lastAppliedAt);

    let msg = 'Weet je zeker dat je deze vakantieperiode wilt verwijderen?';
    if (linkedDrafts.length > 0) {
        const names = linkedDrafts.map(d => `"${d.name}"`).join(', ');
        msg += `\n\n${linkedDrafts.length} gekoppeld(e) concept(en): ${names}`;
        if (activeDrafts.length > 0) {
            msg += `\n\nLet op: ${activeDrafts.length} concept(en) ${activeDrafts.length === 1 ? 'is' : 'zijn'} toegepast. Bestaande shifts blijven staan maar het concept wordt ontkoppeld.`;
        }
        msg += '\n\nAlle gekoppelde concepten worden verwijderd.';
    }
    if (await showConfirm(msg)) {
        // Verwijder alle gekoppelde concepten
        if (DataStore._draftsFromTable) {
            for (const draft of linkedDrafts) {
                try {
                    await deleteScheduleDraft(draft.id);
                } catch (e) {
                    console.error('Error deleting linked vakantie draft:', e);
                }
            }
        }
        // Verwijder ook uit lokale cache
        DataStore.settings.schedule_drafts = (DataStore.settings.schedule_drafts || []).filter(
            d => !(d.type === 'vakantie' && String(d.holidayPeriodId) === String(id))
        );
        removeHolidayPeriod(id);
        renderSettings();
    }
}

// ===== TEAM TOGGLES (bezetting + weekend rotatie) =====

// #330: deze functie muteerde eerst DataStore, ving daarna elke fout op met
// alleen een console.error, en meldde vervolgens onvoorwaardelijk groen
// "Teaminstellingen opgeslagen". De beheerder zag een valse bevestiging tot hij
// herlaadde, en dan was de wijziging weg.
//
// Nu wordt de oude waarde bewaard, bij een fout teruggezet, en verschijnt de
// succesmelding alleen als er ook echt iets bewaard is. updateTeamColor() deed
// dat al goed en diende als voorbeeld.
async function saveTeamToggles() {
    const mislukt = [];

    // Coverage teams
    const coverageTeams = [];
    document.querySelectorAll('.coverage-team-cb').forEach(cb => {
        if (cb.checked) coverageTeams.push(cb.dataset.teamId);
    });
    // Alles uitvinken kan niet: zonder bezettingsteams valt de hele
    // bezettingsberekening weg. Voordien werd er dan stil niets opgeslagen
    // terwijl dezelfde groene melding verscheen.
    if (coverageTeams.length === 0) {
        showToast('Er moet minstens één team meetellen voor de bezetting. De bezettingsvinkjes zijn teruggezet.', 'error');
        // Alleen de bezettingsvinkjes terugzetten, niet het hele scherm
        // hertekenen: een wijziging aan de weekendrotatie in dezelfde
        // bewerking mag niet verloren gaan doordat wij hier ingrijpen.
        const bewaard = DataStore.settings.coverageTeams || [];
        document.querySelectorAll('.coverage-team-cb').forEach(cb => {
            cb.checked = bewaard.includes(cb.dataset.teamId);
        });
        return;
    }
    const vorigeCoverage = DataStore.settings.coverageTeams;
    DataStore.settings.coverageTeams = coverageTeams;
    try {
        await saveSettings('coverageTeams', coverageTeams);
    } catch (e) {
        console.error('Error saving coverageTeams:', e);
        DataStore.settings.coverageTeams = vorigeCoverage;
        mislukt.push('bezettingsteams');
    }

    // Eligible teams for weekend rotation
    const eligibleTeams = [];
    document.querySelectorAll('.eligible-team-cb').forEach(cb => {
        if (cb.checked) eligibleTeams.push(cb.dataset.teamId);
    });
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = { eligibleTeams: [], assignments: {} };
    }
    const vorigeEligible = DataStore.settings.responsibleRotation.eligibleTeams;
    DataStore.settings.responsibleRotation.eligibleTeams = eligibleTeams;

    try {
        await saveSettings('responsibleRotation', DataStore.settings.responsibleRotation);
    } catch (e) {
        console.error('Error saving responsibleRotation:', e);
        DataStore.settings.responsibleRotation.eligibleTeams = vorigeEligible;
        mislukt.push('weekendrotatie');
    }

    if (mislukt.length > 0) {
        showToast(`Niet opgeslagen: ${mislukt.join(' en ')}. De vinkjes zijn teruggezet naar de bewaarde waarde.`, 'error');
        // Opnieuw tekenen vanuit DataStore, dat nu weer de serverwaarde bevat.
        renderSettings();
        return;
    }

    showToast('Teaminstellingen opgeslagen', 'success');

    // Update heatmap if visible
    if (typeof renderCoverageHeatmap === 'function' && AppState.showHeatmap) {
        renderPlanning();
    }
    // Update upcoming weekends list
    const upcomingContainer = document.querySelector('.upcoming-responsibles');
    if (upcomingContainer) {
        upcomingContainer.innerHTML = renderUpcomingResponsibles();
        IconHelper.init(upcomingContainer);
        attachUpcomingWeekendListeners(upcomingContainer);
    }
}

// Legacy aliases
function saveCoverageTeams() { saveTeamToggles(); }
function saveEligibleTeamsQuiet() { saveTeamToggles(); }
function saveEligibleTeams() { saveTeamToggles(); }
function renderCoverageTeamsCheckboxes() { return ''; }
function renderEligibleTeamsCheckboxes() { return ''; }

function renderRotationSettings() {
    return renderRotationSettingsCompact();
}

function renderRotationSettingsCompact() {
    const rotation = DataStore.settings.responsibleRotation || {};
    const eligible = getEligibleEmployeesForResponsible();

    const referenceDate = getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate || '';
    const currentStart = rotation.rotationStart || referenceDate;
    const currentEmployee = String(rotation.rotationStartEmployee || '');

    let employeeOptions = '<option value="">-- Kies eerste persoon --</option>';
    eligible.forEach(emp => {
        // Compare as strings to avoid precision issues
        const selected = String(emp.id) === currentEmployee ? 'selected' : '';
        employeeOptions += `<option value="${emp.id}" ${selected}>${escapeHtml(emp.name)}</option>`;
    });

    return `
    <div class="form-row compact">
        <div class="form-group">
            <label for="rotation-start-date">Startdatum:</label>
            <input type="date" id="rotation-start-date" class="form-input" value="${escapeHtml(currentStart)}" />
        </div>
        <div class="form-group">
            <label for="rotation-start-employee">Begint met:</label>
            <select id="rotation-start-employee" class="form-input">
                ${employeeOptions}
            </select>
        </div>
        <button class="btn btn-primary btn-sm self-end" onclick="saveRotationSettings()">Opslaan</button>
    </div>`;
}

function saveRotationSettings() {
    const dateInput = document.getElementById('rotation-start-date');
    const employeeSelect = document.getElementById('rotation-start-employee');

    const startDate = dateInput?.value;
    const employeeId = employeeSelect?.value;

    if (!startDate) {
        showToast('Kies een startdatum', 'warning');
        return;
    }

    if (!employeeId) {
        showToast('Selecteer wie begint', 'warning');
        return;
    }

    const date = parseDateOnly(startDate);
    if (date.getDay() !== 1) {
        showToast('De startdatum moet een maandag zijn', 'warning');
        return;
    }

    setRotationStart(date, parseInt(employeeId, 10));
    renderSettings();
    renderPlanning();
    showToast('Rotatie ingesteld', 'success');
}

function renderUpcomingResponsibles() {
    const eligible = getEligibleEmployeesForResponsible();
    if (eligible.length === 0) {
        return '<p class="no-items-text">Geen medewerkers in aanmerking</p>';
    }

    const rotation = DataStore.settings.responsibleRotation || {};
    if (!rotation.rotationStart || !rotation.rotationStartEmployee) {
        return '<p class="no-items-text">Stel eerst de rotatie in hierboven</p>';
    }

    const assignments = rotation.assignments || {};

    // Toon de komende 8 weekenden
    let html = '<div class="upcoming-list">';
    const today = new Date();
    const currentMonday = getMondayOfWeek(today);

    let count = 0;
    const checkDate = new Date(currentMonday);

    while (count < 8) {
        if (isWeekendOrHolidayWeek(checkDate)) {
            const responsible = getOrCalculateResponsible(checkDate);
            const weekendSat = new Date(checkDate);
            weekendSat.setDate(weekendSat.getDate() + 5);
            const weekendSun = new Date(checkDate);
            weekendSun.setDate(weekendSun.getDate() + 6);
            const dateDisplay = `${weekendSat.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })} – ${weekendSun.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })}`;
            const mondayKey = formatDateYYYYMMDD(checkDate);
            const isManual = !!assignments[mondayKey];

            if (responsible) {
                const teamColor = DataStore.settings.teams[responsible.mainTeam]?.color || '#6b7280';
                const responsibleName = escapeHtml(responsible.name);
                const weekHoliday = typeof getHolidayPeriod === 'function' ? getHolidayPeriod(weekendSat) : null;
                const isVakantieResp = weekHoliday && weekHoliday.responsibleId;
                const badge = isVakantieResp ? ' <span class="upcoming-manual-badge shift-badge-upcoming">vakantie</span>'
                    : isManual ? ' <span class="upcoming-manual-badge">handmatig</span>' : '';
                html += `
                <div class="upcoming-item upcoming-item-clickable" data-monday="${mondayKey}">
                    <span class="upcoming-date">${dateDisplay}</span>
                    <span class="upcoming-name" style="border-left: 3px solid ${teamColor}; padding-left: 8px;">
                        ${responsibleName}${badge}
                    </span>
                    <span class="upcoming-edit-icon">${IconHelper.html(ICONS.edit, 'xs')}</span>
                </div>`;
                count++;
            }
        }
        checkDate.setDate(checkDate.getDate() + 7);

        // Safety: max 52 weken vooruit kijken
        if (checkDate - currentMonday > 365 * 24 * 60 * 60 * 1000) break;
    }

    html += '</div>';
    return html;
}

function showWeekendResponsiblePicker(mondayKey) {
    const eligible = getEligibleEmployeesForResponsible();
    const rotation = DataStore.settings.responsibleRotation || {};
    const assignments = rotation.assignments || {};
    const currentAssignment = assignments[mondayKey] ? String(assignments[mondayKey]) : null;

    const monday = parseDateOnly(mondayKey);
    const sat = new Date(monday);
    sat.setDate(sat.getDate() + 5);
    const sun = new Date(monday);
    sun.setDate(sun.getDate() + 6);
    const dateLabel = `${sat.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' })} – ${sun.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' })}`;

    // Calculate who rotation would pick automatically
    const autoResponsible = (() => {
        const saved = assignments[mondayKey];
        delete assignments[mondayKey];
        const result = getOrCalculateResponsible(monday);
        if (saved !== undefined) assignments[mondayKey] = saved;
        return result;
    })();

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
        <div class="modal-content modal-content--xs">
            <div class="modal-header">
                <h3>Weekendverantwoordelijke</h3>
                <button type="button" class="modal-close" id="weekend-picker-close" aria-label="Sluiten">&times;</button>
            </div>
            <div class="modal-body modal-body-md">
                <p class="text-sm text-muted mb-md">${dateLabel}</p>
                <div class="weekend-picker-options">
                    <label class="weekend-picker-option ${!currentAssignment ? 'selected' : ''}" data-value="auto">
                        <input type="radio" name="weekend-responsible" value="auto" ${!currentAssignment ? 'checked' : ''}>
                        <span class="weekend-picker-label">
                            Automatisch (rotatie)
                            ${autoResponsible ? `<span class="weekend-picker-hint">→ ${escapeHtml(autoResponsible.name)}</span>` : ''}
                        </span>
                    </label>
                    ${(() => {
                        // Group eligible employees by team
                        const byTeam = {};
                        eligible.forEach(emp => {
                            const team = emp.mainTeam || 'other';
                            if (!byTeam[team]) byTeam[team] = [];
                            byTeam[team].push(emp);
                        });
                        return Object.entries(byTeam).map(([teamId, emps]) => {
                            const teamInfo = (DataStore.settings.teams || {})[teamId] || {};
                            const teamColor = teamInfo.color || '#6b7280';
                            const teamName = teamInfo.name || teamId;
                            return `<div class="weekend-picker-team-group">
                                <div class="weekend-picker-team-header" style="border-left: 3px solid ${teamColor}">${escapeHtml(teamName)}</div>
                                ${emps.map(emp => {
                                    const isSelected = currentAssignment === String(emp.id);
                                    return `<label class="weekend-picker-option ${isSelected ? 'selected' : ''}" data-value="${emp.id}">
                                        <input type="radio" name="weekend-responsible" value="${emp.id}" ${isSelected ? 'checked' : ''}>
                                        <span class="weekend-picker-color" style="background: ${teamColor};"></span>
                                        <span class="weekend-picker-label">${escapeHtml(emp.name)}</span>
                                    </label>`;
                                }).join('')}
                            </div>`;
                        }).join('');
                    })()}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="weekend-picker-cancel">Annuleren</button>
                <button class="btn btn-primary" id="weekend-picker-save">Opslaan</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Highlight selected option
    overlay.querySelectorAll('.weekend-picker-option').forEach(opt => {
        opt.addEventListener('click', () => {
            overlay.querySelectorAll('.weekend-picker-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            opt.querySelector('input').checked = true;
        });
    });

    overlay.querySelector('#weekend-picker-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#weekend-picker-cancel').addEventListener('click', () => overlay.remove());
    // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
    // en de muis buiten het kader loslaat.
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#weekend-picker-save').addEventListener('click', async () => {
        const selected = overlay.querySelector('input[name="weekend-responsible"]:checked')?.value;
        if (!selected) return;

        if (selected === 'auto') {
            await removeWeekendResponsible(monday);
        } else {
            await setWeekendResponsible(monday, Number(selected));
        }

        overlay.remove();

        // Refresh the upcoming list
        const upcomingContainer = document.querySelector('.upcoming-responsibles');
        if (upcomingContainer) {
            upcomingContainer.innerHTML = renderUpcomingResponsibles();
            IconHelper.init(upcomingContainer);
            attachUpcomingWeekendListeners(upcomingContainer);
        }
        showToast('Weekendverantwoordelijke bijgewerkt', 'success');
    });
}

function attachUpcomingWeekendListeners(container) {
    container.querySelectorAll('.upcoming-item-clickable').forEach(item => {
        item.addEventListener('click', () => {
            const mondayKey = item.dataset.monday;
            if (mondayKey) showWeekendResponsiblePicker(mondayKey);
        });
    });
}

function setupSettingsCollapsibles(scope = document) {
    const cards = [];
    if (scope?.classList?.contains('settings-card') && scope?.dataset?.collapsible) {
        cards.push(scope);
    }
    cards.push(...scope.querySelectorAll('.settings-card[data-collapsible]'));
    cards.forEach(card => {
        const btn = card.querySelector('.settings-toggle-btn');
        if (!btn) return;
        const isOpen = card.dataset.open === 'true';
        card.classList.toggle('is-collapsed', !isOpen);
        btn.textContent = isOpen ? 'Verberg' : 'Toon';
        btn.addEventListener('click', () => {
            const nowCollapsed = !card.classList.toggle('is-collapsed');
            card.dataset.open = nowCollapsed ? 'false' : 'true';
            btn.textContent = nowCollapsed ? 'Toon' : 'Verberg';
        });
    });
}

// ===== DAG CONTEXT MENU (RECHTSKLIK SLUITEN/OPENEN) =====

(function setupDayContextMenu() {
    let activeMenu = null;

    function closeDayContextMenu() {
        if (activeMenu) {
            activeMenu.remove();
            activeMenu = null;
        }
    }

    function showDayContextMenu(x, y, dateStr) {
        closeDayContextMenu();
        const isClosed = isDateManuallyClosed(dateStr);
        const closedInfo = getClosedDateInfo(dateStr);

        const menu = document.createElement('div');
        menu.className = 'day-context-menu';

        const d = parseDateOnly(dateStr);
        const label = d.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' });

        if (!isClosed) {
            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = `${IconHelper.html(ICONS.lock, 'xs')} Dag sluiten`;
            closeBtn.addEventListener('click', async () => {
                closeDayContextMenu();
                const shiftsOnDate = DataStore.shifts.filter(s => s.date === dateStr);

                // #189: hier werd eerst verwijderd en pas daarna om een reden
                // gevraagd. Wie op Annuleer klikte, was zijn diensten kwijt
                // terwijl de dag niet gesloten werd, zonder enige melding en
                // zonder dat het scherm werd bijgewerkt.
                //
                // Alle vragen komen nu vóór de eerste wijziging, zodat afbreken
                // op elk moment betekent dat er niets gebeurd is.
                const reason = await promptReason('Reden (optioneel):');
                if (reason === null) return;

                if (shiftsOnDate.length > 0) {
                    const ok = await showConfirm(
                        `Er staan ${shiftsOnDate.length} dienst(en) ingepland op ${label}. Deze worden verwijderd bij het sluiten.`,
                        'Dag sluiten'
                    );
                    if (!ok) return;
                }

                try {
                    for (const shift of shiftsOnDate) {
                        // skipBlock: het sluiten van de dag houdt hem al leeg,
                        // een blokkade per medewerker is overbodig en blijft
                        // achter als de dag later heropend wordt.
                        await deleteShift(shift.id, true);
                    }
                    await addClosedDate(dateStr, reason);
                    showToast(`Dag gesloten: ${label}`, 'success');
                } catch (error) {
                    showToast('Dag sluiten mislukt: ' + getUserFriendlyError(error), 'error');
                } finally {
                    // Ook in het foutpad, anders toont het scherm diensten die
                    // er niet meer zijn.
                    renderPlanning();
                }
            });
            menu.appendChild(closeBtn);
        } else {
            const openBtn = document.createElement('button');
            openBtn.innerHTML = `${IconHelper.html('lock-open', 'xs')} Dag heropenen`;
            if (closedInfo?.reason) {
                const reasonEl = document.createElement('div');
                reasonEl.style.cssText = 'padding: 4px 14px; font-size: 12px; color: var(--text-secondary, #64748b);';
                reasonEl.textContent = closedInfo.reason;
                menu.appendChild(reasonEl);
            }
            openBtn.addEventListener('click', async () => {
                closeDayContextMenu();
                await removeClosedDate(dateStr);
                renderPlanning();
            });
            menu.appendChild(openBtn);
        }

        document.body.appendChild(menu);
        activeMenu = menu;

        // Positie corrigeren als menu buiten viewport valt
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        menu.style.left = (x + rect.width > vw ? vw - rect.width - 8 : x) + 'px';
        menu.style.top  = (y + rect.height > vh ? vh - rect.height - 8 : y) + 'px';
    }

    function promptReason(label) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center';
            overlay.innerHTML = `
                <div class="quick-dialog">
                    <div class="quick-dialog-title">Dag sluiten</div>
                    <label class="quick-dialog-label text-muted">${label}</label>
                    <input id="_reason-input" type="text" class="form-input quick-dialog-input" placeholder="bijv. Brugdag Hemelvaartsdag" maxlength="80">
                    <div class="quick-dialog-actions">
                        <button id="_reason-cancel" class="btn btn-secondary">Annuleer</button>
                        <button id="_reason-ok" class="btn btn-primary">Sluiten</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const input = overlay.querySelector('#_reason-input');
            input.focus();
            overlay.querySelector('#_reason-ok').addEventListener('click', () => { overlay.remove(); resolve(input.value.trim()); });
            overlay.querySelector('#_reason-cancel').addEventListener('click', () => { overlay.remove(); resolve(null); });
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { overlay.remove(); resolve(input.value.trim()); } });
        });
    }

    // showConfirmDialog stond hier: een driewegdialoog die nergens werd
    // aangeroepen, zonder Escape en zonder klik-buiten. Verwijderd als dode
    // code. Wie ooit een echte driewegvraag nodig heeft, bouwt hem beter in
    // app-ui.js naast showConfirm, zodat er één plek is voor dialogen.

    document.addEventListener('contextmenu', (e) => {
        const header = e.target.closest('.timeline-day-header, .month-day-header');
        if (!header) { closeDayContextMenu(); return; }
        if (!hasPermission('MANAGE_SHIFTS')) { closeDayContextMenu(); return; }
        const dateStr = header.dataset.date;
        if (!dateStr) return;
        e.preventDefault();
        showDayContextMenu(e.clientX, e.clientY, dateStr);
    });

    document.addEventListener('click', (e) => {
        if (activeMenu && !activeMenu.contains(e.target)) closeDayContextMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDayContextMenu();
    });
})();

// De berekening van de schoolvakanties heeft geen DOM nodig en wordt in Node
// getest (#352). In de browser bestaat `module` niet, dus deze guard verandert
// daar niets.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { belgischeSchoolvakanties };
}
