import request from 'supertest';
import { createApp } from '../../src/app';
import { Application } from 'express';
import { userRepository } from '../../src/repositories/user.repository';

describe('User Routes Integration', () => {
  let app: Application;
  let authToken: string;
  let userId: string;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    await userRepository.clear();
  });

  describe('POST /api/register', () => {
    it('should register a new user', async () => {
      const response = await request(app)
        .post('/api/register')
        .send({
          email: 'test@example.com',
          username: 'testuser',
          password: 'Test123!@#',
          firstName: 'Test',
          lastName: 'User',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe('test@example.com');
      expect(response.body.data).not.toHaveProperty('password');
      
      userId = response.body.data.id;
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/register')
        .send({
          email: 'invalid-email',
          username: 'test',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should prevent duplicate email registration', async () => {
      const userData = {
        email: 'test@example.com',
        username: 'testuser1',
        password: 'Test123!@#',
      };

      await request(app).post('/api/register').send(userData);
      
      const response = await request(app)
        .post('/api/register')
        .send({ ...userData, username: 'testuser2' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('Email already exists');
    });
  });

  describe('POST /api/login', () => {
    beforeEach(async () => {
      const registerResponse = await request(app)
        .post('/api/register')
        .send({
          email: 'test@example.com',
          username: 'testuser',
          password: 'Test123!@#',
        });
      
      userId = registerResponse.body.data.id;
    });

    it('should login with valid credentials', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({
          email: 'test@example.com',
          password: 'Test123!@#',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.token).toBeDefined();
      expect(response.body.data.user.email).toBe('test@example.com');
      
      authToken = response.body.data.token;
    });

    it('should reject invalid credentials', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({
          email: 'test@example.com',
          password: 'WrongPassword',
        });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toContain('Invalid credentials');
    });
  });

  describe('Protected Routes', () => {
    beforeEach(async () => {
      // Register and login to get auth token
      await request(app)
        .post('/api/register')
        .send({
          email: 'test@example.com',
          username: 'testuser',
          password: 'Test123!@#',
          role: 'admin',
        });

      const loginResponse = await request(app)
        .post('/api/login')
        .send({
          email: 'test@example.com',
          password: 'Test123!@#',
        });

      authToken = loginResponse.body.data.token;
      userId = loginResponse.body.data.user.id;
    });

    describe('GET /api/profile', () => {
      it('should get user profile with valid token', async () => {
        const response = await request(app)
          .get('/api/profile')
          .set('Authorization', `Bearer ${authToken}`);

        expect(response.status).toBe(200);
        expect(response.body.data.email).toBe('test@example.com');
      });

      it('should reject request without token', async () => {
        const response = await request(app)
          .get('/api/profile');

        expect(response.status).toBe(401);
      });
    });

    describe('PUT /api/users/:id', () => {
      it('should update user profile', async () => {
        const response = await request(app)
          .put(`/api/users/${userId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            firstName: 'Updated',
            lastName: 'Name',
          });

        expect(response.status).toBe(200);
        expect(response.body.data.firstName).toBe('Updated');
        expect(response.body.data.lastName).toBe('Name');
      });
    });

    describe('POST /api/change-password', () => {
      it('should change password with correct old password', async () => {
        const response = await request(app)
          .post('/api/change-password')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            oldPassword: 'Test123!@#',
            newPassword: 'NewTest123!@#',
          });

        expect(response.status).toBe(200);
        expect(response.body.message).toContain('Password changed successfully');
      });

      it('should reject with incorrect old password', async () => {
        const response = await request(app)
          .post('/api/change-password')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            oldPassword: 'WrongPassword',
            newPassword: 'NewTest123!@#',
          });

        expect(response.status).toBe(401);
      });
    });

    describe('GET /api/users', () => {
      beforeEach(async () => {
        // Create multiple users
        for (let i = 0; i < 5; i++) {
          await request(app)
            .post('/api/register')
            .send({
              email: `user${i}@example.com`,
              username: `user${i}`,
              password: 'Test123!@#',
            });
        }
      });

      it('should list users with pagination', async () => {
        const response = await request(app)
          .get('/api/users')
          .set('Authorization', `Bearer ${authToken}`)
          .query({ page: 1, limit: 3 });

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(3);
        expect(response.body.meta.totalPages).toBeGreaterThan(1);
      });

      it('should filter users by search', async () => {
        const response = await request(app)
          .get('/api/users')
          .set('Authorization', `Bearer ${authToken}`)
          .query({ search: 'user1' });

        expect(response.status).toBe(200);
        expect(response.body.data.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('API Documentation', () => {
    it('should return API documentation', async () => {
      const response = await request(app).get('/api/docs');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('User Service API');
      expect(response.body.endpoints).toBeDefined();
    });
  });
});