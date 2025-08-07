# User Service API Documentation

## Base URL
```
http://localhost:3000/api
```

## Authentication

The API uses JWT (JSON Web Tokens) for authentication. Include the token in the Authorization header:

```http
Authorization: Bearer <your-jwt-token>
```

## API Endpoints

### User Registration

**Endpoint:** `POST /api/register`  
**Access:** Public  
**Description:** Register a new user account

**Request Body:**
```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "SecurePass123!",
  "firstName": "John",
  "lastName": "Doe",
  "role": "user"
}
```

**Validation Rules:**
- Email: Valid email format, required
- Username: Alphanumeric, 3-30 characters, required
- Password: Min 8 chars, must contain uppercase, lowercase, and number, required
- FirstName: Max 50 characters, optional
- LastName: Max 50 characters, optional
- Role: One of [admin, user, moderator, guest], optional (defaults to 'user')

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "johndoe",
    "firstName": "John",
    "lastName": "Doe",
    "role": "user",
    "status": "active",
    "emailVerified": false,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  },
  "message": "User created successfully"
}
```

### User Login

**Endpoint:** `POST /api/login`  
**Access:** Public  
**Description:** Authenticate user and receive JWT token

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "username": "johndoe",
      "role": "user",
      "status": "active"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "message": "Login successful"
}
```

### Get User Profile

**Endpoint:** `GET /api/profile`  
**Access:** Protected (Authentication required)  
**Description:** Get current authenticated user's profile

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "johndoe",
    "firstName": "John",
    "lastName": "Doe",
    "avatar": "https://example.com/avatar.jpg",
    "role": "user",
    "status": "active",
    "emailVerified": true,
    "lastLogin": "2024-01-01T00:00:00Z",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

### Change Password

**Endpoint:** `POST /api/change-password`  
**Access:** Protected (Authentication required)  
**Description:** Change authenticated user's password

**Request Body:**
```json
{
  "oldPassword": "OldPass123!",
  "newPassword": "NewPass456!"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

### List Users

**Endpoint:** `GET /api/users`  
**Access:** Protected (Admin/Moderator only)  
**Description:** Get paginated list of users with filtering

**Query Parameters:**
- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10, max: 100)
- `sortBy` (string): Sort field (createdAt, updatedAt, email, username)
- `sortOrder` (string): Sort order (asc, desc)
- `role` (string): Filter by role
- `status` (string): Filter by status
- `emailVerified` (boolean): Filter by email verification
- `search` (string): Search in email, username, firstName, lastName

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "username": "johndoe",
      "firstName": "John",
      "lastName": "Doe",
      "role": "user",
      "status": "active",
      "emailVerified": true,
      "createdAt": "2024-01-01T00:00:00Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "limit": 10,
    "totalPages": 5
  }
}
```

### Get User By ID

**Endpoint:** `GET /api/users/:id`  
**Access:** Protected (Owner or Admin)  
**Description:** Get specific user by ID

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "johndoe",
    "firstName": "John",
    "lastName": "Doe",
    "avatar": "https://example.com/avatar.jpg",
    "role": "user",
    "status": "active",
    "emailVerified": true,
    "lastLogin": "2024-01-01T00:00:00Z",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

### Update User

**Endpoint:** `PUT /api/users/:id`  
**Access:** Protected (Owner or Admin)  
**Description:** Update user information

**Request Body:**
```json
{
  "email": "newemail@example.com",
  "username": "newusername",
  "firstName": "Updated",
  "lastName": "Name",
  "avatar": "https://example.com/new-avatar.jpg",
  "role": "moderator",
  "status": "active"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "newemail@example.com",
    "username": "newusername",
    "firstName": "Updated",
    "lastName": "Name",
    "updatedAt": "2024-01-01T00:00:00Z"
  },
  "message": "User updated successfully"
}
```

### Delete User

**Endpoint:** `DELETE /api/users/:id`  
**Access:** Protected (Admin only)  
**Description:** Delete or soft-delete a user

**Query Parameters:**
- `soft` (boolean): Soft delete if true (default: true)

**Response (200 OK):**
```json
{
  "success": true,
  "message": "User deactivated successfully"
}
```

### Verify Email

**Endpoint:** `POST /api/verify-email`  
**Access:** Protected (Authentication required)  
**Description:** Mark user's email as verified

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Email verified successfully"
}
```

### User Statistics

**Endpoint:** `GET /api/users/stats`  
**Access:** Protected (Admin only)  
**Description:** Get user statistics

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "total": 150,
    "active": 120,
    "inactive": 30,
    "verified": 100,
    "unverified": 50
  }
}
```

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "message": "Error description",
    "stack": "Stack trace (development only)"
  }
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input or validation error |
| 401 | Unauthorized - Authentication required or invalid credentials |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource not found |
| 409 | Conflict - Resource already exists |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## Rate Limiting

The API implements rate limiting to prevent abuse:
- Default: 100 requests per 15 minutes per IP
- Rate limit headers are included in responses:
  - `X-RateLimit-Limit`: Maximum requests allowed
  - `X-RateLimit-Remaining`: Remaining requests
  - `X-RateLimit-Reset`: Time when limit resets

## Pagination

Paginated endpoints return metadata:
```json
{
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 10,
    "totalPages": 10
  }
}
```

## Health Check

**Endpoint:** `GET /health`  
**Access:** Public  
**Description:** Check service health

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "uptime": 3600,
  "environment": "production"
}
```