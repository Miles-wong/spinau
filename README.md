# SPIN AU Task Management System

A React-based Task & Workload Management System built for the SPIN AU technical assessment.  
This project demonstrates clean component architecture, strong validation logic, thoughtful UI/UX design, and backend/cloud-ready engineering.

---

## ✨ Key Features

### Task Management
- Create / Edit / Delete tasks
- Auto-generate incremental numeric Task IDs
- Double-click table row to edit
- Delete confirmation to prevent accidental removal

### Workload Management
- Add multiple workloads per task
- Edit workload start / end dates
- Remove workloads
- Automatic workload duration calculation (inclusive days)

### Validation & Data Integrity
- Task start date ≤ end date
- Workload start date ≤ end date
- Workload dates must fall inside task date range
- Automatic clamping when task date range changes
- Dual-layer validation (UI constraints + logic validation)

### UI / UX Enhancements
- Color-coded status badges:
  - Not Started (Gray)
  - In Progress (Blue)
  - Completed (Green)
- Guided empty-state message
- Toast notifications on create / update / delete
- Date pickers restricted with min / max values
- Real-time workload duration display
- User notification when workloads auto-adjust

### Persistence
- Initial seed data loaded from JSON
- All changes saved to localStorage
- Data persists after page refresh
- Simulates real backend database behavior

---

## 🧩 Data Model

### Task
```json
{
  "id": 1,
  "taskName": "Design Control Panel",
  "description": "Design UI for the new control system",
  "startDate": "2026-01-01",
  "endDate": "2026-02-01",
  "requestedBy": "Manager A",
  "assignedTo": "Resource A",
  "status": "In Progress",
  "project": "Project Alpha",
  "workloads": [
    { "startDate": "2026-01-03", "endDate": "2026-01-05" }
  ]
}
Workload
json
Copy code
{
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD"
}
The frontend strictly follows this schema to ensure direct backend compatibility.

🏗️ System Architecture
css
Copy code
App (Single Source of Truth)
 ├── Table         → Task list & status display
 └── TaskModal    → Task form & validation
        └── LoadEditor → Workload editor & date logic
Component Responsibilities
App

Holds global tasks state

Performs Create / Update / Delete

Manages modal visibility

Handles persistence layer

Acts as single source of truth

Table

Stateless presentation component

Displays tasks and status badges

Emits edit / delete events

TaskModal

Manages task form draft state

Performs task & workload validation

Assembles clean payload for saving

LoadEditor

Manages workload CRUD

Enforces date range rules

Auto-corrects invalid ranges

Calculates duration

🧠 Design & UX Thinking
The UI is designed to prevent user errors rather than only reacting to them.

Date inputs are constrained to valid ranges

Invalid selections are auto-corrected

Users receive immediate visual feedback

Status badges improve scannability

Empty state guides first-time users

Toast messages confirm successful actions

Goal: Make interactions intuitive while guaranteeing data consistency.

🔄 Data Flow
css
Copy code
User Action
   ↓
Table / TaskModal / LoadEditor
   ↓
App updates tasks state
   ↓
localStorage persistence
   ↓
UI re-renders from single source of truth
This ensures predictable unidirectional data flow.

💾 Persistence Strategy
localStorage simulates backend database

Automatic save on every state change

JSON seed data for first-time initialization

Ready to replace localStorage with REST API

🚀 Running Locally
Install dependencies
bash
Copy code
npm install
Start development server
bash
Copy code
npm start
Open in browser:

arduino
Copy code
http://localhost:3000
☁️ Backend & Cloud Ready (AWS)
The project is structured for direct backend integration.

Planned Backend Stack
API Gateway (REST API)

AWS Lambda (business logic)

DynamoDB (task & workload storage)

Frontend Hosting Options
AWS Amplify Hosting (CI/CD from GitHub)

Or S3 + CloudFront (SPA + CDN)

Integration Strategy
Replace localStorage with API service layer

Use async CRUD operations

Optimistic UI updates for responsive UX

Backend validates same business rules

🧪 Testing Highlights
Empty task name validation

Invalid date order prevention

Workload outside task range blocked

Auto-clamp on task range change

Persistence after refresh

Delete confirmation protection

📈 Future Enhancements
Search and filter tasks

Calendar / timeline view for workloads

Workload analytics dashboard

Authentication & role-based access

Multi-user collaboration

👨‍💻 Author
[Mingyong Wang]
SPIN AU Technical Assessment Project