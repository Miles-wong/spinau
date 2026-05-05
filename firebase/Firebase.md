Firebase Security Rules: Single-File Workflow

Overview
- Firestore and Storage security rules are maintained in one file: `firebase/security.rules.bundle`
- Generated deploy files:
  - `firebase/generated/firestore.rules`
  - `firebase/generated/storage.rules`
- Firebase CLI deploys both in one command.

1. Install and login
```bash
npm install -g firebase-tools
firebase login
```

2. Edit one file only
- Edit `firebase/security.rules.bundle`
- Use section markers:
  - `# >>> FIRESTORE` ... `# <<< FIRESTORE`
  - `# >>> STORAGE` ... `# <<< STORAGE`

3. Build generated rule files
```bash
npm run firebase:rules:build
```

4. One-click deploy (Firestore + Storage)
```bash
npm run firebase:rules:deploy
```

5. Firebase config
- `firebase/firebase.json` points to generated files:
  - `firestore.rules = generated/firestore.rules`
  - `storage.rules = generated/storage.rules`

6. Local emulators
```bash
firebase emulators:start --config firebase/firebase.json
```

Notes
- Keep `.firebaserc` committed so teammates deploy to the right project.
- If you changed rules, always run the build step before deploy.