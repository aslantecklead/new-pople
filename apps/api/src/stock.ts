import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';

type StockAsset = {
  downloadUrl: string;
  extension: string;
  mimeType: string;
  originalName: string;
  sourceProvider: 'pexels' | 'wikimedia-commons' | 'nasa';
  sourceUrl: string;
  sourceAuthor?: string;
  sourceLicense?: string;
  tags: string[];
};

type Scene = { query: string; kind: 'video' | 'photo' };
export type RemoteMedia = { id: string; kind: 'video' | 'photo'; title: string; previewUrl: string; provider: string; sourceUrl: string; author?: string; license?: string; query: string };
type CommonsImageInfo = {
  url?: string;
  thumburl?: string;
  mime?: string;
  descriptionurl?: string;
  extmetadata?: { LicenseShortName?: { value?: string }; Artist?: { value?: string } };
};
type CommonsPage = { title: string; imageinfo?: CommonsImageInfo[] };

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
    return photo && downloadUrl ? { downloadUrl, extension: '.jpg', mimeType: 'image/jpeg', originalName: `pexels-${photo.id}.jpg`, sourceProvider: 'pexels', sourceUrl: photo.url, sourceAuthor: photo.photographer, sourceLicense: 'Pexels License', tags: [scene.query] } : undefined;
  }
  const video = data.videos?.[0];
  const file = video?.video_files?.filter((item) => item.file_type === 'video/mp4' && item.link).sort((a, b) => Math.abs((a.height ?? 0) - 1080) - Math.abs((b.height ?? 0) - 1080))[0];
  return video && file?.link ? { downloadUrl: file.link, extension: '.mp4', mimeType: 'video/mp4', originalName: `pexels-${video.id}.mp4`, sourceProvider: 'pexels', sourceUrl: video.url, sourceAuthor: video.user?.name, sourceLicense: 'Pexels License', tags: [scene.query] } : undefined;
}

function plainText(value?: string) {
  return value?.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

async function searchWikimediaCommons(scene: Scene): Promise<StockAsset[]> {
  if (process.env.WIKIMEDIA_COMMONS_ENABLED === 'false') return [];
  const filetype = scene.kind === 'photo' ? 'bitmap' : 'video';
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '8',
    gsrsearch: `${scene.query} filetype:${filetype}`, prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata', iiurlwidth: '1280', origin: '*',
  });
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': process.env.WIKIMEDIA_USER_AGENT ?? 'NewsVideoFactory/0.1 (self-hosted local test)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return [];
  const data = await response.json() as { query?: { pages?: Record<string, CommonsPage> } };
  const infos = Object.values(data.query?.pages ?? {}).map((page) => ({ title: page.title, info: page.imageinfo?.[0] })).filter((item): item is { title: string; info: CommonsImageInfo } => Boolean(item.info?.url && item.info.mime));
  const allowed = infos.filter(({ info }) => {
    const license = plainText(info.extmetadata?.LicenseShortName?.value)?.toUpperCase() ?? '';
    return license.includes('PDM') || license.includes('PUBLIC DOMAIN') || license.includes('CC0') || (license.includes('CC BY') && !license.includes('SA'));
  });
  return allowed.map(({ info, title }) => {
    const isImage = info.mime?.startsWith('image/');
    const extension = isImage ? '.jpg' : info.mime === 'video/webm' ? '.webm' : info.mime === 'video/ogg' ? '.ogv' : '.mp4';
    return { downloadUrl: isImage ? info.thumburl ?? info.url! : info.url!, extension, mimeType: info.mime!, originalName: title.replace(/^File:/, '').replace(/\s+/g, '-'), sourceProvider: 'wikimedia-commons' as const, sourceUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, sourceAuthor: plainText(info.extmetadata?.Artist?.value), sourceLicense: plainText(info.extmetadata?.LicenseShortName?.value), tags: [scene.query] };
  });
}

async function searchNasa(scene: Scene): Promise<StockAsset[]> {
  const response = await fetch(`https://images-api.nasa.gov/search?q=${encodeURIComponent(scene.query)}&media_type=image&page_size=2`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return [];
  const data = await response.json() as { collection?: { items?: Array<{ href?: string; data?: Array<{ title?: string; photographer?: string; nasa_id?: string }>; links?: Array<{ href?: string }> }> } };
  return (data.collection?.items ?? []).flatMap((item) => {
    const meta = item.data?.[0];
    const preview = item.links?.[0]?.href;
    return meta && preview ? [{ downloadUrl: preview, extension: '.jpg', mimeType: 'image/jpeg', originalName: `${meta.nasa_id ?? 'nasa'}.jpg`, sourceProvider: 'nasa' as const, sourceUrl: item.href ?? 'https://images.nasa.gov/', sourceAuthor: meta.photographer ?? 'NASA', sourceLicense: 'NASA media — review usage rights', tags: [scene.query] }] : [];
  });
}

export async function downloadSelectedStock(asset: StockAsset, projectId: string, mediaRoot: string, db: Pool) {
  const response = await fetch(asset.downloadUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`cannot download ${asset.sourceProvider} media`);
  const id = randomUUID();
  const objectKey = join('stock', projectId, `${id}${asset.extension}`);
  const fullPath = join(mediaRoot, objectKey);
  await mkdir(join(mediaRoot, 'stock', projectId), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(fullPath));
  await db.query(`INSERT INTO assets (id, project_id, object_key, original_name, mime_type, tags, source_provider, source_url, source_author, source_license)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`, [id, projectId, objectKey, asset.originalName, asset.mimeType, JSON.stringify(asset.tags), asset.sourceProvider, asset.sourceUrl, asset.sourceAuthor ?? null, asset.sourceLicense ?? null]);
  return { object_key: objectKey, mime_type: asset.mimeType };
}

export async function downloadAutomaticStock(text: string, projectId: string, mediaRoot: string, db: Pool) {
  if (process.env.WIKIMEDIA_COMMONS_ENABLED === 'false' && !process.env.PEXELS_API_KEY) return [];
  const scenes = await createStoryboard(text);
  const assets: Array<{ object_key: string; mime_type: string }> = [];
  for (const scene of scenes) {
    try {
      const candidate = (await searchWikimediaCommons(scene))[0] ?? await findOnPexels(scene);
      if (candidate) assets.push(await downloadSelectedStock(candidate, projectId, mediaRoot, db));
    } catch {
      // One unavailable source must not cancel the whole video; the next scene or local library can still render.
    }
  }
  return assets;
}

const selections = new Map<string, StockAsset>();
const searchCache = new Map<string, { expiresAt: number; items: RemoteMedia[] }>();
export async function searchRemoteMedia(text: string) {
  const cacheKey = text.trim().toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const scenes = await createStoryboard(text);
  const found = (await Promise.all(scenes.map(async (scene) => {
    const commons = (await searchWikimediaCommons(scene)).slice(0, 4);
    const nasa = (await searchNasa(scene)).slice(0, 1);
    return [...commons, ...nasa].map((asset) => ({ scene, asset }));
  })))
    .flat().slice(0, 20);
  const items = found.map(({ scene, asset }) => {
    const id = randomUUID();
    selections.set(id, asset);
    return { id, kind: asset.mimeType.startsWith('image/') ? 'photo' as const : 'video' as const, title: asset.originalName, previewUrl: asset.downloadUrl, provider: asset.sourceProvider, sourceUrl: asset.sourceUrl, author: asset.sourceAuthor, license: asset.sourceLicense, query: scene.query } satisfies RemoteMedia;
  });
  searchCache.set(cacheKey, { expiresAt: Date.now() + 86_400_000, items });
  return items;
}

export function selectedRemoteMedia(id: string) { return selections.get(id); }
