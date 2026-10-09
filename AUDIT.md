# CampusFlow — audit status

Current as of the latest commit on `arena/928184cc-test-one-time-table-app`.
"Proven" means a test in `tests/` or a direct check ran here. "Needs you" means it
requires a console action, a deploy, or a real browser.

## Status of each finding

| # | Finding | Status | Proof / what is left |
|---|---------|--------|----------------------|
| 1 | Relief and Find read the wrong school day (UTC vs local midnight) | Fixed | One `schoolDayKey()` rule (Asia/Colombo) in app, attendance and server. Proven: 4 date checks. |
| 2 | Clock-ins could be forged from the browser | Fixed in rules | `attendance/…/byMember/$uid` is now read-only for clients; only Cloud Functions write clock-ins. Proven from the rules file. Not run on the Firebase emulator. |
| 3 | Device endpoint trusted the client | Fixed | Keys stored as SHA-256 only; old plain-text keys migrate on first use; server time decides the clock-in; 60 pushes/minute per device. Proven: rules and code reviewed. Not called live. |
| 4 | Super-admin UID and personal email hard-coded | **Open** (not in this round) | Replace with a custom claim set by the Admin SDK. |
| 5 | A principal could demote another principal | Fixed in rules | Proven from the rules file. |
| 6 | No App Check | Wired in, **off** | Needs you: create a reCAPTCHA v3 site key in Firebase console → App Check, paste it into `APP_CHECK_SITE_KEY` in `app.js`, register the web app, then deploy functions with `ENFORCE_APP_CHECK=true`. Until then nothing changes. |
| 8 | Public phone number could be overridden by saved settings | Fixed | 072 399 3300 / WhatsApp 94723993300 are fixed in code; the form shows them read-only. Proven: 3 checks. |
| 10 | Find bar problems | **Need details** | Could not reproduce. Search handles awkward inputs (proven); the fault is probably layout or focus. |
| 11 | Scanned PDFs | Partly proven | A PDF with no text now gives a clear message (proven with a real fixture). The OCR reading of pictures is untested here (needs a browser). |
| 12 | Phone layout | **Needs you** | Run `tests/phone-layout.mjs` on your computer (instructions at the top of the file). The sandbox cannot download a browser. |
| 13 | This file was stale | Fixed | This file. |
| 14 | No automated tests on push | Fixed | `.github/workflows/tests.yml` runs `tests/e2e.js` on every push and pull request. |

## Deploy checklist (nothing here is live until you do this)

1. `firebase deploy --only database,functions` from the repo root. This publishes the
   rules (items 2, 5) and the functions (items 3, and the "last seen" column).
2. Host the web app from `main` once the branch is merged (you handle `main`).
3. Existing fingerprint-machine keys keep working; they are converted to hashed storage the first time they are used.
4. Revoke the Gemini key that was pasted into chat earlier, if that has not been done.

## Known limits that remain by design

- **Manual clock-in (`clockManual`)** lets a staff member record their own presence without a
  fingerprint. It is now recorded as `manual` by the server, so it is visible, but it is not proof.
- **Device replay:** a captured device request can be sent again within the rate limit. A stronger
  fix needs a per-request nonce from the device.
- **Offline device queue:** device-reported times are only kept for reference. Clock-ins are
  stamped when the server receives them.
- **Client-side role checks** (`canViewUsers`, `canReadDayAttendance`, etc.) only control what is
  shown. The database rules and Cloud Functions are the real protection.
