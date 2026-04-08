import NextAuth from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';

const ALLOWED_DOMAINS = ['commure.com', 'getathelas.com'];

// Role assignments — extend this list as needed
const ROLE_MAP = {
  'gray.hoffman@commure.com': 'admin',
  'gray.hoffman@getathelas.com': 'admin',
  'neha.bhongir@commure.com': 'contributor',
  'andrew.sapien@commure.com': 'contributor',
};

function getRole(email) {
  if (ROLE_MAP[email]) return ROLE_MAP[email];
  // Default: contributor for allowed domains, null for others
  const domain = email.split('@')[1];
  if (ALLOWED_DOMAINS.includes(domain)) return 'contributor';
  return null;
}

export default NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email || '';
      const domain = email.split('@')[1];
      if (!ALLOWED_DOMAINS.includes(domain)) {
        return false; // Block non-commure/athelas emails
      }
      return true;
    },
    async session({ session, token }) {
      if (session?.user?.email) {
        session.user.role = getRole(session.user.email);
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = getRole(user.email);
      }
      return token;
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  secret: process.env.NEXTAUTH_SECRET,
});
