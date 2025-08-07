import { createApp } from './app';
import { config, validateConfig } from './config/config';
import { logger } from './utils/logger';

async function startServer() {
  try {
    // Validate configuration
    validateConfig();

    // Create Express app
    const app = createApp();

    // Start server
    const server = app.listen(config.port, config.host, () => {
      logger.info(`🚀 User Service started successfully`);
      logger.info(`📡 Server running at http://${config.host}:${config.port}`);
      logger.info(`🌍 Environment: ${config.env}`);
      logger.info(`📚 API Docs: http://${config.host}:${config.port}/api/docs`);
      logger.info(`🏥 Health Check: http://${config.host}:${config.port}/health`);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown...`);
      
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();