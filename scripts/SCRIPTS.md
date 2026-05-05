# Scripts

Utility scripts for managing Firestore data and Firebase Auth users locally.

All scripts require `backend/serviceAccountKey.json`. See the README for setup instructions.

Install dependencies from the project root before running any script:

```bash
npm install
```

---

## Users

### `createAdminUser.ts`

Creates a single admin user in Firebase Auth and Firestore.

- Email: `admin@spingroup.global`
- Password: `123456789`
- Role: `admin`

```bash
npm run create-admin
```

---

### `seedReporterUsers.ts`

Interactively creates multiple reporter users in Firebase Auth and Firestore.

- Prompts for how many users to create
- Email format: `reporter.<random>@spingroup.global`
- Password: `123456789`
- Role: `reporter`

```bash
npm run seed:reporters
```

---

### `backfillAssignedToName.mjs`

Backfills `assigned_to_name` on existing tickets using the assigned admin's user profile.

Useful after introducing reporter-safe assignee display without requiring reporters
to read the `users` collection directly.

```bash
npm run backfill:assignee-name
```

---

### `seedTickets.ts`

Interactively seeds N tickets spread randomly across the last 30 days. ~70% created by reporter, ~30% by admin.

Useful for testing dashboards and charts that rely on historical data.

Each ticket includes subcollections: `audit`, `attachments`, `actions`, `comments`.

```bash
npm run seed
```

---

### `clearTickets.ts`

Deletes **all** tickets and their subcollections from Firestore.

> Warning: this is irreversible. Use only in local/dev environments.

```bash
npm run clear:tickets
```

---

## Troubleshooting

### `serviceAccountKey.json` not found

```
Error: ENOENT: no such file or directory
```

Fix: ensure `backend/serviceAccountKey.json` exists and is a valid Firebase Admin SDK key.

### Permission denied

```
Error: insufficient permissions
```

Fix: verify Firestore security rules allow writes for the target collection.

### Firebase init failed

```
Error: Failed to initialize Firebase
```

Fix: check network connectivity, validate `serviceAccountKey.json`, and verify Firebase project status.
