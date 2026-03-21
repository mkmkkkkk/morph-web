import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is required');
const STATIC_TOKEN = process.env.STATIC_TOKEN || null;

/**
 * Generate a JWT for an account.
 */
export function generateToken(accountId) {
  return jwt.sign({ sub: accountId, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: '30d' });
}

/**
 * Verify a bearer token. Returns { accountId } or null.
 */
export function verifyToken(token) {
  if (!token) return null;

  // Static token shortcut
  if (STATIC_TOKEN && token === STATIC_TOKEN) {
    return { accountId: 'static-user' };
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { accountId: payload.sub || 'default' };
  } catch {
    return null;
  }
}

/**
 * Extract bearer token from Authorization header.
 */
function extractToken(request) {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * Fastify preHandler hook — authenticates requests.
 */
export async function authMiddleware(request, reply) {
  const token = extractToken(request);
  const result = verifyToken(token);
  if (!result) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  request.accountId = result.accountId;
}

/**
 * Generate a fresh account ID for new auth requests.
 */
export function newAccountId() {
  return randomUUID();
}
