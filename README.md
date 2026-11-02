# IT Desk — Helpdesk & Asset Management

> A serverless internal IT helpdesk built on **Google Apps Script + Google Sheets**.
> Employees report faults and track tickets; IT Support triages, assigns technicians, records resolutions, and maintains the company asset register.

**Tech Stack:** Google Apps Script (V8) · Google Sheets (Datastore) · `CacheService` (Sessions) · Vanilla HTML/CSS/JS · Playwright (Testing)

## What this demonstrates

This project was built to solve a real business need using zero-cost, serverless infrastructure. It demonstrates several key engineering concepts:

- **Server-side authorization:** The browser is never trusted. Every browser-callable function starts with `requireUser_(token)` and re-validates the user's role and active status against the database on *every single call*.
- **Concurrency & Locking:** `LockService` wraps all write operations (ticket creation, updates, asset management) to prevent race conditions and duplicate ID generation.
- **Injection Defense:** Spreadsheet formula injection (`=cmd...`) is prevented by forcing text-only column formats on write. Reflected XSS is prevented by escaping all user-generated output in the browser.
- **Enforced State Machine:** The ticket lifecycle is strictly enforced (e.g., a ticket cannot be marked "Resolved" without a resolution note; employee replies automatically re-open "Waiting for Employee" tickets).
- **Automated Testing:** The backend and UI are tested against an Apps Script emulator using Playwright.

## Workflow

- **Employee:** Registers → signs in → reports a fault → tracks the complaint → receives the resolution. The "My Equipment" page lists what IT has assigned to them and allows reporting faults directly from a specific item.
- **IT Support:** Signs in → views complaints → assigns a technician → updates status → records the resolution → manages the company asset register.

---

## Setup (about 10 minutes)

### 1. Create the database sheet
1. Create a new blank Google Spreadsheet and keep it **private**.
2. Copy its ID from the URL (the long value between `/d/` and `/edit`).
3. In that spreadsheet open **Extensions → Apps Script**.
4. **Project Settings → Script Properties → Add property**: `DATABASE_ID` = your spreadsheet ID.

### 2. Add the files
1. Replace the contents of `Code.gs` with the supplied `Code.gs`.
2. Add an HTML file named `Index` and paste in `Index.html`.
3. Project Settings → tick **Show "appsscript.json" manifest file**, and paste in the supplied `appsscript.json` (sets timezone Africa/Lagos and web-app access).

### 3. Create the tabs
Select `setupDatabase` in the function dropdown → **Run** → approve the permissions. Check the sheet now has Users, Departments, Assets, Tickets, TicketUpdates tabs.

### 4. Create the first IT administrator
1. Project Settings → Script Properties → add three properties:
   `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (12+ characters).
2. Select `createInitialAdmin` → **Run**.
3. `ADMIN_PASSWORD` is deleted automatically. Repeat with new values to add more IT staff.

### 5. Deploy
**Deploy → New deployment → Web app** · Execute as: **Me** · Who has access: **Anyone** → Deploy → authorise. Share only the web-app URL.

> **Updating later:** after pasting new code you must use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Saving alone does not change the live app.

---

## Managing Accounts (run from the Apps Script editor)

| Task | Set in Script Properties | Then run |
|---|---|---|
| Make an existing employee IT Support | `PROMOTE_EMAIL` | `promoteToAdmin` |
| Disable / re-enable / change an account | `USER_EMAIL` and `USER_ACCESS` (`disabled`, `enabled`, `employee`, `admin`) | `setUserAccess` |

Both clear their properties after running. The last active administrator cannot be removed. Role and disabled-account changes take effect on the user's very next click (sessions re-check the sheet every call).

**Assigning equipment:** In the *Asset Register*, set "Assigned employee email" to the employee's sign-in email. The item then appears in their *My Equipment* page. (You can assign before the employee registers.)

---

## How Permissions Work

- Employees can only read and write **their own** tickets, and only see equipment assigned to **their own** email (no internal notes, no one else's data).
- Only IT Support can update tickets, assign technicians, record resolutions, and add or edit assets. This is enforced on the server in `Code.gs`, not just hidden in the menu.
- A technician can only be chosen from active IT Support accounts.
- A ticket cannot be Resolved/Closed without a resolution; closed tickets reject further employee messages.
- Five wrong passwords lock that email for 15 minutes.
- Text typed by users is stored as plain text in the sheet (it cannot become a spreadsheet formula) and is escaped on screen.

## Architecture Overview

```text
Browser (Index.html)
     │  google.script.run
     ▼
Code.gs  ── requireUser_(token) → CacheService session validation
         ── role check → isAdmin_
         ── LockService.getScriptLock() → prevents concurrent write collisions
         ── readObjects_ / appendObject_ / setFields_
     ▼
Google Sheet (Users · Departments · Assets · Tickets · TicketUpdates)
