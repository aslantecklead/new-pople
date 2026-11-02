import { extractKeywords, type Keyword } from './keywords.js';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';

type StockAsset = {
  downloadUrl: string;
  previewUrl?: string;
  extension: string;
  mimeType: string;
  originalName: string;
  sourceProvider: 'pexels' | 'wikimedia-commons' | 'nasa' | 'coverr' | 'google-images' | 'yandex-images' | 'pinterest' | 'vecteezy';
  sourceUrl: string;
  sourceAuthor?: string;
  sourceLicense?: string;
  tags: string[];
};

type Scene = { query: string; kind: 'video' | 'photo' };
export type RemoteMedia = { id: string; kind: 'video' | 'photo'; title: string; previewUrl: string; provider: string; sourceUrl: string; author?: string; license?: string; query: string };
export async function createStoryboard(text: string): Promise<Scene[]> {
  return (await extractKeywords(text)).keywords.map(k => ({query: k.query, kind: 'video'}));
}

async function searchCoverr(scene: Scene, page = 1): Promise<StockAsset[]> {
  const key = process.env.COVERR_API_KEY;
  if (!key) return [];
  const search = async (query: string) => {
    // Some searches have no vertical result at Coverr. Crop happens in the renderer,
    // so returning a relevant landscape clip is preferable to returning no video.
    const params = new URLSearchParams({ query, page_size: '12', page: String(page - 1), urls: 'true', sort: 'trending' });
    const response = await fetch(`https://api.coverr.co/videos?${params}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { hits?: Array<{ id?: string; slug?: string; title?: string; description?: string; tags?: unknown; urls?: { mp4_download?: string; mp4_preview?: string; mp4?: string }; mp4_download?: string }> };
    return (data.hits ?? []).flatMap((item) => {
      const tokens: string[] = query.toLowerCase().match(/[a-z]{3,}/g)?.filter(t => !['the','and','with','for','from'].includes(t)) ?? [];
      const description = `${item.title ?? ''} ${item.description ?? ''} ${JSON.stringify(item.tags ?? [])}`.toLowerCase();
      const words: string[] = description.match(/[a-z]+/g) ?? [];
      const forbidden: string[] = ['pregnant', 'pregnancy', 'newborn', 'baby', 'nursery', 'maternity'];
      // A generic tag such as "toys" must not quietly turn into pregnancy or baby-room footage.
      if (forbidden.some(word => words.includes(word)) && !tokens.some(token => forbidden.includes(token))) return [];
      const matches = tokens.filter(token => words.some(word => word === token || word.replace(/s$/, '') === token.replace(/s$/, '') || (token.length > 5 && word.startsWith(token.replace(/ing$/, ''))))).length;
      if (!tokens.length || matches < (tokens.length > 2 ? 2 : 1)) return [];
      const url = item.urls?.mp4_download ?? item.urls?.mp4 ?? item.mp4_download;
      return url ? [{ downloadUrl: url, previewUrl: item.urls?.mp4_preview ?? url, extension: '.mp4', mimeType: 'video/mp4', originalName: item.title ? `${item.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.mp4` : `coverr-${item.id ?? randomUUID()}.mp4`, sourceProvider: 'coverr' as const, sourceUrl: `https://coverr.co/videos/${item.slug ?? item.id ?? ''}`, sourceLicense: 'Coverr License', tags: [scene.query] }] : [];
    });
  };
  return search(scene.query);
}

function decodeHtml(html: string) {
  return html.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\\u002F/gi, '/');
}

async function searchYandex(query: string, page: number, tag = query): Promise<StockAsset[]> {
  const url = `https://yandex.ru/images/search?text=${encodeURIComponent(query)}&p=${page - 1}`;
  const response = await fetch(url, {headers: {'user-agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(18000)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = decodeHtml(await response.text());
  const items: StockAsset[] = [];
  // Read actual result records rather than arbitrary image URLs in page CSS.
  for (const match of html.matchAll(/"origUrl":"([^"\n]+)"[\s\S]{0,300}?"snippet":(\{[^}]+\})/g)) {
    try {
      const downloadUrl = JSON.parse('"' + match[1] + '"');
      const snippet = JSON.parse(match[2]);
      if (!/^https?:\/\//.test(downloadUrl) || !snippet.url || !snippet.title) continue;
      items.push({downloadUrl, extension:'.jpg', mimeType:'image/jpeg', originalName:snippet.title,
        sourceProvider:'yandex-images', sourceUrl:snippet.url, tags:[tag], sourceLicense:'Источник: проверьте условия использования'});
    } catch { /* Ignore malformed result records. */ }
  }
  if (!items.length && /captcha|showcaptcha|SmartCaptcha/i.test(html)) throw new Error('Источник запросил проверку CAPTCHA');
  return items.slice(0,24);
}

export async function downloadSelectedStock(asset: StockAsset, projectId: string, mediaRoot: string, db: Pool) {
  const response = await fetch(asset.downloadUrl, { headers: {'user-agent':'NewsVideoFactory/0.1'}, signal: AbortSignal.timeout(120_000) });
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
  if (!process.env.COVERR_API_KEY) return [];
  const scenes = await createStoryboard(text);
  const assets: Array<{ object_key: string; mime_type: string }> = [];
  for (const scene of scenes) {
    try {
      const candidate = (await searchCoverr(scene))[0];
      if (candidate) assets.push(await downloadSelectedStock(candidate, projectId, mediaRoot, db));
    } catch {
      // One unavailable source must not cancel the whole video; the next scene or local library can still render.
    }
  }
  return assets;
}

const selections = new Map<string, StockAsset>();
const searchCache = new Map<string, {expiresAt:number; items: RemoteMedia[]; warnings:string[]; hasMore:boolean}>();
export async function searchRemoteMedia(text: string, keywords?: Keyword[], page = 1) {
  const queries = keywords ?? (await extractKeywords(text)).keywords;
  const cacheKey = JSON.stringify({queries, page});
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const warnings: string[] = [];
  const groups: StockAsset[][] = [];
  // Limit network fanout to two topics at a time.
  for (let i=0;i<queries.length;i+=2) {
    const batch = await Promise.all(queries.slice(i,i+2).map(async k => {
      // Russian label is sent to Russian image search; English translation is sent to Coverr.
      const results = await Promise.allSettled([
        searchCoverr({query:k.query,kind:'video'},page),
        // Search Yandex in Russian, but keep the English query as the stable UI tag.
        // The UI filters and paginates by that tag, so a result must not disappear
        // merely because its source uses a Russian phrase.
        searchYandex(k.label,page,k.query),
      ]);
      return results.flatMap((r,index) => {
        if (r.status === 'fulfilled') return r.value;
        warnings.push(`${index ? 'Яндекс' : 'Coverr'} · ${k.label}: ${r.reason instanceof Error ? r.reason.message : 'нет ответа'}`);
        return [];
      });
    }));
    groups.push(...batch);
  }
  const unique = new Map<string, StockAsset>();
  // Round-robin topics, preventing the first query from taking all result slots.
  for (let i=0;i<36;i++) for (const group of groups) {
    const asset = group[i]; if (!asset) continue;
    const canonical = new URL(asset.downloadUrl); canonical.search = '';
    const key = canonical.toString().replace(/\/small_2x\//, '/small/');
    if (!unique.has(key)) unique.set(key,asset);
  }
  const items = [...unique.values()].map(asset => {
    const id = randomUUID(); selections.set(id,asset);
    const previewUrl = asset.sourceProvider === 'coverr'
      ? `/api/media/preview?url=${encodeURIComponent(asset.previewUrl ?? asset.downloadUrl)}`
      : asset.previewUrl ?? asset.downloadUrl;
    return {id, kind:asset.mimeType.startsWith('image/')?'photo' as const:'video' as const,
      title:asset.originalName, previewUrl, provider:asset.sourceProvider, sourceUrl:asset.sourceUrl,
      author:asset.sourceAuthor, license:asset.sourceLicense, query:asset.tags[0]};
  });
  const result = {items, warnings, hasMore:groups.some(g=>g.length>=12), expiresAt:Date.now()+3600000};
  if (searchCache.size > 100) searchCache.clear();
  searchCache.set(cacheKey,result);
  return result;
}

export function selectedRemoteMedia(id: string) { return selections.get(id); }
