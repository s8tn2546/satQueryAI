import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      req.isAnonymous = true;
      return next();
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-dev-secret');
      
      const user = await User.findById(decoded.userId).select('-passwordHash');
      
      if (!user) {
        req.user = null;
        req.isAnonymous = true;
        return next();
      }

      req.user = user;
      req.isAnonymous = false;
      next();
    } catch (jwtError) {
      req.user = null;
      req.isAnonymous = true;
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
