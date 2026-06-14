# 🔐 Madeira Auth Layer (`madeira-auth-layer`)

This is a **thin, focused Lambda Layer** dedicated to authentication utilities.

It provides:
- User ID generation and validation (`auth-utils.js`)
- JWT signing and verification (`jwt.js`)

It depends on the **Core Layer** for configuration, logging, and password hashing.

**Location in repo:** `Layers/madeira-auth-layer/`

---

## Purpose

- Provide clean utilities for user identity and JWT handling
- Keep auth-related logic centralized and easy to maintain
- Depend on the Core Layer for secrets, logging, and bcrypt functions

---

## Folder Structure

```
Layers/madeira-auth-layer/
└── nodejs/
    ├── auth-utils.js     ← User ID generation + validation
    └── jwt.js              ← JWT signing & verification
```

---

## 1. `auth-utils.js` – User ID Utilities

### Exports

| Function            | Description                                      | Returns     |
|---------------------|--------------------------------------------------|-------------|
| `generateUserId()`  | Generates a unique 8-character User ID with checksum | `string`    |
| `validateUserId(userId)` | Validates a User ID (length + checksum)     | `boolean`   |

### Example Usage

```js
const { generateUserId, validateUserId } = require('/opt/nodejs/auth-utils');

const userId = generateUserId();           // e.g. "L7WDZWC8"
const isValid = validateUserId(userId);    // true
```

**Note:** These functions are used during user creation (onboarding, delegation, etc.).

---

## 2. `jwt.js` – JWT Handling

### Exports

| Function                     | Description                          | Returns             |
|------------------------------|--------------------------------------|---------------------|
| `signJWT(payload, options?)` | Signs a JWT token                    | `Promise<string>`   |
| `verifyJWT(token)`           | Verifies and decodes a JWT token     | `Promise<object>`   |

### Example Usage

```js
const { signJWT, verifyJWT } = require('/opt/nodejs/jwt');

// Sign a token
const token = await signJWT({
    user_id: 'L7WDZWC8',
    permissions: ['partner', 'admin'],
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
});

// Verify a token
try {
    const decoded = await verifyJWT(token);
    console.log(decoded.user_id);
} catch (err) {
    console.error('Invalid or expired token');
}
```

---

## Bcrypt / Password Hashing

**Bcrypt functions are NOT in this layer.**

Password hashing (`hashPassword` / `comparePassword`) lives in the **Core Layer**:

- `Layers/madeira-core-layer/nodejs/helpers.js`
- Exported via `/opt/nodejs/helpers`

```js
const { hashPassword, comparePassword } = require('/opt/nodejs/helpers');

const hashed = await hashPassword('MyPassword123');
const match = await comparePassword('MyPassword123', hashed);
```

See the [Core Layer README](../madeira-core-layer/readme.md) for full details.

---

## Dependencies

This layer depends on the **Core Layer** (`madeira-core-layer`) for:
- `getJwtConfig()`
- `logger`
- `hashPassword` / `comparePassword` (bcrypt)

---

## Important Notes

- The layer uses **HS256** algorithm only for JWTs.
- User IDs are always 8 characters with a checksum digit.
- All errors are logged with a unique `transactionId`.
- Do **not** duplicate auth logic in individual services.

---

**Last Updated:** 14 June 2026  
**Maintained by:** Simon Barnett (Club Madeira)  
**Depends on:** `madeira-core-layer`