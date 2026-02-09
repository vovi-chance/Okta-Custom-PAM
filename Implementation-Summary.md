# JIT Admin Portal - Complete Implementation Summary

## Document Purpose

This document captures the complete state of the JIT Admin Request Portal implementation as of February 2026. Use this to resume work in future sessions.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [GCP Infrastructure](#gcp-infrastructure)
5. [Okta Configuration](#okta-configuration)
6. [Application Source Files](#application-source-files)
7. [Environment Variables & Secrets](#environment-variables--secrets)
8. [Deployment Process](#deployment-process)
9. [Current State & Issues](#current-state--issues)
10. [Next Steps to Complete](#next-steps-to-complete)
11. [Useful Commands Reference](#useful-commands-reference)
12. [Related Documents](#related-documents)

---

## 1. Project Overview

### What It Does

The JIT (Just-In-Time) Admin Request Portal allows NFI Industries users to request temporary privileged admin access through a web interface. The portal authenticates users via Okta, collects request details, and invokes an Okta Workflow (`JIT-Admin-Request`) that handles the activation/deactivation lifecycle of admin accounts.

### User Flow

1. User navigates to the portal URL
2. User clicks "Sign In with Okta" → redirects to Okta OIDC login
4. After Okta auth, user sees the JIT request form with auto-populated info
5. User selects request type, duration, provides justification
6. Portal backend invokes Okta Workflow API via OAuth 2.0 (private key JWT)
7. Workflow handles approval routing, admin account activation, notifications

### Request Types

| Type | Duration Range | Approval | Business Justification |
|------|---------------|----------|----------------------|
| Standard | 15-240 min | User approval | Required (10-1000 chars) |
| Extended | 15-480 min | User approval | Not required |
| Emergency | 15-480 min | Manager approval | Required (10-1000 chars) |

---

## 2. Architecture

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Production Architecture                       │
│                                                                      │
│  User Browser                                                        │
│       │                                                              │
│       ▼                                                              │
│  ┌─────────────────┐                                                 │
│  │  Cloud Run       │  ← Node.js/Express app                        │
│  │  jit-admin-portal│  ← Port 8080                                   │
│  │  (us-central1)   │  ← Secrets from GCP Secret Manager             │
│  └────────┬────────┘                                                 │
│           │                                                          │
│     ┌─────┴──────┐                                                   │
│     │            │                                                   │
│     ▼            ▼                                                   │
│  ┌────────┐  ┌──────────────────┐                                    │
│  │ Okta   │  │ Okta Workflows   │                                    │
│  │ OIDC   │  │ API Endpoint     │                                    │
│  │ Auth   │  │ (OAuth 2.0 +     │                                    │
│  │        │  │  Private Key JWT) │                                    │
│  └────────┘  └──────────────────┘                                    │
│                      │                                               │
│                      ▼                                               │
│              ┌──────────────────┐                                    │
│              │ JIT-Admin-Request│                                     │
│              │ Workflow          │                                    │
│              │ (Activation,     │                                     │
│              │  Approval, etc.) │                                     │
│              └──────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Authentication Layers

| Layer | Service | Purpose |
|-------|---------|---------|
| Layer 1 | Okta OIDC | Authenticates user via Okta (ensures Okta identity) |
| Layer 2 | Group-based Authorization | Verifies user belongs to `JIT-Eligible-Users` group |
| Layer 3 | OAuth 2.0 Private Key JWT | Backend authenticates to Okta Workflows API |

---

## 3. Tech Stack

### Application

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20 (slim) |
| Framework | Express | 5.x |
| Okta Auth | @okta/oidc-middleware | 5.4.1 |
| JWT Signing | jose | 5.x |
| Template Engine | EJS | 3.1.x |
| Session | express-session | 1.19.x |
| Security Headers | helmet | 8.x |
| Rate Limiting | express-rate-limit | 7.x |
| Logging | Custom structured JSON logger | (built-in) |
| UUID Generation | uuid | 11.x |

### Infrastructure

| Component | Service |
|-----------|---------|
| Container Hosting | Google Cloud Run |
| Container Registry | Google Artifact Registry |
| Secrets Management | Google Secret Manager |
| Container Build | Google Cloud Build |

---

## 4. GCP Infrastructure

### Project Details

| Setting | Value |
|---------|-------|
| **Project ID** | `jit-admin-portal` |
| **Project Number** | `65719149240` |
| **Region** | `us-central1` |
| **Service URL** | `https://jit-admin-portal-65719149240.us-central1.run.app` |

### GCP Resources Created

| Resource | Name | Type |
|----------|------|------|
| Cloud Run Service | `jit-admin-portal` | Service |
| Artifact Registry Repo | `jit-portal-repo` | Docker Repository |
| Container Image | `us-central1-docker.pkg.dev/jit-admin-portal/jit-portal-repo/jit-admin-portal` | Docker Image |
| Network Endpoint Group | `jit-portal-neg` | Serverless NEG |
| Backend Service | `jit-portal-backend` | Global Backend |
| URL Map | `jit-portal-url-map` | URL Map |
| SSL Certificate | `jit-portal-cert` | Managed SSL |
| Static IP | `jit-portal-ip` | Global External IP |
| HTTPS Proxy | `jit-portal-https-proxy` | Target HTTPS Proxy |
| Forwarding Rule | `jit-portal-forwarding-rule` | Global Forwarding Rule |

### GCP APIs Enabled

- `run.googleapis.com`
- `cloudbuild.googleapis.com`
- `secretmanager.googleapis.com`
- `containerregistry.googleapis.com`
- `artifactregistry.googleapis.com`

### IAM Roles Assigned

| Service Account | Role |
|----------------|------|
| `65719149240-compute@developer.gserviceaccount.com` | `roles/storage.objectAdmin` |
| `65719149240-compute@developer.gserviceaccount.com` | `roles/artifactregistry.writer` |
| `65719149240-compute@developer.gserviceaccount.com` | `roles/logging.logWriter` |
| `65719149240-compute@developer.gserviceaccount.com` | `roles/secretmanager.secretAccessor` |
| `65719149240@cloudbuild.gserviceaccount.com` | `roles/storage.objectAdmin` |
| `65719149240@cloudbuild.gserviceaccount.com` | `roles/storage.admin` |
| `65719149240@cloudbuild.gserviceaccount.com` | `roles/artifactregistry.writer` |
| `65719149240@cloudbuild.gserviceaccount.com` | `roles/run.admin` |
| `65719149240@cloudbuild.gserviceaccount.com` | `roles/iam.serviceAccountUser` |

### Cloud Run IAM Policy

```yaml
bindings:
- members:
  - domain:test.nfiindustries.com
  - user:victor.vo@test.nfiindustries.com
  role: roles/run.invoker
```

### Organization Policy Constraint

The org policy `iam.allowedPolicyMemberDomains` restricts IAM policy members to customer `C012imv50`. This means:
- ❌ `allUsers` is blocked (no public access to Cloud Run)
- ❌ `allAuthenticatedUsers` may be blocked
- ✅ `user:` and `domain:` within `test.nfiindustries.com` are allowed
- ✅ Cloud Run is set to `--no-allow-unauthenticated`

---

## 5. Okta Configuration

### Organization

| Setting | Value |
|---------|-------|
| **Okta Org URL** | `https://nfi.oktapreview.com` |
| **OIDC Issuer** | `https://nfi.oktapreview.com/oauth2/default` |

### Application 1: OIDC Web Application (User Authentication)

| Setting | Value |
|---------|-------|
| **App Name** | `JIT Admin Request Portal` |
| **Sign-in Method** | OIDC - OpenID Connect |
| **Application Type** | Web Application |
| **Grant Types** | Authorization Code |
| **Sign-in Redirect URI** | `https://jit-admin-portal-65719149240.us-central1.run.app/authorization-code/callback` |
| **Sign-out Redirect URI** | `https://jit-admin-portal-65719149240.us-central1.run.app` |
| **Scopes** | `openid`, `profile`, `email` |
| **Client ID** | Stored in GCP Secret: `jit-portal-okta-client-id` |
| **Client Secret** | Stored in GCP Secret: `jit-portal-okta-client-secret` |

### Application 2: API Services App (Workflow Invocation)

| Setting | Value |
|---------|-------|
| **App Name** | `JIT Portal - Workflow Invoker` |
| **App Type** | API Services |
| **Client Authentication** | Public key / Private key |
| **Granted Scope** | `okta.workflows.invoke.manage` |
| **Client ID** | Stored in GCP Secret: `jit-portal-wf-client-id` |
| **Key ID (kid)** | Stored in GCP Secret: `jit-portal-wf-key-id` |
| **Private Key** | Stored in GCP Secret: `jit-portal-wf-private-key` |

### Workflow API Endpoint

| Setting | Value |
|---------|-------|
| **Workflow Name** | `JIT-Admin-Request` |
| **Security Level** | Secure with OAuth 2.0 |
| **Allowed App** | `JIT Portal - Workflow Invoker` |
| **Invoke URL** | Stored in GCP Secret: `jit-portal-wf-invoke-url` |

### Required Okta Groups

| Group Name | Purpose |
|------------|---------|
| JIT-Admins-Active | Admin accounts with currently active JIT access |
| JIT-Eligible-Users | Standard users eligible to request JIT admin access |
| JIT-Approvers | Users authorized to approve JIT access requests |
| Admin-Accounts-All | All admin accounts (for policy assignment) |

---

## 6. Application Source Files

### Project Structure

```
jit-admin-portal/
├── Dockerfile                          # Container build (Node 20 slim, non-root)
├── deploy.sh                           # GCP deployment script
├── package.json                        # Dependencies
├── package-lock.json                   # Locked dependency versions
├── .env.example                        # Environment variable documentation
├── src/
│   ├── server.js                       # Main Express app (routes, middleware, OIDC, cache-busting)
│   ├── middleware/
│   │   ├── authorization.js            # Group-based auth (JIT-groups claim)
│   │   ├── rateLimiter.js              # Per-user rate limiting (API: 30/hr, Pages: 100/15min)
│   │   └── validation.js               # Request validation (conditional justification)
│   ├── services/
│   │   └── workflowsService.js         # OAuth 2.0 + Workflow invocation (circuit breaker, retries)
│   ├── utils/
│   │   └── logger.js                   # Structured JSON logging (GCP Cloud Logging compatible)
│   ├── views/
│   │   ├── home.ejs                    # Landing page (redirects to /dashboard)
│   │   ├── dashboard.ejs              # JIT request form (duration unit selector, conditional fields)
│   │   ├── profile.ejs                # User profile display
│   │   └── error.ejs                  # Error page
│   └── public/
│       ├── css/
│       │   ├── common.css             # Shared styles (navbar, cards, buttons)
│       │   ├── dashboard.css          # Dashboard form, alerts, spinner
│       │   ├── home.css               # Landing page layout
│       │   ├── profile.css            # Profile card and group list
│       │   └── error.css              # Error page styling
│       └── js/
│           └── dashboard.js           # Client-side form handling (unit conversion, conditional fields)
```

### Key Implementation Details

#### server.js (Currently Deployed)
- Starts on PORT 8080 with configuration validation
- Cache-busting: generates `CACHE_BUST` token via `app.locals` for all EJS templates
- Checks for required config before initializing OIDC; falls back to degraded mode
- Health check at `/health` always available (minimal response, no info disclosure)
- Root `/` auto-redirects to `/dashboard`
- Protected routes: `/dashboard`, `/profile`, `/api/jit-request`
- Token revocation on logout
- Trust proxy set to `1` (single proxy layer)

#### workflowsService.js
- Generates RS256 JWT client assertion using private key
- Requests OAuth 2.0 access token from `{OKTA_ORG_URL}/oauth2/v1/token`
- Caches access token until 60 seconds before expiry
- Invokes Workflow API with Bearer token
- Circuit breaker (5-failure threshold, 60s reset)
- Retry with exponential backoff (2 retries)
- Automatic token refresh on 401

#### authorization.js
- Extracts `JIT-groups` claim from ID token
- Verifies user belongs to required group (`JIT-Eligible-Users`)
- Returns 403 if groups claim is missing

#### rateLimiter.js
- API rate limiter: 30 requests/hour per user
- Page rate limiter: 100 requests/15 minutes per user

#### validation.js
- Validates request type (standard/emergency/extended)
- Validates duration ranges per request type
- Business justification required for standard and emergency (10-1000 chars)
- Business justification **not required** for extended requests

#### dashboard.js (Client-Side)
- Duration unit selector (minutes/hours) with automatic conversion
- Conditional business justification field (hidden for extended)
- Hours-to-minutes conversion before API submission
- Form reset clears conditional fields

#### API Endpoint: POST /api/jit-request
```json
// Request body
{
  "requestType": "standard|emergency|extended",
  "durationMinutes": 30,
  "businessJustification": "Reason for access..."
}

// Payload sent to Okta Workflow (requestorId from session, not user input)
{
  "requestorId": "00u...",           // From Okta OIDC session (user.sub)
  "requestorEmail": "user@company.com",
  "requestorName": "First Last",
  "durationMinutes": 30,
  "businessJustification": "...",
  "requestType": "standard",
  "requestTimestamp": "2026-01-30T...",
  "sourceApplication": "JIT-Admin-Portal"
}
```

### Dockerfile (Currently Deployed)

```dockerfile
FROM node:20-slim
WORKDIR /app
RUN groupadd -r nodejs && useradd -r -g nodejs nodejs
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src/ ./src/
RUN chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "src/server.js"]
```

> **Note:** Uses `npm install --omit=dev` for production-only dependencies. The `package-lock.json` is now included in the repository.

---

## 7. Environment Variables & Secrets

### GCP Secret Manager Secrets

| Secret Name | Maps To Env Var | Purpose |
|-------------|----------------|---------|
| `jit-portal-session-secret` | `SESSION_SECRET` | Express session encryption |
| `jit-portal-okta-client-id` | `OKTA_CLIENT_ID` | OIDC Web App Client ID |
| `jit-portal-okta-client-secret` | `OKTA_CLIENT_SECRET` | OIDC Web App Client Secret |
| `jit-portal-wf-client-id` | `OKTA_WORKFLOWS_CLIENT_ID` | API Services App Client ID |
| `jit-portal-wf-key-id` | `OKTA_WORKFLOWS_KEY_ID` | API Services App Key ID |
| `jit-portal-wf-private-key` | `OKTA_WORKFLOWS_PRIVATE_KEY` | API Services App Private Key (PEM) |
| `jit-portal-wf-invoke-url` | `OKTA_WORKFLOWS_INVOKE_URL` | Workflow API Endpoint URL |

### Environment Variables (Non-Secret)

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `OKTA_ORG_URL` | `https://nfi.oktapreview.com` |
| `APP_BASE_URL` | `https://jit-admin-portal-65719149240.us-central1.run.app` |
| `PORT` | `8080` (set by Cloud Run) |

---

## 8. Deployment Process

### Build & Deploy Commands

```bash
# Set variables
export PROJECT_ID="jit-admin-portal"
export REGION="us-central1"
export OKTA_ORG_URL="https://nfi.oktapreview.com"
export SERVICE_URL="https://jit-admin-portal-65719149240.us-central1.run.app"

# Build container
cd ~/jit-portal
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/jit-portal-repo/jit-admin-portal

# Deploy to Cloud Run
gcloud run deploy jit-admin-portal \
  --image $REGION-docker.pkg.dev/$PROJECT_ID/jit-portal-repo/jit-admin-portal:latest \
  --platform managed \
  --region $REGION \
  --no-allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "OKTA_ORG_URL=$OKTA_ORG_URL" \
  --set-env-vars "APP_BASE_URL=$SERVICE_URL" \
  --update-secrets "SESSION_SECRET=jit-portal-session-secret:latest" \
  --update-secrets "OKTA_CLIENT_ID=jit-portal-okta-client-id:latest" \
  --update-secrets "OKTA_CLIENT_SECRET=jit-portal-okta-client-secret:latest" \
  --update-secrets "OKTA_WORKFLOWS_CLIENT_ID=jit-portal-wf-client-id:latest" \
  --update-secrets "OKTA_WORKFLOWS_KEY_ID=jit-portal-wf-key-id:latest" \
  --update-secrets "OKTA_WORKFLOWS_PRIVATE_KEY=jit-portal-wf-private-key:latest" \
  --update-secrets "OKTA_WORKFLOWS_INVOKE_URL=jit-portal-wf-invoke-url:latest"
```

### Deployment Issues Encountered & Resolved

| Issue | Root Cause | Solution |
|-------|-----------|----------|
| Cloud Build permission denied on storage | Missing IAM role | Added `roles/storage.objectAdmin` to compute service account |
| `npm ci` requires package-lock.json | No lock file generated | Changed Dockerfile to `npm install --omit=dev` |
| Artifact Registry push denied | Missing IAM role | Created Artifact Registry repo + added `roles/artifactregistry.writer` |
| Secret Manager access denied | Missing IAM role | Added `roles/secretmanager.secretAccessor` to compute SA |
| Container failed to start | Missing `APP_BASE_URL` env var | Updated server.js with error handling; set all env vars in single deploy |
| 403 Forbidden on Cloud Run URL | Org policy blocks `allUsers` | Configured authorized domain access via `roles/run.invoker` |
| `OKTA_ORG_URL` not set after update | Env vars reset on update | Included all env vars in single deploy command |

---

## 9. Current State

### What's Working

- Application builds and deploys to Cloud Run (19+ revisions deployed)
- Okta OIDC authentication and group-based authorization
- Dashboard with JIT request form (duration unit selector, conditional justification)
- Request validation with per-type duration ranges
- Cache-busting on all static assets
- Rate limiting on API and page routes
- Structured JSON logging with correlation IDs
- Health check endpoint with minimal info disclosure
- Token revocation on logout
- Security headers via Helmet (CSP with no inline scripts/styles)
- All secrets stored in GCP Secret Manager

---

## 10. Next Steps

### Okta Workflows

1. **Configure the JIT-Admin-Request workflow** in Okta Workflows (per the implementation guide)
2. **Set up linked objects** between standard and admin accounts
3. **Create custom attributes**: `jitActivatedAt`, `jitExpiresAt`
4. **Build the deactivation workflow** (`JIT-Admin-Expire`)
5. **Configure Google Chat (Gspace) notifications**

### Production Readiness

- [ ] Add persistent session store (Redis/Memorystore) for multi-instance Cloud Run
- [ ] Consider Cloud Run `--ingress internal` to block external access (requires VPN)
- [ ] Set up monitoring and alerting
- [ ] Test approval workflow end-to-end
- [ ] Test automatic expiration
- [ ] Add Bookmark App tile in Okta dashboard for easy access

---

## 11. Useful Commands Reference

### Cloud Shell Setup (After Session Expiry)

```bash
gcloud auth login
export PROJECT_ID="jit-admin-portal"
export REGION="us-central1"
export OKTA_ORG_URL="https://nfi.oktapreview.com"
export SERVICE_URL="https://jit-admin-portal-65719149240.us-central1.run.app"
gcloud config set project $PROJECT_ID
```

### View Logs

```bash
gcloud run services logs read jit-admin-portal --region us-central1 --limit 50
```

### Check Service Status

```bash
gcloud run services describe jit-admin-portal --region us-central1
```

### Rebuild & Redeploy

```bash
cd ~/jit-portal
gcloud builds submit --tag us-central1-docker.pkg.dev/jit-admin-portal/jit-portal-repo/jit-admin-portal

gcloud run deploy jit-admin-portal \
  --image us-central1-docker.pkg.dev/jit-admin-portal/jit-portal-repo/jit-admin-portal:latest \
  --platform managed \
  --region us-central1 \
  --no-allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "OKTA_ORG_URL=https://nfi.oktapreview.com" \
  --set-env-vars "APP_BASE_URL=https://jit-admin-portal-65719149240.us-central1.run.app" \
  --update-secrets "SESSION_SECRET=jit-portal-session-secret:latest" \
  --update-secrets "OKTA_CLIENT_ID=jit-portal-okta-client-id:latest" \
  --update-secrets "OKTA_CLIENT_SECRET=jit-portal-okta-client-secret:latest" \
  --update-secrets "OKTA_WORKFLOWS_CLIENT_ID=jit-portal-wf-client-id:latest" \
  --update-secrets "OKTA_WORKFLOWS_KEY_ID=jit-portal-wf-key-id:latest" \
  --update-secrets "OKTA_WORKFLOWS_PRIVATE_KEY=jit-portal-wf-private-key:latest" \
  --update-secrets "OKTA_WORKFLOWS_INVOKE_URL=jit-portal-wf-invoke-url:latest"
```

### Update a Single Secret

```bash
echo -n "new-value" | gcloud secrets versions add SECRET_NAME --data-file=-
```

### Proxy for Local Testing

```bash
gcloud run services proxy jit-admin-portal --region us-central1 --port 8081
# Then use Web Preview on port 8081
```

---

## 12. Related Documents

| Document | Location | Purpose |
|----------|----------|---------|
| JIT Workflow Implementation Guide v4 | `/mnt/project/JIT-Admin-Account-Workflow-Implementation-Guide-v4.md` | Complete Okta Workflows build guide (all cards, step-by-step) |
| Application Source Code | `~/jit-portal/` on Cloud Shell | Deployed application files |
| Container Image | `us-central1-docker.pkg.dev/jit-admin-portal/jit-portal-repo/jit-admin-portal` | Built Docker image |

---

## Appendix: Files Created in Cloud Shell

All application files were created by pasting `cat > filename << 'EOF'` commands directly into Google Cloud Shell. The files live in `~/jit-portal/` on Cloud Shell. If Cloud Shell resets, the files will need to be recreated using the same paste commands.

### Key File Sizes (as deployed)

| File | Size |
|------|------|
| src/server.js | ~11KB (updated version with error handling) |
| src/services/workflowsService.js | ~5KB |
| src/middleware/validation.js | ~3KB |
| src/views/dashboard.ejs | ~12KB |
| src/views/profile.ejs | ~5KB |
| src/views/home.ejs | ~2KB |
| src/views/error.ejs | ~1KB |
| package.json | ~1KB |
| Dockerfile | ~1KB |

---

*Document Version: 2.0*
*Last Updated: February 2026*
*Session Context: Claude AI Project - JIT Admin Portal Implementation*
