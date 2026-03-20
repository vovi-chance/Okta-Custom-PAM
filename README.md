# Okta Custom PAM

A self-service web portal for requesting temporary Just-In-Time (JIT) privileged admin access, powered by Okta authentication and Okta Workflows. Designed for deployment on Google Cloud Run.

## Features

- **Okta OIDC authentication** — Authorization Code flow with automatic session management
- **Group-based authorization** — Access restricted to members of a configurable Okta group
- **Three request types** — Standard, Extended, and Emergency with configurable duration ranges
- **Okta Workflows integration** — Submits JIT requests via OAuth 2.0 private key JWT (RS256)
- **Defense-in-depth security** — Helmet CSP, rate limiting, input validation, secure cookies
- **Circuit breaker & retry** — Resilient workflow invocation with exponential backoff
- **Structured logging** — JSON logs compatible with Google Cloud Logging
- **Cloud-native** — Containerized, stateless, secrets via GCP Secret Manager

## Prerequisites

- **Node.js** 20+
- **Okta tenant** with:
  - An OIDC Web Application (Authorization Code flow)
  - A custom `JIT-groups` claim on the authorization server returning group memberships
  - An Okta group (default: `JIT-Eligible-Users`) for portal access
  - Okta Workflows with a flow to process JIT requests
  - An OAuth 2.0 service app (private key JWT) for invoking workflows
- **Google Cloud Platform** project with:
  - Cloud Run, Cloud Build, Artifact Registry, and Secret Manager APIs enabled

## Project Structure

```
src/
  server.js                  # Express app, routes, middleware pipeline
  middleware/
    authorization.js         # Group-based access control
    rateLimiter.js           # Per-user rate limiting
    validation.js            # JIT request schema validation
  services/
    workflowsService.js      # Okta Workflows API client (RS256 JWT auth)
  utils/
    logger.js                # Structured JSON logger for Cloud Logging
  views/                     # EJS templates (dashboard, profile, error)
  public/                    # Static assets (CSS, client JS)
Dockerfile                   # Node 20-slim, non-root user
deploy.sh                    # Cloud Run deployment automation
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | Yes | Secret key for session encryption |
| `OKTA_ORG_URL` | Yes | Your Okta org URL (e.g. `https://your-org.okta.com`) |
| `APP_BASE_URL` | Yes | Public URL of this portal (e.g. `https://your-app.run.app`) |
| `OKTA_CLIENT_ID` | Yes | OIDC web application client ID |
| `OKTA_CLIENT_SECRET` | Yes | OIDC web application client secret |
| `OKTA_WORKFLOWS_CLIENT_ID` | No | OAuth service app client ID for Workflows API |
| `OKTA_WORKFLOWS_KEY_ID` | No | Key ID for the RS256 private key |
| `OKTA_WORKFLOWS_PRIVATE_KEY` | No | RS256 private key (PEM or JWK format) |
| `OKTA_WORKFLOWS_INVOKE_URL` | No | Okta Workflows invoke endpoint URL |
| `PORT` | No | Server port (default: `8080`) |
| `NODE_ENV` | No | Environment (`production` / `development`) |

## Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/Okta-Custom-PAM.git
   cd Okta-Custom-PAM
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   # Edit .env with your Okta and app configuration
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open `http://localhost:8080` in your browser.

## Okta Setup

### 1. OIDC Web Application

1. In Okta Admin Console, go to **Applications > Create App Integration**
2. Select **OIDC - OpenID Connect** and **Web Application**
3. Set the sign-in redirect URI to `{APP_BASE_URL}/authorization-code/callback`
4. Set the sign-out redirect URI to `{APP_BASE_URL}`
5. Assign the application to users/groups who should access the portal

### 2. Custom Groups Claim

1. Go to **Security > API > Authorization Servers > default**
2. Under **Claims**, add a new claim:
   - Name: `JIT-groups`
   - Include in: `ID Token` (Always)
   - Value type: `Groups`
   - Filter: Matches regex `.*` (or a specific pattern for your groups)

### 3. Authorization Group

Create an Okta group (default name: `JIT-Eligible-Users`) and assign users who should be able to submit JIT requests.

### 4. Workflows OAuth Service App

1. Create a new **API Services** application in Okta
2. Configure **Client Credentials** with **Public key / Private key** authentication
3. Grant the `okta.workflows.invoke.manage` scope
4. Generate an RS256 key pair and note the Key ID

## GCP Deployment

### 1. Enable APIs

```bash
gcloud services enable   run.googleapis.com   cloudbuild.googleapis.com   secretmanager.googleapis.com   artifactregistry.googleapis.com
```

### 2. Create Artifact Registry Repository

```bash
gcloud artifacts repositories create jit-portal-repo   --repository-format=docker   --location=us-central1
```

### 3. Create Secrets

```bash
# Create each secret in Secret Manager
echo -n "your-session-secret" | gcloud secrets create okta-custom-pam-session-secret --data-file=-
echo -n "your-client-id" | gcloud secrets create okta-custom-pam-okta-client-id --data-file=-
echo -n "your-client-secret" | gcloud secrets create okta-custom-pam-okta-client-secret --data-file=-
# ... repeat for remaining secrets (see deploy.sh --help for secret names)
```

### 4. Deploy

```bash
export GCP_PROJECT_ID=your-project-id
export OKTA_ORG_URL=https://your-org.okta.com
export APP_BASE_URL=https://your-app-url.run.app

./deploy.sh
```

See `./deploy.sh --help` for all available options and environment variables.

## Security Features

- **Authentication**: Okta OIDC (Authorization Code flow)
- **Authorization**: Group membership verification via ID token claims
- **Transport**: HTTPS-only cookies (`secure`, `httpOnly`, `sameSite: lax`)
- **Headers**: Helmet.js with strict Content Security Policy
- **Rate limiting**: Per-user limits for API (30/hr) and page loads (100/15min)
- **Input validation**: Schema-based validation on all JIT request payloads
- **API security**: OAuth 2.0 private key JWT (RS256) for machine-to-machine auth
- **Container**: Non-root user, production-only dependencies, minimal base image
- **Cloud Run**: `--no-allow-unauthenticated` requires identity verification
- **Secrets**: All credentials stored in GCP Secret Manager

---

## Okta Workflow Setup Guide

> **📊 Visual Guide Available** — For a card-by-card visual reference that mirrors the Okta Workflows designer, open [`docs/workflow-visual-guide.html`](docs/workflow-visual-guide.html) in your browser.

The following guide provides step-by-step instructions for building the Okta Workflow that receives and processes JIT access requests from this portal.

# JIT Admin Activate — Step-by-Step Recreation Guide

## What This Workflow Does

This automation enables **Just-In-Time (JIT) Temporary Admin Access**. When a user needs elevated admin privileges for a limited time, they submit a request via API. The workflow validates their identity, verifies they have a linked admin account, sends an MFA push notification to either themselves or their manager (depending on request type), and — if approved — temporarily activates the admin account. When the timer expires, the admin account is automatically suspended and removed from the privileged group. A safety net scheduled flow catches any cases where the timer fails.

### Approval Routing

| Request Type | Approval Method | Justification Required | Duration Range |
|---|---|---|---|
| **Standard** | MFA push to the **requestor** (self-approval) | Yes | 15–240 minutes |
| **Extended** | MFA push to the **requestor** (self-approval) | No | 15–480 minutes |
| **Emergency** | MFA push to the requestor's **manager** | Yes | 15–480 minutes |

---

## Prerequisites Before Building

Before creating any flows, set up the following in your environment:

1. **Okta Connection** — Create a named Okta API connection in Workflows (e.g. "Okta – [Your Org Name]"). This is used in every Okta action throughout all flows.
2. **Linked Objects in Okta** — Configure a Primary Linked Object relationship so that a standard user account can be linked to an admin account. Every requestor must have their admin account linked before this workflow can function.
3. **JIT Admin Group** — Create a group in Okta that represents elevated/admin access. Note the Group ID — you will reference it in the expiration and activation steps.
4. **Custom Profile Attribute** — Add a custom attribute on Okta user profiles called something like `JIT Expiration` (text/datetime field). This is used to record when the admin's elevated access will end.
5. **Okta Workflows Table** — Create a table to serve as the JIT audit log (see Table Schema section at the bottom of this guide).
6. **MFA Push Factor** — Ensure that approvers (managers or requestors, depending on your configuration) have an Okta push factor (e.g. Okta Verify) enrolled. The workflow specifically looks for a `push` factor type.

---

## Flow Inventory

Build these 6 flows in the order listed. Each depends on the ones below it being created first.

| Build Order | Flow Name | Type | Purpose |
|---|---|---|---|
| 1 | **1.4 Helper – JIT Admin Expire** | Helper | Suspends admin, removes from group, updates table |
| 2 | **1.3b Helper – JIT Safety Net Check** | Helper | Checks if a pending record is overdue and calls Expire |
| 3 | **1.3a Schedule – JIT Safety Net Poller** | Schedule | Sweeps the table on a schedule and calls 1.3b |
| 4 | **1.2 Helper – Wait & Suspend** | Helper | Waits the requested duration then calls Expire |
| 5 | **1.1 Helper – JIT-Admin-Approve** | Helper | Handles MFA challenge and approval logic |
| 6 | **1.0 Main – JIT Admin Activate** | API Endpoint | Entry point — orchestrates all validation and activation |

---

---

# Flow 1 — 1.4 Helper – JIT Admin Expire

**Type:** Helper Flow
**Called by:** 1.2 Helper – Wait & Suspend, 1.3b Helper – JIT Safety Net Check

**Purpose:** This is the expiration engine. It reads the admin account's current status, and if the account is still active, suspends it, removes it from the privileged group, records the action in the audit table, and updates the admin's Okta profile.

### Inputs

| Input Name | Description |
|---|---|
| `AdminID` | The Okta ID of the admin account to be expired |
| `tableRowId` | The Row ID of the audit table record for this session |
| `requestorId` | The Okta ID of the person who originally requested access |
| `source` | Which flow triggered the expiration (e.g. "waitfor", "schedule") |
| `requestorName` | Display name of the requestor, used in notifications |

### Steps

**Step 1 — Read the Admin Account**
- Add an Okta **Read User** action.
- Set the ID or Login input to the `AdminID` input from this helper flow.
- Collect the outputs: `ID`, `Status`, `Primary email`, `Secondary email`, and your custom JIT Expiration attribute.

**Step 2 — Check if Admin is Still ACTIVE**
- Add a **Branching → If/Else** card.
- Condition: `Status` (from Step 1) **equal to** `"ACTIVE"`
- This protects against double-processing — if the account was already suspended by another path, skip the expiration actions.

**TRUE branch — Admin is still active, proceed to expire:**

> **Step 2a — Suspend the Admin User**
> - Add an Okta **Suspend User** action.
> - Set the ID or Login to the `ID` output from Step 1.

> **Step 2b — Remove Admin from the Privileged Group**
> - Add an Okta **Remove User from Group** action.
> - Set the Group ID to your JIT Admin group's ID.
> - Set the User ID to the `ID` output from Step 1.

> **Step 2c — Get the Current Timestamp**
> - Add a **Date & Time → Now** action.
> - You will use the date output to record when the suspension occurred.

> **Step 2d — Format the Date**
> - Add a **Date & Time → Date to Text** action.
> - Set the start date to the output from Step 2c.
> - Set your preferred date/time format (e.g. `MM/DD/YYYY hh:mm`).
> - Set the timezone to your organization's local timezone.
> - Output: `Formatted Date`

> **Step 2e — Update the Audit Table Row**
> - Add a **Tables → Update Row** action.
> - Set Update By to **Row ID**, and map `tableRowId` from the helper inputs.
> - Set the following fields:
>   - `source` → the `source` input from this helper (e.g. "waitfor")
>   - `notes` → a descriptive message such as "Account suspended successfully"
>   - `status` → the text value `"processed"`
>   - `processedSuspensionTimestamp` → the `Formatted Date` from Step 2d

> **Step 2f — Update the Admin User's Okta Profile**
> - Add an Okta **Update User** action.
> - Set the User ID to the `ID` from Step 1.
> - Under Profile, set your JIT Expiration custom attribute to the `Formatted Date` from Step 2d.
> - This records in the user's Okta profile when their elevated access ended.

> **Step 2g — Return Success**
> - Add a **Flow Control → Return** action.
> - Return an output named `Expire Result` with the value `"Success"`.

**FALSE branch — Admin is not active (already suspended):**

> - Add an **Error Handling → Return Error** action.
> - Set the message to something descriptive like `"No expiration set — account was not active"`.

---

# Flow 2 — 1.3b Helper – JIT Safety Net Check

**Type:** Helper Flow
**Called by:** 1.3a Schedule – JIT Safety Net Poller

**Purpose:** For each pending audit table row, this flow calculates whether the session has expired. If it has and the admin account is still active, it calls Flow 1 (1.4 Expire) to clean it up. If the account was already suspended, it marks the row as processed.

### Inputs

| Input Name | Description |
|---|---|
| `AdminID` | Okta ID of the admin account |
| `expirationDateTime` | The recorded expiration datetime from the table row |
| `tableRowId` | Row ID of the audit table record |
| `currentDateTime` | The current time passed in from the scheduler |
| `requestorId` | Okta ID of the original requestor |
| `requestorName` | Display name of the original requestor |

### Steps

**Step 1 — Calculate Time Remaining**
- Add a **Date & Time → Difference** action.
- Set **End date** to `expirationDateTime`.
- Set **Start date** to `currentDateTime`.
- Collect the `minutes` output — this tells you how many minutes remain before expiration. A zero or negative value means the session has expired.

**Step 2 — Check if Expired**
- Add a **Branching → If/Else** card.
- Condition: `minutes` **less than or equal to** `"0"`
- **TRUE path** (expired) → proceed to Step 3.
- **FALSE path** (not yet expired) → add a **Return Error** with message `"Not yet expired"` to skip this row gracefully.

**Step 3 — Read Admin Account Status**
- Add an Okta **Read User** action.
- Set ID or Login to `AdminID`.
- Collect: `ID`, `Status`.

**Step 4 — Check if Admin is Still ACTIVE**
- Add a **Branching → If/Else** card.
- Condition: `Status` **equal to** `"ACTIVE"`
- **TRUE path** (still active, needs expiring):
  - Add a **Flow Control → Call Flow** action.
  - Select **1.4 Helper – JIT Admin Expire**.
  - Pass: `AdminID`, `tableRowId`, `requestorId`, `source = "schedule"`, `requestorName`.
- **FALSE path** (already suspended, just clean up the table row):
  - Add a **Text → Compose** action with a note such as `"Admin account already suspended — marking as processed"`.
  - Add a **Tables → Update Row** action.
  - Update By: Row ID → `tableRowId`.
  - Set `status` to `"processed"`.

---

# Flow 3 — 1.3a Schedule – JIT Safety Net Poller

**Type:** Scheduled Flow
**Status:** Keep OFF until you are ready for production. Enable and configure the schedule (recommended: every 5–15 minutes) once the rest of the framework is tested.

**Purpose:** Runs on a recurring schedule and acts as a safety net. It finds all audit table rows still in `"pending"` status and triggers Flow 2 (1.3b) to check each one.

### Steps

**Step 1 — Search for Pending Records**
- Add a **Tables → Search Rows** action targeting your JIT audit table.
- Set the **Where Expression / Filter** to: `"status" = "pending"`.
- Set Sort Direction to **Descending**.
- Collect all column outputs including `AdminID`, `requestorId`, `requestorName`, `expirationDateTime`, and `Row ID`.

**Step 2 — Loop Through Each Pending Row**
- Add a **List → For Each** action.
- Set the list to the `Rows` output from Step 1.
- Under **Run this Flow**, select **1.3b Helper – JIT Safety Net Check**.
- Set **concurrency to 1** (processes one row at a time to avoid race conditions).
- Map the following values per row:
  - `AdminID` → `AdminID` from the row
  - `expirationDateTime` → `expirationDateTime` from the row
  - `tableRowId` → `Row ID` from the row
  - `currentDateTime` → `Current Time` from the scheduled flow's context
  - `requestorId` → `requestorId` from the row
  - `requestorName` → `requestorName` from the row

---

# Flow 4 — 1.2 Helper – Wait & Suspend

**Type:** Helper Flow
**Called by:** 1.0 Main (asynchronously)

**Purpose:** Receives the session duration and waits that many minutes before calling the Expire helper. This is the primary expiration mechanism. It runs asynchronously so the API caller gets an immediate response while this flow waits silently in the background.

### Inputs

| Input Name | Description |
|---|---|
| `AdminID` | Okta ID of the admin account |
| `durationMinutes` | How many minutes to wait before expiring access |
| `tableRowId` | Row ID of the audit table record |
| `requestorId` | Okta ID of the original requestor |
| `requestorName` | Display name of the original requestor |

### Steps

**Step 1 — Wait for the Duration**
- Add a **Flow Control → Wait For** action.
- Set **delay** to `durationMinutes` from the helper inputs.
- Set **unit** to **Minute**.

**Step 2 — Call the Expire Helper**
- Add a **Flow Control → Call Flow** action.
- Select **1.4 Helper – JIT Admin Expire**.
- Pass:
  - `AdminID` → `AdminID`
  - `tableRowId` → `tableRowId`
  - `requestorId` → `requestorId`
  - `source` → the hardcoded text `"waitfor"` (identifies this came from the timer)
  - `requestorName` → `requestorName`
- Collect output: `Expire Result`

**Step 3 — Handle Result**
- Add a **Branching → If/Else** card.
- Condition: `Expire Result` **equal to** `"Success"`
- **TRUE path:** Add a **Text → Compose** with a success message (e.g. `"JIT Admin expiration completed successfully"`).
- **FALSE path:** Add a **Text → Compose** with a failure message (e.g. `"JIT Admin expiration encountered an issue"`).

---

# Flow 5 — 1.1 Helper – JIT-Admin-Approve

**Type:** Helper Flow
**Called by:** 1.0 Main

**Purpose:** Handles the approval step. For standard and extended requests, the requestor self-approves via their own MFA push notification. For emergency requests, the requestor's manager is challenged instead. It polls for the response and returns the result.

### Inputs

| Input Name | Description |
|---|---|
| `requestorId` | Okta ID of the requestor |
| `adminAccountId` | Okta ID of the linked admin account |
| `requestorEmail` | Requestor's primary email |
| `requestorName` | Requestor's display name |
| `businessJustification` | The reason provided for the request (may be empty for extended requests) |
| `durationMinutes` | Requested duration in minutes |
| `requestType` | `"standard"`, `"extended"`, or `"emergency"` |

### Steps

**Step 1 — Check Request Type**
- Add a **Branching → If/Else** card.
- Condition: `requestType` **equal to** `"emergency"`
- **TRUE path** → look up the manager and challenge them (emergency requires manager approval)
- **FALSE path** → challenge the requestor directly (standard and extended use self-approval)

---

### TRUE Path — Emergency Request (Manager Approval)

**T1 — Read Requestor's Profile**
- Add an Okta **Read User** action.
- Input: `requestorId`.
- Outputs to collect: `ID`, `Status`, `First name`, `Last name`, `Primary email`, `Manager` (manager's email address).

**T2 — Concatenate Manager Name**
- Add a **Text → Concatenate** action.
- Combine First name + a space + Last name.
- Output: `manager name` (for reference/logging).

**T3 — Look Up the Manager's Okta Account**
- Add an Okta **List Users with Search** action.
- Set **Primary email** input to the `Manager` value from T1 (manager's email).
- Outputs to collect: Manager's `ID`, `Status`, `First Name`, `Last Name`, `Login`.

**T4 — Build the Manager's Factor API Endpoint**
- Add a **Text → Concatenate** action with three parts:
  - Part 1: `/api/v1/users/`
  - Part 2: Manager's `ID` (from T3)
  - Part 3: `/factors`
- Output: `Factor API endpoint`

**T5 — Fetch Manager's Enrolled Factors**
- Add an Okta **Custom API Action**.
- Set the Relative URL to `Factor API endpoint` from T4.
- This calls the Okta Factors API to retrieve all enrolled factors for the manager.
- Output: `Body` (raw JSON)

**T6 — Parse the Factor List**
- Add a **JSON → Parse** action.
- Input: `Body` from T5.
- Output: `Mgr Factors` (a structured list of the manager's factors)

**T7 — Find the Push Factor**
- Add a **List → Find** action.
- List: `Mgr Factors`
- Filter path: `factorType`, comparison: **equal to**, value: `"push"`
- Outputs: `List of Push Factors`, `Push Factors Number`

**T8 — Check if a Push Factor Exists**
- Add a **Branching → If/Else** card.
- Condition: `List of Push Factors` **is not empty**
- **TRUE path** → proceed to issue the challenge
- **FALSE path** → the manager has no push factor enrolled; add a **Return Error** with a descriptive message (e.g. `"Approver has no push factor enrolled"`)

**T9 — Issue MFA Challenge to Manager**
- Add a **Flow Control → Call Flow** action.
- Select your **Issue MFA Challenge** helper flow (a pre-built or custom flow that triggers an Okta push notification).
- Input: `ID or Login` = Manager's `ID` from T3.
- Output: `pollUrl` (the URL used to check the push response status)

**T10 — Poll for the MFA Response**
- Add a **Flow Control → Call Flow** action.
- Select your **Poll MFA Status** helper flow (a flow that checks whether the push was approved or denied, and loops if still pending).
- Inputs: `pollUrl` from T9, `iteration = 0`.
- Output: `Poll MFA Result` (True = approved, False = denied/timed out)

**T11 — Assign the Poll Result**
- Add a **Flow Control → Assign** action.
- Set `Poll MFA Result` = the output from T10.

**T12 — Check the Poll Result**
- Add a **Branching → If/Else** card.
- Condition: `Poll MFA Result` **equal to** `True`
- **TRUE path:** Add a **Flow Control → Return** with output `approvalResult = True`.
- **FALSE path:** Add a **Flow Control → Return** with output `approvalResult = False`.

---

### FALSE Path — Standard / Extended Request (Requestor Self-Approval)

Repeat steps T1 through T12 above, but instead of looking up the manager:
- Use `requestorId` as the user to read (instead of manager lookup).
- Build the Factor API endpoint using the **requestor's** Okta `ID`.
- Issue the MFA challenge to the **requestor** directly.
- Poll and return the result the same way.

This path allows the requestor to self-approve using their own push factor for standard and extended requests.

---

# Flow 6 — 1.0 Main – JIT Admin Activate

**Type:** API Endpoint (HTTP POST)
**Status:** ON — this is the entry point for the entire framework.

**Purpose:** Receives the JIT access request, validates the requestor and their admin account, calls the approval helper, and if approved, activates the admin account, records the session, and kicks off the async wait timer.

### Inputs (HTTP Request Body)

| Input Name | Description |
|---|---|
| `requestorLogin` | Okta login/username of the person requesting access |
| `requestorId` | Okta ID of the requestor |
| `durationMinutes` | How long the admin access should last (in minutes) |
| `businessJustification` | Text reason for the request |
| `requestorEmail` | Email of the requestor |
| `requestType` | `"standard"` (self-approval), `"extended"` (self-approval, no justification), or `"emergency"` (manager approval) |
| `sourceApplication` | Name of the system or app that sent the request |
| `requestTimestamp` | Timestamp of when the request was made |
| `requestorName` | Display name of the requestor (pre-built by the portal) |
| `correlationId` | Unique request tracking ID from the portal (useful for log correlation) |

### Steps

**Step 1 — Read the Requestor's Okta Profile**
- Add an Okta **Read User** action.
- Set ID or Login to `requestorId` from the request body.
- Collect: `ID`, `Status`, `Username`, `First name`, `Last name`, `Primary email`, `Secondary email`.

**Step 2 — Build the Requestor's Display Name**
- Add a **Text → Concatenate** action.
- Combine `First name` + a space + `Last name`.
- Output: `Requestor Name`

**Step 3 — Validate: Is the Requestor's Account ACTIVE?**
- Add a **Branching → If/Else** card.
- Condition: `Status` (from Step 1) **equal to** `"ACTIVE"`
- **TRUE path:** Add a **Flow Control → Assign** with `msg = "proceed"` and continue.
- **FALSE path:**
  - Add a **Text → Compose** action. Write a message such as: `"Requestor: [Requestor Name] — Failed Admin Access request from [sourceApplication] at [requestTimestamp] because their account is not Active."`
  - Add an **Error Handling → Return Error** with status code `500` and a descriptive message such as `"Request account is not active"`.

**Step 4 — Get the Requestor's Linked Admin Account**
- Add an Okta **Get Primary Linked Object Value** action.
- Set the User to the requestor's `ID` from Step 1.
- This retrieves the admin account linked to the requestor via the Linked Objects configuration.
- Collect: `Admin User ID`, `User Self Link`.

**Step 5 — Validate: Does the Requestor Have a Linked Admin Account?**
- Add a **Branching → If/Else** card.
- Condition: `Admin User ID` **is not empty**
- **TRUE path:** Add a **Flow Control → Assign** with `msg = "proceed"` and continue.
- **FALSE path:**
  - Add a **Text → Compose** action with an error message such as: `"Failed Admin Access request from [sourceApplication] at [requestTimestamp] because [Requestor Name] does not have an Admin Account linked."`
  - Add an **Error Handling → Return Error**: status `500`, message `"No admin account linked to this user."`

**Step 6 — Read the Admin Account's Profile**
- Add an Okta **Read User** action.
- Set ID or Login to `Admin User ID` from Step 4.
- Collect: `Admin ID`, `Status`, `Username`, `Primary email`, `Secondary email`, and your `JIT Expiration` custom attribute.

**Step 7 — Check if Admin Account is Already Elevated**
- Add two **Branching → Assign If** cards in parallel:
  - **Assign If A:** `Status` **equal to** `"PROVISIONED"` → if true output `false`, else output `true`
  - **Assign If B:** `Status` **equal to** `"ACTIVE"` → if true output `false`, else output `true`
- Feed both outputs into a **True/False → Any False?** card.
  - If the admin is already ACTIVE or PROVISIONED, one of the Assign Ifs returns `false`, making `any false?` = true.
- Add a **Branching → If/Else** card.
  - Condition: `any false?` **equal to** `false` (meaning the admin is in a neutral/suspendable state)
  - **TRUE path** → proceed to Step 8 (approval)
  - **FALSE path:**
    - Add a **Flow Control → Assign** with a message such as `"Admin account already active."` and return this to the caller.

**Step 8 — Call the Approval Helper**
- Add a **Flow Control → Call Flow** action.
- Select **1.1 Helper – JIT-Admin-Approve**.
- Map inputs:
  - `requestorId` → `requestorId`
  - `adminAccountId` → `Admin User ID`
  - `requestorEmail` → `Primary email` (requestor's)
  - `requestorName` → `Requestor Name`
  - `reason` → `businessJustification`
  - `durationMinutes` → `durationMinutes`
  - `requestType` → `requestType`
- Collect output: `approvalResult`

**Step 9 — Check the Approval Result**
- Add a **Branching → If/Else** card.
- Condition: `approvalResult` **equal to** `True`
- **FALSE path** → no action needed, flow ends (access was denied by approver).
- **TRUE path** → continue to Step 10.

**Step 10 — Search for Existing Pending Sessions**
- Add a **Tables → Search Rows** action on your JIT audit table.
- Filter: `"status" = "pending"`, Sort: Descending.
- This is used to check for any prior active sessions and pass context to the return message.

**Step 11 — Compose and Return Success to the API Caller**
- Add a **Text → Compose** action with a success message for the caller.
- Add a **Flow Control → Return** action to immediately send a success response back to the calling system.
- This return happens before the activation steps below, so the API caller does not have to wait.

**Step 12 — Start the Async Expiration Timer**
- Add a **Flow Control → Call Flow Async** action.
- Select **1.2 Helper – Wait & Suspend**.
- Pass: `AdminID`, `durationMinutes`, `tableRowId` (from the row created in Step 15), `requestorId`, `requestorName`.
- Because this is **async**, it fires and runs in the background without blocking the current flow.

> **Note on ordering:** Create the table row (Step 15) before passing the `tableRowId` to the async call. Arrange Steps 12–16 so that the table row is created first, then the async call is made, then the Okta activation steps follow.

**Step 13 — Unsuspend / Activate the Admin Account**
- Add an Okta **Unsuspend User** action.
- Set the ID or Login to the `Admin ID` from Step 6.
- This transitions the admin account from Suspended to Active.

**Step 14 — Add Admin to the Privileged Group**
- Add an Okta **Add User to Group** action.
- Set the Group ID to your JIT Admin group.
- Set the User ID to the `Admin ID` from Step 6.

**Step 15 — Get Current Time and Calculate Expiration**
- Add a **Date & Time → Now** action to get the current timestamp.
- Add a **Date & Time → Add** action to add `durationMinutes` (in minutes) to the current time.
- Output: the calculated expiration datetime.

**Step 16 — Create the Audit Table Row**
- Add a **Tables → Create Row** action on your JIT audit table.
- Populate fields:
  - `AdminID` → Admin ID
  - `requestorId` → requestorId
  - `requestorEmail` → requestor's Primary email
  - `requestorName` → Requestor Name
  - `durationMinutes` → durationMinutes
  - `expirationDateTime` → calculated expiration from Step 15
  - `source` → `sourceApplication` from the request body
  - `status` → `"pending"`
  - `correlationId` → `correlationId` from the request body (for traceability)
- Collect output: `Row ID` (this is your `tableRowId`, needed by the async call and expire helper)

**Step 17 — Update Admin User's Profile with Expiration**
- Add an Okta **Update User** action.
- Set the User ID to the `Admin ID`.
- Under Profile, set your `JIT Expiration` custom attribute to the formatted expiration datetime.

---

## Audit Table Schema

Create this table in Okta Workflows before building the flows. All flows read from and write to this single table.

| Column Name | Type | Description |
|---|---|---|
| `AdminID` | Text | Okta ID of the admin account |
| `requestorId` | Text | Okta ID of the person who requested access |
| `requestorEmail` | Text | Email of the requestor |
| `requestorName` | Text | Display name of the requestor |
| `durationMinutes` | Number | Requested access duration in minutes |
| `expirationDateTime` | Text/DateTime | Calculated datetime when access should end |
| `source` | Text | Which system or flow created the record |
| `correlationId` | Text | Request tracking ID from the portal (for log correlation) |
| `createdAt` | Text | When the record was created |
| `notes` | Text | Free-text notes (e.g. "Account suspended successfully") |
| `status` | Text | `"pending"` while active, `"processed"` after expiration |
| `processedSuspensionTimestamp` | Text | Datetime when the account was actually suspended |

---

## End-to-End Logic Summary

```
API Request → 1.0 Main
  ├─ Read requestor profile
  ├─ Build display name
  ├─ [CHECK] Requestor account is ACTIVE?
  │     No  → Return error "Not Active"
  ├─ Get linked admin account ID
  ├─ [CHECK] Admin account is linked?
  │     No  → Return error "No Admin Account"
  ├─ Read admin account profile
  ├─ [CHECK] Admin is NOT already elevated?
  │     Already elevated → Return "Admin account already active"
  ├─ Call 1.1 Helper – JIT-Admin-Approve
  │     ├─ [CHECK] requestType == "emergency"?
  │     │     Yes → Look up manager → Get manager's factors → Push challenge to MANAGER
  │     │     No  → Get requestor's factors → Push challenge to REQUESTOR (self-approval)
  │     ├─ Issue MFA Challenge (helper flow)
  │     ├─ Poll MFA Status (helper flow, loops until approved/denied/timeout)
  │     └─ Return approvalResult (True or False)
  ├─ [CHECK] Approved?
  │     No  → Flow ends (access denied)
  ├─ Return success to API caller (immediate)
  ├─ Unsuspend admin account (Okta)
  ├─ Add admin to privileged group (Okta)
  ├─ Calculate expiration datetime
  ├─ Write audit table row
  ├─ Update admin's Okta profile with expiration
  └─ Start async timer → 1.2 Helper – Wait & Suspend
        ├─ Wait [durationMinutes] minutes
        └─ Call 1.4 Helper – JIT Admin Expire
              ├─ Read admin status
              ├─ [CHECK] Still ACTIVE?
              │     Yes → Suspend + Remove from group + Update table + Update profile
              │     No  → Return error (already handled)
              └─ Return "Success" or error

Scheduled Safety Net (runs every X minutes):
1.3a Schedule – JIT Safety Net Poller
  ├─ Search table for all rows where status = "pending"
  └─ For Each pending row → 1.3b Helper – JIT Safety Net Check
        ├─ Calculate minutes remaining until expiration
        ├─ [CHECK] Expired? (minutes <= 0)
        │     No  → Skip (not yet expired)
        ├─ Read admin account status
        ├─ [CHECK] Still ACTIVE?
        │     Yes → Call 1.4 Helper – JIT Admin Expire
        │     No  → Update table row to "processed"
```


---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
