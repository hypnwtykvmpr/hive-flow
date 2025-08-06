import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { 
  CreateUserDTO, 
  UpdateUserDTO, 
  LoginDTO, 
  PaginationOptions,
  UserFilter 
} from '../types/user.types';

export class UserController {
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userData: CreateUserDTO = req.body;
      const user = await userService.createUser(userData);
      
      res.status(201).json({
        success: true,
        data: user,
        message: 'User created successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const loginData: LoginDTO = req.body;
      const authResponse = await userService.login(loginData);
      
      res.json({
        success: true,
        data: authResponse,
        message: 'Login successful',
      });
    } catch (error) {
      next(error);
    }
  }

  async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const user = await userService.getUserById(userId);
      
      if (!user) {
        return next(new Error('User not found'));
      }
      
      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const user = await userService.getUserById(id);
      
      if (!user) {
        return next(new Error('User not found'));
      }
      
      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const updateData: UpdateUserDTO = req.body;
      const user = await userService.updateUser(id, updateData);
      
      res.json({
        success: true,
        data: user,
        message: 'User updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const { oldPassword, newPassword } = req.body;
      
      await userService.changePassword(userId, oldPassword, newPassword);
      
      res.json({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const soft = req.query.soft !== 'false';
      
      await userService.deleteUser(id, soft);
      
      res.json({
        success: true,
        message: soft ? 'User deactivated successfully' : 'User deleted permanently',
      });
    } catch (error) {
      next(error);
    }
  }

  async listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const pagination: PaginationOptions = {
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 10,
        sortBy: req.query.sortBy as string,
        sortOrder: req.query.sortOrder as 'asc' | 'desc',
      };
      
      const filter: UserFilter = {
        role: req.query.role as any,
        status: req.query.status as any,
        emailVerified: req.query.emailVerified === 'true' ? true : 
                      req.query.emailVerified === 'false' ? false : undefined,
        search: req.query.search as string,
      };
      
      const result = await userService.listUsers(filter, pagination);
      
      res.json({
        success: true,
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      await userService.verifyEmail(userId);
      
      res.json({
        success: true,
        message: 'Email verified successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await userService.getUserStats();
      
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();