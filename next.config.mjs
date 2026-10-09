/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep ffmpeg-static as a real require() at runtime so __dirname resolves
  // to node_modules/ffmpeg-static/ instead of the Next.js bundle directory.
  serverExternalPackages: ["ffmpeg-static"],

  experimental: {
    // Explicitly include the ffmpeg binary in Vercel's output file tracing so
    // it ends up inside the Lambda deployment ZIP.
    // Without this, nft may skip the binary since it's not a JS module.
    outputFileTracingIncludes: {
      "/api/studio/exports/[id]/process": [
        "./node_modules/ffmpeg-static/ffmpeg",
      ],
    },
  },

  images: {
    remotePatterns: [
      // fal.ai CDN (generated images/videos)
      { protocol: "https", hostname: "**.fal.media" },
      { protocol: "https", hostname: "**.fal.run" },
      // Supabase Storage
      { protocol: "https", hostname: "**.supabase.co" },
      // Google OAuth avatars
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      // GitHub OAuth avatars
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  async redirects() {
    return [
      // Cinema Studio lives on /cinema-studio-new; the old URL keeps working.
      // permanent:false (307) pre-launch so browsers don't hard-cache it; flip to true at launch.
      { source: "/cinema-studio", destination: "/cinema-studio-new", permanent: false },
      // Former page slugs, renamed to English.
      { source: "/alati", destination: "/tools", permanent: true },
      { source: "/karijere", destination: "/careers", permanent: true },
      { source: "/kontakt", destination: "/contact", permanent: true },
      { source: "/modeli", destination: "/models", permanent: true },
      { source: "/o-nama", destination: "/about", permanent: true },
      // Legacy registration is retired: sign-up is wallet-only on /signup (the query string,
      // e.g. callbackUrl, is passed through).
      { source: "/register", destination: "/signup", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
      {
        source: "/api/(.*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
