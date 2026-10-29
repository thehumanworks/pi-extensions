import type { NextConfig } from "next";

const staticExport = process.env.BOT_WEB_STATIC_EXPORT === "1";
const config: NextConfig = {
  ...(staticExport ? { output: "export" as const, images: { unoptimized: true } } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  // The native host sends the same headers. Next export cannot emit headers.
  headers: staticExport ? undefined : async () => {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
      ]
    }];
  },
};
export default config;
