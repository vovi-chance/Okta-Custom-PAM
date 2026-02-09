'use strict';

const { logger } = require('../utils/logger');

// Duration ranges per request type (minutes)
const DURATION_RANGES = {
  standard: { min: 15, max: 240 },
  emergency: { min: 15, max: 480 },
  extended: { min: 15, max: 480 },
};

const VALID_REQUEST_TYPES = Object.keys(DURATION_RANGES);

const JUSTIFICATION_MIN_LENGTH = 10;
const JUSTIFICATION_MAX_LENGTH = 1000;

/**
 * Validates the JIT access request body.
 * Returns 400 with specific error messages on validation failure.
 */
function validateJitRequest(req, res, next) {
  const errors = [];
  const body = req.body || {};
  const { requestType, durationMinutes, businessJustification } = body;

  // If body parsing failed or no JSON was provided, fail gracefully.
  // (Without this, destructuring from undefined can throw and become a 500.)
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      success: false,
      errors: ['Request body is missing or invalid JSON.'],
    });
  }

  // Validate request type
  if (!requestType || !VALID_REQUEST_TYPES.includes(requestType)) {
    errors.push(
      `Invalid request type. Must be one of: ${VALID_REQUEST_TYPES.join(', ')}`
    );
  }

  // Validate duration
  const duration = Number(durationMinutes);
  if (!Number.isInteger(duration) || duration <= 0) {
    errors.push('Duration must be a positive integer (minutes).');
  } else if (requestType && DURATION_RANGES[requestType]) {
    const range = DURATION_RANGES[requestType];
    if (duration < range.min || duration > range.max) {
      errors.push(
        `Duration for ${requestType} requests must be between ${range.min} and ${range.max} minutes.`
      );
    }
  }

  // Validate business justification (required for standard and emergency, not extended)
  if (requestType !== 'extended') {
    if (!businessJustification || typeof businessJustification !== 'string') {
      errors.push('Business justification is required.');
    } else {
      const trimmed = businessJustification.trim();
      if (trimmed.length < JUSTIFICATION_MIN_LENGTH) {
        errors.push(
          `Business justification must be at least ${JUSTIFICATION_MIN_LENGTH} characters.`
        );
      }
      if (trimmed.length > JUSTIFICATION_MAX_LENGTH) {
        errors.push(
          `Business justification must be no more than ${JUSTIFICATION_MAX_LENGTH} characters.`
        );
      }
    }
  }

  if (errors.length > 0) {
    logger.warn('JIT request validation failed', {
      errors,
      requestType,
      userId: req.userContext?.userinfo?.sub,
    });

    return res.status(400).json({
      success: false,
      errors,
    });
  }

  // Sanitize and normalize validated data
  req.validatedBody = {
    requestType,
    durationMinutes: duration,
  };

  if (requestType !== 'extended' && businessJustification) {
    req.validatedBody.businessJustification = businessJustification.trim();
  }

  next();
}

module.exports = { validateJitRequest, DURATION_RANGES, VALID_REQUEST_TYPES };
