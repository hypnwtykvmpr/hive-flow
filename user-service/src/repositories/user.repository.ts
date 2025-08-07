import { v4 as uuidv4 } from 'uuid';
import { 
  User, 
  CreateUserDTO, 
  UpdateUserDTO, 
  UserRole, 
  UserStatus, 
  PaginationOptions, 
  PaginatedResult,
  UserFilter 
} from '../types/user.types';

// In-memory storage for demonstration
// In production, replace with actual database implementation
class UserRepository {
  private users: Map<string, User> = new Map();

  async create(data: CreateUserDTO): Promise<User> {
    const user: User = {
      id: uuidv4(),
      ...data,
      role: data.role || UserRole.USER,
      status: UserStatus.ACTIVE,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    this.users.set(user.id, user);
    return { ...user };
  }

  async findById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === email.toLowerCase()) {
        return { ...user };
      }
    }
    return null;
  }

  async findByUsername(username: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === username.toLowerCase()) {
        return { ...user };
      }
    }
    return null;
  }

  async update(id: string, data: UpdateUserDTO): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;

    const updatedUser = {
      ...user,
      ...data,
      updatedAt: new Date(),
    };
    
    this.users.set(id, updatedUser);
    return { ...updatedUser };
  }

  async delete(id: string): Promise<boolean> {
    return this.users.delete(id);
  }

  async softDelete(id: string): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;

    const updatedUser = {
      ...user,
      status: UserStatus.DELETED,
      updatedAt: new Date(),
    };
    
    this.users.set(id, updatedUser);
    return { ...updatedUser };
  }

  async findAll(
    filter: UserFilter = {},
    pagination: PaginationOptions
  ): Promise<PaginatedResult<User>> {
    let filteredUsers = Array.from(this.users.values());

    // Apply filters
    if (filter.role) {
      filteredUsers = filteredUsers.filter(u => u.role === filter.role);
    }
    if (filter.status) {
      filteredUsers = filteredUsers.filter(u => u.status === filter.status);
    }
    if (filter.emailVerified !== undefined) {
      filteredUsers = filteredUsers.filter(u => u.emailVerified === filter.emailVerified);
    }
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      filteredUsers = filteredUsers.filter(u => 
        u.email.toLowerCase().includes(searchLower) ||
        u.username.toLowerCase().includes(searchLower) ||
        u.firstName?.toLowerCase().includes(searchLower) ||
        u.lastName?.toLowerCase().includes(searchLower)
      );
    }

    // Sort
    const sortBy = pagination.sortBy || 'createdAt';
    const sortOrder = pagination.sortOrder || 'desc';
    filteredUsers.sort((a, b) => {
      const aVal = a[sortBy as keyof User];
      const bVal = b[sortBy as keyof User];
      if (aVal === undefined || bVal === undefined) return 0;
      const comparison = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    // Paginate
    const total = filteredUsers.length;
    const start = (pagination.page - 1) * pagination.limit;
    const end = start + pagination.limit;
    const paginatedData = filteredUsers.slice(start, end);

    return {
      data: paginatedData.map(u => ({ ...u })),
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(total / pagination.limit),
    };
  }

  async updateLastLogin(id: string): Promise<void> {
    const user = this.users.get(id);
    if (user) {
      user.lastLogin = new Date();
      user.updatedAt = new Date();
      this.users.set(id, user);
    }
  }

  async verifyEmail(id: string): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;

    const updatedUser = {
      ...user,
      emailVerified: true,
      updatedAt: new Date(),
    };
    
    this.users.set(id, updatedUser);
    return { ...updatedUser };
  }

  async count(filter: UserFilter = {}): Promise<number> {
    let count = 0;
    for (const user of this.users.values()) {
      if (filter.role && user.role !== filter.role) continue;
      if (filter.status && user.status !== filter.status) continue;
      if (filter.emailVerified !== undefined && user.emailVerified !== filter.emailVerified) continue;
      count++;
    }
    return count;
  }

  async clear(): Promise<void> {
    this.users.clear();
  }
}

export const userRepository = new UserRepository();