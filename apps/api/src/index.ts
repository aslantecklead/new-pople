import 'dotenv/config';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';
import { renderQueue } from './queue.js';
import { downloadSelectedStock, searchRemoteMedia, selectedRemoteMedia } from './stock.js';

const app = Fastify({ logger: true });
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const mediaRoot = process.env.MEDIA_ROOT ?? join(process.cwd(), 'media');
mkdirSync(join(mediaRoot, 'uploads'), { recursive: true });
mkdirSync(join(mediaRoot, 'outputs'), { recursive: true });

const configuredOrigins = new Set((process.env.WEB_ORIGIN ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || configuredOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
});
await app.register(multipart, { limits: { fileSize: 1_500_000_000, files: 20 } });
await app.register(fastifyStatic, { root: mediaRoot, prefix: '/media/' });
await db.query('ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS output_path TEXT');
await db.query('ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_provider TEXT');
await db.query('ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_url TEXT');
await db.query('ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_author TEXT');
await db.query('ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_license TEXT');
await db.query(`CREATE TABLE IF NOT EXISTS project_assets (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, asset_id)
)`);

app.get('/health', async () => ({
  ok: true,
  service: 'news-video-factory',
  stockSearch: {
    wikimediaCommons: process.env.WIKIMEDIA_COMMONS_ENABLED !== 'false',
    pexels: Boolean(process.env.PEXELS_API_KEY),
    localStoryboardModel: Boolean(process.env.OLLAMA_BASE_URL && process.env.OLLAMA_MODEL),
  },
}));

app.get('/api/projects', async () => {
  const { rows } = await db.query('SELECT * FROM projects ORDER BY created_at DESC LIMIT 30');
  return rows;
});

app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
  const project = await db.query('SELECT * FROM projects WHERE id = $1', [request.params.id]);
  if (!project.rowCount) return reply.code(404).send({ error: 'project not found' });
  const [assets, jobs] = await Promise.all([
    db.query(`SELECT DISTINCT a.* FROM assets a
      LEFT JOIN project_assets pa ON pa.asset_id = a.id
      WHERE a.project_id = $1 OR pa.project_id = $1 ORDER BY a.created_at DESC`, [request.params.id]),
    db.query('SELECT * FROM render_jobs WHERE project_id = $1 ORDER BY created_at DESC', [request.params.id]),
  ]);
  return { ...project.rows[0], assets: assets.rows, jobs: jobs.rows };
});

app.post<{ Body: { newsText: string } }>('/api/projects', async (request, reply) => {
  const newsText = request.body?.newsText?.trim();
  if (!newsText) return reply.code(400).send({ error: 'newsText is required' });
  const id = randomUUID();
  const { rows } = await db.query(
    'INSERT INTO projects (id, news_text) VALUES ($1, $2) RETURNING *',
    [id, newsText],
  );
  return reply.code(201).send(rows[0]);
});

app.patch<{ Params: { id: string }; Body: { newsText: string } }>('/api/projects/:id', async (request, reply) => {
  const newsText = request.body?.newsText?.trim();
  if (!newsText) return reply.code(400).send({ error: 'newsText is required' });
  const { rows } = await db.query('UPDATE projects SET news_text = $1 WHERE id = $2 RETURNING *', [newsText, request.params.id]);
  return rows[0] ?? reply.code(404).send({ error: 'project not found' });
});

app.post<{ Params: { id: string } }>('/api/projects/:id/assets', async (request, reply) => {
  const exists = await db.query('SELECT 1 FROM projects WHERE id = $1', [request.params.id]);
  if (!exists.rowCount) return reply.code(404).send({ error: 'project not found' });
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: 'file is required' });
  if (!file.mimetype.startsWith('video/') && !file.mimetype.startsWith('image/')) {
    file.file.resume();
    return reply.code(400).send({ error: 'only video and image files are supported' });
  }
  const id = randomUUID();
  const originalName = basename(file.filename || 'asset');
  const extension = extname(originalName).toLowerCase() || (file.mimetype.startsWith('image/') ? '.jpg' : '.mp4');
  const objectKey = join('uploads', `${id}${extension}`);
  await pipeline(file.file, createWriteStream(join(mediaRoot, objectKey)));
  await db.query(
    'INSERT INTO assets (id, project_id, object_key, original_name, mime_type) VALUES ($1, $2, $3, $4, $5)',
    [id, request.params.id, objectKey, originalName, file.mimetype],
  );
  return reply.code(201).send({ id, originalName, url: `/media/${objectKey.replaceAll('\\', '/')}` });
});

app.post<{ Params: { id: string }; Body: { assetId: string } }>('/api/projects/:id/assets/from-library', async (request, reply) => {
  const assetId = request.body?.assetId;
  const [project, asset] = await Promise.all([
    db.query('SELECT 1 FROM projects WHERE id = $1', [request.params.id]),
    db.query('SELECT 1 FROM assets WHERE id = $1 AND project_id IS NULL', [assetId]),
  ]);
  if (!project.rowCount || !asset.rowCount) return reply.code(404).send({ error: 'project or library asset not found' });
  await db.query('INSERT INTO project_assets (project_id, asset_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.params.id, assetId]);
  return reply.code(204).send();
});

app.post('/api/library/assets', async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: 'file is required' });
  if (!file.mimetype.startsWith('video/') && !file.mimetype.startsWith('image/')) {
    file.file.resume();
    return reply.code(400).send({ error: 'only video and image files are supported' });
  }
  const tagsField = file.fields.tags as { value?: string } | undefined;
  const tags = (tagsField?.value ?? '').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const id = randomUUID();
  const originalName = basename(file.filename || 'asset');
  const extension = extname(originalName).toLowerCase() || (file.mimetype.startsWith('image/') ? '.jpg' : '.mp4');
  const objectKey = join('uploads', `${id}${extension}`);
  await pipeline(file.file, createWriteStream(join(mediaRoot, objectKey)));
  await db.query('INSERT INTO assets (id, object_key, original_name, mime_type, tags) VALUES ($1, $2, $3, $4, $5::jsonb)', [id, objectKey, originalName, file.mimetype, JSON.stringify(tags)]);
  return reply.code(201).send({ id, originalName, tags, url: `/media/${objectKey.replaceAll('\\', '/')}` });
});

app.get<{ Querystring: { q?: string } }>('/api/library/search', async (request) => {
  const query = request.query.q?.trim().toLowerCase() ?? '';
  const { rows } = await db.query(
    `SELECT id, original_name, mime_type, tags, object_key FROM assets
      WHERE project_id IS NULL AND ($1 = '' OR original_name ILIKE '%' || $1 || '%' OR tags::text ILIKE '%' || $1 || '%')
      ORDER BY created_at DESC LIMIT 60`,
    [query],
  );
  return rows.map((asset) => ({ ...asset, url: `/media/${String(asset.object_key).replaceAll('\\', '/')}` }));
});

app.post<{ Body: { newsText: string } }>('/api/media/search', async (request, reply) => {
  const text = request.body?.newsText?.trim();
  if (!text) return reply.code(400).send({ error: 'newsText is required' });
  const items = await searchRemoteMedia(text);
  return { items };
});

app.post<{ Params: { id: string }; Body: { mediaIds: string[] } }>('/api/projects/:id/assets/import', async (request, reply) => {
  const ids = request.body?.mediaIds ?? [];
  const exists = await db.query('SELECT 1 FROM projects WHERE id = $1', [request.params.id]);
  if (!exists.rowCount) return reply.code(404).send({ error: 'project not found' });
  const imported = [];
  for (const id of ids.slice(0, 8)) {
    const media = selectedRemoteMedia(id);
    if (media) imported.push(await downloadSelectedStock(media, request.params.id, mediaRoot, db));
  }
  return reply.code(201).send({ imported: imported.length });
});

app.get<{ Querystring: { q?: string; type?: 'photo' | 'video' } }>('/api/stock/search', async (request, reply) => {
  const key = process.env.PEXELS_API_KEY;
  const query = request.query.q?.trim();
  if (!key) return reply.code(503).send({ error: 'PEXELS_API_KEY is not configured' });
  if (!query) return reply.code(400).send({ error: 'q is required' });
  const baseUrl = request.query.type === 'photo' ? 'https://api.pexels.com/v1/search' : 'https://api.pexels.com/v1/videos/search';
  const response = await fetch(`${baseUrl}?query=${encodeURIComponent(query)}&per_page=12&orientation=portrait&locale=ru-RU`, { headers: { Authorization: key } });
  if (!response.ok) return reply.code(response.status).send({ error: 'stock provider request failed' });
  return response.json();
});

app.post<{ Params: { id: string } }>('/api/projects/:id/render', async (request, reply) => {
  const jobId = randomUUID();
  const exists = await db.query('SELECT 1 FROM projects WHERE id = $1', [request.params.id]);
  if (!exists.rowCount) return reply.code(404).send({ error: 'project not found' });
  await db.query('INSERT INTO render_jobs (id, project_id) VALUES ($1, $2)', [jobId, request.params.id]);
  await renderQueue.add('assemble-video', { jobId, projectId: request.params.id }, { jobId, attempts: 2 });
  return reply.code(202).send({ id: jobId, stage: 'queued' });
});

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
  const { rows } = await db.query('SELECT * FROM render_jobs WHERE id = $1', [request.params.id]);
  return rows[0] ?? reply.code(404).send({ error: 'job not found' });
});

const port = Number(process.env.API_PORT ?? 8080);
await app.listen({ host: '0.0.0.0', port });
