const ANONYMOUS_IDENTITY_POSTS = new Set([
  '/identity/auth/login',
  '/identity/auth/refresh',
  '/identity/auth/register',
  '/identity/auth/email/verify',
  '/identity/auth/email/otp/send',
  '/identity/auth/email/otp/verify',
  '/identity/auth/password/reset/request',
  '/identity/auth/password/reset/confirm',
]);

export function isAnonymousIdentityPost(method, path) {
  return method === 'POST' && ANONYMOUS_IDENTITY_POSTS.has(path);
}
