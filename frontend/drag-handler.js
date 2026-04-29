// ===== DRAG & DROP HANDLER =====
// Handles drag-to-transfer, click-to-create, and resize operations for timeline shifts

const DragHandler = {
    state: {
        isDragging: false,
        dragType: null, // 'transfer' | 'resize-start' | 'resize-end' | null
        shiftId: null,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        startTime: 0,
        originalData: {}, // Store original shift data for cancel/revert
        ghostElement: null,
        targetElement: null // The element being dragged
    },

    constants: {
        CLICK_THRESHOLD_MS: 200,
        DRAG_THRESHOLD_PX: 5,
        RESIZE_HANDLE_WIDTH: 10,
        TIME_SNAP_MINUTES: 15,
        START_HOUR: 7,
        END_HOUR: 24,
        TOTAL_HOURS: 17
    },

    // Initialize drag handlers on timeline
    init() {
        console.log('[DragHandler] Initializing drag & drop handlers');

        // Clean up existing listeners first
        this.cleanup();

        // Get timeline container
        const timeline = document.querySelector('.timeline-view-wrapper');
        if (!timeline) {
            console.warn('[DragHandler] Timeline container not found');
            return;
        }

        // Store bound references for proper cleanup (bind creates new objects each time)
        this._boundMouseDown = this.handleMouseDown.bind(this);
        this._boundMouseMove = this.handleMouseMove.bind(this);
        this._boundMouseUp = this.handleMouseUp.bind(this);
        this._boundKeyDown = this.handleKeyDown.bind(this);
        this._boundMobileClick = this.handleMobileClick.bind(this);

        // Attach event listeners using event delegation
        timeline.addEventListener('mousedown', this._boundMouseDown);
        document.addEventListener('mousemove', this._boundMouseMove);
        document.addEventListener('mouseup', this._boundMouseUp);
        document.addEventListener('keydown', this._boundKeyDown);
        // Mobile tap handler (mousedown is disabled on mobile, so use click)
        timeline.addEventListener('click', this._boundMobileClick);

        // Store references for cleanup
        this.state.timeline = timeline;
        this.state.initialized = true;

        console.log('[DragHandler] Initialized successfully');
    },

    // Clean up event listeners
    cleanup() {
        if (!this.state.initialized) return;

        console.log('[DragHandler] Cleaning up event listeners');

        const timeline = this.state.timeline;
        if (timeline && this._boundMouseDown) {
            timeline.removeEventListener('mousedown', this._boundMouseDown);
        }

        if (this._boundMouseMove) document.removeEventListener('mousemove', this._boundMouseMove);
        if (this._boundMouseUp) document.removeEventListener('mouseup', this._boundMouseUp);
        if (this._boundKeyDown) document.removeEventListener('keydown', this._boundKeyDown);
        if (this._boundMobileClick && timeline) timeline.removeEventListener('click', this._boundMobileClick);

        // Reset state
        this.state.initialized = false;
        this.state.timeline = null;
    },

    // Handle mouse down - initiate potential drag/click
    handleMouseDown(e) {
        // Check if mobile - disable drag on mobile
        if (window.matchMedia('(max-width: 767px)').matches) {
            return; // Let mobile use click-to-edit only
        }

        // Find if clicked on shift block, resize handle, or empty cell
        const shiftBlock = e.target.closest('.timeline-block');
        const emptyCell = e.target.closest('.timeline-day-cell');

        if (shiftBlock) {
            const shiftId = parseInt(shiftBlock.dataset.shiftId, 10);
            const shift = getShift(shiftId);

            if (!shift) return;

            // Check permissions
            if (!canUserEditShift(shift)) {
                console.log('[DragHandler] User cannot edit this shift');
                showToast('Je hebt geen rechten om deze shift te bewerken', 'warning');
                return;
            }

            // Check if shift has pending swap request
            if (this.hasPendingSwapRequest(shiftId)) {
                showToast('Deze shift heeft een openstaande ruil/afstaan aanvraag. Annuleer eerst de aanvraag voordat je de shift kan verplaatsen.', 'warning');
                return;
            }

            // Determine if clicking on resize handle
            const rect = shiftBlock.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const width = rect.width;

            let dragType = 'transfer';
            if (offsetX < this.constants.RESIZE_HANDLE_WIDTH) {
                dragType = 'resize-start';
            } else if (offsetX > width - this.constants.RESIZE_HANDLE_WIDTH) {
                dragType = 'resize-end';
            }

            // Record start position and time
            this.state.startX = e.clientX;
            this.state.startY = e.clientY;
            this.state.currentX = e.clientX;
            this.state.currentY = e.clientY;
            this.state.startTime = Date.now();
            this.state.shiftId = shiftId;
            this.state.dragType = dragType;
            this.state.targetElement = shiftBlock;
            this.state.originalData = { ...shift }; // Clone shift data

            // Prevent default to avoid text selection
            e.preventDefault();
        } else if (emptyCell && !emptyCell.classList.contains('closed')) {
            // Clicked on empty cell - record for potential shift creation
            this.state.startX = e.clientX;
            this.state.startY = e.clientY;
            this.state.currentX = e.clientX;
            this.state.currentY = e.clientY;
            this.state.startTime = Date.now();
            this.state.dragType = 'create';
            this.state.targetElement = emptyCell;
        }
    },

    // Handle mouse move - start drag if threshold exceeded
    handleMouseMove(e) {
        if (!this.state.startTime || !this.state.targetElement) return;

        this.state.currentX = e.clientX;
        this.state.currentY = e.clientY;

        // Calculate distance moved
        const distance = Math.sqrt(
            Math.pow(this.state.currentX - this.state.startX, 2) +
            Math.pow(this.state.currentY - this.state.startY, 2)
        );

        // Check if drag threshold exceeded
        if (!this.state.isDragging && distance > this.constants.DRAG_THRESHOLD_PX) {
            // Permission check for transfer operations (after threshold, not on mousedown)
            // This allows clicks and resize operations but blocks transfer drags for medewerkers
            if (this.state.dragType === 'transfer') {
                const shift = getShift(this.state.shiftId);
                if (shift && !canUserTransferShift(shift)) {
                    console.log('[DragHandler] User cannot transfer shifts - cancelling drag');
                    showToast('Je kunt alleen je eigen shift tijden aanpassen, niet naar anderen verplaatsen. Gebruik "Shift afstaan" om je shift over te dragen.', 'warning');
                    this.cleanup();
                    return;
                }
            }

            // Start drag operation
            if (this.state.dragType === 'transfer') {
                this.startTransferDrag();
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.startResizeDrag();
            }
            // Don't start drag for 'create' type - that's a click only
        }

        // Update drag position if already dragging
        if (this.state.isDragging) {
            if (this.state.dragType === 'transfer') {
                this.updateTransferDrag(e);
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.updateResizeDrag(e);
            }
        }
    },

    // Handle mouse up - complete drag or trigger click
    handleMouseUp(e) {
        if (!this.state.startTime) return;

        // Check if this is a click (within thresholds)
        if (this.isClick()) {
            if (this.state.dragType === 'create') {
                this.handleCellClick(this.state.targetElement);
            } else if (this.state.shiftId) {
                // Click on shift block - only open if user has permission
                const shift = getShift(this.state.shiftId);
                if (shift && canUserEditShift(shift)) {
                    openEditShiftModal(this.state.shiftId);
                }
            }
            this.reset();
        } else if (this.state.isDragging) {
            // Complete drag operation - async handlers manage their own cleanup
            if (this.state.dragType === 'transfer') {
                this.completeTransferDrag(e);
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.completeResizeDrag(e);
            } else {
                this.reset();
            }
        } else {
            this.reset();
        }
    },

    // Handle keyboard events
    handleKeyDown(e) {
        if (e.key === 'Escape' && this.state.isDragging) {
            console.log('[DragHandler] Drag cancelled by user (Escape key)');
            this.cancelDrag();
        }
    },

    // Check if interaction is a click (within thresholds)
    isClick() {
        const timeDiff = Date.now() - this.state.startTime;
        const distance = Math.sqrt(
            Math.pow(this.state.currentX - this.state.startX, 2) +
            Math.pow(this.state.currentY - this.state.startY, 2)
        );

        return timeDiff < this.constants.CLICK_THRESHOLD_MS &&
               distance < this.constants.DRAG_THRESHOLD_PX;
    },

    // Check if shift has pending swap request
    hasPendingSwapRequest(shiftId) {
        const swapRequests = DataStore.swapRequests || [];
        return swapRequests.some(
            req => req.shift_id === shiftId && req.status === 'pending'
        );
    },

    // Start transfer drag operation
    startTransferDrag() {
        console.log('[DragHandler] Starting transfer drag for shift', this.state.shiftId);
        this.state.isDragging = true;

        // Capture original dimensions and position BEFORE making it position:fixed
        const rect = this.state.targetElement.getBoundingClientRect();
        this.state.originalWidth = rect.width;
        this.state.originalHeight = rect.height;

        // Store original styles to restore later
        this.state.originalStyles = this.state.targetElement.style.cssText;

        // Set ONLY the positioning styles we need (don't preserve conflicting styles)
        this.state.targetElement.style.cssText = '';
        this.state.targetElement.style.transition = 'none'; // DISABLE CSS TRANSITIONS!
        this.state.targetElement.style.position = 'fixed';
        this.state.targetElement.style.left = `${rect.left}px`;
        this.state.targetElement.style.top = `${rect.top}px`;
        this.state.targetElement.style.width = `${rect.width}px`;
        this.state.targetElement.style.height = `${rect.height}px`;
        this.state.targetElement.style.zIndex = '10000';

        // Add visual feedback classes
        this.state.targetElement.classList.add('is-dragging');
        document.body.style.cursor = 'grabbing';

        // Create ghost element (placeholder in original position)
        const ghost = this.state.targetElement.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.classList.remove('is-dragging');
        ghost.style.pointerEvents = 'none';
        this.state.ghostElement = ghost;
        this.state.targetElement.parentElement.appendChild(ghost);
    },

    // Update transfer drag position
    updateTransferDrag(e) {
        // Move the dragging element with the cursor
        if (this.state.targetElement) {
            this.state.targetElement.style.left = `${e.clientX}px`;
            this.state.targetElement.style.top = `${e.clientY}px`;
        }

        // Highlight valid/invalid drop targets
        const dayCell = this.getDayCellFromPoint(e.clientX, e.clientY);

        // Clear previous highlights
        document.querySelectorAll('.drop-target-valid, .drop-target-invalid').forEach(cell => {
            cell.classList.remove('drop-target-valid', 'drop-target-invalid');
        });

        if (dayCell && !dayCell.classList.contains('closed')) {
            // Check if this is a valid drop target
            const isValid = this.isValidDropTarget(dayCell);
            dayCell.classList.add(isValid ? 'drop-target-valid' : 'drop-target-invalid');
        }
    },

    // Complete transfer drag
    async completeTransferDrag(e) {
        // 1. Capture all needed state SYNCHRONOUSLY before any async work
        const dayCell = this.getDayCellFromPoint(e.clientX, e.clientY);
        const shiftId = this.state.shiftId;
        const originalData = { ...this.state.originalData };
        const targetEmployee = dayCell ? this.getEmployeeFromRow(dayCell) : null;
        const targetDate = dayCell ? this.getDateFromCell(dayCell) : null;

        // 2. Reset visual state immediately (before async API call)
        this.reset();

        // 3. Validate using captured data
        if (!dayCell) {
            console.log('[DragHandler] Invalid drop target - cancelling');
            showToast('Ongeldige locatie. Sleep de shift naar een dag in de planner.', 'warning');
            return;
        }

        if (dayCell.classList.contains('closed')) {
            console.log('[DragHandler] Drop target is closed day');
            showToast('Deze dag is gesloten. Je kunt hier geen shift toewijzen.', 'warning');
            return;
        }

        if (!targetEmployee || !targetDate) {
            console.log('[DragHandler] Could not determine target employee/date');
            showToast('Kon de medewerker of datum niet bepalen. Probeer opnieuw.', 'warning');
            return;
        }

        // Permission check handled by canUserTransferShift() at drag start

        // Check if employee has availability/absence on this date - warn but allow override
        const availability = getAvailability(targetEmployee.id, targetDate);
        if (availability && availability.type) {
            const absenceLabels = {
                'verlof': 'verlof heeft',
                'ziek': 'ziek is',
                'overuren': 'overuren opneemt',
                'vorming': 'vorming heeft',
                'andere': 'afwezig is'
            };
            const reason = absenceLabels[availability.type] || 'afwezig is';
            const confirmed = await showConfirm(
                `${targetEmployee.name} ${reason} op ${formatDate(targetDate)}.\n\nToch shift toewijzen?`,
                'Medewerker afwezig'
            );
            if (!confirmed) return;
        }

        // Check validation rules (11-hour rule, overlap, etc.) - warn but allow override
        const testShift = {
            ...originalData,
            employeeId: targetEmployee.id,
            date: targetDate
        };
        const validation = validateShift(testShift, shiftId);
        if (!validation.isValid || validation.hasWarnings) {
            const issues = [...validation.errors, ...validation.warnings].map(i => `- ${i.message}`).join('\n');
            const confirmed = await showConfirm(
                `Er zijn opmerkingen:\n\n${issues}\n\nToch shift toewijzen?`,
                'Validatie opmerkingen'
            );
            if (!confirmed) return;
        }

        console.log(`[DragHandler] Transferring shift ${shiftId} to ${targetEmployee.name} on ${targetDate}`);

        // 4. Update shift via API (using captured data, not this.state)
        showSectionLoading('planning-view', 'Shift verplaatsen...');
        try {
            const originalEmployeeId = originalData.employeeId;
            const originalDate2 = originalData.date;

            // Update shift - mark as manual to prevent auto-schedule from replacing it
            await updateShift(shiftId, {
                employeeId: targetEmployee.id,
                date: targetDate,
                team: originalData.team,
                startTime: originalData.startTime,
                endTime: originalData.endTime,
                notes: originalData.notes || '',
                source: 'manual' // Mark as manual so it persists
            });

            // Record undo action for drag transfer (using captured shiftId)
            if (typeof UndoManager !== 'undefined') {
                UndoManager.push({
                    type: 'update',
                    shiftId: shiftId,
                    shiftData: { employeeId: targetEmployee.id, date: targetDate, team: originalData.team, startTime: originalData.startTime, endTime: originalData.endTime, notes: originalData.notes || '' },
                    previousData: { employeeId: originalEmployeeId, date: originalDate2, team: originalData.team, startTime: originalData.startTime, endTime: originalData.endTime, notes: originalData.notes || '' }
                });
            }

            // Refresh view
            renderPlanning();

            showToast(`Shift overgedragen aan ${targetEmployee.name}`, 'success');
        } catch (error) {
            console.error('[DragHandler] Error transferring shift:', error);
            showToast(`Fout bij overdragen shift: ${error.message}`, 'error');
            // Re-sync from server to ensure UI matches DB
            try { await refreshShifts(); renderPlanning(); } catch (_) {}
        } finally {
            hideSectionLoading('planning-view');
        }
    },

    // Start resize drag operation
    startResizeDrag() {
        console.log('[DragHandler] Starting resize drag (type:', this.state.dragType + ')');
        this.state.isDragging = true;

        // Store original styles to restore on cancel
        if (this.state.targetElement && this.state.originalStyles === undefined) {
            this.state.originalStyles = this.state.targetElement.style.cssText;
        }

        // Change cursor
        document.body.style.cursor = 'ew-resize';
    },

    // Update resize drag
    updateResizeDrag(e) {
        // Get day cell containing the shift
        const dayCell = this.state.targetElement.parentElement;
        const rect = dayCell.getBoundingClientRect();

        // Calculate time from X position
        const newTime = this.getTimeFromX(e.clientX, rect);

        if (!newTime) return;

        // Validate and update visual feedback
        const shift = this.state.originalData;
        let newStartTime = shift.startTime;
        let newEndTime = shift.endTime;

        if (this.state.dragType === 'resize-start') {
            newStartTime = newTime;
        } else {
            newEndTime = newTime;
        }

        // Calculate duration
        const duration = this.calculateDuration(newStartTime, newEndTime);

        // Don't allow resize if duration would be less than 1 hour
        if (duration < 1) {
            return;
        }

        // Update shift block visual appearance in real-time
        this.updateShiftBlockVisual(newStartTime, newEndTime);
    },

    // Update shift block visual appearance during resize
    updateShiftBlockVisual(startTime, endTime) {
        if (!this.state.targetElement) return;

        // Parse times
        const [startHour, startMin] = startTime.split(':').map(Number);
        const [endHour, endMin] = endTime.split(':').map(Number);

        // Calculate position and width as percentages
        const startFrac = startHour + startMin / 60;
        const endFrac = endHour + endMin / 60;

        const START_HOUR = this.constants.START_HOUR;
        const TOTAL_HOURS = this.constants.TOTAL_HOURS;

        const leftPercent = Math.max(0, ((startFrac - START_HOUR) / TOTAL_HOURS) * 100);
        const widthPercent = ((endFrac - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;

        // Update the visual position/size
        this.state.targetElement.style.left = `${leftPercent}%`;
        this.state.targetElement.style.width = `${widthPercent}%`;

        // Update the time label
        const timeLabel = this.state.targetElement.querySelector('.block-time');
        if (timeLabel) {
            timeLabel.textContent = `${startTime}-${endTime}`;
        }

        // Add visual feedback class
        this.state.targetElement.classList.add('is-resizing');
    },

    // Complete resize drag
    async completeResizeDrag(e) {
        // 1. Capture all needed state SYNCHRONOUSLY before any async work
        const targetElement = this.state.targetElement;
        const dayCell = targetElement ? targetElement.parentElement : null;
        const shiftId = this.state.shiftId;
        const originalData = { ...this.state.originalData };
        const dragType = this.state.dragType;

        if (!dayCell) {
            this.reset();
            return;
        }

        const rect = dayCell.getBoundingClientRect();
        const newTime = this.getTimeFromX(e.clientX, rect);

        // 2. Reset visual state immediately
        this.reset();

        if (!newTime) {
            return;
        }

        let newStartTime = originalData.startTime;
        let newEndTime = originalData.endTime;

        if (dragType === 'resize-start') {
            newStartTime = newTime;
        } else {
            newEndTime = newTime;
        }

        // Validate duration (minimum 1 hour)
        const duration = this.calculateDuration(newStartTime, newEndTime);
        if (duration < 1) {
            showToast('Een shift moet minimaal 1 uur duren', 'warning');
            return;
        }

        console.log(`[DragHandler] Resizing shift ${shiftId} to ${newStartTime} - ${newEndTime}`);

        // 3. Update shift via API (using captured data, not this.state)
        try {
            const previousData = {
                employeeId: originalData.employeeId,
                date: originalData.date,
                team: originalData.team,
                startTime: originalData.startTime,
                endTime: originalData.endTime,
                notes: originalData.notes || ''
            };
            const newData = {
                employeeId: originalData.employeeId,
                date: originalData.date,
                team: originalData.team,
                startTime: newStartTime,
                endTime: newEndTime,
                notes: originalData.notes || '',
                source: 'manual'
            };

            // Mark as manual so resized shifts persist across auto-schedule regeneration
            await updateShift(shiftId, newData);

            // Record undo action for drag resize (using captured shiftId)
            if (typeof UndoManager !== 'undefined') {
                UndoManager.push({
                    type: 'update',
                    shiftId: shiftId,
                    shiftData: newData,
                    previousData: previousData
                });
            }

            // Refresh view
            renderPlanning();

            showToast('Shift aangepast', 'success');
        } catch (error) {
            console.error('[DragHandler] Error resizing shift:', error);
            showToast(`Fout bij aanpassen shift: ${error.message}`, 'error');
            // Re-sync from server to ensure UI matches DB
            try { await refreshShifts(); renderPlanning(); } catch (_) {}
        }
    },

    // Handle tap/click on mobile (mousedown is disabled on ≤767px)
    handleMobileClick(e) {
        if (!window.matchMedia('(max-width: 767px)').matches) return;

        const shiftBlock = e.target.closest('.timeline-block');
        const dayCell = e.target.closest('.timeline-day-cell');

        if (shiftBlock) {
            const shiftId = parseInt(shiftBlock.dataset.shiftId, 10);
            const shift = shiftId ? getShift(shiftId) : null;
            if (shift && canUserEditShift(shift)) openEditShiftModal(shiftId);
        } else if (dayCell && !dayCell.classList.contains('closed')) {
            this.handleCellClick(dayCell);
        }
    },

    // Handle cell click (create shift)
    handleCellClick(dayCell) {
        console.log('[DragHandler] Cell clicked - opening shift creation modal');

        // Get employee and date from cell
        const employee = this.getEmployeeFromRow(dayCell);
        const date = this.getDateFromCell(dayCell);

        if (!employee || !date) {
            console.warn('[DragHandler] Could not determine employee/date from cell');
            return;
        }

        // Check permissions - can user create shifts for this team?
        const role = getEffectiveRole();

        if (role === 'medewerker') {
            // Medewerkers can only create shifts for themselves
            if (employee.id !== AppState.currentUser.id) {
                showToast('Je kan alleen shifts voor jezelf aanmaken', 'warning');
                return;
            }
        }
        // Admin and roosterverantwoordelijke can create for any team

        // Get default times from employee's week schedule for this day
        const dayOfWeek = new Date(date).getDay();
        const weekNumber = getWeekNumber(new Date(date));
        const schedule = getEmployeeWeekSchedule(employee, weekNumber);
        const daySchedule = schedule.find(s => s.dayOfWeek === dayOfWeek && s.enabled);

        const defaultStartTime = daySchedule?.startTime || '09:00';
        const defaultEndTime = daySchedule?.endTime || '17:00';

        // Pre-fill shift modal and open it
        // (We'll modify openAddShiftModal to accept pre-fill data)
        if (typeof openAddShiftModalWithData === 'function') {
            openAddShiftModalWithData({
                employeeId: employee.id,
                date: date,
                team: employee.mainTeam,
                startTime: defaultStartTime,
                endTime: defaultEndTime
            });
        } else {
            // Fallback: open normal modal and manually fill
            openAddShiftModal();
            // TODO: Pre-fill form fields
            document.getElementById('shift-employee').value = employee.id;
            document.getElementById('shift-date').value = date;
            document.getElementById('shift-team').value = employee.mainTeam;
            document.getElementById('shift-start').value = defaultStartTime;
            document.getElementById('shift-end').value = defaultEndTime;
        }
    },

    // Cancel drag operation
    cancelDrag() {
        console.log('[DragHandler] Cancelling drag');

        // Remove visual feedback
        if (this.state.targetElement) {
            this.state.targetElement.classList.remove('is-dragging', 'is-resizing');
        }

        if (this.state.ghostElement) {
            this.state.ghostElement.remove();
        }

        document.querySelectorAll('.drop-target-valid, .drop-target-invalid').forEach(cell => {
            cell.classList.remove('drop-target-valid', 'drop-target-invalid');
        });

        document.body.style.cursor = '';

        this.reset();
    },

    // Reset drag state
    reset() {
        // Remove ghost element
        if (this.state.ghostElement) {
            this.state.ghostElement.remove();
        }

        // Remove drag classes and restore original styles
        if (this.state.targetElement) {
            this.state.targetElement.classList.remove('is-dragging', 'is-resizing');
            // Restore original styles completely
            if (this.state.originalStyles !== undefined) {
                this.state.targetElement.style.cssText = this.state.originalStyles;
            }
        }

        // Remove drop target highlights
        document.querySelectorAll('.drop-target-valid, .drop-target-warning, .drop-target-invalid').forEach(cell => {
            cell.classList.remove('drop-target-valid', 'drop-target-warning', 'drop-target-invalid');
        });

        // Reset cursor
        document.body.style.cursor = '';

        // Reset state
        this.state.isDragging = false;
        this.state.dragType = null;
        this.state.shiftId = null;
        this.state.startX = 0;
        this.state.startY = 0;
        this.state.currentX = 0;
        this.state.currentY = 0;
        this.state.startTime = 0;
        this.state.originalData = {};
        this.state.ghostElement = null;
        this.state.targetElement = null;
        this._lastValidationTime = null;
        this._lastValidationResult = null;
    },

    // Helper: Get day cell from mouse coordinates
    getDayCellFromPoint(x, y) {
        const elements = document.elementsFromPoint(x, y);
        return elements.find(el => el.classList.contains('timeline-day-cell'));
    },

    // Helper: Check if day cell is a valid drop target
    isValidDropTarget(dayCell) {
        if (!dayCell || dayCell.classList.contains('closed')) return false;

        // Get target employee and date
        const targetEmployee = this.getEmployeeFromRow(dayCell);
        const targetDate = this.getDateFromCell(dayCell);

        if (!targetEmployee || !targetDate) return false;

        // Always allow drop - validation issues are shown as warnings after drop
        return true;
    },

    // Helper: Get employee from row containing day cell
    getEmployeeFromRow(dayCell) {
        const row = dayCell.parentElement;
        if (!row || !row.classList.contains('timeline-row')) return null;

        const empNameElement = row.querySelector('.emp-name');
        if (!empNameElement) return null;

        const empName = empNameElement.textContent.trim();
        return DataStore.users.find(u => u.name === empName);
    },

    // Helper: Get date from day cell
    getDateFromCell(dayCell) {
        // Get all day cells in this row
        const row = dayCell.parentElement;
        const dayCells = Array.from(row.querySelectorAll('.timeline-day-cell'));
        const index = dayCells.indexOf(dayCell);

        if (index === -1) return null;

        // Get week dates
        const weekDates = getWeekDates(AppState.currentWeekStart);
        return weekDates[index];
    },

    // Helper: Get time from X coordinate (with snapping)
    getTimeFromX(clientX, cellRect) {
        const offsetX = Math.max(0, clientX - cellRect.left);
        const percent = Math.min(1, offsetX / cellRect.width);

        // Calculate hours from percent
        let hours = this.constants.START_HOUR + (percent * this.constants.TOTAL_HOURS);

        // Snap to nearest interval
        const totalMinutes = hours * 60;
        const snappedMinutes = Math.round(totalMinutes / this.constants.TIME_SNAP_MINUTES) * this.constants.TIME_SNAP_MINUTES;
        hours = snappedMinutes / 60;

        // Clamp to valid range
        hours = Math.max(this.constants.START_HOUR, Math.min(this.constants.END_HOUR, hours));

        // Format as HH:MM
        const wholeHours = Math.floor(hours);
        const minutes = Math.round((hours % 1) * 60);

        return `${String(wholeHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    },

    // Helper: Calculate duration between two times
    calculateDuration(startTime, endTime) {
        const [startHour, startMin] = startTime.split(':').map(Number);
        const [endHour, endMin] = endTime.split(':').map(Number);

        const startMinutes = startHour * 60 + startMin;
        let endMinutes = endHour * 60 + endMin;

        // Handle overnight shifts
        if (endMinutes < startMinutes) {
            endMinutes += 24 * 60;
        }

        return (endMinutes - startMinutes) / 60; // Return hours
    }
};

// ===== BUILDER DRAG & DROP HANDLER =====
// Operates on AppState.builderGrid (local state), no API calls needed

const BuilderDragHandler = {
    state: {
        isDragging: false,
        dragType: null, // 'transfer' | 'resize-start' | 'resize-end' | null
        employeeId: null,
        dayIndex: null,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        startTime: 0,
        originalAssignment: null,
        targetElement: null,
        ghostElement: null,
        originalStyles: undefined
    },

    constants: {
        CLICK_THRESHOLD_MS: 200,
        DRAG_THRESHOLD_PX: 5,
        RESIZE_HANDLE_WIDTH: 12,
        TIME_SNAP_MINUTES: 15,
        START_HOUR: 7,
        END_HOUR: 24,
        TOTAL_HOURS: 17
    },

    init() {
        this.cleanup();
        const grid = document.querySelector('.builder-grid');
        if (!grid) return;

        this._boundMouseDown = this.handleMouseDown.bind(this);
        this._boundMouseMove = this.handleMouseMove.bind(this);
        this._boundMouseUp = this.handleMouseUp.bind(this);
        this._boundKeyDown = this.handleKeyDown.bind(this);

        grid.addEventListener('mousedown', this._boundMouseDown);
        document.addEventListener('mousemove', this._boundMouseMove);
        document.addEventListener('mouseup', this._boundMouseUp);
        document.addEventListener('keydown', this._boundKeyDown);

        this.state.grid = grid;
        this.state.initialized = true;
    },

    cleanup() {
        if (!this.state.initialized) return;
        const grid = this.state.grid;
        if (grid && this._boundMouseDown) grid.removeEventListener('mousedown', this._boundMouseDown);
        if (this._boundMouseMove) document.removeEventListener('mousemove', this._boundMouseMove);
        if (this._boundMouseUp) document.removeEventListener('mouseup', this._boundMouseUp);
        if (this._boundKeyDown) document.removeEventListener('keydown', this._boundKeyDown);
        this.state.initialized = false;
        this.state.grid = null;
    },

    handleMouseDown(e) {
        if (window.matchMedia('(max-width: 767px)').matches) return;

        const block = e.target.closest('.builder-timeline-block');
        const cell = e.target.closest('.builder-cell');

        if (block && cell && !cell.classList.contains('closed')) {
            const empId = Number(cell.dataset.employeeId);
            const dayIndex = Number(cell.dataset.day);

            // Determine drag type based on click position within block
            const rect = block.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const width = rect.width;

            let dragType = 'transfer';
            if (offsetX < this.constants.RESIZE_HANDLE_WIDTH) {
                dragType = 'resize-start';
            } else if (offsetX > width - this.constants.RESIZE_HANDLE_WIDTH) {
                dragType = 'resize-end';
            }

            const empGrid = AppState.builderGrid[empId] || {};
            const assignment = empGrid[dayIndex];
            if (!assignment) return;

            this.state.startX = e.clientX;
            this.state.startY = e.clientY;
            this.state.currentX = e.clientX;
            this.state.currentY = e.clientY;
            this.state.startTime = Date.now();
            this.state.employeeId = empId;
            this.state.dayIndex = dayIndex;
            this.state.dragType = dragType;
            this.state.targetElement = block;
            this.state.originalAssignment = { ...assignment };
            e.preventDefault();
        } else if (cell && !cell.classList.contains('closed') && !block) {
            // Click on empty cell
            this.state.startX = e.clientX;
            this.state.startY = e.clientY;
            this.state.currentX = e.clientX;
            this.state.currentY = e.clientY;
            this.state.startTime = Date.now();
            this.state.dragType = 'click-empty';
            this.state.targetElement = cell;
        }
    },

    handleMouseMove(e) {
        if (!this.state.startTime || !this.state.targetElement) return;

        this.state.currentX = e.clientX;
        this.state.currentY = e.clientY;

        const distance = Math.sqrt(
            Math.pow(this.state.currentX - this.state.startX, 2) +
            Math.pow(this.state.currentY - this.state.startY, 2)
        );

        if (!this.state.isDragging && distance > this.constants.DRAG_THRESHOLD_PX) {
            if (this.state.dragType === 'transfer') {
                this.startTransferDrag();
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.startResizeDrag();
            }
        }

        if (this.state.isDragging) {
            if (this.state.dragType === 'transfer') {
                this.updateTransferDrag(e);
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.updateResizeDrag(e);
            }
        }
    },

    handleMouseUp(e) {
        if (!this.state.startTime) return;

        if (this.isClick()) {
            if (this.state.dragType === 'click-empty') {
                const cell = this.state.targetElement;
                const empId = Number(cell.dataset.employeeId);
                const dayIndex = Number(cell.dataset.day);
                this.reset();
                openBuilderShiftModal(empId, dayIndex);
            } else if (this.state.employeeId != null) {
                const empId = this.state.employeeId;
                const dayIndex = this.state.dayIndex;
                this.reset();
                openBuilderShiftModal(empId, dayIndex);
            } else {
                this.reset();
            }
        } else if (this.state.isDragging) {
            if (this.state.dragType === 'transfer') {
                this.completeTransferDrag(e);
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.completeResizeDrag(e);
            } else {
                this.reset();
            }
        } else {
            this.reset();
        }
    },

    handleKeyDown(e) {
        if (e.key === 'Escape' && this.state.isDragging) {
            this.cancelDrag();
        }
    },

    isClick() {
        const timeDiff = Date.now() - this.state.startTime;
        const distance = Math.sqrt(
            Math.pow(this.state.currentX - this.state.startX, 2) +
            Math.pow(this.state.currentY - this.state.startY, 2)
        );
        return timeDiff < this.constants.CLICK_THRESHOLD_MS &&
               distance < this.constants.DRAG_THRESHOLD_PX;
    },

    // --- Transfer drag ---
    startTransferDrag() {
        this.state.isDragging = true;

        const rect = this.state.targetElement.getBoundingClientRect();
        this.state.originalStyles = this.state.targetElement.style.cssText;

        this.state.targetElement.style.cssText = '';
        this.state.targetElement.style.transition = 'none';
        this.state.targetElement.style.position = 'fixed';
        this.state.targetElement.style.left = `${rect.left}px`;
        this.state.targetElement.style.top = `${rect.top}px`;
        this.state.targetElement.style.width = `${rect.width}px`;
        this.state.targetElement.style.height = `${rect.height}px`;
        this.state.targetElement.style.zIndex = '10000';
        this.state.targetElement.classList.add('is-dragging');
        document.body.style.cursor = 'grabbing';

        // Ghost placeholder
        const ghost = this.state.targetElement.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.classList.remove('is-dragging');
        ghost.style.cssText = this.state.originalStyles;
        ghost.style.pointerEvents = 'none';
        ghost.style.opacity = '0.3';
        this.state.ghostElement = ghost;
        this.state.targetElement.parentElement.appendChild(ghost);
    },

    updateTransferDrag(e) {
        if (this.state.targetElement) {
            this.state.targetElement.style.left = `${e.clientX - 30}px`;
            this.state.targetElement.style.top = `${e.clientY - 15}px`;
        }

        // Highlight drop targets with live validation (throttled 100ms)
        const cell = this.getCellFromPoint(e.clientX, e.clientY);
        document.querySelectorAll('.builder-cell.drop-target-valid, .builder-cell.drop-target-warning, .builder-cell.drop-target-invalid').forEach(c => {
            c.classList.remove('drop-target-valid', 'drop-target-warning', 'drop-target-invalid');
        });
        if (cell && !cell.classList.contains('closed')) {
            const now = Date.now();
            if (!this._lastValidationTime || now - this._lastValidationTime >= 100) {
                this._lastValidationTime = now;
                const targetEmpId = Number(cell.dataset.employeeId);
                const targetDay = Number(cell.dataset.day);
                const result = this.validateBuilderPlacement(targetEmpId, targetDay, this.state.originalAssignment);
                this._lastValidationResult = result;
            }
            const result = this._lastValidationResult || { level: 'ok' };
            if (result.level === 'error') cell.classList.add('drop-target-invalid');
            else if (result.level === 'warning') cell.classList.add('drop-target-warning');
            else cell.classList.add('drop-target-valid');
        }
    },

    completeTransferDrag(e) {
        const cell = this.getCellFromPoint(e.clientX, e.clientY);
        const origEmpId = this.state.employeeId;
        const origDay = this.state.dayIndex;
        const assignment = { ...this.state.originalAssignment };

        this.reset();

        if (!cell || cell.classList.contains('closed')) {
            showToast('Ongeldige locatie', 'warning');
            renderBuilder();
            return;
        }

        const targetEmpId = Number(cell.dataset.employeeId);
        const targetDay = Number(cell.dataset.day);

        // Same position = no-op
        if (targetEmpId === origEmpId && targetDay === origDay) {
            renderBuilder();
            return;
        }

        // Live validation: warn but always allow placement
        const validation = this.validateBuilderPlacement(targetEmpId, targetDay, assignment);

        // Remove from original position
        if (AppState.builderGrid[origEmpId]) {
            delete AppState.builderGrid[origEmpId][origDay];
        }

        // Place at new position (overwrite if occupied)
        if (!AppState.builderGrid[targetEmpId]) AppState.builderGrid[targetEmpId] = {};
        AppState.builderGrid[targetEmpId][targetDay] = assignment;

        AppState.builderIsDirty = true;
        renderBuilder();
        if (validation.level !== 'ok') showToast(validation.message, 'warning');
        else showToast('Dienst verplaatst', 'success');
    },

    validateBuilderPlacement(targetEmpId, targetDay, assignment) {
        if (!assignment?.startTime || !assignment?.endTime) return { level: 'ok', message: '' };

        const grid = AppState.builderGrid[targetEmpId] || {};
        const toMin = t => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };

        const startMin = toMin(assignment.startTime);
        const endMin = toMin(assignment.endTime);

        const gapHours = (aEndMin, bStartMin) => {
            const raw = bStartMin >= aEndMin ? bStartMin - aEndMin : 1440 - aEndMin + bStartMin;
            return raw / 60;
        };

        // Check rest gap with previous day's assignment
        const prev = grid[targetDay - 1];
        if (prev?.endTime) {
            const gap = gapHours(toMin(prev.endTime), startMin);
            if (gap < 11) return { level: 'error', message: `Onvoldoende rust — ${gap.toFixed(1)}u na vorige dienst (min. 11u)` };
        }

        // Check rest gap with next day's assignment
        const next = grid[targetDay + 1];
        if (next?.startTime) {
            const gap = gapHours(endMin, toMin(next.startTime));
            if (gap < 11) return { level: 'error', message: `Onvoldoende rust — ${gap.toFixed(1)}u voor volgende dienst (min. 11u)` };
        }

        return { level: 'ok', message: '' };
    },

    // --- Resize drag ---
    startResizeDrag() {
        this.state.isDragging = true;
        if (this.state.targetElement && this.state.originalStyles === undefined) {
            this.state.originalStyles = this.state.targetElement.style.cssText;
        }
        document.body.style.cursor = 'ew-resize';
        this.state.targetElement.classList.add('is-resizing');
    },

    updateResizeDrag(e) {
        const cell = this.state.targetElement.closest('.builder-cell');
        if (!cell) return;
        const rect = cell.getBoundingClientRect();
        const newTime = this.getTimeFromX(e.clientX, rect);
        if (!newTime) return;

        const orig = this.state.originalAssignment;
        let newStart = orig.startTime;
        let newEnd = orig.endTime;

        if (this.state.dragType === 'resize-start') {
            newStart = newTime;
        } else {
            newEnd = newTime;
        }

        // Min 1 hour
        if (this.calculateDuration(newStart, newEnd) < 1) return;

        // Update visual
        const pos = calcTimePosition(newStart, newEnd);
        this.state.targetElement.style.left = `${pos.leftPct.toFixed(1)}%`;
        this.state.targetElement.style.width = `${pos.widthPct.toFixed(1)}%`;

        const timeLabel = this.state.targetElement.querySelector('.btb-time');
        if (timeLabel) timeLabel.textContent = `${newStart}-${newEnd}`;
    },

    completeResizeDrag(e) {
        const cell = this.state.targetElement ? this.state.targetElement.closest('.builder-cell') : null;
        const empId = this.state.employeeId;
        const dayIndex = this.state.dayIndex;
        const orig = { ...this.state.originalAssignment };
        const dragType = this.state.dragType;

        this.reset();

        if (!cell) return;
        const rect = cell.getBoundingClientRect();
        const newTime = this.getTimeFromX(e.clientX, rect);
        if (!newTime) { renderBuilder(); return; }

        let newStart = orig.startTime;
        let newEnd = orig.endTime;
        if (dragType === 'resize-start') newStart = newTime;
        else newEnd = newTime;

        if (this.calculateDuration(newStart, newEnd) < 1) {
            showToast('Een dienst moet minimaal 1 uur duren', 'warning');
            renderBuilder();
            return;
        }

        // Update builderGrid
        if (!AppState.builderGrid[empId]) AppState.builderGrid[empId] = {};
        AppState.builderGrid[empId][dayIndex] = {
            ...orig,
            startTime: newStart,
            endTime: newEnd
        };

        AppState.builderIsDirty = true;
        renderBuilder();
        showToast(`Dienst aangepast: ${newStart}-${newEnd}`, 'success');
    },

    cancelDrag() {
        if (this.state.targetElement) {
            this.state.targetElement.classList.remove('is-dragging', 'is-resizing');
        }
        if (this.state.ghostElement) this.state.ghostElement.remove();
        document.querySelectorAll('.builder-cell.drop-target-valid, .builder-cell.drop-target-invalid').forEach(c => {
            c.classList.remove('drop-target-valid', 'drop-target-invalid');
        });
        document.body.style.cursor = '';
        this.reset();
        renderBuilder();
    },

    reset() {
        if (this.state.ghostElement) this.state.ghostElement.remove();
        if (this.state.targetElement) {
            this.state.targetElement.classList.remove('is-dragging', 'is-resizing');
            if (this.state.originalStyles !== undefined) {
                this.state.targetElement.style.cssText = this.state.originalStyles;
            }
        }
        document.querySelectorAll('.builder-cell.drop-target-valid, .builder-cell.drop-target-invalid').forEach(c => {
            c.classList.remove('drop-target-valid', 'drop-target-invalid');
        });
        document.body.style.cursor = '';

        this.state.isDragging = false;
        this.state.dragType = null;
        this.state.employeeId = null;
        this.state.dayIndex = null;
        this.state.startX = 0;
        this.state.startY = 0;
        this.state.currentX = 0;
        this.state.currentY = 0;
        this.state.startTime = 0;
        this.state.originalAssignment = null;
        this.state.ghostElement = null;
        this.state.targetElement = null;
        this.state.originalStyles = undefined;
    },

    // --- Helpers ---
    getCellFromPoint(x, y) {
        const elements = document.elementsFromPoint(x, y);
        return elements.find(el => el.classList.contains('builder-cell'));
    },

    getTimeFromX(clientX, cellRect) {
        const offsetX = Math.max(0, clientX - cellRect.left);
        const percent = Math.min(1, offsetX / cellRect.width);
        let hours = this.constants.START_HOUR + (percent * this.constants.TOTAL_HOURS);

        const totalMinutes = hours * 60;
        const snappedMinutes = Math.round(totalMinutes / this.constants.TIME_SNAP_MINUTES) * this.constants.TIME_SNAP_MINUTES;
        hours = snappedMinutes / 60;
        hours = Math.max(this.constants.START_HOUR, Math.min(this.constants.END_HOUR, hours));

        const wholeHours = Math.floor(hours);
        const minutes = Math.round((hours % 1) * 60);
        return `${String(wholeHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    },

    calculateDuration(startTime, endTime) {
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        let startMin = sh * 60 + sm;
        let endMin = eh * 60 + em;
        if (endMin < startMin) endMin += 24 * 60;
        return (endMin - startMin) / 60;
    }
};
