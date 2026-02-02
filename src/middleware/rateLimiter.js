'use strict';

const rateLimit = require('express-rate-limit');
const { logger } = require('../utils/logger');

/**
 * Rate limiter for API endpoints.
 * Keyed by Okta user ID (falls back to IP if not authenticated).
 * Limits: 30 JIT requests per hour per user.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 30, // 30 requests per window
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.userContext?.userinfo?.sub || req.ip;
  },
  handler: (req, res) => {
    const userId = req.userContext?.userinfo?.sub || req.ip;
    logger.warn('Rate limit exceeded', {
      userId,
      path: req.originalUrl,
      ip: req.ip,
    });
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
  skip: (req) => {
    // Don't rate-limit health checks
    return req.path === '/health';
  },
});

/**
 * General rate limiter for page loads.
 * More generous limits for browsing.
 */
const pageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 page loads per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.userContext?.userinfo?.sub || req.ip;
  },
  handler: (req, res) => {
    logger.warn('Page rate limit exceeded', { ip: req.ip });
    res.status(429).render('error', {
      title: 'Too Many Requests',
      message: 'You are making too many requests. Please wait a few minutes and try again.',
    });
  },
  skip: (req) => {
    return req.path === '/health';
  },
});

module.exports = { apiLimiter, pageLimiter };
