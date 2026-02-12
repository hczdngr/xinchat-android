# Admin Login (Isolated From User DB)

## Overview

Admin authentication is now separated from normal user authentication:

- Normal users: `backend/data/users.json`, `/api/login`
- Admin users: `backend/data/admin-users.json`, `/api/admin/auth/login`

`/api/admin/*` routes accept admin token only (`X-Admin-Token` or `Authorization: Bearer <admin_token>`), plus optional legacy `ADMIN_API_TOKEN`.

## Bootstrap Admin Account

Set environment variables before starting backend:

- `ADMIN_BOOTSTRAP_USERNAME`
- `ADMIN_BOOTSTRAP_PASSWORD`
- `ADMIN_BOOTSTRAP_DISPLAY_NAME` (optional)
- `ADMIN_BOOTSTRAP_FORCE_RESET_PASSWORD=true` (optional)

Recommended for strict mode:

- `ADMIN_ENABLE_INSECURE=false`

## APIs

### `POST /api/admin/auth/login`

Request:

```json
{
  "username": "ops_admin",
  "password": "StrongPassw0rd!"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "token": "<admin_token>",
    "tokenExpiresAt": "2026-02-12T10:00:00.000Z",
    "admin": {
      "source": "admin_account",
      "id": 1,
      "username": "ops_admin",
      "displayName": "Ops Admin",
      "role": "super_admin",
      "lastLoginAt": "2026-02-11T10:00:00.000Z"
    }
  }
}
```

### `GET /api/admin/auth/me`

Headers: `X-Admin-Token: <admin_token>`

### `POST /api/admin/auth/logout`

Headers: `X-Admin-Token: <admin_token>`

## Compatibility

- If `ADMIN_API_TOKEN` is set, it is still accepted for admin APIs.
- If `ADMIN_ENABLE_INSECURE=true` and no token is provided, admin APIs remain accessible for local development.
