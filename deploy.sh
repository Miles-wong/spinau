#!/usr/bin/env bash
# Sample: build backend image, push to Artifact Registry, deploy Cloud Run.
# Copy to deploy-cloud-run.sh, fill in placeholders, chmod +x, then run.
set -euo pipefail

PROJECT_ID="contry-project"
REGION="australia-southeast2"
REPO="cyber-backend"
IMAGE_NAME="cyber-incident-api"
SERVICE="${IMAGE_NAME}"
FRONTEND_ORIGIN_HTTPS="https://spin-cyber.web.app,https://spin-cyber.firebaseapp.com"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"

TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}:$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo manual)"

echo "Building ${TAG}"
docker build -t "${TAG}" "${BACKEND_DIR}"

echo "Configuring Docker auth for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "Pushing ${TAG}"
docker push "${TAG}"

echo "Deploying Cloud Run service ${SERVICE}"
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${TAG}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=0 \
  --max-instances=10 \
  --timeout=300 \
  --set-env-vars="FIREBASE_PROJECT_ID=${PROJECT_ID},ALLOWED_ORIGINS=${FRONTEND_ORIGIN_HTTPS}" \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest"

echo "Done. Set frontend VITE_API_URL to the Cloud Run URL (https://...run.app) and run:"
echo "  cd frontend && npm run build"
echo "  npx firebase-tools deploy --config firebase/firebase.json --only hosting"
