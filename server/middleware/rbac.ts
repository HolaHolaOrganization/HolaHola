import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { User } from "../../shared/schema";
import crypto from "crypto";
import { touchFounderPresence } from "../services/founder-presence";
import { resolveCoordinationActor } from "./coordination-auth";

// Role hierarchy: admin > developer > teacher > student
const roleHierarchy = {
  student: 0,
  teacher: 1,
  developer: 2,
  admin: 3,
};

type UserRole = keyof typeof roleHierarchy;

// Extended Express Request with authenticated user
export interface AuthenticatedRequest extends Request {
  user?: {
    claims: {
      sub: string; // User ID
      email?: string;
    };
  };
  authenticatedUser?: User; // Full user object with role
}

/**
 * Middleware to require a minimum role level
 * Usage: app.get('/api/admin/users', requireRole('admin'), handler)
 */
export function requireRole(...minRoles: UserRole[]): RequestHandler {
  const minRole = minRoles[0];
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      // Password auth / agent session path: session.userId set directly (covers AI browser + agent sessions)
      const sessionUserId = (req.session as any)?.userId;
      if (sessionUserId) {
        if (!req.authenticatedUser) {
          return res.status(500).json({ error: "User data not loaded. Ensure loadAuthenticatedUser middleware runs first." });
        }
        const userRole = req.authenticatedUser.role as UserRole;
        if (roleHierarchy[userRole] < roleHierarchy[minRole]) {
          return res.status(403).json({ error: "Insufficient permissions", required: minRole, current: userRole });
        }
        return next();
      }

      // OIDC / Replit Auth path
      if (!req.user?.claims?.sub) {
        return res.status(401).json({ error: "Authentication required" });
      }

      // Get full user object with role
      if (!req.authenticatedUser) {
        return res.status(500).json({ error: "User data not loaded. Ensure loadAuthenticatedUser middleware runs first." });
      }

      const userRole = req.authenticatedUser.role as UserRole;

      // Check if user's role meets minimum requirement
      if (roleHierarchy[userRole] < roleHierarchy[minRole]) {
        return res.status(403).json({ 
          error: "Insufficient permissions",
          required: minRole,
          current: userRole
        });
      }

      next();
    } catch (error) {
      console.error("[RBAC] Error in requireRole middleware:", error);
      return res.status(500).json({ error: "Authorization check failed" });
    }
  };
}

/**
 * Middleware to allow specific roles (OR condition)
 * Usage: app.get('/api/content', allowRoles(['teacher', 'admin']), handler)
 */
export function allowRoles(allowedRoles: UserRole[]): RequestHandler {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      // Password auth / agent session path: session.userId set directly (covers AI browser + agent sessions)
      const sessionUserId = (req.session as any)?.userId;
      if (sessionUserId) {
        if (!req.authenticatedUser) {
          return res.status(500).json({ error: "User data not loaded. Ensure loadAuthenticatedUser middleware runs first." });
        }
        const userRole = req.authenticatedUser.role as UserRole;
        if (!allowedRoles.includes(userRole)) {
          return res.status(403).json({ error: "Insufficient permissions", allowed: allowedRoles, current: userRole });
        }
        return next();
      }

      // OIDC / Replit Auth path
      if (!req.user?.claims?.sub) {
        return res.status(401).json({ error: "Authentication required" });
      }

      // Get full user object with role
      if (!req.authenticatedUser) {
        return res.status(500).json({ error: "User data not loaded" });
      }

      const userRole = req.authenticatedUser.role as UserRole;

      // Check if user's role is in allowed list
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: "Insufficient permissions",
          allowed: allowedRoles,
          current: userRole
        });
      }

      next();
    } catch (error) {
      console.error("[RBAC] Error in allowRoles middleware:", error);
      return res.status(500).json({ error: "Authorization check failed" });
    }
  };
}

/**
 * Middleware to load authenticated user data into request
 * Should run after isAuthenticated middleware
 * This populates req.authenticatedUser with full user object including role
 */
export function loadAuthenticatedUser(storage: any): RequestHandler {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      // Skip if not authenticated - check both password auth and OIDC
      const userId = (req.session as any)?.userId || req.user?.claims?.sub;
      if (!userId) {
        return next();
      }
      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Attach full user object to request
      req.authenticatedUser = user;

      next();
    } catch (error) {
      console.error("[RBAC] Error loading authenticated user:", error);
      return res.status(500).json({ error: "Failed to load user data" });
    }
  };
}

/**
 * Check if user is admin
 */
export function isAdmin(user: User | undefined): boolean {
  return user?.role === 'admin';
}

/**
 * Check if user is developer or above
 */
export function isDeveloperOrAbove(user: User | undefined): boolean {
  if (!user) return false;
  const userRole = user.role as UserRole;
  return roleHierarchy[userRole] >= roleHierarchy.developer;
}

/**
 * Check if user is teacher or above
 */
export function isTeacherOrAbove(user: User | undefined): boolean {
  if (!user) return false;
  const userRole = user.role as UserRole;
  return roleHierarchy[userRole] >= roleHierarchy.teacher;
}

/**
 * Check if user has permission to perform an action
 * Admins can do everything, developers can read everything but not mutate strategic configs
 */
export function hasPermission(user: User | undefined, action: 'read' | 'write' | 'delete', resourceType: string): boolean {
  if (!user) return false;
  
  const userRole = user.role as UserRole;
  
  // Admin can do everything
  if (userRole === 'admin') return true;
  
  // Developer can read everything
  if (userRole === 'developer' && action === 'read') return true;
  
  // Teachers can manage their own classes and assignments
  if (userRole === 'teacher') {
    if (resourceType === 'class' || resourceType === 'assignment') {
      return true; // Additional owner check required at route level
    }
  }
  
  return false;
}

/**
 * Check if impersonation is active for current request
 */
export function isImpersonating(user: User | undefined): boolean {
  if (!user) return false;
  return !!(user.impersonatedBy && user.impersonationExpiresAt && new Date(user.impersonationExpiresAt) > new Date());
}

/**
 * Get original admin ID if impersonating
 */
export function getOriginalAdminId(user: User | undefined): string | null {
  if (!user || !isImpersonating(user)) return null;
  return user.impersonatedBy || null;
}

// Founder user ID for founder-only endpoints
const FOUNDER_USER_ID = '49847136';

/** Sensitive founder grants never accept the non-production test equivalent. */
export function isCanonicalFounderId(id: string | undefined | null): boolean {
  return id === FOUNDER_USER_ID;
}

// ── Dev-only founder-equivalent test account ──────────────────────────────────
// scripts/data-ops/seed-dev-test-account.ts seeds a single shared account
// (DEV_TEST_ACCOUNT_ID) that agents/CI log into via the real password-auth
// API instead of the old DEV_AUTH_BYPASS skip-auth-entirely shortcut. Without
// this allow-list, that account would satisfy every ordinary role check
// (it's role='admin') but could never pass a founder-only gate, leaving
// Alden tools/Team Room/Brain Health/Voice Health/Telemetry/Growth Memories/
// Curriculum Sync untestable by agents.
//
// This exact NODE_ENV guard is what keeps that dev-only equivalence from
// ever applying in production -- locked by the prod-founder-bypass-guard CI
// check (server/scripts/test-prod-founder-bypass-guard.ts), mirroring the
// production-safety pattern DEV_AUTH_BYPASS itself used to rely on.
const DEV_TEST_ACCOUNT_ID = 'dev-test-agent';
function isFounderId(id: string | undefined | null): boolean {
  if (!id) return false;
  if (id === FOUNDER_USER_ID) return true;
  if (process.env.NODE_ENV !== 'production' && id === DEV_TEST_ACCOUNT_ID) return true;
  return false;
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if user is the founder
 */
export function isFounder(user: User | undefined): boolean {
  return isFounderId(user?.id);
}

/**
 * Middleware to require founder access only
 * Usage: app.get('/api/admin/voice-health', requireFounder, handler)
 */
export function requireFounder(req: Request, res: Response, next: NextFunction) {
  const _req = req as AuthenticatedRequest;
  try {
    // Password auth path: session.userId set directly (covers AI browser + password login)
    const sessionUserId = (req.session as any)?.userId;
    if (isFounderId(sessionUserId)) {
      if (!_req.authenticatedUser) {
        return res.status(500).json({ error: "User data not loaded. Ensure loadAuthenticatedUser middleware runs first." });
      }
      touchFounderPresence();
      return next();
    }

    // OIDC / Replit Auth path
    if (!_req.user?.claims?.sub) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!_req.authenticatedUser) {
      return res.status(500).json({ error: "User data not loaded. Ensure loadAuthenticatedUser middleware runs first." });
    }

    if (!isFounderId(_req.authenticatedUser.id)) {
      return res.status(403).json({ error: "Founder access required" });
    }

    touchFounderPresence();
    next();
  } catch (error) {
    console.error("[RBAC] Error in requireFounder middleware:", error);
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

// ===== REPLIT AGENT AUTHENTICATION =====
// Dedicated token for Replit Agent (builders) to access Hive/Wren services
// Separate from ARCHITECT_SECRET to allow granular permission control

// Audit log for agent actions (in-memory ring buffer, persists to hiveSnapshots)
interface AgentAuditEntry {
  timestamp: Date;
  action: string;
  endpoint: string;
  success: boolean;
  details?: string;
}
const agentAuditLog: AgentAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 100;

/**
 * Log an agent action for audit trail
 */
export function logAgentAction(action: string, endpoint: string, success: boolean, details?: string) {
  const entry: AgentAuditEntry = {
    timestamp: new Date(),
    action,
    endpoint,
    success,
    details
  };
  
  agentAuditLog.push(entry);
  
  // Ring buffer - keep last N entries
  if (agentAuditLog.length > MAX_AUDIT_ENTRIES) {
    agentAuditLog.shift();
  }
  
  console.log(`[AGENT-AUDIT] ${success ? '✓' : '✗'} ${action} on ${endpoint}${details ? ` - ${details}` : ''}`);
}

/**
 * Get recent agent audit entries
 */
export function getAgentAuditLog(limit = 50): AgentAuditEntry[] {
  return agentAuditLog.slice(-limit);
}

/**
 * Extended request type for agent-authenticated requests
 */
export interface AgentAuthenticatedRequest extends Request {
  agentId?: string; // Identifier for the agent (for future multi-agent support)
}

/** Check if Luca [Replit]'s dedicated credential is configured. */
export function isAgentTokenConfigured(): boolean {
  const token = process.env.COORDINATION_LUCA_REPLIT_TOKEN;
  return Boolean(token && token.length >= 32);
}

function resolveReplitAgentRequest(req: Request) {
  return resolveCoordinationActor(
    typeof req.headers['x-coordination-token'] === 'string'
      ? req.headers['x-coordination-token']
      : undefined,
    undefined,
  );
}

export function isReplitAgentRequest(req: Request): boolean {
  const resolution = resolveReplitAgentRequest(req);
  return resolution.ok && resolution.actor === 'luca-replit';
}

/**
 * Middleware to require Replit Agent token authentication
 * Usage: app.get('/api/agent/sprints', requireAgentToken, handler)
 * 
 * Authenticates via Luca [Replit]'s dedicated x-coordination-token header.
 * Provides read-only access to Wren services
 */
export function requireAgentToken(req: AgentAuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    // Check if token is configured
    if (!isAgentTokenConfigured()) {
      console.warn('[RBAC] Luca agent credential not configured or too short (min 32 chars)');
      logAgentAction('auth_attempt', req.path, false, 'Token not configured');
      return res.status(503).json({ error: 'Agent authentication not configured' });
    }

    const resolution = resolveReplitAgentRequest(req);
    if (!resolution.ok && resolution.status === 401 && !req.headers['x-coordination-token']) {
      logAgentAction('auth_attempt', req.path, false, 'No token provided');
      return res.status(401).json({ error: 'Agent token required (x-coordination-token header)' });
    }

    if (!resolution.ok) {
      logAgentAction('auth_attempt', req.path, false, resolution.error);
      return res.status(resolution.status === 503 ? 503 : 401).json({ error: resolution.error });
    }

    if (resolution.actor !== 'luca-replit') {
      logAgentAction('auth_attempt', req.path, false, `Unexpected actor: ${resolution.actor}`);
      return res.status(403).json({ error: 'This endpoint requires Luca [Replit]' });
    }

    // Token valid - set agent ID for tracking
    req.agentId = resolution.actor;
    
    logAgentAction('auth_success', req.path, true);
    next();
  } catch (error) {
    console.error('[RBAC] Error in requireAgentToken middleware:', error);
    logAgentAction('auth_error', req.path, false, String(error));
    return res.status(500).json({ error: 'Agent authorization check failed' });
  }
}

/**
 * Dual-auth: agent token OR founder session — whichever comes first wins.
 * Used for monitoring endpoints that Luca (agent) reads directly but founders
 * can also access via browser.
 * Usage: app.get('/api/admin/live-monitor', requireFounderOrAgent, handler)
 */
export function requireFounderOrAgent(req: Request, res: Response, next: NextFunction) {
  // Fast path: valid agent token → pass through without needing a session
  try {
    const resolution = resolveReplitAgentRequest(req);
    if (resolution.ok && resolution.actor === 'luca-replit') {
      logAgentAction('auth_success', req.path, true);
      return next();
    }
  } catch {
    // fall through to founder check
  }

  // Founder session path
  return requireFounder(req, res, next);
}
