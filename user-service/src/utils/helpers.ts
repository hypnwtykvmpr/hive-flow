import { User } from '../types/user.types';

export function excludePassword<T extends Partial<User>>(user: T): Omit<T, 'password'> {
  const { password, ...userWithoutPassword } = user;
  void password; // Mark as intentionally unused
  return userWithoutPassword as Omit<T, 'password'>;
}