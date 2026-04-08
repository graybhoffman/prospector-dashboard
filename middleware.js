import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const token = req.nextauth?.token;

    // API routes (excluding auth): return 401 JSON if no token
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth')) {
      if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl;
        // API routes and auth routes don't use the redirect-based authorized check
        if (pathname.startsWith('/api/')) return true;
        // All other routes require a token (NextAuth handles the redirect)
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: [
    '/((?!auth/signin|auth/error|_next/static|_next/image|favicon.ico).*)',
  ],
};
