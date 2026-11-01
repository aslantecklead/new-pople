import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';

type StockAsset = {
  downloadUrl: string;
  extension: '.mp4' | '.jpg';
  mimeType: 'video/mp4' | 'image/jpeg';
  originalName: string;
  sourceProvider: 'pexels' | 'pixabay';
  sourceUrl: string;
  sourceAuthor?: string;
  tags: string[];
};

type Scene = { query: string; kind: 'video' | 'photo' };

function fallbackScenes(text: string): Scene[] {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((value) => value.trim()).filter(Boolean);
  const visualHints: Array<[RegExp, string]> = [
    [/звон|телефон|созвон/i, 'telephone call close up'],
    [/встреч|переговор|саммит|участием/i, 'diplomatic meeting flags'],
    [/заявил|сказал|пресс/i, 'press conference microphones'],
    [/осло|норвег/i, 'Oslo Norway city'],
    [/финлянд|хельсинки/i, 'Helsinki Finland city'],
    [/санкц|закон|госдум|депутат/i, 'government documents parliament'],
    [/войн|военн|арм|фронт/i, 'world map news background'],
  ];
  const scenes = (sentences.length ? sentences : [text]).slice(0, 5).map((sentence, index) => {
    const withoutQuotes = sentence.replace(/[«»“”"']/g, '').replace(/https?:\/\/\S+/g, '');
    const words = withoutQuotes.match(/[А-Яа-яЁёA-Za-z]{4,}/g) ?? [];
    const hint = visualHints.find(([pattern]) => pattern.test(withoutQuotes))?.[1];
    return { query: hint ?? (words.slice(0, 7).join(' ') || 'news background'), kind: index % 3 === 2 ? 'photo' as const : 'video' as const };
  });
  return scenes;
}

export async function createStoryboard(text: string): Promise<Scene[]> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  const model = process.env.OLLAMA_MODEL;
  if (!baseUrl || !model) return fallbackScenes(text);
  try {
    const prompt = `Разбей новостной текст на 3–5 визуальных сцен для вертикального ролика. Для каждой дай короткий поисковый запрос для стоковых фото или видео. Запрос описывает общий визуальный план, а не утверждает, что на нём конкретный политик или реальное новостное событие. Верни только JSON: {"scenes":[{"query":"...","kind":"video"}]}. Текст: ${text}`;
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, format: 'json', stream: false, options: { temperature: 0.2 } }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json() as { response?: string };
    const parsed = JSON.parse(payload.response ?? '{}') as { scenes?: Array<{ query?: string; kind?: string }> };
    const scenes = parsed.scenes?.flatMap((scene) => scene.query?.trim() ? [{ query: scene.query.trim().slice(0, 100), kind: scene.kind === 'photo' ? 'photo' as const : 'video' as const }] : []) ?? [];
    return scenes.length ? scenes.slice(0, 5) : fallbackScenes(text);
  } catch {
    return fallbackScenes(text);
  }
}

async function findOnPexels(scene: Scene): Promise<StockAsset | undefined> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return undefined;
  const endpoint = scene.kind === 'photo' ? 'https://api.pexels.com/v1/search' : 'https://api.pexels.com/v1/videos/search';
  const response = await fetch(`${endpoint}?query=${encodeURIComponent(scene.query)}&per_page=8&orientation=portrait&locale=ru-RU`, {
    headers: { Authorization: key }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return undefined;
  const data = await response.json() as { photos?: Array<{ id: number; url: string; photographer?: string; src: { large2x?: string; large?: string } }>; videos?: Array<{ id: number; url: string; user?: { name?: string }; video_files?: Array<{ link?: string; file_type?: string; width?: number; height?: number }> }> };
  if (scene.kind === 'photo') {
    const photo = data.photos?.[0];
    const downloadUrl = photo?.src.large2x ?? photo?.src.large;
    return photo && downloadUrl ? { downloadUrl, extension: '.jpg', mimeType: 'image/jpeg', originalName: `pexels-${photo.id}.jpg`, sourceProvider: 'pexels', sourceUrl: photo.url, sourceAuthor: photo.photographer, tags: [scene.query] } : undefined;
  }
  const video = data.videos?.[0];
  const file = video?.video_files?.filter((item) => item.file_type === 'video/mp4' && item.link).sort((a, b) => Math.abs((a.height ?? 0) - 1080) - Math.abs((b.height ?? 0) - 1080))[0];
  return video && file?.link ? { downloadUrl: file.link, extension: '.mp4', mimeType: 'video/mp4', originalName: `pexels-${video.id}.mp4`, sourceProvider: 'pexels', sourceUrl: video.url, sourceAuthor: video.user?.name, tags: [scene.query] } : undefined;
}

async function findOnPixabay(scene: Scene): Promise<StockAsset | undefined> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return undefined;
  const endpoint = scene.kind === 'photo' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/';
  const response = await fetch(`${endpoint}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(scene.query)}&lang=ru&per_page=8&orientation=vertical&safesearch=true`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return undefined;
  const data = await response.json() as { hits?: Array<{ id: number; pageURL: string; user?: string; largeImageURL?: string; videos?: { medium?: { url?: string } } }> };
  const item = data.hits?.[0];
  const downloadUrl = scene.kind === 'photo' ? item?.largeImageURL : item?.videos?.medium?.url;
  return item && downloadUrl ? { downloadUrl, extension: scene.kind === 'photo' ? '.jpg' : '.mp4', mimeType: scene.kind === 'photo' ? 'image/jpeg' : 'video/mp4', originalName: `pixabay-${item.id}${scene.kind === 'photo' ? '.jpg' : '.mp4'}`, sourceProvider: 'pixabay', sourceUrl: item.pageURL, sourceAuthor: item.user, tags: [scene.query] } : undefined;
}

async function download(asset: StockAsset, projectId: string, mediaRoot: string, db: Pool) {
  const response = await fetch(asset.downloadUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`cannot download ${asset.sourceProvider} media`);
  const id = randomUUID();
  const objectKey = join('stock', projectId, `${id}${asset.extension}`);
  const fullPath = join(mediaRoot, objectKey);
  await mkdir(join(mediaRoot, 'stock', projectId), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(fullPath));
  await db.query(`INSERT INTO assets (id, project_id, object_key, original_name, mime_type, tags, source_provider, source_url, source_author)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`, [id, projectId, objectKey, asset.originalName, asset.mimeType, JSON.stringify(asset.tags), asset.sourceProvider, asset.sourceUrl, asset.sourceAuthor ?? null]);
  return { object_key: objectKey, mime_type: asset.mimeType };
}

export async function downloadAutomaticStock(text: string, projectId: string, mediaRoot: string, db: Pool) {
  if (!process.env.PEXELS_API_KEY && !process.env.PIXABAY_API_KEY) return [];
  const scenes = await createStoryboard(text);
  const assets: Array<{ object_key: string; mime_type: string }> = [];
  for (const scene of scenes) {
    try {
      const candidate = await findOnPexels(scene) ?? await findOnPixabay(scene);
      if (candidate) assets.push(await download(candidate, projectId, mediaRoot, db));
    } catch {
      // One unavailable source must not cancel the whole video; the next scene or local library can still render.
    }
  }
  return assets;
}
