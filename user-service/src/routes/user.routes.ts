import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { authenticate, authorize, authorizeOwner } from '../middleware/auth.middleware';
import { validateBody, validateParams, validateQuery } from '../middleware/validation.middleware';
import { schemas } from '../utils/validation';
import { UserRole } from '../types/user.types';

const router = Router();

// Public routes
router.post('/register', 
  validateBody(schemas.createUser), 
  userController.register
);

router.post('/login', 
  validateBody(schemas.login), 
  userController.login
);

// Protected routes - require authentication
router.get('/profile', 
  authenticate, 
  userController.getProfile
);

router.post('/change-password', 
  authenticate,
  validateBody(schemas.changePassword),
  userController.changePassword
);

router.post('/verify-email',
  authenticate,
  userController.verifyEmail
);

// User management routes
router.get('/users',
  authenticate,
  authorize(UserRole.ADMIN, UserRole.MODERATOR),
  validateQuery(schemas.pagination.concat(schemas.userFilter)),
  userController.listUsers
);

router.get('/users/stats',
  authenticate,
  authorize(UserRole.ADMIN),
  userController.getUserStats
);

router.get('/users/:id',
  authenticate,
  authorizeOwner('id'),
  validateParams(schemas.userId),
  userController.getUserById
);

router.put('/users/:id',
  authenticate,
  authorizeOwner('id'),
  validateParams(schemas.userId),
  validateBody(schemas.updateUser),
  userController.updateUser
);

router.delete('/users/:id',
  authenticate,
  authorize(UserRole.ADMIN),
  validateParams(schemas.userId),
  userController.deleteUser
);

export default router;