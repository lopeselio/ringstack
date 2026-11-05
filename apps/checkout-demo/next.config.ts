import type { NextConfig } from "next";

const apiUrl = process.env.CHECKOUT_API_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  // The browser only talks to this origin; /api/* is proxied to the Fastify API.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
  poweredByHeader: false,
};

export default config;
