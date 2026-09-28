import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { resolveJwtSecret } from '../config.js';

export const authMiddleware = async (req, res, next) => {
  try {
    let secret;
    try {
      secret = resolveJwtSecret();
    } catch (err) {
      // Secret unavailable (e.g. production started without one, which
      // startServer would have prevented): treat as anonymous rather than
      // crash every request. Ownership guards still protect each route.
      req.user = null;
      req.isAnonymous = true;
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      req.isAnonymous = true;
      return next();
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, secret);

      const user = await User.findById(decoded.userId).select('-passwordHash');

      if (!user) {
        req.user = null;
        req.isAnonymous = true;
        req.authError = 'unknown_user';
        return next();
      }

      req.user = user;
      req.isAnonymous = false;
      req.authError = undefined;
      next();
    } catch (jwtError) {
      // Invalid/expired tokens are downgraded to anonymous. Routes that need a
      // real identity apply their own guards (requireAuth / ownership checks).
      req.user = null;
      req.isAnonymous = true;
      req.authError = 'invalid_token';
      next();
    }
  } catch (error) {
    console.error('[Auth Middleware] Error:', error);
    req.user = null;
    req.isAnonymous = true;
    next();
  }
};

export const requireAuth = (req, res, next) => {
  if (!req.user || req.isAnonymous) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'You must be logged in to access this resource'
    });
  }
  next();
};