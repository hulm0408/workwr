// GET /api/status — saare bots ka health JSON (read-only, koi secret nahi)
import { fetchAllTargets } from '../lib/health.js';

export default async function handler(req, res) {
  const summary = await fetchAllTargets(process.env);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(JSON.stringify(summary, null, 2));
}
