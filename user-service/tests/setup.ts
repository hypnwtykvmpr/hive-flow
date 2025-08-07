import { userRepository } from '../src/repositories/user.repository';

// Clear database before each test
beforeEach(async () => {
  await userRepository.clear();
});

// Set test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';
process.env.LOG_LEVEL = 'error';