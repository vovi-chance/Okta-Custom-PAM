'use strict';

const { v4: uuidv4 } = require('uuid');

// Severity levels compatible with Google Cloud Logging
const SEVERITY = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
};

/**
 * Structured JSON logger for Cloud Run.
 * Outputs JSON to stdout which Cloud Logging ingests automatically.
 * Includes trace/correlation ID support for request tracking.
 */
class Logger {
  constructor(context = {}) {
    this.defaultContext = context;
  }

  _write(severity, message, meta = {}) {
    const entry = {
      severity,
      message,
      timestamp: new Date().toISOString(),
      ...this.defaultContext,
      ...meta,
    };

    // Remove undefined values
    Object.keys(entry).forEach((k) => {
      if (entry[k] === undefined) delete entry[k];
    });

    const line = JSON.stringify(entry);
    if (severity === SEVERITY.ERROR || severity === SEVERITY.CRITICAL) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  debug(message, meta) {
    this._write(SEVERITY.DEBUG, message, meta);
  }
  info(message, meta) {
    this._write(SEVERITY.INFO, message, meta);
  }
  warn(message, meta) {
    this._write(SEVERITY.WARNING, message, meta);
  }
  error(message, meta) {
    if (meta instanceof Error) {
      meta = { error: meta.message, stack: meta.stack };
    }
    this._write(SEVERITY.ERROR, message, meta);
  }
  critical(message, meta) {
    if (meta instanceof Error) {
      meta = { error: meta.message, stack: meta.stack };
    }
    this._write(SEVERITY.CRITICAL, message, meta);
  }

  /**
   * Returns a child logger that inherits parent context and adds its own.
   */
  child(context) {
    return new Logger({ ...this.defaultContext, ...context });
  }
}

const logger = new Logger({ service: 'jit-admin-portal' });

/**
 * Express middleware that attaches a correlation ID to each request
 * and creates a request-scoped logger at req.log.
 */
function requestLogger(req, res, next) {
  const correlationId =
    req.headers['x-request-id'] ||
    req.headers['x-cloud-trace-context']?.split('/')[0] ||
    uuidv4();

  req.correlationId = correlationId;
  res.setHeader('X-Request-Id', correlationId);

  req.log = logger.child({
    correlationId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const meta = {
      statusCode: res.statusCode,
      durationMs: duration,
      userAgent: req.headers['user-agent'],
    };

    if (req.userContext?.userinfo) {
      meta.userId = req.userContext.userinfo.sub;
      meta.userEmail = req.userContext.userinfo.email;
    }

    if (res.statusCode >= 500) {
      req.log.error('Request completed with server error', meta);
    } else if (res.statusCode >= 400) {
      req.log.warn('Request completed with client error', meta);
    } else {
      req.log.info('Request completed', meta);
    }
  });

  next();
}

module.exports = { logger, requestLogger, SEVERITY };
