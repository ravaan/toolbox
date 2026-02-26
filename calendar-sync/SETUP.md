# Calendar Sync v3.0 — Setup & Deployment Checklist

## Status: NOT YET DEPLOYED

All code is written. Follow this checklist step-by-step to go live.
Check off each step as you complete it.

---

## Step 1: Local clasp Setup

```bash
# Install clasp globally
npm install -g @google/clasp

# Enable the Apps Script API (opens browser)
# Go to: https://script.google.com/home/usersettings
# Toggle "Google Apps Script API" → ON
```

## Step 2: Get Your Script ID

1. Open your Apps Script project at https://script.google.com
2. Click the **gear icon** (Project Settings) in the left sidebar
3. Copy the **Script ID** (long alphanumeric string)
4. Edit `calendar-sync/.clasp.json` — replace `YOUR_APPS_SCRIPT_PROJECT_ID_HERE` with your Script ID

## Step 3: Login to clasp

```bash
clasp login
# This opens a browser for Google authentication
# After login, it creates ~/.clasprc.json with your tokens
```

## Step 4: GCP Setup (CRITICAL)

### 4a: Set OAuth consent screen to Production
1. Go to https://console.cloud.google.com/apis/credentials/consent
2. Select the GCP project linked to your Apps Script project
3. If publishing status is "Testing" → click **PUBLISH APP**
4. **Why:** Testing mode tokens expire in 7 days, breaking CI/CD

### 4b: Enable Google Calendar API
1. Go to https://console.cloud.google.com/apis/library
2. Search for **Google Calendar API**
3. Click **Enable**

## Step 5: First Push (Test Locally)

```bash
cd calendar-sync/

# Verify connection
clasp status

# Push all files to Apps Script (REPLACES everything in the cloud project)
clasp push --force
```

After pushing:
1. Open the Apps Script editor in your browser
2. Verify all files appear: config.gs, sync.gs, helpers.gs, reverse-sync.gs, booking.gs, booking.html
3. Check that appsscript.json shows Calendar API v3 under Services

## Step 6: Migration (One-Time)

In the Apps Script editor, run these manually:

```javascript
// 1. Purge old events from Destination 1 (dry-run first)
purgeFutureEvents({ destIndex: 0, deleteFlag: false });
// Review the output, then:
purgeFutureEvents({ destIndex: 0, deleteFlag: true, clearTokens: true });

// 2. Purge old events from Destination 2
purgeFutureEvents({ destIndex: 1, deleteFlag: false });
purgeFutureEvents({ destIndex: 1, deleteFlag: true, clearTokens: true });

// 3. Run the new sync with logging
runAllSyncs({ enableLogging: true });
```

## Step 7: Verify

Check in Google Calendar:
- [ ] Events appear on Personal Aggregate calendar
- [ ] Events have correct colors per source
- [ ] Events have titles like "Busy - Meeting Name" or "Busy (Roqit)"
- [ ] No duplicates for the same meeting across sources
- [ ] Manual events on aggregate are NOT deleted

## Step 8: Update the Trigger

1. In Apps Script editor → **Triggers** (clock icon)
2. Delete the old trigger that calls `syncBusyCalendars`
3. Create a new trigger:
   - Function: `runAllSyncs`
   - Event source: Time-driven
   - Type: Minutes timer
   - Interval: Every 1 minute

## Step 9: Test Reverse Sync

1. Create a manual "Block" event on your Personal Aggregate calendar
2. Wait ~1 minute for the trigger to fire
3. Check your personal gmail calendar and studio calendar → a "Busy" block should appear
4. Delete the block from the aggregate → wait 1 min → it should disappear from sources

## Step 10: Deploy Booking Page (Optional)

1. In Apps Script editor → **Deploy** → **New deployment**
2. Type: **Web app**
3. Execute as: **Me**
4. Who has access: **Anyone with Google Account**
5. Click **Deploy**
6. Copy the web app URL
7. Test: open the URL, see available slots, book a test meeting
8. Note the Deployment ID for CI/CD (from `clasp deployments`)

## Step 11: Set Up GitHub Actions (Optional)

### 11a: Get secrets from clasp credentials
Open `~/.clasprc.json` (Windows: `C:\Users\simon\.clasprc.json`) and extract:
- `token.refresh_token` → GitHub secret `CLASP_REFRESH_TOKEN`
- `oauth2ClientSettings.clientId` → GitHub secret `CLASP_CLIENT_ID`
- `oauth2ClientSettings.clientSecret` → GitHub secret `CLASP_CLIENT_SECRET`
- Deployment ID from Step 10 → GitHub secret `CLASP_DEPLOYMENT_ID`

### 11b: Store secrets in GitHub
Go to https://github.com/YOUR_USER/toolbox/settings/secrets/actions
Add each of the 4 secrets above.

### 11c: Enable the workflow
Edit `.github/workflows/deploy-calendar-sync.yml`:
- Uncomment the `push` trigger
- Remove or comment out the `workflow_dispatch` line
- Commit and push

### 11d: Test the pipeline
Make a small edit to any file in `calendar-sync/`, push to master, and check GitHub Actions.

---

## Rollback Plan

If anything goes wrong after deploying v3.0:

1. Open Apps Script editor
2. Paste the contents of `calendar-sync.gs` (the old file in repo root) into Code.gs
3. Delete all the new files from the project
4. The old trigger still calls `syncBusyCalendars` which exists in the old code
5. Everything reverts to v2.4 behavior

The old `calendar-sync.gs` file is preserved in the repo root. Do NOT delete it until v3.0 is verified working for at least 24 hours.
