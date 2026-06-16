/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The backend is a separate service (Render/Fly). Vercel doesn't run the
  // FastAPI app — set NEXT_PUBLIC_API_URL in Vercel Project Settings → Env.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
  },
};

module.exports = nextConfig;
