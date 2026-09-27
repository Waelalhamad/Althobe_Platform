import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import type { Db } from '../../shared/db.js';
import { DomainError, NotFoundError } from '../../shared/errors.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type Permission,
} from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import { isRoleName, permissionsFor, ROLE_NAMES } from './roles.js';

// docs/security.md → Authentication.
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // expires after 12 h without use
const TOUCH_EVERY_MS = 5 * 60 * 1000; // extend at most every 5 min, not on every request
const MIN_PASSWORD_LENGTH = 12;

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
}

export class NotAuthenticatedError extends DomainError {
  constructor() {
    super('NOT_AUTHENTICATED', 'Please log in');
  }
}

export class LockoutPreventedError extends DomainError {
  constructor(reason: string) {
    super('LOCKOUT_PREVENTED', reason);
  }
}

export class EmailTakenError extends DomainError {
  constructor(email: string) {
    super('EMAIL_TAKEN', 'An account with this email already exists', { email });
  }
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120).optional(),
  roles: z
    .array(z.string())
    .min(1)
    .refine((roles) => roles.every(isRoleName), `Roles must be among: ${ROLE_NAMES.join(', ')}`),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const rolesSchema = z
  .array(z.string())
  .min(1)
  .refine((roles) => roles.every(isRoleName), `Roles must be among: ${ROLE_NAMES.join(', ')}`);

const adminCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  nameAr: z.string().trim().min(1).max(120),
  roles: rolesSchema,
});

const updateUserSchema = z.object({
  nameAr: z.string().trim().min(1).max(120).optional(),
  roles: rolesSchema.optional(),
  isActive: z.boolean().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

export interface AccountView {
  id: string;
  email: string;
  nameAr: string;
  roles: string[];
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const accountSelect = {
  id: true,
  email: true,
  nameAr: true,
  roles: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

export interface SessionUser {
  id: string;
  email: string;
  nameAr: string;
  nameEn: string | null;
  roles: string[];
  permissions: Permission[];
}

export interface Authenticated {
  actor: ActorContext;
  user: SessionUser;
}

// Verifying against a fixed hash when the email is unknown keeps login time the same whether or
// not the account exists, so response timing does not reveal which emails are registered.
let dummyHash: Promise<string> | undefined;

export function createAuthService(db: Db) {
  const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

  function toSessionUser(u: {
    id: string;
    email: string;
    nameAr: string;
    nameEn: string | null;
    roles: string[];
  }): SessionUser {
    // Pick fields explicitly: callers pass whole database rows, and spreading one would send
    // password_hash to the browser. (A spread did exactly that before 2026-09-24.)
    return {
      id: u.id,
      email: u.email,
      nameAr: u.nameAr,
      nameEn: u.nameEn,
      roles: u.roles,
      permissions: [...permissionsFor(u.roles)],
    };
  }

  return {
    async login(
      input: z.input<typeof loginSchema>,
      meta: { ip?: string; userAgent?: string },
    ): Promise<{ token: string; expiresAt: Date; user: SessionUser }> {
      const data = parse(loginSchema, input);
      const user = await db.user.findUnique({ where: { email: data.email } });

      dummyHash ??= hash('not-a-real-password-0000');
      const ok = await verify(user?.passwordHash ?? (await dummyHash), data.password);
      if (!user || !user.passwordHash || !user.isActive || !ok) throw new InvalidCredentialsError();

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_IDLE_MS);
      await db.$transaction(async (tx) => {
        await tx.session.create({
          data: {
            userId: user.id,
            tokenHash: sha256(token),
            expiresAt,
            ip: meta.ip ?? null,
            userAgent: meta.userAgent?.slice(0, 300) ?? null,
          },
        });
        await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        await writeAudit(tx, {
          actorId: user.id,
          action: 'auth.login',
          entityType: 'user',
          entityId: user.id,
          after: { ip: meta.ip ?? null },
        });
      });
      return { token, expiresAt, user: toSessionUser(user) };
    },

    /** Resolves a session cookie to an actor. Sliding expiry: use keeps the session alive. */
    async authenticate(token: string | undefined): Promise<Authenticated> {
      if (!token) throw new NotAuthenticatedError();
      const session = await db.session.findUnique({
        where: { tokenHash: sha256(token) },
        include: { user: true },
      });
      const now = Date.now();
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt.getTime() <= now ||
        !session.user.isActive
      ) {
        throw new NotAuthenticatedError();
      }
      if (now - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
        await db.session.update({
          where: { id: session.id },
          data: { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_IDLE_MS) },
        });
      }
      const user = toSessionUser(session.user);
      return { user, actor: { userId: user.id, permissions: new Set(user.permissions) } };
    },

    /** Server-side revocation: deleting the cookie alone is not logout. */
    async logout(token: string | undefined): Promise<void> {
      if (!token) return;
      await db.session.updateMany({
        where: { tokenHash: sha256(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    // -- Account management (owner only: admin.users.write) --------------------------------

    async listUsers(ctx: ActorContext): Promise<AccountView[]> {
      assertPermission(ctx, PERMISSIONS.admin.users);
      // Machine users (no password, e.g. "system") are not people and are not listed.
      return db.user.findMany({
        where: { passwordHash: { not: null } },
        select: accountSelect,
        orderBy: { createdAt: 'asc' },
      });
    },

    /** Creates a login and returns a one-time password to hand over privately. */
    async adminCreateUser(
      input: z.input<typeof adminCreateSchema>,
      ctx: ActorContext,
    ): Promise<{ user: AccountView; password: string }> {
      assertPermission(ctx, PERMISSIONS.admin.users);
      const data = parse(adminCreateSchema, input);
      if (await db.user.findUnique({ where: { email: data.email } })) {
        throw new EmailTakenError(data.email);
      }
      const password = randomBytes(12).toString('base64url');
      const passwordHash = await hash(password);
      const user = await db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email: data.email, nameAr: data.nameAr, roles: data.roles, passwordHash },
          select: accountSelect,
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'admin.users.create',
          entityType: 'user',
          entityId: created.id,
          after: { email: created.email, roles: created.roles },
        });
        return created;
      });
      return { user, password };
    },

    async updateUser(
      userId: string,
      input: z.input<typeof updateUserSchema>,
      ctx: ActorContext,
    ): Promise<AccountView> {
      assertPermission(ctx, PERMISSIONS.admin.users);
      const data = parse(updateUserSchema, input);
      return db.$transaction(async (tx) => {
        const before = await tx.user.findUnique({ where: { id: userId }, select: accountSelect });
        if (!before) throw new NotFoundError('user', userId);

        const losesAdmin =
          (data.isActive === false && before.isActive) ||
          (data.roles !== undefined && !permissionsFor(data.roles).has(PERMISSIONS.admin.users));
        if (losesAdmin && userId === ctx.userId) {
          throw new LockoutPreventedError(
            'You cannot deactivate yourself or remove your own owner rights',
          );
        }
        if (losesAdmin && permissionsFor(before.roles).has(PERMISSIONS.admin.users)) {
          const others = await tx.user.findMany({
            where: { isActive: true, id: { not: userId } },
            select: { roles: true },
          });
          if (!others.some((u) => permissionsFor(u.roles).has(PERMISSIONS.admin.users))) {
            throw new LockoutPreventedError('At least one active owner must remain');
          }
        }

        const after = await tx.user.update({
          where: { id: userId },
          data: {
            ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
            ...(data.roles !== undefined ? { roles: data.roles } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
          select: accountSelect,
        });
        // Deactivation and role changes take effect now, not at the next login.
        if (data.isActive === false || data.roles !== undefined) {
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'admin.users.update',
          entityType: 'user',
          entityId: userId,
          before: { nameAr: before.nameAr, roles: before.roles, isActive: before.isActive },
          after: { nameAr: after.nameAr, roles: after.roles, isActive: after.isActive },
        });
        return after;
      });
    },

    /** New one-time password; every existing session of that user ends. */
    async resetPassword(userId: string, ctx: ActorContext): Promise<{ password: string }> {
      assertPermission(ctx, PERMISSIONS.admin.users);
      const password = randomBytes(12).toString('base64url');
      const passwordHash = await hash(password);
      await db.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user?.passwordHash) throw new NotFoundError('user', userId);
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'admin.users.reset_password',
          entityType: 'user',
          entityId: userId,
        });
      });
      return { password };
    },

    /** Anyone changes their own password; their other sessions end, this one stays. */
    async changeOwnPassword(
      input: z.input<typeof changePasswordSchema>,
      ctx: ActorContext,
      currentToken: string,
    ): Promise<void> {
      const data = parse(changePasswordSchema, input);
      const user = await db.user.findUnique({ where: { id: ctx.userId } });
      if (!user?.passwordHash || !(await verify(user.passwordHash, data.currentPassword))) {
        throw new InvalidCredentialsError();
      }
      const passwordHash = await hash(data.newPassword);
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null, tokenHash: { not: sha256(currentToken) } },
          data: { revokedAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: user.id,
          action: 'auth.change_password',
          entityType: 'user',
          entityId: user.id,
        });
      });
    },

    /** Colleagues' display names, for "who did this" in histories. Not sensitive. */
    async displayNames(ids: string[]): Promise<Record<string, string>> {
      if (ids.length === 0) return {};
      const users = await db.user.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, nameAr: true },
      });
      return Object.fromEntries(users.map((u) => [u.id, u.nameAr]));
    },

    /** Used by the create-user script. There is no self-registration. */
    async createUser(input: z.input<typeof createUserSchema>): Promise<SessionUser> {
      const data = parse(createUserSchema, input);
      const user = await db.user.create({
        data: {
          email: data.email,
          nameAr: data.nameAr,
          nameEn: data.nameEn ?? null,
          roles: data.roles,
          passwordHash: await hash(data.password),
        },
      });
      return toSessionUser(user);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
