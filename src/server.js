'use strict';

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');
const { logger, requestLogger } = require('./utils/logger');
const { requireGroup } = require('./middleware/authorization');
const { apiLimiter, pageLimiter } = require('./middleware/rateLimiter');
const { validateJitRequest, DURATION_RANGES } = require('./middleware/validation');
const { invokeWorkflow } = require('./services/workflowsService');

const app = express();
const PORT = process.env.PORT || 8080;
const isProduction = process.env.NODE_ENV === 'production';
const CACHE_BUST = Date.now().toString(36);

// Make cacheBust available to all EJS templates
app.locals.cacheBust = CACHE_BUST;

// ──────────────────────────────────────────────────
// Configuration validation
// ──────────────────────────────────────────────────

const REQUIRED_CONFIG = [
  'SESSION_SECRET',
  'OKTA_ORG_URL',
  'APP_BASE_URL',
  'OKTA_CLIENT_ID',
  'OKTA_CLIENT_SECRET',
];

const WORKFLOW_CONFIG = [
  'OKTA_WORKFLOWS_CLIENT_ID',
  'OKTA_WORKFLOWS_KEY_ID',
  'OKTA_WORKFLOWS_PRIVATE_KEY',
  'OKTA_WORKFLOWS_INVOKE_URL',
];

function validateConfig() {
  const missing = [];
  const status = {};

  [...REQUIRED_CONFIG, ...WORKFLOW_CONFIG].forEach((key) => {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
      status[key] = 'NOT SET';
    } else {
      status[key] = 'SET';
    }
  });

  logger.info('Configuration status', { config: status });

  if (missing.some((k) => REQUIRED_CONFIG.includes(k))) {
    logger.error('Missing required configuration', { missing });
    return { valid: false, missing, status };
  }

  if (missing.some((k) => WORKFLOW_CONFIG.includes(k))) {
    logger.warn('Missing workflow configuration — workflow invocation disabled', {
      missing: missing.filter((k) => WORKFLOW_CONFIG.includes(k)),
    });
  }

  return { valid: true, missing, status };
}

// ──────────────────────────────────────────────────
// Trust proxy (Cloud Run behind Google Front End)
// ──────────────────────────────────────────────────

app.set('trust proxy', 1); // Trust only the first proxy (Cloud Run LB)

// ──────────────────────────────────────────────────
// View engine
// ──────────────────────────────────────────────────

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// ──────────────────────────────────────────────────
// Security middleware
// ──────────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ──────────────────────────────────────────────────
// Body parsing
// ──────────────────────────────────────────────────

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ──────────────────────────────────────────────────
// Static files
// ──────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// ──────────────────────────────────────────────────
// Structured request logging
// ──────────────────────────────────────────────────

app.use(requestLogger);

// ──────────────────────────────────────────────────
// Session configuration (hardened)
// ──────────────────────────────────────────────────

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'jit.sid',
    cookie: {
      secure: isProduction,      // HTTPS 
      httpOnly: true,            // Prevent XSS access to cookie
      sameSite: 'lax',           // CSRF protection
      maxAge: 60 * 60 * 1000,   // 1 hour session timeout
    },
  })
);

// ──────────────────────────────────────────────────
// Health check (always available, before auth)
// ──────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const oidcConfigured = !!(
    process.env.OKTA_CLIENT_ID && process.env.OKTA_CLIENT_SECRET
  );

  // Return only minimal status publicly to avoid information disclosure
  const allHealthy = oidcConfigured;
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────
// OIDC Initialization
// ──────────────────────────────────────────────────

const config = validateConfig();
let oidc = null;

if (config.valid) {
  try {
    const { ExpressOIDC } = require('@okta/oidc-middleware');

    oidc = new ExpressOIDC({
      issuer: `${process.env.OKTA_ORG_URL}/oauth2/default`,
      client_id: process.env.OKTA_CLIENT_ID,
      client_secret: process.env.OKTA_CLIENT_SECRET,
      appBaseUrl: process.env.APP_BASE_URL,
      redirect_uri: `${process.env.APP_BASE_URL}/authorization-code/callback`,
      scope: 'openid profile email',
      routes: {
        loginCallback: {
          path: '/authorization-code/callback',
          afterCallback: '/dashboard',
        },
      },
    });

    app.use(oidc.router);
    logger.info('OIDC middleware initialized successfully');
  } catch (err) {
    logger.error('Failed to initialize OIDC middleware', err);
    oidc = null;
  }
} else {
  logger.error('Skipping OIDC initialization due to missing configuration');
}

// ──────────────────────────────────────────────────
// Helper: check if OIDC is available
// ──────────────────────────────────────────────────

function ensureOidc(req, res, next) {
  if (!oidc) {
    return res.status(503).render('error', {
      title: 'Service Unavailable',
      message:
        'Authentication is not configured. Please contact your administrator.',
    });
  }
  next();
}

// ──────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────

// Landing page — redirect to dashboard (triggers Okta login if unauthenticated)
app.get('/', pageLimiter, (req, res) => {
  res.redirect('/dashboard');
});

// Dashboard — protected by OIDC + group authorization
app.get(
  '/dashboard',
  pageLimiter,
  ensureOidc,
  oidc ? oidc.ensureAuthenticated() : (req, res, next) => next(),
  requireGroup('JIT-Eligible-Users'),
  (req, res) => {
    const userInfo = req.userContext.userinfo;
    res.render('dashboard', {
      user: {
        name: userInfo.name || userInfo.preferred_username || 'User',
        email: userInfo.email,
        sub: userInfo.sub,
      },
      durationRanges: DURATION_RANGES,
    });
  }
);

// Profile page
app.get(
  '/profile',
  pageLimiter,
  ensureOidc,
  oidc ? oidc.ensureAuthenticated() : (req, res, next) => next(),
  (req, res) => {
    const userInfo = req.userContext.userinfo;
    res.render('profile', {
      user: userInfo,
      groups: req.userGroups || [],
    });
  }
);

// JIT request API — protected + validated + rate-limited
app.post(
  '/api/jit-request',
  apiLimiter,
  ensureOidc,
  oidc ? oidc.ensureAuthenticated() : (req, res, next) => next(),
  requireGroup('JIT-Eligible-Users'),
  validateJitRequest,
  async (req, res) => {
    const userInfo = req.userContext.userinfo;
    const { requestType, durationMinutes, businessJustification } =
      req.validatedBody;

    const payload = {
      requestorId: userInfo.sub,
      requestorLogin: userInfo.preferred_username || userInfo.email,
      requestorEmail: userInfo.email,
      requestorName: userInfo.name || userInfo.preferred_username || 'Unknown',
      durationMinutes,
      businessJustification: businessJustification || undefined,
      requestType,
      requestTimestamp: new Date().toISOString(),
      sourceApplication: 'JIT-Admin-Portal',
      correlationId: req.correlationId,
    };

    try {
      req.log.info('Submitting JIT request', {
        requestType,
        durationMinutes,
        requestorEmail: userInfo.email,
      });

      const result = await invokeWorkflow(payload);

      req.log.info('JIT request submitted successfully', {
        requestType,
        durationMinutes,
        requestorEmail: userInfo.email,
      });

      res.json({
        success: true,
        message: `${requestType} JIT access request submitted successfully.`,
        requestId: req.correlationId,
        details: {
          requestType,
          durationMinutes,
          submittedAt: payload.requestTimestamp,
        },
      });
    } catch (err) {
      req.log.error('JIT request submission failed', {
        error: err.message,
        requestType,
        requestorEmail: userInfo.email,
      });

      const statusCode = err.message.includes('circuit breaker') ? 503 : 502;
      res.status(statusCode).json({
        success: false,
        error: isProduction
          ? 'Submission failed. Please try again or contact your administrator.'
          : `Submission Failed: ${err.message}`,
        debug_stack: isProduction ? undefined : err.stack,
        requestId: req.correlationId,
      });
    }
  }
);

// Logout — revoke token, destroy session, redirect to Okta logout
app.get('/logout', async (req, res) => {
  const oktaOrgUrl = process.env.OKTA_ORG_URL;
  const appBaseUrl = process.env.APP_BASE_URL;

  // Revoke the access token with Okta before destroying the session
  const accessToken = req.userContext?.tokens?.access_token;
  if (accessToken && oktaOrgUrl) {
    try {
      await fetch(`${oktaOrgUrl}/oauth2/default/v1/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: accessToken,
          token_type_hint: 'access_token',
          client_id: process.env.OKTA_CLIENT_ID,
          client_secret: process.env.OKTA_CLIENT_SECRET,
        }).toString(),
      });
    } catch (err) {
      logger.warn('Token revocation failed', { error: err.message });
    }
  }

  // Destroy session before redirecting
  await new Promise((resolve) => {
    if (req.session) {
      req.session.destroy((err) => {
        if (err) logger.error('Session destruction failed', err);
        resolve();
      });
    } else {
      resolve();
    }
  });

  if (oktaOrgUrl && appBaseUrl) {
    res.redirect(
      `${oktaOrgUrl}/oauth2/default/v1/logout?post_logout_redirect_uri=${encodeURIComponent(appBaseUrl)}`
    );
  } else {
    res.redirect('/');
  }
});

// ──────────────────────────────────────────────────
// 404 handler
// ──────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page Not Found',
    message: 'The page you are looking for does not exist.',
  });
});

// ──────────────────────────────────────────────────
// Global error handler
// ──────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  const log = req.log || logger;
  log.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.originalUrl,
  });

  if (res.headersSent) return;

  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      success: false,
      error: isProduction
        ? 'An unexpected error occurred. Please try again.'
        : err.message,
      requestId: req.correlationId,
    });
  }

  return res.status(500).render('error', {
    title: 'Internal Server Error',
    message: isProduction
      ? 'An unexpected error occurred. Please try again.'
      : err.message,
  });
});

// ──────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────

if (oidc) {
  oidc.on('ready', () => {
    app.listen(PORT, () => {
      logger.info('Server started', {
        port: PORT,
        environment: process.env.NODE_ENV,
        oidcEnabled: true,
      });
    });
  });

  oidc.on('error', (err) => {
    logger.error('OIDC initialization error', err);
    // Start anyway so health check is reachable
    app.listen(PORT, () => {
      logger.warn('Server started in degraded mode (OIDC failed)', {
        port: PORT,
      });
    });
  });
} else {
  app.listen(PORT, () => {
    logger.warn('Server started without OIDC', {
      port: PORT,
      reason: 'Missing configuration or initialization failure',
    });
  });
}

module.exports = app;
