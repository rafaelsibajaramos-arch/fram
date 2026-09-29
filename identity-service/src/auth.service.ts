import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import * as bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { InvitationAcceptDto, InviteDto, LoginDto, PasswordResetConfirmDto, RegisterDto, RefreshDto } from './dto';

const REFRESH_DAYS = 30;
const ACCESS_SECONDS = 15 * 60;
const ACTION_TTL: Record<string, number> = { email_verification: 24 * 3600_000, password_reset: 3600_000, invitation: 7 * 24 * 3600_000 };

@Injectable()
export class AuthService {
  constructor(private db: PrismaService, private jwt: JwtService) {}

  async register(d: RegisterDto) {
    const email = d.email.trim().toLowerCase();
    if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException('El correo ya esta registrado');
    const user = await this.db.user.create({ data: { email, passwordHash: await passwordHash(d.password), fullName: d.full_name.trim(), roles: ['buyer'], status: 'pending_email' } });
    const verification = await this.issueActionToken(user.id, 'email_verification');
    await this.sendActionEmail(email, 'Verifica tu cuenta FarmToTable', `Tu token de verificación es: ${verification}`);
    return { user: this.public(user), delivery: 'verification_required', ...(this.exposeTokens() ? { verification_token: verification } : {}) };
  }

  async login(d: LoginDto, meta: RequestMeta = {}) {
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
    const user = await this.db.user.update({ where: { id: action.userId }, data: { status: 'active', emailVerifiedAt: new Date(), version: { increment: 1 } } });
    return this.public(user);
  }
  async requestPasswordReset(email: string) {
    const user = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status === 'disabled') return { accepted: true };
    const token = await this.issueActionToken(user.id, 'password_reset');
    await this.sendActionEmail(user.email, 'Restablece tu contraseña FarmToTable', `Tu token de recuperación es: ${token}`);
    return { accepted: true, ...(this.exposeTokens() ? { reset_token: token } : {}) };
  }
  async resetPassword(d: PasswordResetConfirmDto) {
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
    let payload: any;
    try { payload = await this.jwt.verifyAsync(token, verifyJwtOptions()); } catch { throw new UnauthorizedException('La sesión expiró. Inicie sesión nuevamente'); }
    if (!payload.sub || !payload.sid || !Number.isInteger(payload.roles_version)) throw new UnauthorizedException('Sesión inválida');
    const session = await this.db.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'active' || session.user.rolesVersion !== payload.roles_version) throw new UnauthorizedException('Sesión inválida');
    return this.public(session.user);
  }

  async disable(id: string) { return this.db.$transaction(async (tx) => { const user = await tx.user.update({ where: { id }, data: { status: 'disabled', version: { increment: 1 } } }); await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); await tx.outboxEvent.create({ data: { eventType: 'identity.user_disabled', routingKey: 'identity.user_disabled', entityId: user.id, entityVersion: user.version, correlationId: randomUUID(), payload: { user_id: user.id, occurred_at: new Date().toISOString() } } }); return this.public(user); }); }
  async updateRoles(id: string, roles: string[]) { const unique = [...new Set(roles)]; if (!unique.length) throw new BadRequestException('La cuenta debe conservar al menos un rol'); const user = await this.db.user.update({ where: { id }, data: { roles: unique, rolesVersion: { increment: 1 } } }); await this.db.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); return this.public(user); }
  async listUsers(search?: string) { const term = search?.trim(); const users = await this.db.user.findMany({ where: term ? { OR: [{ email: { contains: term, mode: 'insensitive' } }, { fullName: { contains: term, mode: 'insensitive' } }] } : undefined, orderBy: { createdAt: 'desc' }, take: 100 }); return users.map((u) => this.public(u)); }

  private async createSession(user: any, meta: RequestMeta) { const refreshToken = randomToken(); const session = await this.db.session.create({ data: { userId: user.id, refreshTokenHash: tokenHash(refreshToken), deviceName: meta.deviceName, userAgent: meta.userAgent, ipAddress: meta.ipAddress, expiresAt: plusDays(REFRESH_DAYS) } }); return this.tokens(user, session, refreshToken); }
  private tokens(user: any, session: any, refreshToken: string) { const accessToken = this.jwt.sign({ sub: user.id, sid: session.id, roles: user.roles, roles_version: user.rolesVersion }, { ...signJwtOptions(), expiresIn: ACCESS_SECONDS }); return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refreshToken, session: { id: session.id, device_name: session.deviceName, expires_at: session.expiresAt }, user: this.public(user) }; }
  private async issueActionToken(userId: string, purpose: 'email_verification' | 'password_reset' | 'invitation') { const raw = randomToken(); await this.db.actionToken.create({ data: { userId, purpose, tokenHash: tokenHash(raw), expiresAt: new Date(Date.now() + ACTION_TTL[purpose]) } }); return raw; }
  private async takeActionToken(raw: string, purpose: 'email_verification' | 'password_reset' | 'invitation') { const token = await this.db.actionToken.findUnique({ where: { tokenHash: tokenHash(raw) } }); if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt <= new Date()) throw new BadRequestException('Token inválido o expirado'); const used = await this.db.actionToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } }); if (!used.count) throw new BadRequestException('Token ya utilizado'); return token; }
  private public(user: any) { return { id: user.id, email: user.email, full_name: user.fullName, roles: user.roles, status: user.status, email_verified_at: user.emailVerifiedAt, created_at: user.createdAt }; }
  private exposeTokens() { return process.env.AUTH_EXPOSE_ACTION_TOKENS === 'true'; }
  private async sendActionEmail(to: string, subject: string, text: string) {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return false;
    try {
      const port = Number(process.env.SMTP_PORT ?? 587);
      const transporter = nodemailer.createTransport({ host, port, secure: process.env.SMTP_SECURE === 'true', auth: { user, pass } });
      const publicUrl = process.env.APP_PUBLIC_URL ?? 'http://localhost:4000';
      await transporter.sendMail({ from: process.env.SMTP_FROM ?? user, to, subject, text: `${text}\n\nAbre este enlace para continuar: ${publicUrl}/#/recuperar?token=${encodeURIComponent(text.split(': ').pop() ?? '')}` });
      return true;
    } catch (error) {
      console.error('No se pudo enviar el correo de identidad', error);
      return false;
    }
  }
}

type RequestMeta = { deviceName?: string; userAgent?: string; ipAddress?: string };
const randomToken = () => randomBytes(48).toString('base64url');
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
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
