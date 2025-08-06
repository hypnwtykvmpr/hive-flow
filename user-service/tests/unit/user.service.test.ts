import { userService } from '../../src/services/user.service';
import { userRepository } from '../../src/repositories/user.repository';
import { CreateUserDTO, UserRole, UserStatus } from '../../src/types/user.types';
import { AppError } from '../../src/utils/errors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

jest.mock('bcrypt');
jest.mock('jsonwebtoken');

describe('UserService', () => {
  const mockUser: CreateUserDTO = {
    email: 'test@example.com',
    username: 'testuser',
    password: 'Test123!@#',
    firstName: 'Test',
    lastName: 'User',
  };

  describe('createUser', () => {
    it('should create a new user successfully', async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      
      const user = await userService.createUser(mockUser);
      
      expect(user).toBeDefined();
      expect(user.email).toBe(mockUser.email);
      expect(user.username).toBe(mockUser.username);
      expect(user).not.toHaveProperty('password');
    });

    it('should throw error if email already exists', async () => {
      await userService.createUser(mockUser);
      
      await expect(userService.createUser(mockUser))
        .rejects
        .toThrow(new AppError('Email already exists', 409));
    });

    it('should throw error if username already exists', async () => {
      await userService.createUser(mockUser);
      
      const newUser = { ...mockUser, email: 'new@example.com' };
      await expect(userService.createUser(newUser))
        .rejects
        .toThrow(new AppError('Username already exists', 409));
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (jwt.sign as jest.Mock).mockReturnValue('mock-token');
      
      await userService.createUser(mockUser);
    });

    it('should login user successfully', async () => {
      const result = await userService.login({
        email: mockUser.email,
        password: mockUser.password,
      });
      
      expect(result.token).toBe('mock-token');
      expect(result.user.email).toBe(mockUser.email);
      expect(result.user).not.toHaveProperty('password');
    });

    it('should throw error for invalid credentials', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      
      await expect(userService.login({
        email: mockUser.email,
        password: 'wrongpassword',
      })).rejects.toThrow(new AppError('Invalid credentials', 401));
    });

    it('should throw error for non-existent user', async () => {
      await expect(userService.login({
        email: 'nonexistent@example.com',
        password: mockUser.password,
      })).rejects.toThrow(new AppError('Invalid credentials', 401));
    });
  });

  describe('getUserById', () => {
    it('should return user without password', async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      const createdUser = await userService.createUser(mockUser);
      
      const user = await userService.getUserById(createdUser.id);
      
      expect(user).toBeDefined();
      expect(user?.email).toBe(mockUser.email);
      expect(user).not.toHaveProperty('password');
    });

    it('should return null for non-existent user', async () => {
      const user = await userService.getUserById('non-existent-id');
      expect(user).toBeNull();
    });
  });

  describe('updateUser', () => {
    it('should update user successfully', async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      const createdUser = await userService.createUser(mockUser);
      
      const updated = await userService.updateUser(createdUser.id, {
        firstName: 'Updated',
        lastName: 'Name',
      });
      
      expect(updated.firstName).toBe('Updated');
      expect(updated.lastName).toBe('Name');
    });

    it('should throw error for non-existent user', async () => {
      await expect(userService.updateUser('non-existent', {}))
        .rejects
        .toThrow(new AppError('User not found', 404));
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      
      const createdUser = await userService.createUser(mockUser);
      
      await expect(userService.changePassword(
        createdUser.id, 
        mockUser.password, 
        'NewPassword123!'
      )).resolves.not.toThrow();
    });

    it('should throw error for invalid old password', async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      const createdUser = await userService.createUser(mockUser);
      
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      
      await expect(userService.changePassword(
        createdUser.id,
        'wrongpassword',
        'NewPassword123!'
      )).rejects.toThrow(new AppError('Invalid old password', 401));
    });
  });

  describe('listUsers', () => {
    beforeEach(async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashedPassword');
      
      for (let i = 0; i < 15; i++) {
        await userService.createUser({
          email: `user${i}@example.com`,
          username: `user${i}`,
          password: 'Test123!',
        });
      }
    });

    it('should return paginated users', async () => {
      const result = await userService.listUsers({}, { page: 1, limit: 10 });
      
      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(15);
      expect(result.totalPages).toBe(2);
    });

    it('should filter users by search', async () => {
      const result = await userService.listUsers(
        { search: 'user1' },
        { page: 1, limit: 10 }
      );
      
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.every(u => 
        u.email.includes('user1') || u.username.includes('user1')
      )).toBe(true);
    });
  });
});