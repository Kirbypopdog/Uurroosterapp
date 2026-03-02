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

        // Attach event listeners using event delegation
        timeline.addEventListener('mousedown', this._boundMouseDown);
        document.addEventListener('mousemove', this._boundMouseMove);
        document.addEventListener('mouseup', this._boundMouseUp);
        document.addEventListener('keydown', this._boundKeyDown);

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
                const shift = getShift(this.state.dragShiftId);
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
                // Click on shift block - open edit modal
                openEditShiftModal(this.state.shiftId);
            }
        } else if (this.state.isDragging) {
            // Complete drag operation
            if (this.state.dragType === 'transfer') {
                this.completeTransferDrag(e);
            } else if (this.state.dragType === 'resize-start' || this.state.dragType === 'resize-end') {
                this.completeResizeDrag(e);
            }
        }

        // Reset state
        this.reset();
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
        const dayCell = this.getDayCellFromPoint(e.clientX, e.clientY);

        if (!dayCell) {
            console.log('[DragHandler] Invalid drop target - cancelling');
            showToast('Ongeldige locatie. Sleep de shift naar een dag in de planner.', 'warning');
            this.cancelDrag();
            return;
        }

        if (dayCell.classList.contains('closed')) {
            console.log('[DragHandler] Drop target is closed day');
            showToast('Deze dag is gesloten. Je kunt hier geen shift toewijzen.', 'warning');
            this.cancelDrag();
            return;
        }

        // Get target employee and date
        const targetEmployee = this.getEmployeeFromRow(dayCell);
        const targetDate = this.getDateFromCell(dayCell);

        if (!targetEmployee || !targetDate) {
            console.log('[DragHandler] Could not determine target employee/date');
            showToast('Kon de medewerker of datum niet bepalen. Probeer opnieuw.', 'warning');
            this.cancelDrag();
            return;
        }

        // Check team permissions for teamverantwoordelijke
        const role = getEffectiveRole();
        if (role === 'teamverantwoordelijke') {
            const userTeamId = AppState.currentUser.team_id;
            if (targetEmployee.mainTeam !== userTeamId) {
                console.log('[DragHandler] Teamverantwoordelijke cannot transfer to different team');
                showToast('Je kan alleen shifts toewijzen aan medewerkers van je eigen team', 'warning');
                this.cancelDrag();
                return;
            }
        }

        // Check if employee has availability/absence on this date
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
            console.log('[DragHandler] Employee has absence - cancelling');
            showToast(`${targetEmployee.name} ${reason} op ${targetDate}. Je kunt geen shift toewijzen als iemand afwezig is.`, 'warning');
            this.cancelDrag();
            return;
        }

        console.log(`[DragHandler] Transferring shift ${this.state.shiftId} to ${targetEmployee.name} on ${targetDate}`);

        // Update shift via API
        try {
            const shift = this.state.originalData;
            const originalEmployeeId = shift.employeeId;
            const originalDate = shift.date;

            // Update shift - mark as manual to prevent auto-schedule from replacing it
            await updateShift(this.state.shiftId, {
                employeeId: targetEmployee.id,
                date: targetDate,
                team: shift.team,
                startTime: shift.startTime,
                endTime: shift.endTime,
                notes: shift.notes || '',
                source: 'manual' // Mark as manual so it persists
            });

            // Create shift block for original employee to prevent auto-regeneration
            try {
                const token = sessionStorage.getItem('hetvlot_token');
                await fetch(`${window.API_BASE}/shift-blocks`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        user_id: originalEmployeeId,
                        date: originalDate,
                        reason: 'Shift transferred via drag & drop'
                    })
                });
                console.log(`[DragHandler] Created shift block for original employee ${originalEmployeeId} on ${originalDate}`);
            } catch (blockError) {
                console.warn('[DragHandler] Could not create shift block:', blockError);
                // Continue anyway - shift was already transferred
            }

            // Refresh view
            renderPlanning();

            // Show success message
            if (typeof showToast === 'function') {
                showToast(`Shift overgedragen aan ${targetEmployee.name}`, 'success');
            } else {
                alert(`Shift overgedragen aan ${targetEmployee.name}`);
            }
        } catch (error) {
            console.error('[DragHandler] Error transferring shift:', error);
            showToast(`Fout bij overdragen shift: ${error.message}`, 'error');
            this.cancelDrag();
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
        const dayCell = this.state.targetElement.parentElement;
        const rect = dayCell.getBoundingClientRect();
        const newTime = this.getTimeFromX(e.clientX, rect);

        if (!newTime) {
            this.cancelDrag();
            return;
        }

        const shift = this.state.originalData;
        let newStartTime = shift.startTime;
        let newEndTime = shift.endTime;

        if (this.state.dragType === 'resize-start') {
            newStartTime = newTime;
        } else {
            newEndTime = newTime;
        }

        // Validate duration (minimum 1 hour)
        const duration = this.calculateDuration(newStartTime, newEndTime);
        if (duration < 1) {
            showToast('Een shift moet minimaal 1 uur duren', 'warning');
            this.cancelDrag();
            return;
        }

        console.log(`[DragHandler] Resizing shift ${this.state.shiftId} to ${newStartTime} - ${newEndTime}`);

        // Update shift via API
        try {
            // Mark as manual so resized shifts persist across auto-schedule regeneration
            await updateShift(this.state.shiftId, {
                employeeId: shift.employeeId,
                date: shift.date,
                team: shift.team,
                startTime: newStartTime,
                endTime: newEndTime,
                notes: shift.notes || '',
                source: 'manual' // Mark as manual so it persists
            });

            // Refresh view
            renderPlanning();

            // Show success message
            if (typeof showToast === 'function') {
                showToast('Shift aangepast', 'success');
            }
        } catch (error) {
            console.error('[DragHandler] Error resizing shift:', error);
            showToast(`Fout bij aanpassen shift: ${error.message}`, 'error');
            this.cancelDrag();
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
        const userTeamId = AppState.currentUser.team_id;

        if (role === 'medewerker') {
            // Medewerkers can only create shifts for themselves
            if (employee.id !== AppState.currentUser.id) {
                showToast('Je kan alleen shifts voor jezelf aanmaken', 'warning');
                return;
            }
        } else if (role === 'teamverantwoordelijke') {
            // Teamverantwoordelijke can only create for own team
            if (employee.mainTeam !== userTeamId) {
                showToast('Je kan alleen shifts aanmaken voor je eigen team', 'warning');
                return;
            }
        }

        // Get default times from employee's week schedule for this day
        const dayOfWeek = new Date(date).getDay();
        const weekNumber = getWeekNumber(new Date(date));
        const schedule = employee[`weekScheduleWeek${weekNumber}`] || [];
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
        document.querySelectorAll('.drop-target-valid, .drop-target-invalid').forEach(cell => {
            cell.classList.remove('drop-target-valid', 'drop-target-invalid');
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

        // Check if employee has availability/absence on this date
        const availability = getAvailability(targetEmployee.id, targetDate);
        if (availability && availability.type) {
            // Employee is absent - invalid target
            return false;
        }

        // Run validation for shift with new employee
        const shift = this.state.originalData;
        const testShift = {
            ...shift,
            employeeId: targetEmployee.id,
            date: targetDate
        };

        const validation = validateShift(testShift, shift.id);

        // Allow drop if valid OR only warnings (not errors)
        return validation.isValid || (!validation.isValid && validation.errors.length === 0);
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
