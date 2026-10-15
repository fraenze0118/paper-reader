// Vite 插件：把 API 挂到同一个 dev server 上，`npm run dev` 一条命令跑通前后端
import { handleApi } from './api.js';

export function apiPlugin() {
  return {
    name: 'paper-reader-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api')) return next();
        try {
          await handleApi(req, res);
        } catch (e) {
          console.error('[api-plugin]', e);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e?.message ?? e) }));
          }
        }
      });
    },
  };
}
