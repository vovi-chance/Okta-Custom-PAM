'use strict';

const { SignJWT, importJWK } = require('jose');
const { createPrivateKey } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../utils/logger');

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

// Cache for parsed private key (to avoid re-parsing on every request)
let cachedPrivateKey = null;

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

  // Debug: Log key characteristics (not the actual key for security)
  const trimmedKey = privateKeyPem.trim();
  logger.info('Private key detection starting', {
    originalLength: trimmedKey.length,
    startsWithBrace: trimmedKey.startsWith('{'),
    startsWithDash: trimmedKey.startsWith('-----'),
    first30Chars: trimmedKey.substring(0, 30),
  });

  let privateKey;

  // Detect key format: JWK (JSON) vs PEM
  if (trimmedKey.startsWith('{')) {
    // ─────────────────────────────────────────────────────────────────────────
    // JWK FORMAT: Key is a JSON Web Key object
    // ─────────────────────────────────────────────────────────────────────────
    logger.info('Detected JWK format private key');

    try {
      const jwk = JSON.parse(trimmedKey);

      // Ensure the key has required fields for RSA signing
      if (!jwk.kty) {
        throw new Error('JWK missing required "kty" field');
      }

      // Import the JWK using jose library
      privateKey = await importJWK(jwk, 'RS256');

      logger.info('JWK private key imported successfully', {
        kty: jwk.kty,
        use: jwk.use,
        hasD: !!jwk.d, // 'd' is the private exponent - confirms it's a private key
      });
    } catch (jwkErr) {
      logger.error('Failed to parse/import JWK private key', {
        error: jwkErr.message,
      });
      throw new Error(`JWK Private Key Error: ${jwkErr.message}`);
    }
  } else {
    // ─────────────────────────────────────────────────────────────────────────
    // PEM FORMAT: Key is PEM-encoded (PKCS#1 or PKCS#8)
    // ─────────────────────────────────────────────────────────────────────────
    logger.info('Detected PEM format private key');

    let normalizedPem = trimmedKey;

    // Handle escaped newlines from environment variables
    if (normalizedPem.includes('\\n')) {
      normalizedPem = normalizedPem.replace(/\\n/g, '\n');
    }

    // Extract and reconstruct PEM if needed
    const beginMatch = normalizedPem.match(/-----BEGIN (RSA |EC |)PRIVATE KEY-----/);
    const endMatch = normalizedPem.match(/-----END (RSA |EC |)PRIVATE KEY-----/);

    if (beginMatch && endMatch) {
      const keyType = beginMatch[1];
      const beginTag = `-----BEGIN ${keyType}PRIVATE KEY-----`;
      const endTag = `-----END ${keyType}PRIVATE KEY-----`;

      const beginIdx = normalizedPem.indexOf(beginTag);
      const endIdx = normalizedPem.indexOf(endTag);

      if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
        const rawBody = normalizedPem.substring(beginIdx + beginTag.length, endIdx);
        const cleanBody = rawBody.replace(/[\s\r\n]+/g, '');
        normalizedPem = `${beginTag}\n${cleanBody}\n${endTag}`;
      }
    }

    try {
      privateKey = createPrivateKey(normalizedPem);
      logger.info('PEM private key imported successfully');
    } catch (pemErr) {
      logger.error('Failed to import PEM private key', {
        error: pemErr.message,
        hasBeginTag: normalizedPem.includes('-----BEGIN'),
        hasEndTag: normalizedPem.includes('-----END'),
      });
      throw new Error(`PEM Private Key Error: ${pemErr.message}`);
    }
  }

  cachedPrivateKey = privateKey;

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

  return { jwt, privateKey };
}

/**
 * Requests an OAuth 2.0 access token from Okta using client_credentials
 * with a private key JWT assertion (private_key_jwt authentication).
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
  const { jwt: clientAssertion } = await generateClientAssertion();

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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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
            'Authorization': `Bearer ${accessToken}`,
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

        // SUCCESS - return immediately, no more retries needed
        const result = await response.json().catch(() => ({
          success: true,
          status: response.status,
        }));

        recordSuccess();

        logger.info('Workflow invoked successfully', {
          requestType: payload.requestType,
          requestorEmail: payload.requestorEmail,
          attempt: attempt + 1,
          workflowResponse: result,
        });

        return result;  // EXIT the retry loop on success
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
