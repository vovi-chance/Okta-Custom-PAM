# JIT Admin Request Portal

**Version 2.0.0** | Node.js 20 | Google Cloud Run | Okta OIDC

A production-hardened web portal for NFI Industries that enables authorized users to request temporary (Just-In-Time) privileged admin access. Requests are authenticated through Okta OIDC, authorized via Okta group membership, and fulfilled by invoking an Okta Workflow. The app runs directly on Google Cloud Run with a dedicated service account for invocation (no load balancer).

---

## Table of Contents

- [Architecture](#architecture)
- [Authentication Flow](#authentication-flow)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Security Features](#security-features)
- [Configuration](#configuration)
- [GCP Infrastructure](#gcp-infrastructure)
- [Okta Configuration](#okta-configuration)
- [Deployment](#deployment)
- [Routes and API](#routes-and-api)
- [JIT Request Types](#jit-request-types)
- [Accessing Google Cloud for Continued Work](#accessing-google-cloud-for-continued-work)
- [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)
- [Known Issues and Notes](#known-issues-and-notes)

---

## Architecture

```
User (Browser)
  |
  v
Cloud Run: jit-admin-portal (Express.js on port 8080)
  |       ← HTTPS provided natively by Cloud Run
  |       ← Authenticated via service account (jit-portal-invoker)
  |       ← Runs as service account (jit-portal-runner)
  |
  +--> Okta OIDC (@okta/oidc-middleware)  (Layer 1 - Okta identity)
  |      |
  |      +--> ID Token "JIT-groups" claim --> Group-based authorization
  |
  +--> Okta Workflows API  (Layer 2 - OAuth 2.0 Private Key JWT)
         |
         +--> JIT-Admin-Request workflow (processes access request)
```

### Two Authentication Layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| 1 | Okta OIDC (Authorization Code flow) | Verifies Okta identity via `nfi.oktapreview.com/oauth2/default`. ID token carries the `JIT-groups` custom claim for authorization. |
| 2 | OAuth 2.0 Private Key JWT (RS256) | Machine-to-machine auth for the backend to invoke the Okta Workflows API with `client_credentials` grant. |

---

## Authentication Flow

1. User navigates to the Cloud Run service URL
2. The Express app serves the landing page
3. User clicks "Sign In with Okta" which redirects to Okta's `/authorize` endpoint
4. Okta authenticates the user and redirects back to `/authorization-code/callback`
5. The OIDC middleware validates the tokens and creates a session
6. The authorization middleware decodes the ID token, reads the `JIT-groups` claim, and verifies the user is in the `JIT-Eligible-Users` group
7. User sees the dashboard and can submit JIT access requests
8. On form submission, the server authenticates to the Okta Workflows API using a private key JWT, obtains a bearer token, and invokes the `JIT-Admin-Request` workflow

---

## Tech Stack

### Application

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `express` | 4.21.0 | Web framework |
| `@okta/oidc-middleware` | 5.4.1 | Okta OpenID Connect authentication |
| `jose` | 5.9.6 | RS256 JWT signing for Workflows API auth |
| `helmet` | 7.1.0 | Security headers and Content Security Policy |
| `express-session` | 1.18.0 | Session management with hardened cookies |
| `express-rate-limit` | 7.4.1 | Per-user rate limiting (API and page) |
| `ejs` | 3.1.10 | Server-side HTML templating |
| `uuid` | 10.0.0 | Correlation IDs and JWT JTI claims |

### Infrastructure

| Service | Purpose |
|---------|---------|
| Google Cloud Run | Container hosting (managed, serverless, with native HTTPS) |
| Google Cloud Build | Container image builds |
| Google Artifact Registry | Docker image storage |
| Google Secret Manager | Stores 7 secrets (session key, Okta credentials, workflow keys) |

### Okta

| Component | Purpose |
|-----------|---------|
| OIDC Web App ("JIT Admin Request Portal") | User authentication via Authorization Code flow |
| API Services App ("JIT Portal - Workflow Invoker") | Machine-to-machine auth with private key JWT |
| Authorization Server (`/oauth2/default`) | Issues tokens with custom `JIT-groups` claim |
| Okta Workflows (`JIT-Admin-Request`) | Processes JIT access requests |

---

## Project Structure

```
jit-admin-portal/
├── src/
│   ├── server.js                    # Main Express app (routes, middleware, OIDC init)
│   ├── middleware/
│   │   ├── authorization.js         # Group-based authorization (JIT-groups claim)
│   │   ├── rateLimiter.js           # API (30/hr) and page (100/15min) rate limiters
│   │   └── validation.js            # JIT request payload validation and sanitization
│   ├── services/
│   │   └── workflowsService.js      # OAuth 2.0 private key JWT, circuit breaker, retry logic
│   ├── utils/
│   │   └── logger.js                # Structured JSON logging for Google Cloud Logging
│   ├── views/
│   │   ├── home.ejs                 # Landing page with sign-in button
│   │   ├── dashboard.ejs            # JIT request form (protected)
│   │   ├── profile.ejs              # User profile and group memberships
│   │   └── error.ejs                # Error display page
│   └── public/                      # Static assets directory
├── Dockerfile                       # Node 20-slim, non-root user, health check
├── deploy.sh                        # Automated Cloud Run deployment script
├── package.json                     # Dependencies and scripts
├── package-lock.json                # Locked dependency versions
├── .gitignore
├── .dockerignore
└── Implementation-Summary.md        # Original architecture notes (v1)
```

---

## Security Features

### Defense-in-Depth Layers

1. **Network** -- Cloud Run set to `--no-allow-unauthenticated`; access restricted to `jit-portal-invoker` service account via `roles/run.invoker`
2. **Transport** -- HTTPS provided natively by Cloud Run; secure cookies enforced in production
3. **Headers** -- Helmet sets CSP, X-Frame-Options, X-Content-Type-Options, and more
4. **Authentication (Okta)** -- OIDC Authorization Code flow with session validation
5. **Authorization** -- ID token `JIT-groups` claim checked against required group (`JIT-Eligible-Users`)
7. **Rate Limiting** -- API: 30 requests/hour per user; Pages: 100 requests/15 minutes per user
8. **Input Validation** -- Schema-based validation with sanitization on all JIT request payloads
9. **Session Hardening** -- `httpOnly`, `sameSite: lax`, `secure: true`, 1-hour `maxAge`, custom cookie name `jit.sid`
10. **API Security** -- OAuth 2.0 Private Key JWT (RS256) for machine-to-machine Workflows API auth; tokens cached with 60s refresh buffer; JTI prevents replay
11. **Resilience** -- Circuit breaker (5-failure threshold, 60s reset), retry with exponential backoff (2 retries), 30s request timeouts
12. **Observability** -- Structured JSON logging with request correlation IDs, compatible with Google Cloud Logging

### Content Security Policy

```
default-src 'self'
script-src  'self' 'unsafe-inline'
style-src   'self' 'unsafe-inline' fonts.googleapis.com
font-src    'self' fonts.gstatic.com
img-src     'self' data:
connect-src 'self'
frame-src   'none'
object-src  'none'
form-action 'self'
```

### Container Security

- Base image: `node:20-slim` (minimal attack surface)
- Runs as non-root `nodejs` user
- Production dependencies only (`npm install --omit=dev`)
- npm cache cleaned after install

---

## Configuration

### Environment Variables

| Variable | Source | Description |
|----------|--------|-------------|
| `NODE_ENV` | Set in deploy | `production` in Cloud Run |
| `PORT` | Cloud Run default | `8080` |
| `OKTA_ORG_URL` | Set in deploy | `https://nfi.oktapreview.com` |
| `APP_BASE_URL` | Set in deploy | Cloud Run service URL (auto-detected) |
| `SESSION_SECRET` | Secret Manager | Express session encryption key |
| `OKTA_CLIENT_ID` | Secret Manager | OIDC web app client ID |
| `OKTA_CLIENT_SECRET` | Secret Manager | OIDC web app client secret |
| `OKTA_WORKFLOWS_CLIENT_ID` | Secret Manager | Workflows API service app client ID |
| `OKTA_WORKFLOWS_KEY_ID` | Secret Manager | Workflows API public key ID |
| `OKTA_WORKFLOWS_PRIVATE_KEY` | Secret Manager | Workflows API private key (PEM, RS256) |
| `OKTA_WORKFLOWS_INVOKE_URL` | Secret Manager | Workflows API endpoint URL |

### GCP Secret Manager Secrets

| Secret Name | Maps To |
|-------------|---------|
| `jit-portal-session-secret` | `SESSION_SECRET` |
| `jit-portal-okta-client-id` | `OKTA_CLIENT_ID` |
| `jit-portal-okta-client-secret` | `OKTA_CLIENT_SECRET` |
| `jit-portal-wf-client-id` | `OKTA_WORKFLOWS_CLIENT_ID` |
| `jit-portal-wf-key-id` | `OKTA_WORKFLOWS_KEY_ID` |
| `jit-portal-wf-private-key` | `OKTA_WORKFLOWS_PRIVATE_KEY` |
| `jit-portal-wf-invoke-url` | `OKTA_WORKFLOWS_INVOKE_URL` |

---

## GCP Infrastructure

| Property | Value |
|----------|-------|
| Project ID | `jit-admin-portal` |
| Project Number | `65719149240` |
| Region | `us-central1` |
| Artifact Registry Repo | `jit-admin-repo` |
| Runner Service Account | `jit-portal-runner@jit-admin-portal.iam.gserviceaccount.com` |
| Invoker Service Account | `jit-portal-invoker@jit-admin-portal.iam.gserviceaccount.com` |

### GCP Resources

- **Cloud Run Service** -- `jit-admin-portal` (managed, us-central1)
- **Artifact Registry** -- `jit-admin-repo` (Docker format, us-central1)
- **Secret Manager** -- 7 secrets storing all credentials
- **Cloud Build** -- Builds Docker images from source

### Service Accounts

| Service Account | Purpose |
|----------------|--------|
| `jit-portal-runner` | Cloud Run runtime identity (reads secrets, writes logs) |
| `jit-portal-invoker` | Authorized to invoke the Cloud Run service (`roles/run.invoker`) |

### IAM

- Runner SA: `roles/secretmanager.secretAccessor`, `roles/logging.logWriter`
- Invoker SA: `roles/run.invoker` (on Cloud Run service)
- Cloud Build SA: `roles/run.admin`, `roles/iam.serviceAccountUser` (on runner SA)
- Organization policy: `iam.allowedPolicyMemberDomains` restricts to customer ID `C012imv50`

### APIs Enabled

`run.googleapis.com`, `cloudbuild.googleapis.com`, `secretmanager.googleapis.com`, `artifactregistry.googleapis.com`

---

## Okta Configuration

**Org URL:** `https://nfi.oktapreview.com`

### Application 1: OIDC Web App

| Setting | Value |
|---------|-------|
| Name | JIT Admin Request Portal |
| Sign-in method | OIDC |
| Application type | Web Application |
| Grant type | Authorization Code |
| Sign-in redirect URI | Cloud Run service URL + `/authorization-code/callback` |
| Sign-out redirect URI | Cloud Run service URL |
| Scopes | `openid`, `profile`, `email` |
| Authorization Server | `default` (`/oauth2/default`) |

### Application 2: API Services App

| Setting | Value |
|---------|-------|
| Name | JIT Portal - Workflow Invoker |
| Sign-in method | OIDC |
| Application type | API Services |
| Authentication | Public key / Private key (RS256) |
| Scope | `okta.workflows.invoke.manage` |
| Grant type | Client Credentials |

### Authorization Server Custom Claim

On the `default` authorization server (`Security > API > default > Claims`):

| Setting | Value |
|---------|-------|
| Claim name | `JIT-groups` |
| Include in | ID Token (Always) |
| Value type | Groups |
| Filter | Matches regex `.*` (or specific group filter) |

### Required Okta Groups

| Group | Purpose |
|-------|---------|
| `JIT-Eligible-Users` | Users authorized to request JIT access (required for dashboard) |
| `JIT-Approvers` | Users who can approve JIT requests |
| `JIT-Admins-Active` | Users with currently active JIT admin access |
| `Admin-Accounts-All` | All admin-level accounts |

### Authorization Server Access Policy

The `default` authorization server must have an Access Policy that allows the JIT Admin Request Portal app to obtain tokens. Configure under `Security > API > default > Access Policies`.

---

## Deployment

### Prerequisites

- Google Cloud SDK (`gcloud`) authenticated with project access
- Artifact Registry repository created:
  ```bash
  gcloud artifacts repositories create jit-admin-repo \
    --repository-format=docker \
    --location=us-central1 \
    --description="JIT Admin Portal container images"
  ```
- All 7 secrets created in GCP Secret Manager
- Okta applications configured with correct redirect URIs

### Quick Deploy (using deploy.sh)

```bash
# Default deployment (uses Cloud Run native URL)
./deploy.sh

# With custom domain (Cloud Run domain mapping)
./deploy.sh --domain jit.nfiindustries.com

# Build container only (no deploy)
./deploy.sh --build-only

# Override project or region
./deploy.sh --project my-project --region us-east1
```

### Manual Build and Deploy

```bash
# Build and push container image
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/jit-admin-portal/jit-admin-repo/jit-admin-portal:latest

# Deploy to Cloud Run
gcloud run deploy jit-admin-portal \
  --image us-central1-docker.pkg.dev/jit-admin-portal/jit-admin-repo/jit-admin-portal:latest \
  --region us-central1
```

> **Note:** The `deploy.sh` script references repo name `jit-portal-repo`. If you created the repository as `jit-admin-repo`, either update the script or use the manual commands above with `jit-admin-repo`.

### Cloud Run Settings

| Setting | Value |
|---------|-------|
| Platform | Managed |
| Region | us-central1 |
| Port | 8080 |
| Memory | 512Mi |
| CPU | 1 vCPU |
| Min instances | 1 (no cold starts) |
| Max instances | 10 |
| Concurrency | 80 requests/instance |
| Request timeout | 60 seconds |
| Authentication | Required (`--no-allow-unauthenticated`) |

---

## Routes and API

| Method | Path | Protection | Description |
|--------|------|-----------|-------------|
| GET | `/` | Page rate limiter | Landing page. Shows sign-in or dashboard button based on auth state. |
| GET | `/dashboard` | Page limiter, OIDC auth, `JIT-Eligible-Users` group | JIT request form. Displays request types, duration ranges, and submission form. |
| GET | `/profile` | Page limiter, OIDC auth | User profile page showing Okta claims and group memberships. |
| POST | `/api/jit-request` | API limiter, OIDC auth, `JIT-Eligible-Users` group, validation | Submits a JIT access request. Invokes Okta Workflow. Returns JSON. |
| GET | `/logout` | None | Destroys session and redirects to Okta logout. |
| GET | `/health` | None (always available) | Health check. Returns service status, OIDC state, memory usage. |
| GET | `/authorization-code/callback` | OIDC middleware | Okta OIDC callback. Handled automatically by `@okta/oidc-middleware`. |

### POST /api/jit-request

**Request body:**
```json
{
  "requestType": "standard | emergency | extended",
  "durationMinutes": 30,
  "businessJustification": "Reason for requesting admin access...",
  "incidentTicket": "INC-12345"
}
```

`incidentTicket` is required only for `emergency` requests.

**Success response (200):**
```json
{
  "success": true,
  "message": "JIT admin access request submitted successfully",
  "requestId": "uuid",
  "details": {
    "requestType": "standard",
    "durationMinutes": 30,
    "requestor": "user@example.com"
  }
}
```

**Error response (4xx/5xx):**
```json
{
  "success": false,
  "error": "Error description",
  "correlationId": "uuid"
}
```

---

## JIT Request Types

| Type | Duration Range | Approval | Incident Ticket |
|------|---------------|----------|----------------|
| Standard | 15 -- 240 minutes | Manager approval | Not required |
| Emergency | 15 -- 480 minutes | Auto-approved | Required (alphanumeric + hyphens, 3-30 chars) |
| Extended | 60 -- 480 minutes | Manager approval | Not required |

All requests require a business justification (10--1000 characters).

---

## Accessing Google Cloud for Continued Work

### Google Cloud Console

Open the project directly:
```
https://console.cloud.google.com/home/dashboard?project=jit-admin-portal
```

### Google Cloud Shell

1. Go to https://console.cloud.google.com
2. Click the **Cloud Shell** icon (terminal icon in the top-right toolbar)
3. Cloud Shell opens with `gcloud` pre-authenticated

The application source files should be in:
```
~/jit-portal/
```

If the files are not present, upload them from your local machine or re-create them.

### Key gcloud Commands

**View application logs:**
```bash
gcloud run services logs read jit-admin-portal --region us-central1 --limit 50
```

**Stream logs in real time:**
```bash
gcloud beta run services logs tail jit-admin-portal --region us-central1
```

**Check service status:**
```bash
gcloud run services describe jit-admin-portal --region us-central1
```

**List revisions:**
```bash
gcloud run revisions list --service jit-admin-portal --region us-central1
```

**Update a secret:**
```bash
echo -n "new-value" | gcloud secrets versions add jit-portal-session-secret --data-file=-
```

**Redeploy (after updating code in Cloud Shell):**
```bash
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/jit-admin-portal/jit-admin-repo/jit-admin-portal:latest \
  && gcloud run deploy jit-admin-portal \
  --image us-central1-docker.pkg.dev/jit-admin-portal/jit-admin-repo/jit-admin-portal:latest \
  --region us-central1
```

**Check service account permissions:**
```bash
gcloud run services get-iam-policy jit-admin-portal --region us-central1
```

**Check invoker SA binding:**
```bash
gcloud run services get-iam-policy jit-admin-portal --region us-central1 --format='yaml(bindings)'
```

**Test health check:**
```bash
# Get identity token for the invoker SA, then curl
CLOUD_RUN_URL=$(gcloud run services describe jit-admin-portal --region us-central1 --format='value(status.url)')
curl -s "${CLOUD_RUN_URL}/health" -H "Authorization: Bearer $(gcloud auth print-identity-token)" | python3 -m json.tool
```

---

## Monitoring and Troubleshooting

### Health Check Endpoint

`GET /health` returns:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-30T...",
  "version": "2.0.0",
  "uptime": 12345,
  "checks": {
    "oidcConfigured": true,
    "workflowConfigured": true,
    "memoryUsage": { "rss": "...", "heapUsed": "..." }
  }
}
```

Returns HTTP 200 when OIDC is configured, 503 otherwise.

### Structured Logging

All logs are written as JSON to stdout/stderr, automatically ingested by Google Cloud Logging. Each request gets a correlation ID (`X-Request-Id` header) for tracing.

View logs in Cloud Console:
```
https://console.cloud.google.com/logs/query?project=jit-admin-portal
```

Filter by severity:
```
resource.type="cloud_run_revision"
resource.labels.service_name="jit-admin-portal"
severity>=ERROR
```

### Common Issues and Fixes

**"Policy evaluation failed" on Okta sign-in:**
The Authorization Server Access Policy on `/oauth2/default` must include a rule that allows the JIT Admin Request Portal app. Go to `Security > API > default > Access Policies` in Okta Admin.

**"PKCS8 must be PKCS#8 formatted string" error:**
The private key PEM from Secret Manager has its newlines stripped. The application handles this automatically with PEM normalization in `workflowsService.js`. If the error persists, verify the secret value contains a valid RSA private key.

**"No groups claim found in ID token" / groups missing:**
The custom claim on the Okta authorization server must be named `JIT-groups` and configured to include in the ID token. Verify under `Security > API > default > Claims`. The code reads `claims['JIT-groups']` from the decoded ID token.

**Container fails to start (MODULE_NOT_FOUND):**
Ensure the `package.json` in Cloud Shell matches the local version with all dependencies (especially `express-rate-limit`). Rebuild the container after updating.

**Artifact Registry "Repository not found":**
The repository may have been deleted. Recreate it:
```bash
gcloud artifacts repositories create jit-admin-repo \
  --repository-format=docker \
  --location=us-central1
```

**500 on /dashboard (authorization middleware):**
Check Cloud Run logs for the specific error. Common causes:
- `JIT-groups` claim not configured on the authorization server
- User not assigned to the OIDC app in Okta
- Access Policy not allowing token issuance

---

## Known Issues and Notes

- **In-memory sessions**: Sessions are stored in-memory (default Express session store). Sessions are lost when Cloud Run instances restart or scale. For multi-instance or persistent sessions, add a Redis-backed session store (e.g., Google Cloud Memorystore).
- **Okta preview environment**: The Okta org `nfi.oktapreview.com` is a preview/sandbox environment. For production, update `OKTA_ORG_URL` to the production Okta org and reconfigure both Okta applications.
- **Repo name mismatch**: `deploy.sh` references `jit-portal-repo` while the Artifact Registry was created as `jit-admin-repo`. Either update the script or use manual deploy commands.
- **Okta Workflow**: The `JIT-Admin-Request` workflow in Okta Workflows needs to be built to handle the incoming request payload (requestType, duration, justification, requestor info) and implement the approval/provisioning logic.
- **Custom domain**: For production, use `./deploy.sh --domain your-domain.com` to set up Cloud Run domain mapping with a proper hostname. Update Okta redirect URIs to match.
