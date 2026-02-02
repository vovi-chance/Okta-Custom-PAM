# JIT Admin Portal - Complete Implementation Summary

## Document Purpose

This document captures the complete state of the JIT Admin Request Portal implementation as of January 30, 2026. Use this to resume work in future sessions.

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
2. Google IAP authenticates user (Google Workspace: `test.nfiindustries.com`)
3. User clicks "Sign In with Okta" → redirects to Okta OIDC login
4. After Okta auth, user sees the JIT request form with auto-populated info
5. User selects request type, duration, provides justification
6. Portal backend invokes Okta Workflow API via OAuth 2.0 (private key JWT)
7. Workflow handles approval routing, admin account activation, notifications

### Request Types

| Type | Duration Range | Approval | Requirements |
|------|---------------|----------|--------------|
| Standard | 15-240 min | Manager approval | Justification |
| Emergency | 15-480 min | Auto-approved | Justification + Incident ticket |
| Extended | 60-480 min | Manager approval | Justification |

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
│  │  Google Cloud    │  ← Static IP: 34.128.181.49                    │
│  │  Load Balancer   │  ← SSL Certificate (managed)                   │
│  │  + IAP           │  ← Google Workspace auth (test.nfiindustries)  │
│  └────────┬────────┘                                                 │
│           │                                                          │
│           ▼                                                          │
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
| Layer 1 | Google IAP (Identity-Aware Proxy) | Authenticates user via Google Workspace |
| Layer 2 | Okta OIDC | Authenticates user via Okta (ensures Okta identity) |
| Layer 3 | OAuth 2.0 Private Key JWT | Backend authenticates to Okta Workflows API |

---

## 3. Tech Stack

### Application

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20 (slim) |
| Framework | Express | 4.21.0 |
| Okta Auth | @okta/oidc-middleware | 5.4.1 |
| JWT Signing | jose | 5.9.6 |
| Template Engine | EJS | 3.1.10 |
| Session | express-session | 1.18.0 |
| Security Headers | helmet | 7.1.0 |
| Logging | morgan | 1.10.0 |
| UUID Generation | uuid | 10.0.0 |

### Infrastructure

| Component | Service |
|-----------|---------|
| Container Hosting | Google Cloud Run |
| Container Registry | Google Artifact Registry |
| Secrets Management | Google Secret Manager |
| Load Balancer | Google Cloud HTTPS Load Balancer (External Managed) |
| Authentication Proxy | Google Identity-Aware Proxy (IAP) |
| SSL Certificate | Google Managed SSL Certificate |
| Static IP | Google Cloud Global Static IP |
| Container Build | Google Cloud Build |

---

## 4. GCP Infrastructure

### Project Details

| Setting | Value |
|---------|-------|
| **Project ID** | `jit-admin-portal` |
| **Project Number** | `65719149240` |
| **Region** | `us-central1` |
| **Static IP** | `34.128.181.49` |
| **App URL (via LB)** | `https://34.128.181.49.nip.io` |
| **Cloud Run URL (direct)** | `https://jit-admin-portal-65719149240.us-central1.run.app` |

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
- `iap.googleapis.com`
- `compute.googleapis.com`

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
| `service-65719149240@gcp-sa-iap.iam.gserviceaccount.com` | `roles/run.invoker` (on Cloud Run service) |

### Cloud Run IAM Policy

```yaml
bindings:
- members:
  - domain:test.nfiindustries.com
  - serviceAccount:service-65719149240@gcp-sa-iap.iam.gserviceaccount.com
  - user:victor.vo@test.nfiindustries.com
  role: roles/run.invoker
```

### IAP Configuration

| Setting | Value |
|---------|-------|
| OAuth Client ID | `65719149240-8u8259ml1bt1gbj443lo3ft213t5c93a.apps.googleusercontent.com` |
| Authorized Redirect URI | `https://iap.googleapis.com/v1/oauth/clientIds/65719149240-8u8259ml1bt1gbj443lo3ft213t5c93a.apps.googleusercontent.com:handleRedirect` |
| IAP Access (user) | `victor.vo@test.nfiindustries.com` → `roles/iap.httpsResourceAccessor` |
| IAP Access (domain) | `test.nfiindustries.com` → `roles/iap.httpsResourceAccessor` |

### Organization Policy Constraint

The org policy `iam.allowedPolicyMemberDomains` restricts IAM policy members to customer `C012imv50`. This means:
- ❌ `allUsers` is blocked (no public access to Cloud Run)
- ❌ `allAuthenticatedUsers` may be blocked
- ✅ `user:` and `domain:` within `test.nfiindustries.com` are allowed
- ✅ IAP is required for browser-based access

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
| **Sign-in Redirect URI** | `https://34.128.181.49.nip.io/authorization-code/callback` |
| **Sign-out Redirect URI** | `https://34.128.181.49.nip.io` |
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
jit-portal/
├── Dockerfile                          # Container build (Node 20 slim)
├── package.json                        # Dependencies
├── src/
│   ├── server.js                       # Main Express app (updated with error handling)
│   ├── services/
│   │   └── workflowsService.js         # OAuth 2.0 + Workflow invocation
│   ├── middleware/
│   │   └── validation.js               # Request validation
│   ├── views/
│   │   ├── home.ejs                    # Landing page with sign-in button
│   │   ├── dashboard.ejs              # JIT request form
│   │   ├── profile.ejs                # User profile display
│   │   └── error.ejs                  # Error page
│   └── public/                         # Static assets (empty)
```

### Key Implementation Details

#### server.js (Updated Version - Currently Deployed)
- Starts on PORT 8080
- Logs all configuration values at startup (SET/NOT SET)
- Checks for required config before initializing OIDC
- Starts in "error mode" with helpful messages if config is missing
- Falls back gracefully if OIDC initialization fails
- Health check at `/health` always available
- Protected routes: `/dashboard`, `/profile`, `/api/jit-request`

#### workflowsService.js
- Generates RS256 JWT client assertion using private key
- Requests OAuth 2.0 access token from `{OKTA_ORG_URL}/oauth2/v1/token`
- Caches access token until 60 seconds before expiry
- Invokes Workflow API with Bearer token
- Automatic token refresh on 401

#### validation.js
- Validates request type (standard/emergency/extended)
- Validates duration ranges per request type
- Requires business justification (10-1000 chars)
- Requires incident ticket for emergency requests
- Ticket format: alphanumeric with hyphens, 3-30 chars

#### API Endpoint: POST /api/jit-request
```json
// Request body
{
  "requestType": "standard|emergency|extended",
  "durationMinutes": 30,
  "businessJustification": "Reason for access...",
  "incidentTicket": "INC-12345"  // Required for emergency
}

// Payload sent to Okta Workflow (requestorId from session, not user input)
{
  "requestorId": "00u...",           // From Okta OIDC session (user.sub)
  "requestorEmail": "user@company.com",
  "requestorName": "First Last",
  "durationMinutes": 30,
  "businessJustification": "...",
  "incidentTicket": "INC-12345",
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

> **Note:** Uses `npm install --omit=dev` (not `npm ci`) because there's no package-lock.json.

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
| `APP_BASE_URL` | `https://34.128.181.49.nip.io` |
| `PORT` | `8080` (set by Cloud Run) |

---

## 8. Deployment Process

### Build & Deploy Commands

```bash
# Set variables
export PROJECT_ID="jit-admin-portal"
export REGION="us-central1"
export OKTA_ORG_URL="https://nfi.oktapreview.com"
export SERVICE_URL="https://34.128.181.49.nip.io"

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
| 403 Forbidden on Cloud Run URL | Org policy blocks `allUsers` | Set up IAP with Load Balancer |
| IAP redirect_uri_mismatch | Missing redirect URI in OAuth | Added exact `handleRedirect` URI to OAuth client |
| IAP service account not provisioned | Missing IAP SA | Created via `gcloud beta services identity create --service=iap.googleapis.com` |
| `OKTA_ORG_URL` not set after update | Env vars reset on update | Included all env vars in single deploy command |

---

## 9. Current State & Issues

### ✅ What's Working

- Application builds and deploys to Cloud Run
- IAP is configured with SSL certificate on load balancer at `34.128.181.49`
- Google Workspace authentication via IAP works
- App loads through IAP (shows JIT Portal landing page)
- All secrets stored in GCP Secret Manager
- IAP redirect URI configured correctly
- IAP service account has Cloud Run invoker permission

### ❌ Current Blocker

**Okta authentication policy blocking sign-in**

When user clicks "Sign In with Okta", Okta returns:
```
error=access_denied
error_description=Policy+evaluation+failed+for+this+request,+please+check+the+policy+configurations.
```

This is **NOT** an app assignment issue (that was fixed). This is an **Okta Authentication Policy** issue.

### Probable Causes

1. **Authentication Policy on the OIDC App** may have rules that:
   - Restrict by network zone (the request comes from GCP's IP, not the user's IP)
   - Require device trust/managed device
   - Require specific MFA enrollment
   - Restrict by user group membership

2. **Global Session Policy** may have restrictive rules

3. **Sign-On Policy** for the app may deny access

### Where to Look in Okta

1. **Applications** → **JIT Admin Request Portal** → **Sign On** tab → Check authentication policy
2. **Security** → **Authentication Policies** → Find policy assigned to the app
3. **Security** → **Global Session Policy** → Check rules
4. Check if network zones are restricting GCP IP ranges

---

## 10. Next Steps to Complete

### Immediate: Fix Okta Authentication Policy

1. In Okta Admin Console, go to **Applications** → **JIT Admin Request Portal** → **Sign On** tab
2. Identify the assigned Authentication Policy
3. Either:
   - Edit the policy to allow access from any network/device
   - Create a new permissive policy and assign it to this app
   - Add a rule that allows the app to work from any location
4. Test sign-in again at `https://34.128.181.49.nip.io`

### After Okta Auth is Working

1. **Test the full flow**: Sign in → Submit JIT request → Verify workflow triggered
2. **Configure the JIT-Admin-Request workflow** in Okta Workflows (per the implementation guide)
3. **Set up linked objects** between standard and admin accounts
4. **Create custom attributes**: `jitActivatedAt`, `jitExpiresAt`
5. **Build the deactivation workflow** (`JIT-Admin-Expire`)
6. **Configure Google Chat (Gspace) notifications**
7. **Add Bookmark App** tile in Okta dashboard for easy access
8. **Set up proper DNS** instead of nip.io for production

### Production Readiness

- [ ] Replace nip.io with a proper domain
- [ ] Configure proper SSL certificate for domain
- [ ] Set up monitoring and alerting
- [ ] Create Okta groups and assign users
- [ ] Test approval workflow
- [ ] Test automatic expiration
- [ ] Document runbooks for operations team
- [ ] Set up Cloud Run min-instances for faster cold starts (optional)

---

## 11. Useful Commands Reference

### Cloud Shell Setup (After Session Expiry)

```bash
gcloud auth login
export PROJECT_ID="jit-admin-portal"
export REGION="us-central1"
export OKTA_ORG_URL="https://nfi.oktapreview.com"
export SERVICE_URL="https://34.128.181.49.nip.io"
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

### Check IAP Status

```bash
gcloud compute backend-services describe jit-portal-backend --global --format="yaml(iap)"
```

### Check SSL Certificate Status

```bash
gcloud compute ssl-certificates describe jit-portal-cert --global --format="get(managed.status)"
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
  --set-env-vars "APP_BASE_URL=https://34.128.181.49.nip.io" \
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

### Proxy for Local Testing (Bypasses IAP)

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

*Document Version: 1.0*
*Last Updated: January 30, 2026*
*Session Context: Claude AI Project - JIT Admin Portal Implementation*
