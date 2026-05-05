# Cyber Incident Platform

Production-oriented incident intake and ticket workflow platform with:

- Frontend: React + TypeScript + Vite
- Backend: Flask API + AI-assisted conversation flow
- Data/Auth: Firebase (Firestore, Storage, Auth)

## Overview

This repository contains one deployable application (`Cyber/`) with three main parts:

- `frontend/`: user-facing web app, direct Firebase client operations, UI workflows
- `backend/`: secure server endpoints for AI conversation, validation, exports, and protected downloads
- `firebase/`: unified security rules source and deploy pipeline

## Repository Structure

```text
Cyber/
  backend/
    app.py
    requirements.txt
    .env.example
    backend_app/
      api/routes/
      ai/
      core/
      services/
      tests/
  frontend/
    package.json
    .env.example
    src/
      components/
      pages/
      services/
  firebase/
    security.rules.bundle
    generated/
    scripts/
    firebase.json
  scripts/
    SCRIPTS.md
  package.json
```

## Directory Responsibilities

### Root level

- `backend/`: Flask application, AI orchestration, and secure server endpoints.
- `frontend/`: React application for reporter/admin workflows and UI state management.
- `firebase/`: single-source Firebase rules workflow and generated deploy artifacts.
- `scripts/`: local utility scripts for user/ticket seeding and maintenance tasks.
- `package.json` (root): shared script entry points for Firebase rule build/deploy and data scripts.

### Backend breakdown

- `backend/app.py`: compatibility launcher that delegates to `backend_app.main`.
- `backend/backend_app/main.py`: app bootstrap, config validation, Firebase init, CORS, route registration.
- `backend/backend_app/api/routes/`: HTTP route modules (`conversation`, `tickets`, `attachments`, `admin_exports`).
- `backend/backend_app/ai/`: conversation state machine, extraction/classification, question generation, LLM calls.
- `backend/backend_app/services/`: Firestore/Firebase helpers, auth utilities, audit and storage access.
- `backend/backend_app/core/`: config, logging, and shared backend infrastructure helpers.
- `backend/backend_app/tests/`: backend unit/integration tests.

### Frontend breakdown

- `frontend/src/pages/`: route-level screens (reporter chat, admin views, ticket pages).
- `frontend/src/components/`: reusable UI components (chat, panel, inputs, tables, cards).
- `frontend/src/services/`: Firebase data access and API wrappers used by UI pages.
- `frontend/src/constants/`: schema enums and selectable option sources shared by forms/panels.
- `frontend/src/types/`: TypeScript domain and auth contracts.

### Firebase breakdown

- `firebase/security.rules.bundle`: single editable source for Firestore + Storage rules.
- `firebase/generated/`: generated split rule files used by Firebase CLI deploy.
- `firebase/scripts/`: tooling that compiles bundled rules into generated files.
- `firebase/firebase.json`: deploy target config for rules and emulators.

## What A Final README Should Always Contain

For release/readiness handoff, keep this README updated with:

1. Project purpose and architecture boundaries (frontend vs backend responsibilities).
2. Exact local setup prerequisites and versions.
3. Credential bootstrap instructions (`serviceAccountKey.json`, backend/frontend `.env`).
4. Source of each required secret/config value (where to retrieve it).
5. Run, test, and build commands.
6. Deployment/rules workflow references.
7. Security do/don't checklist for collaborators.

If any of the above changes, update this README in the same pull request.

## Prerequisites

- Node.js 18+
- npm 9+
- Python 3.10+
- Firebase project access (Auth + Firestore + Storage)

## Secure Configuration

Real credentials are intentionally not committed.

You must provide local values for:

- `backend/serviceAccountKey.json`
- `backend/.env`
- `frontend/.env`

### What You Need Before Starting

From your Firebase project owner/admin, request:

- A Firebase project with enabled Authentication, Firestore, and Storage
- Permission to create service account keys (or ask for a key file securely)
- Web app configuration values (the `VITE_FIREBASE_*` values)
- Backend AI provider key (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `GEMINI_API_KEY`)

If you do not have these values, the app will build but login, DB calls, and AI flow will fail.

### Create `backend/serviceAccountKey.json` (Where To Get It)

This file is a Firebase Admin SDK credential used by the Flask backend.

Steps in Firebase Console:

1. Open Firebase Console -> Project Settings.
2. Go to `Service accounts` tab.
3. Click `Generate new private key`.
4. Download the JSON file.
5. Save it as `backend/serviceAccountKey.json`.

Important:

- Do not rename fields inside the JSON.
- Do not commit this file to Git.
- If exposed, revoke/rotate key immediately in Google Cloud IAM.

Expected JSON shape:

```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",
  "client_email": "firebase-adminsdk-xxxx@your-project-id.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/..."
}
```

### Backend `.env`

Copy from `backend/.env.example` and fill values:

```env
FIREBASE_SERVICE_ACCOUNT=serviceAccountKey.json
MODEL_PROVIDER=openai

OPENAI_API_KEY=
DEEPSEEK_API_KEY=
GEMINI_API_KEY=

# Required model name (single variable for both extraction and assistant)
MODEL_NAME=

EXTRACTION_SPEED=fast

API_PORT=5000
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
FIREBASE_PROJECT_ID=
```

Where values come from:

- `FIREBASE_SERVICE_ACCOUNT`: relative path to the JSON file you created above (usually `serviceAccountKey.json`)
- `MODEL_PROVIDER`: choose one (`openai`, `deepseek`, `gemini`, `local`)
- `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY`: from your AI provider dashboard
- `MODEL_NAME`: the single model ID used by extraction and assistant generation
- `API_PORT`: local backend port (default `5000`)
- `ALLOWED_ORIGINS`: frontend origins allowed by CORS
- `FIREBASE_PROJECT_ID`: Firebase project ID (Project Settings -> General)

Notes:

- Set only the key that matches `MODEL_PROVIDER`.
- `FIREBASE_SERVICE_ACCOUNT` can be a relative path from `backend/`.
- Keep unused provider keys empty.
- You must set `MODEL_NAME` regardless of provider.
- Restart backend after editing `.env`.
- Backend loads `.env` with override mode, so values in `backend/.env` take precedence over same-name terminal/session env vars.

### Frontend `.env`

Copy from `frontend/.env.example`:

```env
VITE_API_URL=http://localhost:5000
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

Where values come from:

Firebase Console -> Project Settings -> General -> Your apps -> Web app config.

Map fields:

- `VITE_FIREBASE_API_KEY` -> `apiKey`
- `VITE_FIREBASE_AUTH_DOMAIN` -> `authDomain`
- `VITE_FIREBASE_PROJECT_ID` -> `projectId`
- `VITE_FIREBASE_STORAGE_BUCKET` -> `storageBucket`
- `VITE_FIREBASE_MESSAGING_SENDER_ID` -> `messagingSenderId`
- `VITE_FIREBASE_APP_ID` -> `appId`
- `VITE_API_URL` -> your local backend URL (normally `http://localhost:5000`)

### Minimal Example Files

`backend/.env` example:

```env
FIREBASE_SERVICE_ACCOUNT=serviceAccountKey.json
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=
GEMINI_API_KEY=

MODEL_NAME=gpt-5
EXTRACTION_SPEED=fast
EXTRACTION_FAST_MAX_TOKENS=220
AI_DEBUG=1
AI_TRACKER_VERBOSE=1

API_PORT=5000
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
FIREBASE_PROJECT_ID=your-project-id
```

`frontend/.env` example:

```env
VITE_API_URL=http://localhost:5000
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef123456
```

### Configuration Validation Checklist

Before starting development, verify:

1. `backend/serviceAccountKey.json` exists and is valid JSON.
2. `backend/.env` exists and points to the correct service account path.
3. `frontend/.env` exists and all `VITE_FIREBASE_*` values are non-empty.
4. Backend health endpoint returns status JSON:

```bash
curl http://localhost:5000/api/health
```

5. Frontend loads and sign-in works.

### Common Setup Errors (And Fixes)

- Error: `missing FIREBASE_SERVICE_ACCOUNT`
  - Fix: set `FIREBASE_SERVICE_ACCOUNT=serviceAccountKey.json` in `backend/.env`.
- Error: `FIREBASE_SERVICE_ACCOUNT file not found`
  - Fix: place key at `backend/serviceAccountKey.json` or update the path.
- Error: AI provider key missing
  - Fix: set the key for the selected `MODEL_PROVIDER` and restart backend.
- Error: provider model not configured
  - Fix: set `MODEL_NAME` in `backend/.env`.
- Frontend starts but auth/db fails
  - Fix: verify `VITE_FIREBASE_*` values are from the same Firebase project.
- CORS blocked in browser
  - Fix: ensure `ALLOWED_ORIGINS` includes your frontend origin.

## Local Development

Run backend and frontend in separate terminals.

### Backend

```bash
cd backend
python -m venv .venv

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

# macOS/Linux
# source .venv/bin/activate

pip install -r requirements.txt
python app.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Default local URLs:

- Frontend: http://localhost:5173
- Backend health: http://localhost:5000/api/health

## Google Cloud (Firebase Hosting + Cloud Run)

Typical production layout:

- **Frontend**: build `frontend/` with production `VITE_API_URL` and `VITE_FIREBASE_*`, then deploy static files with Firebase Hosting (`firebase/firebase.json` includes a `hosting` target pointing at `../frontend/dist`).
- **Backend**: containerized Flask + Gunicorn via [`backend/Dockerfile`](backend/Dockerfile); Cloud Run injects `PORT` (see [`get_api_port()`](backend/backend_app/core/config.py)).
- **Firebase Admin**: either mount a service-account JSON (Secret Manager volume) and set `FIREBASE_SERVICE_ACCOUNT`, or leave that unset and use **Application Default Credentials** on Cloud Run with `FIREBASE_PROJECT_ID` set (see [`backend/backend_app/services/firebase_admin_utils.py`](backend/backend_app/services/firebase_admin_utils.py)).

Commands (after `gcloud` and `firebase` CLI login):

```bash
# Backend image (from repo root; context is backend/)
docker build -f backend/Dockerfile -t cyber-backend:local backend
docker run --rm -e PORT=8080 -e FIREBASE_PROJECT_ID=your-project-id -p 8080:8080 cyber-backend:local
curl -s http://127.0.0.1:8080/api/health
```

Adjust and run [`scripts/deploy-cloud-run.sample.sh`](scripts/deploy-cloud-run.sample.sh) (copy away from `.sample`, fill `PROJECT_ID`, secrets, and `ALLOWED_ORIGINS`). Match **CORS** to your Hosting URL(s). In Firebase Console → Authentication → Settings, add your Hosting domain under **Authorized domains**.

```bash
cd frontend
# Set VITE_API_URL to your Cloud Run HTTPS URL (no path suffix).
npm run build
cd ..
npm run firebase:hosting:deploy
```

## Quality Checks

### Frontend

```bash
cd frontend
npm run lint
npm run typecheck
npm run test
npm run build
```

### Backend

```bash
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest
```

## Runtime Architecture Boundary

- Frontend owns most ticket CRUD using Firebase client SDK (`frontend/src/services/*`).
- Backend owns trusted operations under `/api/*`:
  - conversation flow and extraction
  - pre-submit validation and classification
  - audit logging endpoints
  - protected attachment download
  - admin export endpoints
- App boot depends on backend health (`/api/health`) before full route rendering.

## Key Backend Endpoints

- `GET /api/health`
- Conversation routes in `backend/backend_app/api/routes/conversation.py`
- Ticket routes in `backend/backend_app/api/routes/tickets.py`
- Attachment routes in `backend/backend_app/api/routes/attachments.py`
- Admin export routes in `backend/backend_app/api/routes/admin_exports.py`

## Firebase Rules Workflow

Rules are managed from one source file:

- source: `firebase/security.rules.bundle`
- generated: `firebase/generated/firestore.rules`, `firebase/generated/storage.rules`

Commands:

```bash
npm run firebase:rules:build
npm run firebase:rules:deploy
```

For details, see `firebase/Firebase.md`.

## Utility Scripts

Root scripts are documented in `scripts/SCRIPTS.md`.

Common examples:

```bash
npm run create-admin
npm run seed:reporters
npm run seed
npm run clear:tickets
```

## Release Checklist

1. `frontend` passes lint, typecheck, tests, and build.
2. `backend` tests pass.
3. Local run smoke test passes (`/api/health`, login, report submission).
4. No real credentials are staged in Git.

Pre-push check:

```bash
git status
git diff --cached
git grep -n "API_KEY\|serviceAccount\|private_key"
```

## Security Notes

- Never commit real `.env` values.
- Never commit `serviceAccountKey.json`.
- Rotate secrets immediately if accidentally exposed.

---

Last updated: 2026-04-28
