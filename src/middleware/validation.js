'use strict';

const { logger } = require('../utils/logger');

// Duration ranges per request type (minutes)
const DURATION_RANGES = {
  standard: { min: 15, max: 240 },
  emergency: { min: 15, max: 480 },
  extended: { min: 60, max: 480 },
};

const VALID_REQUEST_TYPES = Object.keys(DURATION_RANGES);

const JUSTIFICATION_MIN_LENGTH = 10;
const JUSTIFICATION_MAX_LENGTH = 1000;

// Ticket format: alphanumeric with hyphens, 3-30 characters
const TICKET_PATTERN = /^[a-zA-Z0-9-]{3,30}$/;

/**
 * Validates the JIT access request body.
 * Returns 400 with specific error messages on validation failure.
 */
function validateJitRequest(req, res, next) {
  const errors = [];
  const body = req.body || {};
  const { requestType, durationMinutes, businessJustification, incidentTicket } = body;

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

  // Validate business justification
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

  // Validate incident ticket for emergency requests
  if (requestType === 'emergency') {
    if (!incidentTicket || typeof incidentTicket !== 'string') {
      errors.push('Incident ticket number is required for emergency requests.');
    } else if (!TICKET_PATTERN.test(incidentTicket.trim())) {
      errors.push(
        'Incident ticket must be 3-30 characters, alphanumeric with hyphens only.'
      );
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
    businessJustification: businessJustification.trim(),
    incidentTicket:
      requestType === 'emergency' ? incidentTicket.trim() : undefined,
  };

  next();
}

module.exports = { validateJitRequest, DURATION_RANGES, VALID_REQUEST_TYPES };
