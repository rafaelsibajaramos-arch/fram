import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import * as bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, Session, User } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CreateProducerApplicationDto, InvitationAcceptDto, InviteDto, LoginDto, PasswordResetConfirmDto, RegisterDto, RefreshDto } from './dto';
import { NeonAuth, NeonAuthError, NeonUser } from './neon-auth';

const REFRESH_DAYS = 30;
const ACCESS_SECONDS = 15 * 60;
const ACTION_TTL: Record<string, number> = { email_verification: 24 * 3600_000, password_reset: 3600_000, invitation: 7 * 24 * 3600_000 };

@Injectable()
export class AuthService {
  private readonly neon = new NeonAuth();
  constructor(private db: PrismaService, private jwt: JwtService) {}

  async register(d: RegisterDto) {
    if (this.neon.enabled) return this.registerNeon(d);
    // El alta pública solo puede crear compradores. Los roles operativos se
    // conceden tras validación administrativa mediante updateRoles/invitación.
    const role = 'buyer';
    const email = d.email.trim().toLowerCase();
    if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException('El correo ya esta registrado');
    const user = await this.db.user.create({ data: { email, passwordHash: await passwordHash(d.password), fullName: d.full_name.trim(), roles: [role], status: 'pending_email' } });
    const verification = await this.issueActionToken(user.id, 'email_verification');
    await this.sendActionEmail(email, 'Verifica tu cuenta FarmToTable', `Tu token de verificación es: ${verification}`);
    return { user: this.public(user), delivery: 'verification_required', ...(this.exposeTokens() ? { verification_token: verification } : {}) };
  }

  async login(d: LoginDto, meta: RequestMeta = {}) {
    if (this.neon.enabled) return this.loginNeon(d, meta);
    const user = await this.db.user.findUnique({ where: { email: d.email.trim().toLowerCase() } });
    if (!user || !(await passwordVerify(user.passwordHash, d.password))) throw new UnauthorizedException('Credenciales invalidas');
    // Migración transparente: los hashes bcrypt previos se reemplazan tras el
    // primer acceso correcto, sin obligar a restablecer contraseñas existentes.
    if (user.passwordHash.startsWith('$2')) user.passwordHash = (await this.db.user.update({ where: { id: user.id }, data: { passwordHash: await passwordHash(d.password) } })).passwordHash;
    if (user.status === 'pending_email') throw new UnauthorizedException('Verifique su correo antes de iniciar sesión');
    if (user.status !== 'active') throw new UnauthorizedException('La cuenta no está activa');
    return this.createSession(user, { ...meta, deviceName: d.device_name ?? meta.deviceName });
  }

  async refresh(d: RefreshDto, meta: RequestMeta = {}) {
    const session = await this.db.session.findUnique({ where: { refreshTokenHash: tokenHash(d.refresh_token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'active') throw new UnauthorizedException('Refresh token inválido o expirado');
    const refreshToken = randomToken();
    const replacement = await this.db.$transaction(async (tx) => {
      const next = await tx.session.create({ data: { userId: session.userId, refreshTokenHash: tokenHash(refreshToken), deviceName: d.device_name ?? meta.deviceName ?? session.deviceName, userAgent: meta.userAgent, ipAddress: meta.ipAddress, expiresAt: plusDays(REFRESH_DAYS) } });
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), replacedById: next.id, lastUsedAt: new Date() } });
      return next;
    });
    // El secreto se genera una sola vez; se sustituye la huella temporal creada arriba.
    // Para conservar rotación atómica, se guarda una nueva huella antes de emitir respuesta.
    return this.tokens(session.user, replacement, refreshToken);
  }

  async logout(refreshToken: string) {
    const session = await this.db.session.findUnique({ where: { refreshTokenHash: tokenHash(refreshToken) } });
    if (session && !session.revokedAt) await this.db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return { revoked: true };
  }

  async logoutAll(userId: string) { await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }); return { revoked: true }; }
  async sessions(userId: string) { const rows = await this.db.session.findMany({ where: { userId }, orderBy: { lastUsedAt: 'desc' } }); return rows.map((s) => ({ id: s.id, device_name: s.deviceName, ip_address: s.ipAddress, created_at: s.createdAt, last_used_at: s.lastUsedAt, expires_at: s.expiresAt, revoked_at: s.revokedAt })); }
  async revokeSession(userId: string, sessionId: string) { const r = await this.db.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } }); if (!r.count) throw new BadRequestException('Sesión inexistente o ya cerrada'); return { revoked: true }; }

  async verifyEmail(token: string) {
    const action = await this.takeActionToken(token, 'email_verification');
    const user = await this.db.$transaction(async (tx) => {
      const activated = await tx.user.update({ where: { id: action.userId }, data: { status: 'active', emailVerifiedAt: new Date(), version: { increment: 1 } } });
      const occurredAt = new Date();
      await tx.outboxEvent.create({ data: { eventType: 'identity.user_created', routingKey: 'identity.user_created', entityId: activated.id, entityVersion: activated.version, correlationId: randomUUID(), occurredAt, payload: { user_id: activated.id, email: activated.email, full_name: activated.fullName, status: activated.status, occurred_at: occurredAt.toISOString() } } });
      return activated;
    });
    return this.public(user);
  }
  async requestPasswordReset(email: string) {
    if (this.neon.enabled) return this.requestNeonReset(email);
    const user = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status === 'disabled') return { accepted: true };
    const token = await this.issueActionToken(user.id, 'password_reset');
    await this.sendActionEmail(user.email, 'Restablece tu contraseña FarmToTable', 'Recibimos una solicitud para cambiar tu contraseña. El enlace es válido durante una hora. Si no solicitaste el cambio, ignora este mensaje.', token);
    return { accepted: true, ...(this.exposeTokens() ? { reset_token: token } : {}) };
  }
  async resetPassword(d: PasswordResetConfirmDto) {
    if (this.neon.enabled) return this.resetNeonPassword(d);
    const action = await this.takeActionToken(d.token, 'password_reset');
    await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: action.userId }, data: { passwordHash: await passwordHash(d.password), version: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: action.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { reset: true };
  }
  async invite(d: InviteDto) {
    const email = d.email.trim().toLowerCase();
    const roles = [...new Set(d.roles)];
    if (!roles.length) throw new BadRequestException('La invitacion debe incluir al menos un rol');
    if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException('El correo ya esta registrado');
    const user = await this.db.user.create({ data: { email, fullName: d.full_name.trim(), passwordHash: await passwordHash(randomToken()), roles, status: 'pending_invite' } });
    const token = await this.issueActionToken(user.id, 'invitation');
    await this.sendActionEmail(user.email, 'Invitación a FarmToTable', `Tu token de invitación es: ${token}`);
    return { user: this.public(user), ...(this.exposeTokens() ? { invitation_token: token } : {}) };
  }
  async acceptInvitation(d: InvitationAcceptDto) {
    const action = await this.takeActionToken(d.token, 'invitation');
    const user = await this.db.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId: action.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return tx.user.update({ where: { id: action.userId }, data: { passwordHash: await passwordHash(d.password), status: 'active', emailVerifiedAt: new Date(), version: { increment: 1 } } });
    });
    return this.public(user);
  }

  async authenticate(header?: string) {
    const [, token] = (header ?? '').split(' ');
    if (!token) throw new UnauthorizedException('Inicie sesión para continuar');
    let payload: SessionJwtPayload;
    try { payload = await this.jwt.verifyAsync<SessionJwtPayload>(token, verifyJwtOptions()); } catch { throw new UnauthorizedException('La sesión expiró. Inicie sesión nuevamente'); }
    if (!payload.sub || !payload.sid || !Number.isInteger(payload.roles_version)) throw new UnauthorizedException('Sesión inválida');
    const session = await this.db.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'active' || session.user.rolesVersion !== payload.roles_version) throw new UnauthorizedException('Sesión inválida');
    return this.public(session.user);
  }

  async disable(id: string) { return this.db.$transaction(async (tx) => { const user = await tx.user.update({ where: { id }, data: { status: 'disabled', version: { increment: 1 } } }); await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); await tx.outboxEvent.create({ data: { eventType: 'identity.user_disabled', routingKey: 'identity.user_disabled', entityId: user.id, entityVersion: user.version, correlationId: randomUUID(), payload: { user_id: user.id, occurred_at: new Date().toISOString() } } }); return this.public(user); }); }
  async updateRoles(id: string, roles: string[], correlationId?: string) {
    const unique = [...new Set(roles)];
    if (!unique.length || unique.some((role) => !['buyer', 'producer', 'driver', 'logistics_admin'].includes(role))) throw new BadRequestException('La cuenta debe conservar roles operativos válidos');
    return this.db.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id }, data: { roles: unique, rolesVersion: { increment: 1 }, version: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.outboxEvent.create({ data: { eventType: 'identity.roles_changed', routingKey: 'identity.roles_changed', entityId: user.id, entityVersion: user.version, correlationId: normalizeCorrelationId(correlationId), payload: { user_id: user.id, roles: unique, roles_version: user.rolesVersion, occurred_at: new Date().toISOString() } } });
      return this.public(user);
    });
  }
  async createProducerApplication(userId: string, dto: CreateProducerApplicationDto) {
    const businessName = dto.business_name.trim().replace(/\s+/g, ' ');
    const phone = dto.phone?.trim() || null;
    const message = dto.message?.trim() || null;
    if (!businessName || businessName.length > 150 || (phone && phone.length > 25) || (message && message.length > 1000)) throw new BadRequestException('Revisa el nombre, teléfono y descripción de la solicitud');
    try {
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user || user.status !== 'active' || !user.roles.includes('buyer')) throw new BadRequestException('Se requiere una cuenta compradora activa y verificada');
        if (user.roles.includes('producer')) throw new ConflictException('Tu cuenta ya tiene un perfil de productor');
        const pending = await tx.producerApplication.findFirst({ where: { userId, status: 'pending' } });
        if (pending) throw new ConflictException('Ya tienes una solicitud de productor pendiente');
        return tx.producerApplication.create({ data: { userId, businessName, phone, message }, include: { applicant: { select: { id: true, fullName: true, email: true } } } });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Ya tienes una solicitud de productor pendiente');
      throw error;
    }
  }
  async myProducerApplication(userId: string) {
    return this.db.producerApplication.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }
  async listProducerApplications() {
    return this.db.producerApplication.findMany({
      include: {
        applicant: { select: { id: true, fullName: true, email: true, status: true, roles: true } },
        reviewer: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }
  async reviewProducerApplication(id: string, adminId: string, decision: 'approved' | 'rejected', reviewNotes?: string, correlationId?: string) {
    const notes = reviewNotes?.trim() || null;
    if (notes && notes.length > 1000) throw new BadRequestException('La nota de revisión no puede superar 1000 caracteres');
    try {
      return await this.db.$transaction(async (tx) => {
        const application = await tx.producerApplication.findUnique({ where: { id }, include: { applicant: true } });
        if (!application) throw new BadRequestException('La solicitud no existe');
        if (application.status !== 'pending') throw new ConflictException('La solicitud ya fue revisada');
        if (application.userId === adminId) throw new ForbiddenException('No puedes revisar tu propia solicitud');
        if (decision === 'approved' && application.applicant.status !== 'active') throw new ConflictException('Solo se puede aprobar una cuenta activa y verificada');
        const claimed = await tx.producerApplication.updateMany({
          where: { id, status: 'pending' },
          data: { status: decision, reviewNotes: notes, reviewedBy: adminId, reviewedAt: new Date() },
        });
        if (claimed.count !== 1) throw new ConflictException('La solicitud ya fue revisada');
        if (decision === 'approved') {
          const roles = [...new Set([...application.applicant.roles, 'producer'])];
          const user = await tx.user.update({ where: { id: application.userId }, data: { roles, rolesVersion: { increment: 1 }, version: { increment: 1 } } });
          await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
          await tx.outboxEvent.create({ data: {
            eventType: 'identity.roles_changed', routingKey: 'identity.roles_changed', entityId: user.id,
            entityVersion: user.version, correlationId: normalizeCorrelationId(correlationId),
            payload: { user_id: user.id, roles, roles_version: user.rolesVersion, occurred_at: new Date().toISOString() },
          } });
        }
        return tx.producerApplication.findUnique({ where: { id }, include: { applicant: { select: { id: true, fullName: true, email: true, status: true, roles: true } }, reviewer: { select: { id: true, fullName: true, email: true } } } });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException('La solicitud fue modificada concurrentemente; actualiza la lista');
      throw error;
    }
  }
  async listUsers(search?: string) { const term = search?.trim(); const users = await this.db.user.findMany({ where: term ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { fullName: { contains: term, mode: 'insensitive' } }] } : undefined, orderBy: { createdAt: 'desc' }, take: 100 }); return users.map((u) => this.public(u)); }

  private async createSession(user: User, meta: RequestMeta) { const refreshToken = randomToken(); const session = await this.db.session.create({ data: { userId: user.id, refreshTokenHash: tokenHash(refreshToken), deviceName: meta.deviceName, userAgent: meta.userAgent, ipAddress: meta.ipAddress, expiresAt: plusDays(REFRESH_DAYS) } }); return this.tokens(user, session, refreshToken); }
  private async registerNeon(d: RegisterDto) {
    return this.neon.run(async () => {
      const email = d.email.trim().toLowerCase();
      if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException('El correo ya está registrado. Inicia sesión o recupera tu contraseña.');
      const remote = await this.neon.signup(email, d.password, d.full_name.trim());
      this.assertNeonUser(remote.user, email);
      const user = await this.db.user.create({ data: { email, neonAuthId: remote.user.id, neonCredentialReady: true, passwordHash: await passwordHash(randomToken()), fullName: d.full_name.trim(), roles: ['buyer'], status: 'pending_email' } });
      await this.neon.sendVerification(email);
      return { user: this.public(user), delivery: 'verification_required', verification_method: 'email_otp' };
    });
  }
  async sendNeonVerification(email: string) {
    if (!this.neon.enabled) throw new BadRequestException('La verificación por código no está habilitada');
    return this.neon.run(async () => { await this.neon.sendVerification(email.trim().toLowerCase()); return { accepted: true }; });
  }
  async verifyNeonEmail(email: string, otp: string) {
    if (!this.neon.enabled) throw new BadRequestException('La verificación por código no está habilitada');
    return this.neon.run(async () => {
      email = email.trim().toLowerCase();
      const remote = await this.neon.verify(email, otp);
      this.assertNeonUser(remote.user, email);
      if (!remote.user.emailVerified) throw new BadRequestException('No se pudo verificar el correo');
      const user = await this.db.user.findUnique({ where: { email } });
      if (!user || user.status === 'disabled' || (user.neonAuthId && user.neonAuthId !== remote.user.id)) throw new ForbiddenException('La cuenta no está disponible');
      const activated = await this.db.$transaction(async tx => {
        const activated = await tx.user.update({ where: { id: user.id }, data: { neonAuthId: remote.user.id, status: 'active', emailVerifiedAt: new Date() } });
        await tx.outboxEvent.create({ data: { eventType: 'identity.user_created', routingKey: 'identity.user_created', entityId: user.id, entityVersion: user.version, correlationId: randomUUID(), payload: { user_id: user.id, email, full_name: user.fullName, status: 'active' } } });
        return activated;
      });
      return this.public(activated);
    });
  }
  private assertNeonUser(user: NeonUser | undefined, email: string) {
    if (!user?.id || user.email?.toLowerCase() !== email) throw new UnauthorizedException('La identidad de la cuenta no coincide');
  }
  private async loginNeon(d: LoginDto, meta: RequestMeta) {
    return this.neon.run(async () => {
      const email = d.email.trim().toLowerCase();
      let user = await this.db.user.findUnique({ where: { email } });
      if (user && ['disabled', 'pending_invite'].includes(user.status)) throw new UnauthorizedException('La cuenta no está activa');
      let remote: { user: NeonUser; token?: string };
      let legacyProof = false;
      try { remote = await this.neon.signin(email, d.password); }
      catch (error) {
        // Never fall back to a legacy password after an account has been linked.
        if (!(error instanceof NeonAuthError) || error.status !== 401 || !user || user.neonCredentialReady || user.status !== 'active' || !(await passwordVerify(user.passwordHash, d.password))) throw error;
        // A recovery request may provision a Neon account with a random
        // credential. Keep the old login usable until that reset succeeds.
        if (user.neonAuthId) return this.createSession(user, { ...meta, deviceName: d.device_name ?? meta.deviceName });
        legacyProof = true;
        remote = await this.neon.signup(email, d.password, user.fullName);
      }
      this.assertNeonUser(remote.user, email);
      if (user?.neonAuthId && user.neonAuthId !== remote.user.id) throw new UnauthorizedException('La identidad de la cuenta no coincide');
      if (!user?.neonAuthId && !legacyProof && !remote.user.emailVerified) {
        // Knowing the password of an unverified external account cannot claim
        // an existing privileged FarmToTable user with the same email address.
        await this.neon.sendVerification(email);
        throw new UnauthorizedException('Verifica tu correo con el código recibido antes de iniciar sesión');
      }
      if (user?.status === 'pending_email' && !remote.user.emailVerified) {
        await this.neon.sendVerification(email);
        throw new UnauthorizedException('Verifica tu correo con el código recibido antes de iniciar sesión');
      }
      if (!remote.token && !legacyProof) throw new UnauthorizedException('Verifica tu correo antes de iniciar sesión');
      if (!user) user = await this.db.user.create({ data: { email, neonAuthId: remote.user.id, neonCredentialReady: true, passwordHash: await passwordHash(randomToken()), fullName: remote.user.name.slice(0, 150), roles: ['buyer'], status: 'active', emailVerifiedAt: new Date() } });
      else if (!user.neonAuthId || !user.neonCredentialReady || user.status === 'pending_email') user = await this.db.user.update({ where: { id: user.id }, data: { neonAuthId: remote.user.id, neonCredentialReady: true, passwordHash: await passwordHash(randomToken()), status: 'active', ...(remote.user.emailVerified ? { emailVerifiedAt: new Date() } : {}) } });
      return this.createSession(user, { ...meta, deviceName: d.device_name ?? meta.deviceName });
    });
  }
  private async requestNeonReset(input: string) {
    return this.neon.run(async () => {
      const email = input.trim().toLowerCase();
      let user = await this.db.user.findUnique({ where: { email } });
      if (!user || user.status === 'disabled') return { accepted: true };
      if (!user.neonAuthId) {
        try {
          const remote = await this.neon.signup(email, randomToken(), user.fullName);
          this.assertNeonUser(remote.user, email);
          user = await this.db.user.update({ where: { id: user.id }, data: { neonAuthId: remote.user.id } });
        } catch (error) {
          if (!(error instanceof NeonAuthError) || !['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'].includes(error.code)) throw error;
        }
      }
      const context = await this.issueActionToken(user.id, 'password_reset');
      const redirectTo = `${this.neon.origin()}/?recovery_context=${encodeURIComponent(context)}#/recuperar`;
      await this.neon.call('/request-password-reset', { email, redirectTo });
      return { accepted: true };
    });
  }
  private async resetNeonPassword(d: PasswordResetConfirmDto) {
    return this.neon.run(async () => {
      if (!d.context) throw new BadRequestException('Solicita un enlace nuevo desde Recuperar contraseña');
      const context = await this.db.actionToken.findUnique({ where: { tokenHash: tokenHash(d.context) } });
      if (!context || context.purpose !== 'password_reset' || context.usedAt || context.expiresAt <= new Date()) throw new BadRequestException('El enlace ya fue utilizado o expiró');
      const user = await this.db.user.findUniqueOrThrow({ where: { id: context.userId } });
      if (user.status === 'disabled') throw new ForbiddenException('La cuenta no está activa');
      await this.neon.call('/reset-password', { token: d.token, newPassword: d.password });
      const remote = await this.neon.signin(user.email, d.password);
      this.assertNeonUser(remote.user, user.email);
      if (user.neonAuthId && remote.user.id !== user.neonAuthId) throw new UnauthorizedException('La identidad de la cuenta no coincide');
      await this.db.$transaction(async tx => {
        const consumed = await tx.actionToken.updateMany({ where: { id: context.id, usedAt: null }, data: { usedAt: new Date() } });
        if (!consumed.count) throw new BadRequestException('El enlace ya fue utilizado');
        await tx.user.update({ where: { id: user.id }, data: { neonAuthId: remote.user.id, neonCredentialReady: true, passwordHash: await passwordHash(randomToken()), status: 'active', emailVerifiedAt: new Date(), version: { increment: 1 } } });
        await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      });
      return { reset: true };
    });
  }
  private tokens(user: User, session: Session, refreshToken: string) { const accessToken = this.jwt.sign({ sub: user.id, sid: session.id, roles: user.roles, roles_version: user.rolesVersion }, { ...signJwtOptions(), expiresIn: ACCESS_SECONDS }); return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refreshToken, session: { id: session.id, device_name: session.deviceName, expires_at: session.expiresAt }, user: this.public(user) }; }
  private async issueActionToken(userId: string, purpose: 'email_verification' | 'password_reset' | 'invitation') { const raw = randomToken(); await this.db.actionToken.create({ data: { userId, purpose, tokenHash: tokenHash(raw), expiresAt: new Date(Date.now() + ACTION_TTL[purpose]) } }); return raw; }
  private async takeActionToken(raw: string, purpose: 'email_verification' | 'password_reset' | 'invitation') { const token = await this.db.actionToken.findUnique({ where: { tokenHash: tokenHash(raw) } }); if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt <= new Date()) throw new BadRequestException('Token inválido o expirado'); const used = await this.db.actionToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } }); if (!used.count) throw new BadRequestException('Token ya utilizado'); return token; }
  private public(user: User) { return { id: user.id, email: user.email, full_name: user.fullName, roles: user.roles, status: user.status, email_verified_at: user.emailVerifiedAt, created_at: user.createdAt }; }
  private exposeTokens() { return process.env.NODE_ENV !== 'production' && process.env.AUTH_EXPOSE_ACTION_TOKENS === 'true'; }
  private async sendActionEmail(to: string, subject: string, text: string, recoveryToken?: string) {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return false;
    let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
    try {
      const port = Number(process.env.SMTP_PORT ?? 587);
      transporter = nodemailer.createTransport({
        host, port, secure: process.env.SMTP_SECURE === 'true', auth: { user, pass },
        // No dejar que un socket SMTP lento mantenga el endpoint de registro o
        // recuperación abierto más que el timeout del Gateway.
        connectionTimeout: smtpTimeout('SMTP_CONNECTION_TIMEOUT_MS', 5_000),
        greetingTimeout: smtpTimeout('SMTP_GREETING_TIMEOUT_MS', 5_000),
        socketTimeout: smtpTimeout('SMTP_SOCKET_TIMEOUT_MS', 10_000),
      });
      const publicUrl = process.env.APP_PUBLIC_URL ?? 'http://localhost:4000';
      const link = `${publicUrl.replace(/\/+$/, '')}/#/recuperar?token=${encodeURIComponent(recoveryToken ?? text.split(': ').pop() ?? '')}`;
      const sent = await transporter.sendMail({ from: process.env.SMTP_FROM ?? user, to, subject, text: `${text}\n\nAbre este enlace para continuar:\n${link}` });
      console.info('Correo de identidad aceptado por SMTP', { accepted: sent.accepted?.length ?? 0 });
      return true;
    } catch (error) {
      console.error('No se pudo enviar el correo de identidad', error);
      return false;
    } finally {
      transporter?.close();
    }
  }
}

interface SessionJwtPayload {
  sub?: string;
  sid?: string;
  roles_version?: number;
}

type RequestMeta = { deviceName?: string; userAgent?: string; ipAddress?: string };
const randomToken = () => randomBytes(48).toString('base64url');
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function normalizeCorrelationId(value?: string) { return value && UUID_PATTERN.test(value) ? value : randomUUID(); }
const plusDays = (days: number) => new Date(Date.now() + days * 86400_000);
async function passwordHash(password: string) { return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }); }
async function passwordVerify(hashValue: string, password: string) { return hashValue.startsWith('$2') ? bcrypt.compare(password, hashValue) : verify(hashValue, password); }
function issuer() { return process.env.JWT_ISSUER ?? 'farmtotable-identity'; }
function audience() { return process.env.JWT_AUDIENCE ?? 'farmtotable-api'; }
function decodeKey(value: string, label: string) { if (!value) throw new Error(`${label} es obligatoria para RS256`); const normalized = value.replace(/\\n/g, '\n').trim(); if (normalized.includes('BEGIN ')) return normalized; return Buffer.from(normalized, 'base64').toString('utf8').replace(/\\n/g, '\n').trim(); }
function privateKey() { return decodeKey(process.env.JWT_PRIVATE_KEY ?? '', 'JWT_PRIVATE_KEY'); }
function publicKey() { return decodeKey(process.env.JWT_PUBLIC_KEY ?? '', 'JWT_PUBLIC_KEY'); }
function signJwtOptions() { return { algorithm: 'RS256' as const, privateKey: privateKey(), issuer: issuer(), audience: audience() }; }
function verifyJwtOptions() { return { algorithms: ['RS256' as const], publicKey: publicKey(), issuer: issuer(), audience: audience() }; }
function smtpTimeout(name: string, fallback: number) { const configured = Number(process.env[name]); return Number.isFinite(configured) && configured >= 1_000 ? Math.min(configured, 30_000) : fallback; }
