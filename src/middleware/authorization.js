'use strict';

const { logger } = require('../utils/logger');

/**
 * Decodes a JWT without verification (the token was already verified
 * by @okta/oidc-middleware during the auth callback).
 * Returns the payload as a plain object.
 */
function decodeIdToken(idToken) {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extracts group memberships from the user context.
 * Checks (in order):
 *   1. userinfo.groups  (if the userinfo endpoint returns it)
 *   2. ID token "groups" claim (decoded from the JWT)
 */
function getGroups(userContext) {
  // Check userinfo first (custom claim name from Okta)
  if (Array.isArray(userContext.userinfo?.['JIT-groups'])) {
    return userContext.userinfo['JIT-groups'];
  }

  // Decode the ID token and check for groups claim
  const idToken = userContext.tokens?.id_token;
  if (idToken) {
    const claims = decodeIdToken(idToken);
    if (claims && Array.isArray(claims['JIT-groups'])) {
      return claims['JIT-groups'];
    }
  }

  return null;
}

/**
 * Middleware factory: requires the authenticated user to be a member
 * of the specified Okta group.
 *
 * Reads groups from the ID token "groups" claim (no extra API call).
 */
function requireGroup(requiredGroup) {
  return async (req, res, next) => {
    try {
      const userContext = req.userContext;
      const userInfo = userContext?.userinfo;

      if (!userInfo) {
        logger.warn('Authorization check failed: no user context', {
          path: req.originalUrl,
        });
        return res.status(401).render('error', {
          title: 'Authentication Required',
          message: 'Please sign in to continue.',
        });
      }

      const userId = userInfo.sub;
      const groupNames = getGroups(userContext);

      if (!groupNames) {
        logger.warn('No groups claim found in ID token or userinfo', {
          userId,
          email: userInfo.email,
          hasIdToken: !!userContext.tokens?.id_token,
          userinfoClaims: Object.keys(userInfo),
        });
        const isApi = req.path.startsWith('/api/');
        if (isApi) {
          return res.status(403).json({
            success: false,
            error: 'Group information is not available in your token. Please contact your administrator.',
          });
        }
        return res.status(403).render('error', {
          title: 'Access Denied',
          message:
            'Group information is not available. Please contact your administrator to configure the groups claim on the authorization server.',
        });
      }

      logger.info('User groups resolved', {
        userId,
        email: userInfo.email,
        groups: groupNames,
      });

      if (!groupNames.includes(requiredGroup)) {
        logger.warn('Authorization denied: user not in required group', {
          userId,
          email: userInfo.email,
          requiredGroup,
          userGroups: groupNames,
        });

        const isApi = req.path.startsWith('/api/');
        if (isApi) {
          return res.status(403).json({
            success: false,
            error: `Membership in the "${requiredGroup}" group is required.`,
          });
        }
        return res.status(403).render('error', {
          title: 'Access Denied',
          message: `You are not authorized to access this portal. Membership in the "${requiredGroup}" group is required. Contact your administrator to request access.`,
        });
      }

      req.userGroups = groupNames;
      next();
    } catch (err) {
      const isApi = req.path.startsWith('/api/');
      const log = req.log || logger;
      log.error('Authorization middleware error', err);

      if (isApi) {
        return res.status(503).json({
          success: false,
          error: 'Unable to verify your access permissions. Please try again.',
        });
      }
      return res.status(500).render('error', {
        title: 'Authorization Error',
        message: 'Unable to verify your access permissions. Please try again.',
      });
    }
  };
}

module.exports = { requireGroup };
