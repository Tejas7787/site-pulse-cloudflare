import { vlyPlugin } from "@vly-ai/integrations";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig(() => {
  // Security headers sent as real HTTP response headers on every response.
  // Note: connect-src must allow *.convex.cloud (http+ws) or the app cannot reach its database.
  const securityHeaders = {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.convex.cloud; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://*.convex.cloud wss://*.convex.cloud; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };

  return {
    plugins: [react(), vlyPlugin(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      // Force a single copy of React across all packages (including vlyPlugin).
      dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router'],
            'convex-vendor': ['convex'],
            'radix-ui': [
              '@radix-ui/react-accordion',
              '@radix-ui/react-alert-dialog',
              '@radix-ui/react-avatar',
              '@radix-ui/react-checkbox',
              '@radix-ui/react-collapsible',
              '@radix-ui/react-context-menu',
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-hover-card',
              '@radix-ui/react-label',
              '@radix-ui/react-menubar',
              '@radix-ui/react-navigation-menu',
              '@radix-ui/react-popover',
              '@radix-ui/react-progress',
              '@radix-ui/react-radio-group',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slider',
              '@radix-ui/react-switch',
              '@radix-ui/react-tabs',
              '@radix-ui/react-toggle',
              '@radix-ui/react-toggle-group',
              '@radix-ui/react-tooltip',
            ],
            'framer-motion': ['framer-motion'],
            'charts': ['recharts'],
            'forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
      chunkSizeWarningLimit: 1000,
      target: 'esnext',
      minify: 'esbuild' as const,
    },
    optimizeDeps: {
      entries: ['index.html'],
      include: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        'react-router',
        '@convex-dev/auth/react',
        'framer-motion',
      ],
    },
    server: {
      // Bind to all interfaces so WebContainer's server-ready event fires.
      host: true,
      port: 5173,
      // Keep HMR on, but disable full-screen error overlay
      hmr: {
        overlay: false,
      },
      // Real HTTP security headers on every response
      headers: securityHeaders,
    },
    // Same security headers when serving a production build via `vite preview`
    preview: {
      headers: securityHeaders,
    },
  };
});
