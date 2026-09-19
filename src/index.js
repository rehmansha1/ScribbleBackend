import 'dotenv/config';
import express from 'express';
import 'express-async-errors';
import helmet from 'helmet';
import multer from 'multer';
import { ZodError } from 'zod';
import router from './routes.js';
import { supabase } from './supabase.js';

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);
});

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

// Healthcheck endpoint
app.get('/health', async (_req, res) => {
  let supabaseStatus = 'disconnected';
  try {
    const { error } = await supabase.from('users').select('count', { count: 'exact', head: true });
    supabaseStatus = error ? `error: ${error.message}` : 'connected';
  } catch (e) {
    supabaseStatus = `error: ${e.message}`;
  }

  res.json({
    ok: true,
    supabase: supabaseStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use(router);

// Error handling middleware
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation', details: err.issues });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code });
  }
  console.error('[ServerError]', err);
  res.status(500).json({ error: 'server_error', message: err?.message });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`[API] Scribble server listening on port ${port} (backed by Supabase)`);
});
