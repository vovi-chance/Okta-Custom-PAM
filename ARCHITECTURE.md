# JIT Admin Portal - Architecture

---

## 1. System Architecture

```mermaid
flowchart TB
    subgraph User["User (Browser)"]
        Browser["Web Browser"]
    end

    subgraph GCP["Google Cloud Platform"]
        subgraph CloudRun["Cloud Run: jit-admin-portal"]
            Express["Express.js Application<br/>Port 8080"]
        end
        SecretMgr["Secret Manager<br/>7 Secrets"]
        ArtifactReg["Artifact Registry<br/>Docker Images"]
        CloudBuild["Cloud Build"]
    end

    subgraph Okta["Okta (nfi.oktapreview.com)"]
        AuthServer["Authorization Server<br/>/oauth2/default"]
        WorkflowsAPI["Workflows API<br/>JIT-Admin-Request"]
    end

    Browser -->|"HTTPS"| CloudRun
    SecretMgr -->|"Inject secrets at deploy"| CloudRun
    Express -->|"1. OIDC Auth Code Flow"| AuthServer
    Express -->|"2. OAuth 2.0 Private Key JWT"| WorkflowsAPI
    CloudBuild -->|"Push image"| ArtifactReg
    ArtifactReg -->|"Pull image"| CloudRun
```

---

## 2. Request Pipeline (Middleware Stack)

```mermaid
flowchart TD
    Request["Incoming HTTP Request"] --> TrustProxy["Trust Proxy<br/><i>app.set('trust proxy', 1)</i>"]
    TrustProxy --> Helmet["Helmet Security Headers<br/><i>CSP, X-Frame-Options, etc.</i>"]
    Helmet --> BodyJSON["JSON Body Parser<br/><i>10kb limit</i>"]
    BodyJSON --> BodyURL["URL-Encoded Parser<br/><i>10kb limit</i>"]
    BodyURL --> Static["Static Files<br/><i>/public, 1-day cache</i>"]
    Static --> ReqLogger["Request Logger<br/><i>Correlation ID, req.log</i>"]
    ReqLogger --> Session["Session Manager<br/><i>httpOnly, sameSite, 1hr maxAge</i>"]
    Session --> OIDC["OIDC Router<br/><i>@okta/oidc-middleware</i>"]
    OIDC --> Routes["Route Matching"]

    Routes --> Health["GET /health<br/><i>No auth required</i>"]
    Routes --> Landing["GET /<br/><i>Redirect to /dashboard</i>"]
    Routes --> Dashboard["GET /dashboard"]
    Routes --> Profile["GET /profile"]
    Routes --> JIT["POST /api/jit-request"]
    Routes --> Logout["GET /logout"]

    subgraph ProtectedRoute["Protected Route Middleware"]
        RL["Rate Limiter<br/><i>Page: 100/15min | API: 30/hr</i>"]
        EO["ensureOidc()<br/><i>Check OIDC initialized</i>"]
        EA["ensureAuthenticated()<br/><i>Valid session required</i>"]
        RG["requireGroup()<br/><i>JIT-Eligible-Users</i>"]
        VJ["validateJitRequest<br/><i>Schema validation</i>"]
    end

    Dashboard --> RL --> EO --> EA --> RG --> Handler["Route Handler"]
    JIT --> RL
    RL --> EO
    EO --> EA
    EA --> RG
    RG --> VJ --> Handler
```

---

## 3. Authentication & Authorization Flow

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Express as Express App
    participant OktaAuth as Okta Authorization Server<br/>(/oauth2/default)

    User->>Browser: Navigate to /
    Browser->>Express: GET /
    Express-->>Browser: 302 Redirect to /dashboard

    Browser->>Express: GET /dashboard
    Express->>Express: ensureAuthenticated() - No session

    Express-->>Browser: 302 Redirect to Okta
    Browser->>OktaAuth: GET /authorize<br/>client_id, redirect_uri,<br/>scope=openid profile email

    User->>OktaAuth: Enter credentials
    OktaAuth-->>Browser: 302 Redirect with auth code

    Browser->>Express: GET /authorization-code/callback?code=...
    Express->>OktaAuth: POST /token (exchange code)
    OktaAuth-->>Express: ID Token + Access Token

    Note over Express: Validate ID token signature<br/>Create session (jit.sid cookie)<br/>Store tokens in session

    Express-->>Browser: 302 Redirect to /dashboard

    Browser->>Express: GET /dashboard (with session cookie)
    Express->>Express: ensureAuthenticated() - Valid session

    Note over Express: requireGroup('JIT-Eligible-Users')<br/>Extract JIT-groups from ID token<br/>Verify group membership

    alt User in JIT-Eligible-Users
        Express-->>Browser: 200 Render dashboard.ejs
    else User NOT in group
        Express-->>Browser: 403 Access Denied
    end
```

---

## 4. JIT Request Submission Flow

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Express as Express App
    participant Validation as validateJitRequest
    participant WFService as workflowsService
    participant OktaToken as Okta Token Endpoint<br/>(/oauth2/v1/token)
    participant OktaWF as Okta Workflows API

    User->>Browser: Fill form & submit
    Browser->>Express: POST /api/jit-request<br/>{requestType, durationMinutes,<br/>businessJustification}

    Express->>Express: Rate limit check (30/hr)
    Express->>Express: ensureAuthenticated()
    Express->>Express: requireGroup()

    Express->>Validation: Validate payload
    Note over Validation: Check requestType valid<br/>Check duration in range<br/>Check justification 10-1000 chars

    alt Validation fails
        Validation-->>Browser: 400 {errors: [...]}
    end

    Validation-->>Express: req.validatedBody

    Note over Express: Build payload with:<br/>requestorId (from Okta sub)<br/>requestorEmail, requestorName<br/>correlationId, timestamp

    Express->>WFService: invokeWorkflow(payload)

    WFService->>WFService: checkCircuit()
    Note over WFService: Circuit Breaker:<br/>Closed = OK<br/>Open (5 failures) = reject<br/>Half-Open (after 60s) = try one

    WFService->>WFService: getAccessToken()

    alt Token not cached or expired
        WFService->>WFService: generateClientAssertion()<br/>RS256 JWT (kid, iss, sub, aud, jti)
        WFService->>OktaToken: POST /token<br/>grant_type=client_credentials<br/>client_assertion=JWT
        OktaToken-->>WFService: {access_token, expires_in}
        Note over WFService: Cache token<br/>(refresh 60s before expiry)
    end

    loop Retry up to 3 attempts
        WFService->>OktaWF: POST workflow URL<br/>Authorization: Bearer token<br/>Body: JIT payload
        alt Success (2xx)
            OktaWF-->>WFService: Response
            WFService->>WFService: recordSuccess()
            WFService-->>Express: result
        else 401 Unauthorized
            WFService->>WFService: Clear token cache
            Note over WFService: Retry with fresh token
        else Error
            WFService->>WFService: recordFailure()
            Note over WFService: Exponential backoff<br/>then retry
        end
    end

    alt Success
        Express-->>Browser: 200 {success: true, requestId, details}
    else Circuit breaker open
        Express-->>Browser: 503 Service Unavailable
    else Other error
        Express-->>Browser: 502 Bad Gateway
    end
```

---

## 5. Deployment Pipeline

```mermaid
flowchart LR
    subgraph Local["Developer Machine"]
        Source["Source Code"]
        DeployScript["deploy.sh"]
    end

    subgraph GCP["Google Cloud Platform"]
        CloudBuild["Cloud Build<br/><i>Builds Docker image<br/>from Dockerfile</i>"]
        ArtifactReg["Artifact Registry<br/><i>us-central1-docker.pkg.dev/<br/>jit-admin-portal/<br/>jit-portal-repo</i>"]
        SecretMgr["Secret Manager<br/><i>7 secrets</i>"]
        CloudRun["Cloud Run<br/><i>jit-admin-portal<br/>us-central1</i>"]
    end

    Source -->|"gcloud builds submit"| CloudBuild
    DeployScript -->|"triggers"| CloudBuild
    CloudBuild -->|"Push image:latest"| ArtifactReg
    ArtifactReg -->|"Pull image"| CloudRun
    SecretMgr -->|"Mount as env vars"| CloudRun
    DeployScript -->|"gcloud run deploy<br/>--no-allow-unauthenticated<br/>--memory 512Mi<br/>--min-instances 1<br/>--max-instances 10"| CloudRun
```

### Container Build (Dockerfile)

```mermaid
flowchart TD
    Base["node:20-slim"] --> Install["npm install --omit=dev"]
    Install --> Copy["COPY src/ → /app/src/"]
    Copy --> Security["Create non-root user: nodejs<br/>chown -R nodejs:nodejs /app<br/>USER nodejs"]
    Security --> Config["ENV NODE_ENV=production<br/>ENV PORT=8080<br/>EXPOSE 8080"]
    Config --> Health["HEALTHCHECK<br/>GET /health every 30s"]
    Health --> Start["CMD node src/server.js"]
```

---

## 6. Security Layers (Defense-in-Depth)

```mermaid
flowchart TD
    Internet["Internet Traffic"]

    Internet --> L1
    subgraph L1["Layer 1: Network"]
        N1["Cloud Run: --no-allow-unauthenticated<br/>Requires IAM credentials to reach service"]
    end

    L1 --> L2
    subgraph L2["Layer 2: Transport"]
        N2["HTTPS enforced by Cloud Run<br/>Secure cookies in production"]
    end

    L2 --> L3
    subgraph L3["Layer 3: Security Headers"]
        N3["Helmet middleware<br/>CSP: no inline scripts/styles<br/>X-Frame-Options, X-Content-Type-Options"]
    end

    L3 --> L4
    subgraph L4["Layer 4: Authentication"]
        N4["Okta OIDC Authorization Code Flow<br/>Session validated on every request"]
    end

    L4 --> L5
    subgraph L5["Layer 5: Authorization"]
        N5["ID Token JIT-groups claim<br/>Must be in JIT-Eligible-Users group"]
    end

    L5 --> L6
    subgraph L6["Layer 6: Rate Limiting"]
        N6["API: 30 requests/hour per user<br/>Pages: 100 requests/15 min per user"]
    end

    L6 --> L7
    subgraph L7["Layer 7: Input Validation"]
        N7["Request type, duration range,<br/>justification length (10-1000 chars)"]
    end

    L7 --> L8
    subgraph L8["Layer 8: Session Hardening"]
        N8["httpOnly, sameSite: lax<br/>1-hour maxAge, custom cookie name"]
    end

    L8 --> L9
    subgraph L9["Layer 9: API Security"]
        N9["OAuth 2.0 Private Key JWT (RS256)<br/>Token caching, JTI replay prevention"]
    end

    L9 --> L10
    subgraph L10["Layer 10: Resilience"]
        N10["Circuit breaker (5 failures, 60s reset)<br/>Retry with exponential backoff<br/>30s request timeouts"]
    end

    L10 --> App["Application Logic"]
```

---

## 7. File Structure

```
jit-admin-portal/
|
+-- Dockerfile                          # Container build (node:20-slim, non-root)
+-- deploy.sh                           # GCP deployment script (Cloud Build + Cloud Run)
+-- package.json                        # Dependencies and Node.js 20 engine requirement
+-- .env.example                        # Environment variable documentation
+-- .gcloudignore                       # Files excluded from Cloud Build uploads
|
+-- src/
|   +-- server.js                       # Main Express app: middleware, routes, OIDC setup
|   |
|   +-- middleware/
|   |   +-- authorization.js            # Group-based auth (JIT-groups claim from ID token)
|   |   +-- rateLimiter.js              # Per-user rate limiting (API: 30/hr, Pages: 100/15min)
|   |   +-- validation.js              # JIT request payload validation and sanitization
|   |
|   +-- services/
|   |   +-- workflowsService.js         # Okta Workflows API client
|   |                                   #   - RS256 JWT client assertion generation
|   |                                   #   - OAuth 2.0 token caching with auto-refresh
|   |                                   #   - Circuit breaker (5 failures / 60s reset)
|   |                                   #   - Retry with exponential backoff (2 retries)
|   |
|   +-- utils/
|   |   +-- logger.js                   # Structured JSON logging (GCP Cloud Logging compatible)
|   |                                   #   - Correlation IDs (X-Request-Id header)
|   |                                   #   - Request/response logging middleware
|   |
|   +-- views/
|   |   +-- dashboard.ejs               # JIT request form (request type, duration, justification)
|   |   +-- home.ejs                    # Landing page (redirects to /dashboard)
|   |   +-- profile.ejs                 # User profile and group memberships
|   |   +-- error.ejs                   # Error display (404, 403, 500)
|   |
|   +-- public/
|       +-- css/
|       |   +-- common.css              # Shared styles (navbar, cards, buttons, typography)
|       |   +-- dashboard.css           # Dashboard form, alerts, spinner, request types table
|       |   +-- home.css                # Landing page layout
|       |   +-- profile.css             # Profile card and group list
|       |   +-- error.css               # Error page styling
|       |
|       +-- js/
|           +-- dashboard.js            # Client-side form handling (fetch API, validation, alerts)
```

---

## 8. Route Map

| Method | Path | Auth | Middleware | Handler |
|--------|------|------|-----------|---------|
| GET | `/` | None | pageLimiter | Redirect to `/dashboard` |
| GET | `/health` | None | None | JSON health status |
| GET | `/dashboard` | OIDC + Group | pageLimiter, ensureOidc, ensureAuthenticated, requireGroup | Render dashboard.ejs |
| GET | `/profile` | OIDC | pageLimiter, ensureOidc, ensureAuthenticated | Render profile.ejs |
| POST | `/api/jit-request` | OIDC + Group | apiLimiter, ensureOidc, ensureAuthenticated, requireGroup, validateJitRequest | invokeWorkflow() |
| GET | `/logout` | None | None | Revoke token, destroy session, Okta logout redirect |
| * | `*` | None | None | 404 error page |

---

## 9. Configuration

### Environment Variables

| Variable | Source | Required | Description |
|----------|--------|----------|-------------|
| `NODE_ENV` | Deploy command | Yes | `production` in Cloud Run |
| `PORT` | Cloud Run | Yes | `8080` (default) |
| `SESSION_SECRET` | Secret Manager | Yes | Express session encryption key |
| `OKTA_ORG_URL` | Deploy command | Yes | `https://nfi.oktapreview.com` |
| `APP_BASE_URL` | Deploy command | Yes | Cloud Run service URL |
| `OKTA_CLIENT_ID` | Secret Manager | Yes | OIDC web app client ID |
| `OKTA_CLIENT_SECRET` | Secret Manager | Yes | OIDC web app client secret |
| `OKTA_WORKFLOWS_CLIENT_ID` | Secret Manager | Optional | Workflows API service app client ID |
| `OKTA_WORKFLOWS_KEY_ID` | Secret Manager | Optional | Workflows API public key ID |
| `OKTA_WORKFLOWS_PRIVATE_KEY` | Secret Manager | Optional | Workflows API private key (PEM/JWK) |
| `OKTA_WORKFLOWS_INVOKE_URL` | Secret Manager | Optional | Workflow endpoint URL |

### Startup Behavior

```mermaid
flowchart TD
    Start["Server Start"] --> ValidateConfig["Validate Configuration"]
    ValidateConfig --> CheckRequired{"Required config<br/>present?"}

    CheckRequired -->|"Missing"| NoOIDC["Start WITHOUT OIDC<br/>(degraded mode)"]
    CheckRequired -->|"Present"| CheckWorkflow{"Workflow config<br/>present?"}

    CheckWorkflow -->|"Missing"| WarnWF["Log warning:<br/>Workflows disabled"]
    CheckWorkflow -->|"Present"| AllGood["All config valid"]

    WarnWF --> InitOIDC["Initialize OIDC Middleware"]
    AllGood --> InitOIDC

    InitOIDC --> OIDCResult{"OIDC init<br/>success?"}
    OIDCResult -->|"Success"| WaitReady["Wait for OIDC 'ready' event"]
    OIDCResult -->|"Error"| StartDegraded["Start in degraded mode"]

    WaitReady --> Listen["Listen on PORT 8080"]
    StartDegraded --> Listen
    NoOIDC --> Listen
```
