#!/usr/bin/env bash
#
# JIT Admin Portal - Production Deployment Script
# Deploys directly to Cloud Run (no load balancer).
#
# Usage:
#   ./deploy.sh                     # Deploy with defaults (Cloud Run native URL)
#   ./deploy.sh --domain jit.nfiindustries.com  # Deploy with custom domain mapping
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
CUSTOM_DOMAIN=""
BUILD_ONLY=false

# Service accounts (replaces allUsers with domain-scoped SAs)
RUNNER_SA="jit-portal-runner@${PROJECT_ID}.iam.gserviceaccount.com"
INVOKER_SA="jit-portal-invoker@${PROJECT_ID}.iam.gserviceaccount.com"

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

# ──────────────────────────────────────────────────
# Preflight checks
# ──────────────────────────────────────────────────

echo "============================================"
echo "  JIT Admin Portal - Deployment"
echo "============================================"
echo ""
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "  Image:    ${IMAGE_NAME}"
echo "  Runner SA:  ${RUNNER_SA}"
echo "  Invoker SA: ${INVOKER_SA}"
if [ -n "${CUSTOM_DOMAIN}" ]; then
  echo "  Custom domain: ${CUSTOM_DOMAIN}"
fi
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

echo "[1/5] Building container image..."
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

echo "[2/5] Deploying to Cloud Run (direct, no load balancer)..."

# Determine the APP_BASE_URL:
#   - If a custom domain is provided, use it
#   - Otherwise, use the Cloud Run-assigned URL
if [ -n "${CUSTOM_DOMAIN}" ]; then
  SERVICE_URL="https://${CUSTOM_DOMAIN}"
else
  # Check if service already exists to get its URL
  SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region "${REGION}" \
    --format='value(status.url)' 2>/dev/null || echo "")

  if [ -z "${SERVICE_URL}" ]; then
    # First deploy — use a placeholder; we'll update after deploy
    SERVICE_URL="https://${SERVICE_NAME}-placeholder.a.run.app"
  fi
fi

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_NAME}:latest" \
  --platform managed \
  --region "${REGION}" \
  --no-allow-unauthenticated \
  --service-account "${RUNNER_SA}" \
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

# Get the actual Cloud Run URL after deployment
CLOUD_RUN_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format='value(status.url)')

# If no custom domain, update APP_BASE_URL with the real Cloud Run URL
if [ -z "${CUSTOM_DOMAIN}" ]; then
  SERVICE_URL="${CLOUD_RUN_URL}"
  echo "      Updating APP_BASE_URL to actual Cloud Run URL..."
  gcloud run services update "${SERVICE_NAME}" \
    --region "${REGION}" \
    --update-env-vars "APP_BASE_URL=${CLOUD_RUN_URL}" \
    --quiet
fi

echo "      Deployment complete."
echo "      Service URL: ${SERVICE_URL}"

# ──────────────────────────────────────────────────
# Step 3: Grant invoker SA access (replaces allUsers)
# ──────────────────────────────────────────────────

echo "[3/5] Granting Cloud Run invoker role to service account..."
echo "      (Uses domain-scoped SA to comply with org policy)"
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --region "${REGION}" \
  --member="serviceAccount:${INVOKER_SA}" \
  --role="roles/run.invoker" \
  --quiet

echo "      Invoker SA granted roles/run.invoker on ${SERVICE_NAME}."

# ──────────────────────────────────────────────────
# Step 4: Custom domain mapping (optional)
# ──────────────────────────────────────────────────

if [ -n "${CUSTOM_DOMAIN}" ]; then
  echo "[4/5] Mapping custom domain ${CUSTOM_DOMAIN}..."
  gcloud run domain-mappings create \
    --service "${SERVICE_NAME}" \
    --domain "${CUSTOM_DOMAIN}" \
    --region "${REGION}" \
    --quiet 2>/dev/null || echo "      Domain mapping already exists or requires DNS verification."

  echo "      Fetching DNS records to configure..."
  gcloud run domain-mappings describe \
    --domain "${CUSTOM_DOMAIN}" \
    --region "${REGION}" \
    --format='yaml(status.resourceRecords)' 2>/dev/null || true
else
  echo "[4/5] No custom domain — using Cloud Run native URL."
fi

# ──────────────────────────────────────────────────
# Step 5: Verify deployment
# ──────────────────────────────────────────────────

echo "[5/5] Verifying deployment..."
echo "      Cloud Run URL: ${CLOUD_RUN_URL}"

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
echo "  Okta configuration:"
echo "    - Redirect URI:  ${SERVICE_URL}/authorization-code/callback"
echo "    - Sign-out URI:  ${SERVICE_URL}"
echo ""

if [ -n "${CUSTOM_DOMAIN}" ]; then
  echo "  Custom domain reminder:"
  echo "    - Verify DNS records shown above are configured for ${CUSTOM_DOMAIN}"
  echo ""
fi
