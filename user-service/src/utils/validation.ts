import Joi from 'joi';
import { UserRole, UserStatus } from '../types/user.types';

export const schemas = {
  createUser: Joi.object({
    email: Joi.string().email().required(),
    username: Joi.string().alphanum().min(3).max(30).required(),
    password: Joi.string().min(8).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required()
      .messages({
        'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      }),
    firstName: Joi.string().max(50),
    lastName: Joi.string().max(50),
    role: Joi.string().valid(...Object.values(UserRole)),
  }),

  updateUser: Joi.object({
    email: Joi.string().email(),
    username: Joi.string().alphanum().min(3).max(30),
    firstName: Joi.string().max(50),
    lastName: Joi.string().max(50),
    avatar: Joi.string().uri(),
    role: Joi.string().valid(...Object.values(UserRole)),
    status: Joi.string().valid(...Object.values(UserStatus)),
  }).min(1),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  changePassword: Joi.object({
    oldPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required()
      .messages({
        'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      }),
  }),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(10),
    sortBy: Joi.string().valid('createdAt', 'updatedAt', 'email', 'username'),
    sortOrder: Joi.string().valid('asc', 'desc'),
  }),

  userFilter: Joi.object({
    role: Joi.string().valid(...Object.values(UserRole)),
    status: Joi.string().valid(...Object.values(UserStatus)),
    emailVerified: Joi.boolean(),
    search: Joi.string().max(100),
  }),

  userId: Joi.object({
    id: Joi.string().uuid().required(),
  }),

  email: Joi.object({
    email: Joi.string().email().required(),
  }),
};

export function validate<T>(schema: Joi.Schema, data: unknown): T {
  const { error, value } = schema.validate(data, { abortEarly: false });
  
  if (error) {
    const messages = error.details.map(detail => detail.message).join(', ');
    throw new Error(messages);
  }
  
  return value as T;
}