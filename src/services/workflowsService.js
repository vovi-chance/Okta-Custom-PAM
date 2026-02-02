'use strict';

const { SignJWT, importPKCS8 } = require('jose');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../utils/logger');

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

// Circuit breaker state
const circuit = {
  failures: 0,
  lastFailure: 0,
  state: 'closed', // closed | open | half-open
  threshold: 5,
  resetTimeoutMs: 60 * 1000, // 1 minute
};

const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const TOKEN_REFRESH_BUFFER_S = 60; // Refresh 60s before expiry
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Generates an RS256 JWT client assertion for Okta OAuth 2.0 token endpoint.
 */
async function generateClientAssertion() {
  const clientId = process.env.OKTA_WORKFLOWS_CLIENT_ID;
  const keyId = process.env.OKTA_WORKFLOWS_KEY_ID;
  const privateKeyPem = process.env.OKTA_WORKFLOWS_PRIVATE_KEY;
  const oktaOrgUrl = process.env.OKTA_ORG_URL;

  if (!clientId || !keyId || !privateKeyPem || !oktaOrgUrl) {
    throw new Error(
      'Missing workflow OAuth configuration. Required: OKTA_WORKFLOWS_CLIENT_ID, OKTA_WORKFLOWS_KEY_ID, OKTA_WORKFLOWS_PRIVATE_KEY, OKTA_ORG_URL'
    );
  }

  // Normalize PEM key: GCP Secret Manager may deliver the key with literal
  // "\n" strings instead of real newline characters when mounted as an env var.
  let normalizedPem = privateKeyPem;
  if (!normalizedPem.includes('\n') || normalizedPem.includes('\\n')) {
    normalizedPem = normalizedPem.replace(/\\n/g, '\n');
  }
  // Ensure header/footer are on their own lines
  normalizedPem = normalizedPem
    .replace(/-----BEGIN PRIVATE KEY-----\s*/, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/\s*-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----\n')
    .trim();

  const privateKey = await importPKCS8(normalizedPem, 'RS256');

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(`${oktaOrgUrl}/oauth2/v1/token`)
    .setIssuedAt(now)
    .setExpirationTime(now + 300) // 5 minutes
    .setJti(uuidv4())
    .sign(privateKey);

  return jwt;
}

/**
 * Requests an OAuth 2.0 access token from Okta using client_credentials
 * with a private key JWT assertion.
 */
async function getAccessToken(forceRefresh = false) {
  // Return cached token if still valid
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() / 1000 < tokenExpiresAt - TOKEN_REFRESH_BUFFER_S
  ) {
    return cachedToken;
  }

  const oktaOrgUrl = process.env.OKTA_ORG_URL;
  const tokenUrl = `${oktaOrgUrl}/oauth2/v1/token`;
  const clientAssertion = await generateClientAssertion();

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'okta.workflows.invoke.manage',
    client_assertion_type:
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    logger.info('Requesting OAuth access token from Okta', {
      tokenUrl,
      grantType: 'client_credentials',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'No body');
      throw new Error(
        `Token request failed (${response.status}): ${errorBody}`
      );
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() / 1000 + (data.expires_in || 3600);

    logger.info('OAuth access token obtained', {
      expiresIn: data.expires_in,
      tokenType: data.token_type,
    });

    return cachedToken;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Checks circuit breaker state. Throws if circuit is open.
 */
function checkCircuit() {
  if (circuit.state === 'open') {
    const elapsed = Date.now() - circuit.lastFailure;
    if (elapsed > circuit.resetTimeoutMs) {
      circuit.state = 'half-open';
      logger.info('Circuit breaker transitioning to half-open');
    } else {
      throw new Error(
        'Workflow API circuit breaker is open. Service temporarily unavailable.'
      );
    }
  }
}

function recordSuccess() {
  if (circuit.state === 'half-open') {
    logger.info('Circuit breaker closing after successful request');
  }
  circuit.failures = 0;
  circuit.state = 'closed';
}

function recordFailure() {
  circuit.failures++;
  circuit.lastFailure = Date.now();
  if (circuit.failures >= circuit.threshold) {
    circuit.state = 'open';
    logger.error('Circuit breaker opened after repeated failures', {
      failures: circuit.failures,
    });
  }
}

/**
 * Invokes the Okta Workflow with retry logic and circuit breaker.
 *
 * @param {Object} payload - The workflow payload
 * @returns {Object} - The workflow response
 */
async function invokeWorkflow(payload) {
  checkCircuit();

  const invokeUrl = process.env.OKTA_WORKFLOWS_INVOKE_URL;
  if (!invokeUrl) {
    throw new Error('OKTA_WORKFLOWS_INVOKE_URL is not configured');
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const accessToken = await getAccessToken(attempt > 0);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        logger.info('Invoking Okta Workflow', {
          attempt: attempt + 1,
          requestType: payload.requestType,
          requestorEmail: payload.requestorEmail,
        });

        const response = await fetch(invokeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.status === 401 && attempt < MAX_RETRIES) {
          logger.warn('Workflow API returned 401, refreshing token', {
            attempt: attempt + 1,
          });
          cachedToken = null;
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => 'No body');
          throw new Error(
            `Workflow invocation failed (${response.status}): ${errorBody}`
          );
        }

        const result = await response.json().catch(() => ({
          success: true,
          status: response.status,
        }));

        recordSuccess();

        logger.info('Workflow invoked successfully', {
          requestType: payload.requestType,
          requestorEmail: payload.requestorEmail,
          workflowResponse: result,
        });

        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err;

      if (err.name === 'AbortError') {
        lastError = new Error(
          `Workflow API request timed out after ${REQUEST_TIMEOUT_MS}ms`
        );
      }

      logger.error('Workflow invocation attempt failed', {
        attempt: attempt + 1,
        error: lastError.message,
        requestType: payload.requestType,
      });

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  recordFailure();
  throw lastError;
}

module.exports = { invokeWorkflow, getAccessToken };
