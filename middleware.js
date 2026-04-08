export { default } from 'next-auth/middleware';

export const config = {
  matcher: [
    '/((?!api/auth|auth/signin|auth/error|_next/static|_next/image|favicon.ico).*)',
  ],
};
