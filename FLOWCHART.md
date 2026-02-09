# JIT Admin Portal - Unified End-to-End Flowchart

> A consolidated view of the complete request lifecycle — from browser entry through authentication, authorization, JIT request processing, and response. For detailed breakdowns of each subsystem, see [ARCHITECTURE.md](ARCHITECTURE.md).

```mermaid
flowchart TD
    %% ===== ENTRY =====
    User["User (Browser)"]

    User -->|"HTTPS"| CR

    subgraph GCP["Google Cloud Platform"]
        CR["Cloud Run<br/>jit-admin-portal"]
    end

    CR --> Express["Express.js :8080"]

    %% ===== MIDDLEWARE PIPELINE =====
    subgraph Pipeline["Middleware Pipeline"]
        direction TB
        TP["Trust Proxy"] --> HM["Helmet<br/>Security Headers"]
        HM --> BP["Body Parsers<br/>JSON + URL (10kb)"]
        BP --> SF["Static Files<br/>/public, 1-day cache"]
        SF --> RL["Request Logger<br/>Correlation ID"]
        RL --> SM["Session Manager<br/>httpOnly, 1hr maxAge"]
        SM --> OIDC["OIDC Router<br/>@okta/oidc-middleware"]
    end

    Express --> TP

    OIDC --> RM{"Route Matching"}

    %% ===== ROUTES =====
    RM -->|"GET /health"| Health["200 Health OK"]
    RM -->|"GET /"| Redirect["302 Redirect<br/>to /dashboard"]
    RM -->|"GET /logout"| Logout["Revoke Token<br/>Destroy Session<br/>Okta Logout"]
    RM -->|"* (no match)"| NotFound["404 Error Page"]
    RM -->|"GET /dashboard<br/>GET /profile<br/>POST /api/jit-request"| Protected

    %% ===== PROTECTED MIDDLEWARE =====
    subgraph Protected["Protected Route Guards"]
        direction TB
        RateLim["Rate Limiter<br/>Pages 100/15min<br/>API 30/hr"]
        EnsOidc["ensureOidc()<br/>OIDC initialized?"]
        EnsAuth{"ensureAuthenticated()<br/>Valid session?"}
        ReqGrp{"requireGroup()<br/>JIT-Eligible-Users?"}

        RateLim --> EnsOidc --> EnsAuth
        EnsAuth -->|"Yes"| ReqGrp
    end

    %% ===== AUTH FLOW (no session) =====
    EnsAuth -->|"No session"| OktaAuth

    subgraph Okta["Okta (nfi.oktapreview.com)"]
        OktaAuth["Authorization Server<br/>/oauth2/default"]
        OktaToken["Token Endpoint<br/>/oauth2/v1/token"]
        OktaWF["Workflows API<br/>JIT-Admin-Request"]
    end

    OktaAuth -->|"Auth Code Flow<br/>openid profile email"| Callback["Callback<br/>/authorization-code/callback"]
    Callback -->|"Exchange code for tokens<br/>Create session (jit.sid)"| EnsAuth

    %% ===== AUTHORIZATION RESULT =====
    ReqGrp -->|"Not in group"| Forbidden["403 Access Denied"]
    ReqGrp -->|"Authorized"| RouteType{"Route Type?"}

    %% ===== DASHBOARD / PROFILE =====
    RouteType -->|"GET /dashboard"| RenderDash["Render dashboard.ejs"]
    RouteType -->|"GET /profile"| RenderProf["Render profile.ejs"]

    %% ===== JIT REQUEST PATH =====
    RouteType -->|"POST /api/jit-request"| Validate{"validateJitRequest<br/>type, duration,<br/>justification?"}

    Validate -->|"Invalid"| ValErr["400 Validation Error"]
    Validate -->|"Valid"| BuildPayload["Build Payload<br/>requestorId, email,<br/>name, correlationId"]

    BuildPayload --> WFService

    subgraph WFService["workflowsService"]
        direction TB
        CB{"Circuit Breaker<br/>State?"}
        GetToken{"Cached token<br/>valid?"}
        GenJWT["Generate Client Assertion<br/>RS256 JWT<br/>(kid, iss, sub, aud, jti)"]
        FetchToken["POST /oauth2/v1/token<br/>client_credentials +<br/>client_assertion"]
        CacheToken["Cache Token<br/>(refresh 60s before expiry)"]
        CallWF["POST Workflow URL<br/>Bearer token + payload"]
        RetryLogic{"Response?"}
        RecordOk["recordSuccess()"]
        RecordFail["recordFailure()"]

        CB -->|"Closed / Half-Open"| GetToken
        GetToken -->|"Valid"| CallWF
        GetToken -->|"Expired / Missing"| GenJWT
        GenJWT --> FetchToken
        FetchToken --> CacheToken --> CallWF
        CallWF --> RetryLogic
        RetryLogic -->|"2xx Success"| RecordOk
        RetryLogic -->|"401 Unauthorized"| ClearCache["Clear token cache<br/>Retry with fresh token"]
        ClearCache --> GetToken
        RetryLogic -->|"Error"| RecordFail
        RecordFail -->|"Retries left?<br/>Exponential backoff"| CallWF
    end

    CB -->|"Open<br/>(5 failures, 60s reset)"| CircuitOpen["503 Service<br/>Unavailable"]
    RecordOk --> Success["200 Success<br/>{requestId, details}"]
    RecordFail -->|"Max retries<br/>exhausted"| Gateway["502 Bad Gateway"]

    FetchToken -.->|"OAuth 2.0<br/>Private Key JWT"| OktaToken
    CallWF -.->|"Invoke"| OktaWF

    %% ===== STYLES =====
    classDef oktaStyle fill:#1662dd,color:#fff,stroke:#0d47a1
    classDef gcpStyle fill:#4285f4,color:#fff,stroke:#1a73e8
    classDef errStyle fill:#c62828,color:#fff,stroke:#b71c1c
    classDef okStyle fill:#2e7d32,color:#fff,stroke:#1b5e20
    classDef warnStyle fill:#ef6c00,color:#fff,stroke:#e65100

    class OktaAuth,OktaToken,OktaWF oktaStyle
    class CR gcpStyle
    class Forbidden,ValErr,NotFound,CircuitOpen,Gateway errStyle
    class Health,Success,RenderDash,RenderProf okStyle
    class Logout,Redirect warnStyle
```

## Legend

| Color | Meaning |
|-------|---------|
| 🟢 Green | Success responses (200, rendered pages) |
| 🔴 Red | Error responses (400, 403, 404, 502, 503) |
| 🔵 Blue | Okta services (Auth Server, Token Endpoint, Workflows API) |
| 🟠 Orange | Redirects and session actions (302, logout) |
| ⬜ Default | Internal processing nodes |

## Flow Summary

1. **Entry**: User hits Cloud Run via HTTPS → Express middleware pipeline processes the request
2. **Routing**: Unprotected routes (`/health`, `/`, `/logout`, `404`) resolve immediately
3. **Auth Guards**: Protected routes pass through rate limiting → OIDC check → session check → group membership
4. **Okta OIDC**: If no session, the user is redirected to Okta for Auth Code Flow, then returned via callback
5. **Page Renders**: Authorized `GET` requests render `dashboard.ejs` or `profile.ejs`
6. **JIT Request**: `POST /api/jit-request` validates input, builds payload, and enters the workflow service
7. **Workflow Service**: Circuit breaker check → OAuth 2.0 token acquisition (cached or fresh via RS256 JWT) → invoke Okta Workflows API with retry logic (up to 3 attempts, exponential backoff, 401 token refresh)
8. **Responses**: Success (200), validation error (400), forbidden (403), bad gateway (502), or circuit open (503)
