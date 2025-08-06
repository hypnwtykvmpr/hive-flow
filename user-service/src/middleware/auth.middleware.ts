import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { UserRole } from '../types/user.types';
import { AuthenticationError, AuthorizationError } from '../utils/errors';

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('No token provided');
    }
    
    const token = authHeader.substring(7);
    const payload = await userService.verifyToken(token);
    
    req.user = payload;
    next();
  } catch (error) {
    next(error);
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AuthenticationError('Not authenticated'));
    }
    
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return next(new AuthorizationError('Insufficient permissions'));
    }
    
    next();
  };
}

export function authorizeOwner(userIdParam: string = 'id') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AuthenticationError('Not authenticated'));
    }
    
    const requestedUserId = req.params[userIdParam];
    
    // Admins can access any user
    if (req.user.role === UserRole.ADMIN) {
      return next();
    }
    
    // Users can only access their own data
    if (req.user.userId !== requestedUserId) {
      return next(new AuthorizationError('Cannot access other user data'));
    }
    
    next();
  };
}