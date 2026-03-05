#!/usr/bin/env python3
"""
Fase 3 Backend Integration Tests
=================================
Tests the 4 backend features from Fase 3 against a running server on http://localhost:3001.

Usage:
    python3 test_fase3.py

Requirements:
    pip install requests
"""

import requests
import time
import sys
import traceback

BASE_URL = "http://localhost:3001"
ADMIN_EMAIL = "admin@hetvlot.be"
ADMIN_PASSWORD = "VlotAdmin2025!"
TEST_TEAM = "vlot1"  # Must exist in the teams table

# Unique suffix to avoid email collisions across runs
TS = str(int(time.time()))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

results = []


def record(test_name, passed, detail=""):
    status = "PASS" if passed else "FAIL"
    results.append((test_name, passed))
    msg = f"  [{status}] {test_name}"
    if detail:
        msg += f"  -- {detail}"
    print(msg)


def auth_header(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def check_response(r, context=""):
    """Check response for common errors and raise with helpful messages."""
    if r.status_code == 404:
        body = ""
        try:
            body = r.text[:200]
        except Exception:
            pass
        raise RuntimeError(
            f"404 Not Found: endpoint does not exist on the server. "
            f"Is Fase 3 deployed? URL: {r.url}  Body: {body}"
        )
    r.raise_for_status()


def admin_login():
    """Login as admin and return (token, user_id)."""
    r = requests.post(f"{BASE_URL}/auth/login", json={
        "email": ADMIN_EMAIL,
        "password": ADMIN_PASSWORD
    })
    r.raise_for_status()
    data = r.json()
    return data["token"], data["user"]["id"]


def register_user(name, email, password="Test1234!"):
    """Register a new user and return (user, token)."""
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "name": name,
        "email": email,
        "password": password
    })
    r.raise_for_status()
    data = r.json()
    return data["user"], data["token"]


def set_user_team(admin_token, user_id, name, email, team=TEST_TEAM):
    """Set the main_team (and team_id) for a user via PUT /users/:id.
    Email must be included to avoid setting it to NULL (violates NOT NULL constraint)."""
    r = requests.put(f"{BASE_URL}/users/{user_id}", json={
        "name": name,
        "email": email,
        "mainTeam": team,
        "extraTeams": [],
        "contractHours": 0,
        "active": True
    }, headers=auth_header(admin_token))
    r.raise_for_status()
    return r.json()


def delete_user(admin_token, user_id):
    """Delete a user via admin endpoint."""
    r = requests.delete(f"{BASE_URL}/admin/users/{user_id}",
                        headers=auth_header(admin_token))
    return r


def login_as(email, password="Test1234!"):
    """Login as a specific user and return token."""
    r = requests.post(f"{BASE_URL}/auth/login", json={
        "email": email,
        "password": password
    })
    r.raise_for_status()
    return r.json()["token"]


def delete_draft(admin_token, draft_id):
    """Delete a schedule draft."""
    r = requests.delete(f"{BASE_URL}/schedule-drafts/{draft_id}",
                        headers=auth_header(admin_token))
    return r


# ---------------------------------------------------------------------------
# Test 3C - User delete transaction (cascade)
# ---------------------------------------------------------------------------

def test_3c_user_delete_cascade():
    print("\n=== Test 3C: User delete transaction (cascade) ===")
    admin_token, admin_id = admin_login()
    headers = auth_header(admin_token)
    email = f"test3c_{TS}@hetvlot.test"
    user_id = None

    try:
        # 1. Create a test user
        user, _ = register_user(f"Test3C {TS}", email)
        user_id = user["id"]
        set_user_team(admin_token, user_id, f"Test3C {TS}", email)
        record("3C.1 Create test user", True, f"id={user_id}")

        # 2. Create a shift for that user
        r = requests.post(f"{BASE_URL}/shifts", json={
            "userId": user_id,
            "team": TEST_TEAM,
            "date": "2026-06-01",
            "startTime": "09:00",
            "endTime": "17:00"
        }, headers=headers)
        check_response(r, "POST /shifts")
        shift_id = r.json()["shift"]["id"]
        record("3C.2 Create shift", True, f"shift_id={shift_id}")

        # 3. Create availability for that user
        r = requests.post(f"{BASE_URL}/availability", json={
            "userId": user_id,
            "date": "2026-06-01",
            "type": "verlof",
            "reason": "Test 3C"
        }, headers=headers)
        check_response(r, "POST /availability")
        record("3C.3 Create availability", True)

        # 4. Delete the user
        r = delete_user(admin_token, user_id)
        check_response(r, "DELETE /admin/users/:id")
        ok = r.json().get("ok", False)
        record("3C.4 Delete user", ok, f"response={r.json()}")

        # 5. Verify user is gone from GET /users
        r = requests.get(f"{BASE_URL}/users", headers=headers)
        check_response(r, "GET /users")
        users = r.json()["users"]
        user_ids = [u["id"] for u in users]
        user_gone = user_id not in user_ids
        record("3C.5 User gone from /users", user_gone,
               f"deleted user_id={user_id} in list: {user_id in user_ids}")

        # 6. Verify shifts are cascaded (no shifts for deleted user on that date)
        r = requests.get(f"{BASE_URL}/shifts",
                         params={"startDate": "2026-06-01", "endDate": "2026-06-01"},
                         headers=headers)
        check_response(r, "GET /shifts")
        shifts = r.json()["shifts"]
        user_shifts = [s for s in shifts if s["userId"] == user_id]
        shifts_gone = len(user_shifts) == 0
        record("3C.6 Shifts cascaded on delete", shifts_gone,
               f"remaining shifts for user: {len(user_shifts)}")

        # User already deleted, no cleanup needed
        user_id = None

    except Exception as e:
        record("3C UNEXPECTED ERROR", False, f"{type(e).__name__}: {e}")
        traceback.print_exc()

    finally:
        # Cleanup: if user still exists (test failed before delete), try to remove
        if user_id is not None:
            try:
                delete_user(admin_token, user_id)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Test 3D - Swap reject with FOR UPDATE
# ---------------------------------------------------------------------------

def test_3d_swap_reject_for_update():
    print("\n=== Test 3D: Swap reject with FOR UPDATE ===")
    admin_token, admin_id = admin_login()
    headers = auth_header(admin_token)
    email_a = f"test3d_a_{TS}@hetvlot.test"
    email_b = f"test3d_b_{TS}@hetvlot.test"
    user_a_id = None
    user_b_id = None

    try:
        # 1. Create 2 test users
        user_a, _ = register_user(f"Test3D-A {TS}", email_a)
        user_a_id = user_a["id"]
        set_user_team(admin_token, user_a_id, f"Test3D-A {TS}", email_a)

        user_b, _ = register_user(f"Test3D-B {TS}", email_b)
        user_b_id = user_b["id"]
        set_user_team(admin_token, user_b_id, f"Test3D-B {TS}", email_b)
        record("3D.1 Create 2 test users", True,
               f"userA={user_a_id}, userB={user_b_id}")

        # 2. Create a shift for each user (future dates)
        r = requests.post(f"{BASE_URL}/shifts", json={
            "userId": user_a_id,
            "team": TEST_TEAM,
            "date": "2026-07-01",
            "startTime": "09:00",
            "endTime": "17:00"
        }, headers=headers)
        check_response(r, "POST /shifts for userA")
        shift_a_id = r.json()["shift"]["id"]

        r = requests.post(f"{BASE_URL}/shifts", json={
            "userId": user_b_id,
            "team": TEST_TEAM,
            "date": "2026-07-02",
            "startTime": "09:00",
            "endTime": "17:00"
        }, headers=headers)
        check_response(r, "POST /shifts for userB")
        shift_b_id = r.json()["shift"]["id"]
        record("3D.2 Create shifts", True,
               f"shiftA={shift_a_id}, shiftB={shift_b_id}")

        # 3. Login as userA (swap requester must own the requester shift)
        token_a = login_as(email_a)

        r = requests.post(f"{BASE_URL}/swap-requests", json={
            "requesterShiftId": shift_a_id,
            "targetShiftId": shift_b_id,
            "message": "Test 3D swap"
        }, headers=auth_header(token_a))
        check_response(r, "POST /swap-requests")
        swap_request = r.json()["swapRequest"]
        swap_id = swap_request["id"]
        record("3D.3 Create swap request", True, f"swap_id={swap_id}")

        # 4. Get swap request from list (admin view)
        r = requests.get(f"{BASE_URL}/swap-requests", headers=headers)
        check_response(r, "GET /swap-requests")
        all_swaps = r.json()["swapRequests"]
        found = any(s["id"] == swap_id for s in all_swaps)
        record("3D.4 Swap visible in GET /swap-requests", found,
               f"total swaps={len(all_swaps)}")

        # 5. Reject the swap (as admin/lead)
        r = requests.put(f"{BASE_URL}/swap-requests/{swap_id}/reject", json={
            "responseNotes": "Test rejection"
        }, headers=headers)
        check_response(r, "PUT /swap-requests/:id/reject")
        reject_ok = r.json().get("ok", False)
        record("3D.5 Reject swap", reject_ok, f"response={r.json()}")

        # 6. Verify status is 'rejected' by checking the swap list
        r = requests.get(f"{BASE_URL}/swap-requests", headers=headers)
        check_response(r, "GET /swap-requests")
        all_swaps = r.json()["swapRequests"]
        swap_entry = next((s for s in all_swaps if s["id"] == swap_id), None)
        status_rejected = swap_entry is not None and swap_entry.get("status") == "rejected"
        record("3D.6 Status is 'rejected'", status_rejected,
               f"status={swap_entry.get('status') if swap_entry else 'NOT FOUND'}")

        # 7. Try to approve the same (already rejected) swap -> should fail
        r = requests.put(f"{BASE_URL}/swap-requests/{swap_id}/approve", json={
            "responseNotes": "Trying to approve rejected"
        }, headers=headers)
        # Should get 400 with "Swap request is al verwerkt"
        approve_blocked = r.status_code == 400
        error_msg = r.json().get("error", "")
        has_correct_msg = "al verwerkt" in error_msg
        record("3D.7 Approve after reject blocked", approve_blocked and has_correct_msg,
               f"status={r.status_code}, error='{error_msg}'")

    except Exception as e:
        record("3D UNEXPECTED ERROR", False, f"{type(e).__name__}: {e}")
        traceback.print_exc()

    finally:
        # 8. Clean up: delete both test users
        cleanup_ok = True
        for uid, label in [(user_a_id, "userA"), (user_b_id, "userB")]:
            if uid is not None:
                try:
                    r = delete_user(admin_token, uid)
                    if r.status_code != 200:
                        cleanup_ok = False
                except Exception:
                    cleanup_ok = False
        record("3D.8 Cleanup test users", cleanup_ok)


# ---------------------------------------------------------------------------
# Test 3A - Sick leave with auto-takeover
# ---------------------------------------------------------------------------

def test_3a_sick_with_takeover():
    print("\n=== Test 3A: Sick leave with auto-takeover ===")
    admin_token, admin_id = admin_login()
    headers = auth_header(admin_token)
    email = f"test3a_{TS}@hetvlot.test"
    user_id = None

    try:
        # 1. Create a test user
        user, _ = register_user(f"Test3A {TS}", email)
        user_id = user["id"]
        set_user_team(admin_token, user_id, f"Test3A {TS}", email)
        record("3A.1 Create test user", True, f"id={user_id}")

        # 2. Create 3 shifts on future dates
        shift_ids = []
        for date in ["2026-08-03", "2026-08-04", "2026-08-05"]:
            r = requests.post(f"{BASE_URL}/shifts", json={
                "userId": user_id,
                "team": TEST_TEAM,
                "date": date,
                "startTime": "09:00",
                "endTime": "17:00"
            }, headers=headers)
            check_response(r, f"POST /shifts for {date}")
            shift_ids.append(r.json()["shift"]["id"])
        record("3A.2 Create 3 shifts", True, f"shift_ids={shift_ids}")

        # 3. Call POST /availability/sick-with-takeover
        r = requests.post(f"{BASE_URL}/availability/sick-with-takeover", json={
            "userId": user_id,
            "startDate": "2026-08-03",
            "endDate": "2026-08-05",
            "type": "ziek",
            "reason": "Test sick leave",
            "createTakeoverRequests": True
        }, headers=headers)
        check_response(r, "POST /availability/sick-with-takeover")
        resp = r.json()

        avail_count = len(resp.get("availability", []))
        takeover_count = resp.get("takeoverRequests", 0)
        conflict_count = resp.get("conflictingShifts", 0)

        avail_ok = avail_count == 3
        takeover_ok = takeover_count >= 1
        conflict_ok = conflict_count == 3

        record("3A.3 Sick-with-takeover response", avail_ok and takeover_ok and conflict_ok,
               f"availability={avail_count}, takeoverRequests={takeover_count}, conflictingShifts={conflict_count}")

        # 4. Verify availability exists
        r = requests.get(f"{BASE_URL}/availability",
                         params={"startDate": "2026-08-03", "endDate": "2026-08-05",
                                 "userId": user_id},
                         headers=headers)
        check_response(r, "GET /availability")
        avail_entries = r.json()["availability"]
        user_avail = [a for a in avail_entries if a["userId"] == user_id]
        record("3A.4 Availability entries exist", len(user_avail) == 3,
               f"found {len(user_avail)} entries for user")

        # 5. Verify takeover requests exist in swap-requests
        r = requests.get(f"{BASE_URL}/swap-requests", headers=headers)
        check_response(r, "GET /swap-requests")
        all_swaps = r.json()["swapRequests"]
        takeover_reqs = [s for s in all_swaps
                         if s.get("request_type") == "takeover"
                         and s.get("requester_user_id") == user_id
                         and s.get("requester_shift_id") in shift_ids]
        record("3A.5 Takeover requests in swap-requests", len(takeover_reqs) >= 1,
               f"found {len(takeover_reqs)} takeover requests for user's shifts")

    except Exception as e:
        record("3A UNEXPECTED ERROR", False, f"{type(e).__name__}: {e}")
        traceback.print_exc()

    finally:
        # Cleanup
        if user_id is not None:
            try:
                delete_user(admin_token, user_id)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Test 3B - Draft apply (atomic)
# ---------------------------------------------------------------------------

def test_3b_draft_apply_atomic():
    print("\n=== Test 3B: Draft apply (atomic) ===")
    admin_token, admin_id = admin_login()
    headers = auth_header(admin_token)
    email_a = f"test3b_a_{TS}@hetvlot.test"
    email_b = f"test3b_b_{TS}@hetvlot.test"
    user_a_id = None
    user_b_id = None
    draft_id = f"test_draft_{TS}"

    try:
        # 1. Create 2 test users
        user_a, _ = register_user(f"Test3B-A {TS}", email_a)
        user_a_id = user_a["id"]
        set_user_team(admin_token, user_a_id, f"Test3B-A {TS}", email_a)

        user_b, _ = register_user(f"Test3B-B {TS}", email_b)
        user_b_id = user_b["id"]
        set_user_team(admin_token, user_b_id, f"Test3B-B {TS}", email_b)
        record("3B.1 Create 2 test users", True,
               f"empA={user_a_id}, empB={user_b_id}")

        # 2. Create a schedule draft with grid for both users
        #    Grid keys are employee IDs (as strings), values are dayIndex -> assignment
        #    dayIndex 0 = Monday, 1 = Tuesday, ... 6 = Sunday
        grid = {
            str(user_a_id): {
                "0": {"startTime": "09:00", "endTime": "17:00"}
            },
            str(user_b_id): {
                "0": {"startTime": "10:00", "endTime": "18:00"}
            }
        }

        r = requests.post(f"{BASE_URL}/schedule-drafts", json={
            "id": draft_id,
            "name": f"Test Draft {TS}",
            "weekNumber": 1,
            "teamFilter": None,
            "grid": grid
        }, headers=headers)
        check_response(r, "POST /schedule-drafts")
        created_draft = r.json()["draft"]
        record("3B.2 Create schedule draft", True,
               f"draft_id={created_draft['id']}")

        # 3. Apply the draft
        r = requests.post(f"{BASE_URL}/schedule-drafts/{draft_id}/apply", json={
            "clearBlocks": True
        }, headers=headers)
        check_response(r, "POST /schedule-drafts/:id/apply")
        apply_resp = r.json()
        applied = apply_resp.get("applied", 0)
        shifts_created = apply_resp.get("shifts", {}).get("created", -1)

        record("3B.3 Apply draft", applied == 2,
               f"applied={applied}, shifts.created={shifts_created}")

        # 4. Verify response structure
        has_applied = "applied" in apply_resp
        has_shifts = "shifts" in apply_resp and "created" in apply_resp.get("shifts", {})
        record("3B.4 Response structure", has_applied and has_shifts,
               f"keys={list(apply_resp.keys())}")

        # 5. Verify users have updated weekSchedules
        r = requests.get(f"{BASE_URL}/users", headers=headers)
        check_response(r, "GET /users")
        all_users = r.json()["users"]

        emp_a = next((u for u in all_users if u["id"] == user_a_id), None)
        emp_b = next((u for u in all_users if u["id"] == user_b_id), None)

        a_has_schedule = False
        b_has_schedule = False

        if emp_a:
            ws = emp_a.get("weekSchedules") or emp_a.get("weekScheduleWeek1")
            if ws and isinstance(ws, list) and len(ws) > 0:
                week1 = ws[0]
                if isinstance(week1, list) and len(week1) > 0:
                    a_has_schedule = True
                elif isinstance(week1, dict):
                    a_has_schedule = True

        if emp_b:
            ws = emp_b.get("weekSchedules") or emp_b.get("weekScheduleWeek1")
            if ws and isinstance(ws, list) and len(ws) > 0:
                week1 = ws[0]
                if isinstance(week1, list) and len(week1) > 0:
                    b_has_schedule = True
                elif isinstance(week1, dict):
                    b_has_schedule = True

        record("3B.5 Users have updated weekSchedules",
               a_has_schedule and b_has_schedule,
               f"empA schedule: {emp_a.get('weekSchedules') if emp_a else 'NOT FOUND'}, "
               f"empB schedule: {emp_b.get('weekSchedules') if emp_b else 'NOT FOUND'}")

    except Exception as e:
        record("3B UNEXPECTED ERROR", False, f"{type(e).__name__}: {e}")
        traceback.print_exc()

    finally:
        # Cleanup: delete users and draft
        cleanup_ok = True
        for uid in [user_a_id, user_b_id]:
            if uid is not None:
                try:
                    r = delete_user(admin_token, uid)
                    if r.status_code != 200:
                        cleanup_ok = False
                except Exception:
                    cleanup_ok = False

        try:
            delete_draft(admin_token, draft_id)
        except Exception:
            pass

        record("3B.6 Cleanup", cleanup_ok)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("  Fase 3 Backend Integration Tests")
    print(f"  Server: {BASE_URL}")
    print(f"  Timestamp: {TS}")
    print("=" * 60)

    # Verify server is reachable
    try:
        r = requests.get(f"{BASE_URL}/auth/login", timeout=5)
    except requests.ConnectionError:
        print(f"\nFATAL: Cannot connect to {BASE_URL}")
        print("Make sure the backend is running: cd backend && npm run dev")
        sys.exit(1)

    # Verify admin login works
    try:
        admin_login()
        print("\nAdmin login OK\n")
    except Exception as e:
        print(f"\nFATAL: Admin login failed: {e}")
        sys.exit(1)

    # Run tests in order
    test_3c_user_delete_cascade()
    test_3d_swap_reject_for_update()
    test_3a_sick_with_takeover()
    test_3b_draft_apply_atomic()

    # Summary
    print("\n" + "=" * 60)
    print("  SUMMARY")
    print("=" * 60)
    passed = sum(1 for _, p in results if p)
    failed = sum(1 for _, p in results if not p)
    total = len(results)

    for name, p in results:
        status = "PASS" if p else "FAIL"
        print(f"  [{status}] {name}")

    print(f"\n  Total: {total}  |  Passed: {passed}  |  Failed: {failed}")
    print("=" * 60)

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
