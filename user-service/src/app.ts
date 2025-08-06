import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config/config';
import { logger, stream } from './utils/logger';
import userRoutes from './routes/user.routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

export function createApp(): Application {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors({
    origin: config.cors.origin,
    credentials: true,
  }));

  // Rate limiting
  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    message: 'Too many requests from this IP, please try again later.',
  });
  app.use('/api/', limiter);

  // Body parsing middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Compression
  app.use(compression());

  // Logging
  if (!config.isTest) {
    app.use(morgan('combined', { stream }));
  }

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.env,
    });
  });

  // API routes
  app.use('/api', userRoutes);

  // Documentation route
  app.get('/api/docs', (req, res) => {
    res.json({
      name: 'User Service API',
      version: '1.0.0',
      endpoints: {
        'POST /api/register': 'Register a new user',
        'POST /api/login': 'Login user',
        'GET /api/profile': 'Get current user profile',
        'POST /api/change-password': 'Change user password',
        'POST /api/verify-email': 'Verify user email',
        'GET /api/users': 'List all users (admin)',
        'GET /api/users/stats': 'Get user statistics (admin)',
        'GET /api/users/:id': 'Get user by ID',
        'PUT /api/users/:id': 'Update user',
        'DELETE /api/users/:id': 'Delete user (admin)',
      },
    });
  });

  // Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}