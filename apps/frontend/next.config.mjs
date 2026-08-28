/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Allow CI/local verification to build beside a running dev server without
  // both processes racing on the same .next cache directory.
  distDir: process.env.NEXT_DIST_DIR?.trim() || '.next',
};

export default nextConfig;
