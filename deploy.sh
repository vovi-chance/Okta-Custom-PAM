#!/usr/bin/env bash
#
# JIT Admin Portal - Production Deployment Script
#
# Usage:
#   ./deploy.sh                     # Deploy with defaults
#   ./deploy.sh --domain custom.example.com  # Deploy with custom domain
#   ./deploy.sh --build-only        # Build container only, no deploy
#
set -euo pipefail

# ──────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────

PROJECT_ID="${GCP_PROJECT_ID:-jit-admin-portal}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="jit-admin-portal"
REPO_NAME="jit-portal-repo"
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"
OKTA_ORG_URL="${OKTA_ORG_URL:-https://nfi.oktapreview.com}"
DEFAULT_URL="https://jit-admin-portal-65719149240.us-central1.run.app"
CUSTOM_DOMAIN=""
BUILD_ONLY=false

# ──────────────────────────────────────────────────
# Parse arguments
# ──────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      CUSTOM_DOMAIN="$2"
      shift 2
      ;;
    --build-only)
      BUILD_ONLY=true
      shift
      ;;
    --project)
      PROJECT_ID="$2"
      IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"
      shift 2
      ;;
    --region)
      REGION="$2"
      IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--domain DOMAIN] [--build-only] [--project ID] [--region REGION]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ -n "${CUSTOM_DOMAIN}" ]; then
  SERVICE_URL="https://${CUSTOM_DOMAIN}"
else
  SERVICE_URL="${DEFAULT_URL}"
fi

# ──────────────────────────────────────────────────
# Preflight checks
# ──────────────────────────────────────────────────

echo "============================================"
echo "  JIT Admin Portal - Deployment"
echo "============================================"
echo ""
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "  URL:      ${SERVICE_URL}"
echo "  Image:    ${IMAGE_NAME}"
echo ""

# Verify gcloud is authenticated
if ! gcloud auth print-identity-token &>/dev/null; then
  echo "ERROR: Not authenticated with gcloud. Run: gcloud auth login"
  exit 1
fi

gcloud config set project "${PROJECT_ID}" --quiet

# ──────────────────────────────────────────────────
# Step 1: Build container
# ──────────────────────────────────────────────────

echo "[1/3] Building container image..."
gcloud builds submit \
  --tag "${IMAGE_NAME}:latest" \
  --quiet

echo "      Build complete: ${IMAGE_NAME}:latest"

if [ "${BUILD_ONLY}" = true ]; then
  echo ""
  echo "Build-only mode. Skipping deployment."
  exit 0
fi

# ──────────────────────────────────────────────────
# Step 2: Deploy to Cloud Run
# ──────────────────────────────────────────────────

echo "[2/3] Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_NAME}:latest" \
  --platform managed \
  --region "${REGION}" \
  --no-allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 10 \
  --timeout 60 \
  --concurrency 80 \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "OKTA_ORG_URL=${OKTA_ORG_URL}" \
  --set-env-vars "APP_BASE_URL=${SERVICE_URL}" \
  --update-secrets "SESSION_SECRET=jit-portal-session-secret:latest" \
  --update-secrets "OKTA_CLIENT_ID=jit-portal-okta-client-id:latest" \
  --update-secrets "OKTA_CLIENT_SECRET=jit-portal-okta-client-secret:latest" \
  --update-secrets "OKTA_WORKFLOWS_CLIENT_ID=jit-portal-wf-client-id:latest" \
  --update-secrets "OKTA_WORKFLOWS_KEY_ID=jit-portal-wf-key-id:latest" \
  --update-secrets "OKTA_WORKFLOWS_PRIVATE_KEY=jit-portal-wf-private-key:latest" \
  --update-secrets "OKTA_WORKFLOWS_INVOKE_URL=jit-portal-wf-invoke-url:latest" \
  --quiet

echo "      Deployment complete."

# ──────────────────────────────────────────────────
# Step 3: Verify deployment
# ──────────────────────────────────────────────────

echo "[3/3] Verifying deployment..."

# Check Cloud Run service is serving
CLOUD_RUN_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format='value(status.url)')

echo "      Cloud Run URL: ${CLOUD_RUN_URL}"
echo "      APP_BASE_URL:  ${SERVICE_URL}"

# Check latest revision
LATEST_REVISION=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format='value(status.latestReadyRevisionName)')
echo "      Latest Revision: ${LATEST_REVISION}"

# Check recent logs for startup
echo ""
echo "  Recent logs:"
gcloud run services logs read "${SERVICE_NAME}" \
  --region "${REGION}" \
  --limit 5 \
  2>/dev/null || echo "      (unable to read logs)"

echo ""
echo "============================================"
echo "  Deployment Complete"
echo "============================================"
echo ""
echo "  Next steps:"
echo "    1. Test health check:  curl -s ${SERVICE_URL}/health"
echo "    2. Open portal:        ${SERVICE_URL}"
echo "    3. Check logs:         gcloud run services logs read ${SERVICE_NAME} --region ${REGION} --limit 50"
echo ""

if [ -n "${CUSTOM_DOMAIN}" ]; then
  echo "  Custom domain reminder:"
  echo "    - Update Okta redirect URI to: ${SERVICE_URL}/authorization-code/callback"
  echo "    - Update Okta sign-out URI to: ${SERVICE_URL}"
  echo ""
fi
