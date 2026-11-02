import 'dotenv/config';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Bot, Context, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { Pool, type PoolClient } from 'pg';
import { renderQueue } from './queue.js';
import { countWords, estimateDuration, rewriteForVideo, targetWordRange, type DeliveryStyle, type RewriteMode } from './scripts.js';
import { ensureSchema } from './schema.js';
import { sceneCaptions } from './timeline.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

const apiRoot = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/$/, '');
const bot = new Bot(token, { client: { apiRoot } });
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const mediaRoot = process.env.MEDIA_ROOT ?? join(process.cwd(), 'media');
const run = promisify(execFile);
await mkdir(join(mediaRoot, 'uploads'), { recursive: true });
await mkdir(join(mediaRoot, 'outputs'), { recursive: true });
await ensureSchema(db);

const allowedIds = new Set(
  (process.env.ALLOWED_TELEGRAM_IDS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);
const allowedUsernames=new Set((process.env.ALLOWED_TELEGRAM_USERNAMES??'')
  .split(',').map(value=>value.trim().replace(/^@/,'').toLowerCase()).filter(Boolean));

const mainKeyboard = new Keyboard()
  .text('🎞 Материалы').text('📝 Текст').row()
  .text('⚙️ Настройки').text('📁 Проекты').row()
  .text('🚀 Собрать видео')
  .resized()
  .persistent();

type Session = {
  telegram_user_id: string;
  telegram_chat_id: string;
  current_project_id: string | null;
  state: string;
  state_data: Record<string, unknown>;
};

type Project = {
  id: string;
  title: string;
  status: string;
  source_text: string;
  news_text: string;
  target_duration_sec: 30 | 60;
  delivery_style: DeliveryStyle;
  voice_id: string;
  caption_font: string;
  caption_color: string;
  caption_size: number;
};

type Asset = {
  id: string;
  position: number;
  object_key: string;
  original_name: string;
  mime_type: string;
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  telegram_file_id: string | null;
  trim_start_sec: string;
  trim_end_sec: string | null;
  crop_mode: 'left'|'center'|'right';
  description: string;
};

const voices: Record<string, { label: string; piper: string }> = {
  irina: { label: 'Ирина — женский, спокойный', piper: 'irina' },
  dmitri: { label: 'Дмитрий — мужской, нейтральный', piper: 'dmitri' },
  denis: { label: 'Денис — мужской, спокойный', piper: 'denis' },
};

const fonts: Record<string, string> = {
  sans: 'DejaVu Sans',
  serif: 'DejaVu Serif',
  mono: 'DejaVu Sans Mono',
};

const colors: Record<string, { label: string; ass: string }> = {
  white: { label: 'Белый', ass: '&H00FFFFFF' },
  yellow: { label: 'Жёлтый', ass: '&H0000D7FF' },
  cyan: { label: 'Голубой', ass: '&H00FFD68A' },
};

function userId(ctx: Context) {
  if (!ctx.from) throw new Error('Telegram user is missing');
  return String(ctx.from.id);
}

function chatId(ctx: Context) {
  if (!ctx.chat) throw new Error('Telegram chat is missing');
  return String(ctx.chat.id);
}

async function ensureSession(ctx: Context) {
  await db.query(
    `INSERT INTO bot_sessions (telegram_user_id, telegram_chat_id)
     VALUES ($1, $2)
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET telegram_chat_id = EXCLUDED.telegram_chat_id, updated_at = now()`,
    [userId(ctx), chatId(ctx)],
  );
}

async function session(ctx: Context) {
  const { rows } = await db.query<Session>('SELECT * FROM bot_sessions WHERE telegram_user_id=$1', [userId(ctx)]);
  if (!rows[0]) {
    await ensureSession(ctx);
    return session(ctx);
  }
  return rows[0];
}

async function setState(ctx: Context, state: string, data: Record<string, unknown> = {}) {
  await db.query(
    'UPDATE bot_sessions SET state=$1,state_data=$2::jsonb,updated_at=now() WHERE telegram_user_id=$3',
    [state, JSON.stringify(data), userId(ctx)],
  );
}

async function currentProject(ctx: Context) {
  const { rows } = await db.query<Project>(
    `SELECT p.* FROM projects p
     JOIN bot_sessions s ON s.current_project_id=p.id
     WHERE s.telegram_user_id=$1 AND p.owner_telegram_id=$1 AND p.archived_at IS NULL`,
    [userId(ctx)],
  );
  return rows[0] ?? null;
}

async function useProject(ctx: Context, projectId: string) {
  const result = await db.query(
    `UPDATE bot_sessions SET current_project_id=$1,state='idle',state_data='{}',updated_at=now()
     WHERE telegram_user_id=$2
       AND EXISTS(SELECT 1 FROM projects WHERE id=$1 AND owner_telegram_id=$2 AND archived_at IS NULL)`,
    [projectId, userId(ctx)],
  );
  return Boolean(result.rowCount);
}

function shortText(text: string, max = 3000) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function statusName(status: string) {
  return ({
    draft: 'черновик',
    collecting_assets: 'добавляются материалы',
    ready: 'готов к сборке',
    rendering: 'собирается',
    completed: 'готов',
    failed: 'ошибка сборки',
  } as Record<string, string>)[status] ?? status;
}

async function replyHome(ctx: Context, text: string) {
  return ctx.reply(text, { reply_markup: mainKeyboard });
}

async function showProjectHome(ctx: Context) {
  const project = await currentProject(ctx);
  if (!project) {
    return ctx.reply('Активного проекта нет. Создадим первый?', {
      reply_markup: new InlineKeyboard().text('➕ Новый проект', 'project:new'),
    });
  }
  const assets = await db.query<{ count: string }>(
    'SELECT count(*) FROM assets WHERE project_id=$1 AND deleted_at IS NULL',
    [project.id],
  );
  return replyHome(ctx,
    `${project.title}\nСтатус: ${statusName(project.status)}\n` +
    `Длительность: ${project.target_duration_sec} сек · Материалы: ${assets.rows[0].count}\n` +
    `Текст: ${project.news_text ? `${countWords(project.news_text)} слов` : 'не готов'}`,
  );
}

async function showScript(ctx: Context, selectedProject?: Project | null) {
  const project = selectedProject ?? await currentProject(ctx);
  if (!project) return showProjectHome(ctx);
  if (!project.source_text) {
    await setState(ctx, 'awaiting_source_text');
    return ctx.reply('Пришли исходный текст новости одним сообщением.', { reply_markup: mainKeyboard });
  }
  const script = project.news_text || 'Сценарий ещё не создан.';
  const range = targetWordRange(project.target_duration_sec);
  const keyboard = new InlineKeyboard()
    .text('✏️ Исправить сценарий', 'script:edit').row()
    .text('🔁 Новый вариант', 'script:regen')
    .text('📄 Заменить исходник', 'script:source').row()
    .text('✅ Подтвердить текст', 'script:confirm');
  return ctx.reply(
    `Сценарий: ${countWords(script)} слов · около ${estimateDuration(script)} сек\n` +
    `Цель: ${range.min}–${range.max} слов · ${project.delivery_style === 'news' ? 'Новостная сводка' : 'Популярная подача'}\n\n` +
    shortText(script),
    { reply_markup: keyboard },
  );
}

async function saveScript(project: Project, text: string, origin: 'llm' | 'manual') {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const version = await client.query<{ next: number }>(
      'SELECT COALESCE(MAX(version_no),0)+1 AS next FROM script_versions WHERE project_id=$1',
      [project.id],
    );
    await client.query(
      `INSERT INTO script_versions
       (id,project_id,version_no,text,word_count,estimated_duration_sec,origin,model,prompt_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'v1')`,
      [randomUUID(), project.id, version.rows[0].next, text, countWords(text), estimateDuration(text), origin,
        origin === 'llm' ? process.env.OLLAMA_MODEL ?? null : null],
    );
    await client.query(
      "UPDATE projects SET news_text=$1,status='draft',updated_at=now() WHERE id=$2",
      [text, project.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function generateScript(ctx: Context, project: Project, mode:RewriteMode='balanced') {
  const progress = await ctx.reply('Ужимаю текст и проверяю длину…');
  try {
    const script = await rewriteForVideo(project.source_text, project.target_duration_sec, project.delivery_style,mode);
    await saveScript(project, script, 'llm');
    await ctx.api.deleteMessage(chatId(ctx), progress.message_id).catch(() => undefined);
    const refreshed = await currentProject(ctx);
    return showScript(ctx, refreshed);
  } catch (error) {
    await ctx.api.editMessageText(
      chatId(ctx),
      progress.message_id,
      `Не удалось подготовить сценарий: ${error instanceof Error ? error.message : 'неизвестная ошибка'}\n` +
      'Можно повторить позже или прислать готовый короткий текст вручную.',
      { reply_markup: new InlineKeyboard().text('✏️ Ввести сценарий вручную', 'script:edit') },
    );
  }
}

async function listAssets(projectId: string) {
  const { rows } = await db.query<Asset>(
    `SELECT id,position,object_key,original_name,mime_type,duration_seconds,width,height,telegram_file_id,
            trim_start_sec,trim_end_sec,crop_mode,description
     FROM assets WHERE project_id=$1 AND deleted_at IS NULL ORDER BY position,id`,
    [projectId],
  );
  return rows;
}

async function showAsset(ctx: Context, requestedId?: string) {
  const project = await currentProject(ctx);
  if (!project) return showProjectHome(ctx);
  const assets = await listAssets(project.id);
  if (!assets.length) {
    await setState(ctx, 'awaiting_assets');
    return ctx.reply('Материалов пока нет. Пришли видео или изображение.', { reply_markup: mainKeyboard });
  }
  let index = requestedId ? assets.findIndex(asset => asset.id === requestedId) : 0;
  if (index < 0) index = 0;
  const asset = assets[index];
  const previous = assets[(index - 1 + assets.length) % assets.length];
  const next = assets[(index + 1) % assets.length];
  const duration = asset.duration_seconds ? ` · ${Number(asset.duration_seconds).toFixed(1)} сек` : '';
  const dimensions = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : '';
  const trimEnd=asset.trim_end_sec?Number(asset.trim_end_sec):Number(asset.duration_seconds??0);
  const trim=asset.mime_type.startsWith('video/')?`\nОтрезок: ${Number(asset.trim_start_sec).toFixed(1)}–${trimEnd.toFixed(1)} сек · кадр ${asset.crop_mode}`:'';
  const description=asset.description?`\nСодержание: ${asset.description}`:'';
  const caption = `Материал ${index + 1} из ${assets.length}\n${asset.original_name}${duration}${dimensions}${trim}${description}`;
  const keyboard = new InlineKeyboard();
  if (assets.length > 1) keyboard.text('◀️', `asset:view:${previous.id}`).text('▶️', `asset:view:${next.id}`).row();
  keyboard.text('⬆️ Раньше', `asset:move:${asset.id}:-1`).text('Позже ⬇️', `asset:move:${asset.id}:1`).row()
    .text('✂️ Обрезать/кадр',`asset:params:${asset.id}`).text('✏️ Описание',`asset:describe:${asset.id}`).row()
    .text('🔄 Заменить', `asset:replace:${asset.id}`).text('🗑 Удалить', `asset:delete:${asset.id}`).row()
    .text('✨ Автопорядок по тексту','assets:autoorder').row()
    .text('✅ Материалы готовы', 'assets:done');
  const path = join(mediaRoot, asset.object_key);
  try {
    if (asset.mime_type.startsWith('image/')) {
      await ctx.replyWithPhoto(new InputFile(path), { caption, reply_markup: keyboard });
    } else {
      await ctx.replyWithVideo(new InputFile(path), { caption, reply_markup: keyboard, supports_streaming: true });
    }
  } catch {
    await ctx.reply(`${caption}\nПредпросмотр не отправился, но файл сохранён на сервере.`, { reply_markup: keyboard });
  }
}

async function renumberAssets(client: PoolClient, projectId: string, orderedIds: string[]) {
  await client.query('UPDATE assets SET position=position+10000 WHERE project_id=$1 AND deleted_at IS NULL', [projectId]);
  for (let index = 0; index < orderedIds.length; index++) {
    await client.query('UPDATE assets SET position=$1 WHERE id=$2 AND project_id=$3', [index + 1, orderedIds[index], projectId]);
  }
}

async function moveAsset(projectId: string, assetId: string, direction: number) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM assets WHERE project_id=$1 AND deleted_at IS NULL ORDER BY position,id FOR UPDATE',
      [projectId],
    );
    const ids = rows.map(row => row.id);
    const from = ids.indexOf(assetId);
    const to = Math.max(0, Math.min(ids.length - 1, from + direction));
    if (from >= 0 && from !== to) [ids[from], ids[to]] = [ids[to], ids[from]];
    await renumberAssets(client, projectId, ids);
    await client.query('UPDATE projects SET updated_at=now() WHERE id=$1', [projectId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function showAssetParams(ctx:Context,assetId:string) {
  const project=await currentProject(ctx);
  if(!project)return;
  const assets=await listAssets(project.id);
  const asset=assets.find(item=>item.id===assetId);
  if(!asset)return ctx.reply('Материал не найден.');
  if(asset.mime_type.startsWith('image/')) {
    return ctx.reply('Для изображения доступно только кадрирование 9:16.',{reply_markup:new InlineKeyboard()
      .text(`Кадр: ${asset.crop_mode}`,`asset:crop:${asset.id}`).row().text('← Назад',`asset:view:${asset.id}`)});
  }
  const end=Number(asset.trim_end_sec??asset.duration_seconds??0);
  return ctx.reply(`Обрезка материала\nНачало: ${Number(asset.trim_start_sec).toFixed(1)} сек\nКонец: ${end.toFixed(1)} сек\nКадрирование: ${asset.crop_mode}`,{
    reply_markup:new InlineKeyboard()
      .text('Начало −1с',`asset:trim:${asset.id}:start:-1`).text('Начало +1с',`asset:trim:${asset.id}:start:1`).row()
      .text('Конец −1с',`asset:trim:${asset.id}:end:-1`).text('Конец +1с',`asset:trim:${asset.id}:end:1`).row()
      .text(`Кадр: ${asset.crop_mode}`,`asset:crop:${asset.id}`).row()
      .text('← К материалу',`asset:view:${asset.id}`),
  });
}

async function suggestAssetOrder(text:string,assets:Asset[]) {
  const base=process.env.OLLAMA_BASE_URL;
  const model=process.env.OLLAMA_MODEL;
  if(!base||!model)throw new Error('Ollama не настроена');
  const response=await fetch(`${base.replace(/\/$/,'')}/api/generate`,{
    method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(120_000),
    body:JSON.stringify({model,stream:false,format:'json',options:{temperature:0,num_predict:500},
      prompt:`Ты видеоредактор. Расположи футажи в порядке рассказа так, чтобы содержание кадра совпадало с очередной частью озвучки. Каждый индекс используй ровно один раз. Если описание неинформативно, сохрани его относительный порядок. Верни только JSON {"order":[0,1]}.
ОЗВУЧКА: ${text.slice(0,8000)}
ФУТАЖИ: ${JSON.stringify(assets.map((asset,index)=>({index,description:asset.description||asset.original_name})))}`}),
  });
  if(!response.ok)throw new Error(`Ollama вернула HTTP ${response.status}`);
  const payload=await response.json() as {response?:string};
  const parsed=JSON.parse(payload.response??'{}') as {order?:unknown};
  if(!Array.isArray(parsed.order)||parsed.order.length!==assets.length)throw new Error('Модель вернула неполный порядок');
  const indices=parsed.order.map(Number);
  if(new Set(indices).size!==assets.length||indices.some(index=>!Number.isInteger(index)||!assets[index]))throw new Error('Модель вернула некорректный порядок');
  return indices.map(index=>assets[index].id);
}

type IncomingMedia = { fileId: string; name: string; mime: string };

function incomingMedia(ctx: Context): IncomingMedia | null {
  const message = ctx.message;
  if (!message) return null;
  if (message.video) return {
    fileId: message.video.file_id,
    name: message.video.file_name ?? `video-${message.message_id}.mp4`,
    mime: message.video.mime_type ?? 'video/mp4',
  };
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return { fileId: photo.file_id, name: `photo-${message.message_id}.jpg`, mime: 'image/jpeg' };
  }
  if (message.document && /^(video|image)\//.test(message.document.mime_type ?? '')) return {
    fileId: message.document.file_id,
    name: message.document.file_name ?? `file-${message.message_id}`,
    mime: message.document.mime_type ?? 'application/octet-stream',
  };
  return null;
}

async function fileSha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function probeMedia(path: string) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', path,
  ], { timeout: 60_000, maxBuffer: 1_000_000 });
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const visual = data.streams?.find(stream => stream.codec_type === 'video') ?? data.streams?.[0];
  return {
    duration: data.format?.duration ? Number(data.format.duration) : null,
    width: visual?.width ?? null,
    height: visual?.height ?? null,
  };
}

async function describeMedia(path:string,mime:string,duration:number|null) {
  const base=process.env.OLLAMA_BASE_URL;
  const model=process.env.OLLAMA_MODEL;
  if(!base||!model)return '';
  const previews=join(mediaRoot,'previews');
  await mkdir(previews,{recursive:true});
  const preview=join(previews,`${randomUUID()}.jpg`);
  try {
    const seek=!mime.startsWith('image/')&&duration?['-ss',String(Math.max(0,duration/2))]:[];
    await run('ffmpeg',['-v','error',...seek,'-i',path,'-frames:v','1','-vf',
      "scale='min(640,iw)':-2",'-q:v','3','-y',preview],{timeout:60_000,maxBuffer:1_000_000});
    const image=(await readFile(preview)).toString('base64');
    const response=await fetch(`${base.replace(/\/$/,'')}/api/generate`,{
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(120_000),
      body:JSON.stringify({model,stream:false,format:'json',images:[image],options:{temperature:0,num_predict:160},
        prompt:'Опиши по-русски, что видно в этом футаже. Назови главного человека, организацию, место, действие и предметы, только если они действительно видны. Не выдумывай имена. Верни только JSON {"description":"одно точное предложение"}.'}),
    });
    if(!response.ok)return '';
    const payload=await response.json() as {response?:string};
    const parsed=JSON.parse(payload.response??'{}') as {description?:unknown};
    return typeof parsed.description==='string'?parsed.description.trim().slice(0,500):'';
  } catch {
    return '';
  } finally {
    await rm(preview,{force:true});
  }
}

async function downloadTelegramFile(fileId: string, destination: string) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');
  if (file.file_path.startsWith('/') && existsSync(file.file_path)) {
    await copyFile(file.file_path, destination);
    return;
  }
  const response = await fetch(`${apiRoot}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать файл: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

async function saveIncomingMedia(ctx: Context, media: IncomingMedia, project: Project, replaceId?: string) {
  const id = randomUUID();
  const safeExtension = extname(basename(media.name)).toLowerCase().slice(0, 10)
    || (media.mime.startsWith('image/') ? '.jpg' : '.mp4');
  const objectKey = join('uploads', `${id}${safeExtension}`);
  const path = join(mediaRoot, objectKey);
  await downloadTelegramFile(media.fileId, path);
  try {
    const [sha256, metadata] = await Promise.all([fileSha256(path), probeMedia(path)]);
    const duplicate = await db.query(
      'SELECT 1 FROM assets WHERE project_id=$1 AND sha256=$2 AND deleted_at IS NULL',
      [project.id, sha256],
    );
    if (duplicate.rowCount) {
      await unlink(path);
      return { duplicate: true, position: 0, ...metadata };
    }
    const description=await describeMedia(path,media.mime,metadata.duration);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let position: number;
      if (replaceId) {
        const old = await client.query<{ position: number }>(
          'SELECT position FROM assets WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL FOR UPDATE',
          [replaceId, project.id],
        );
        if (!old.rows[0]) throw new Error('Материал для замены не найден');
        position = old.rows[0].position;
        await client.query('UPDATE assets SET deleted_at=now(),position=NULL WHERE id=$1', [replaceId]);
      } else {
        const result = await client.query<{ position: number }>(
          'SELECT COALESCE(MAX(position),0)+1 AS position FROM assets WHERE project_id=$1 AND deleted_at IS NULL',
          [project.id],
        );
        position = result.rows[0].position;
      }
      await client.query(
        `INSERT INTO assets
         (id,project_id,position,object_key,original_name,mime_type,duration_seconds,width,height,telegram_file_id,sha256,status,description,trim_end_sec)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready',$12,$13)`,
        [id, project.id, position, objectKey, basename(media.name), media.mime, metadata.duration,
          metadata.width, metadata.height, media.fileId, sha256,description,metadata.duration],
      );
      await client.query("UPDATE projects SET status='collecting_assets',updated_at=now() WHERE id=$1", [project.id]);
      await client.query('COMMIT');
      return { duplicate: false, position, ...metadata };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function showSettings(ctx: Context) {
  const project = await currentProject(ctx);
  if (!project) return showProjectHome(ctx);
  const color = Object.values(colors).find(item => item.ass === project.caption_color)?.label ?? 'свой';
  const keyboard = new InlineKeyboard()
    .text('🎙 Ирина', 'voice:irina').text('Дмитрий', 'voice:dmitri').text('Денис', 'voice:denis').row()
    .text('Sans', 'font:sans').text('Serif', 'font:serif').text('Mono', 'font:mono').row()
    .text('⚪ Белый', 'color:white').text('🟡 Жёлтый', 'color:yellow').text('🔵 Голубой', 'color:cyan').row()
    .text('S', 'size:48').text('M', 'size:58').text('L', 'size:68').row()
    .text('🎧 Послушать голос', 'voice:sample').text('👁 Пример субтитров', 'caption:preview');
  return ctx.reply(
    `Настройки проекта\n` +
    `Голос: ${voices[project.voice_id]?.label ?? project.voice_id}\n` +
    `Субтитры: ${project.caption_font}, ${color}, ${project.caption_size}px`,
    { reply_markup: keyboard },
  );
}

async function temporaryWorkdir(prefix:string) {
  const path=join(mediaRoot,'outputs',`${prefix}-${randomUUID()}`);
  await mkdir(path,{recursive:true});
  return path;
}

async function sendVoiceSample(ctx:Context,project:Project) {
  const workdir=await temporaryWorkdir('voice-sample');
  try {
    const timeline=join(workdir,'timeline.json');
    await writeFile(timeline,JSON.stringify([{text:'Это пример голоса для короткой новостной сводки.',assetId:null}]));
    await run(process.env.TTS_PYTHON??'/opt/tts/bin/python',['src/narrate.py',timeline,project.voice_id],{timeout:120_000,maxBuffer:1_000_000});
    await ctx.replyWithAudio(new InputFile(join(workdir,'narration.wav')), {caption: voices[project.voice_id]?.label??project.voice_id});
  } finally {
    await rm(workdir,{recursive:true,force:true});
  }
}

async function sendCaptionPreview(ctx:Context,project:Project) {
  const workdir=await temporaryWorkdir('caption-preview');
  try {
    const assPath=join(workdir,'preview.ass');
    const outputPath=join(workdir,'preview.jpg');
    await writeFile(assPath,sceneCaptions('Так будут выглядеть субтитры в готовом ролике',3,{
      font:project.caption_font,size:project.caption_size,color:project.caption_color,
    }));
    const subtitlePath=assPath.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'");
    await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x172033:s=1080x1920:r=1',
      '-vf',`subtitles='${subtitlePath}'`,'-frames:v','1','-q:v','2','-y',outputPath],{timeout:60_000,maxBuffer:1_000_000});
    await ctx.replyWithPhoto(new InputFile(outputPath),{caption:'Пример оформления субтитров'});
  } finally {
    await rm(workdir,{recursive:true,force:true});
  }
}

async function listProjects(ctx: Context, filter: 'open' | 'completed' = 'open') {
  const condition = filter === 'completed' ? "status='completed'" : "status<>'completed'";
  const { rows } = await db.query<{ id: string; title: string; status: string; target_duration_sec: number }>(
    `SELECT id,title,status,target_duration_sec FROM projects
     WHERE owner_telegram_id=$1 AND archived_at IS NULL AND ${condition}
     ORDER BY updated_at DESC LIMIT 10`,
    [userId(ctx)],
  );
  const keyboard = new InlineKeyboard().text('➕ Новый проект', 'project:new').row()
    .text('🟡 Незаконченные', 'projects:open').text('✅ Готовые', 'projects:completed').row();
  for (const project of rows) keyboard.text(`${project.title} · ${project.target_duration_sec}с`, `project:use:${project.id}`).row();
  return ctx.reply(rows.length ? 'Выбери проект:' : 'В этом разделе проектов пока нет.', { reply_markup: keyboard });
}

async function renderSummary(ctx: Context) {
  const project = await currentProject(ctx);
  if (!project) return showProjectHome(ctx);
  const assets = await listAssets(project.id);
  const missing: string[] = [];
  if (!project.news_text) missing.push('текст');
  if (!assets.length) missing.push('материалы');
  if (missing.length) {
    return ctx.reply(`Пока не хватает: ${missing.join(', ')}.`, {
      reply_markup: new InlineKeyboard().text('📝 Текст', 'nav:text').text('🎞 Материалы', 'nav:assets'),
    });
  }
  return ctx.reply(
    `Проект готов к сборке\n` +
    `Формат: 1080×1920, MP4, 30 fps\n` +
    `Текст: ${countWords(project.news_text)} слов · около ${estimateDuration(project.news_text)} сек\n` +
    `Материалы: ${assets.length}\n` +
    `Голос: ${voices[project.voice_id]?.label ?? project.voice_id}\n` +
    `Субтитры: ${project.caption_font}, ${project.caption_size}px`,
    { reply_markup: new InlineKeyboard().text('🚀 Начать сборку', 'render:confirm').row()
      .text('📝 Текст', 'nav:text').text('🎞 Материалы', 'nav:assets').text('⚙️ Настройки', 'nav:settings') },
  );
}

bot.use(async (ctx, next) => {
  if (!ctx.from || !ctx.chat) return;
  const username=ctx.from.username?.toLowerCase();
  if ((allowedIds.size||allowedUsernames.size)
    && !allowedIds.has(String(ctx.from.id))
    && !(username&&allowedUsernames.has(username))) {
    await ctx.reply('У этого Telegram ID нет доступа к боту.');
    return;
  }
  await ensureSession(ctx);
  await next();
});

bot.command('start', showProjectHome);
bot.command('new', async ctx => {
  await setState(ctx, 'choosing_duration');
  await ctx.reply('Выбери длительность будущего видео.', {
    reply_markup: new InlineKeyboard().text('30 секунд', 'duration:30').text('60 секунд', 'duration:60'),
  });
});
bot.command('cancel', async ctx => {
  await setState(ctx, 'idle');
  await replyHome(ctx, 'Текущий ввод отменён. Проект сохранён.');
});

bot.hears('🎞 Материалы', ctx => showAsset(ctx));
bot.hears('📝 Текст', ctx => showScript(ctx));
bot.hears('⚙️ Настройки', ctx => showSettings(ctx));
bot.hears('📁 Проекты', ctx => listProjects(ctx));
bot.hears('🚀 Собрать видео', ctx => renderSummary(ctx));

bot.callbackQuery('project:new', async ctx => {
  await ctx.answerCallbackQuery();
  await setState(ctx, 'choosing_duration');
  await ctx.reply('Выбери длительность будущего видео.', {
    reply_markup: new InlineKeyboard().text('30 секунд', 'duration:30').text('60 секунд', 'duration:60'),
  });
});

bot.callbackQuery(/^duration:(30|60)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const duration = Number(ctx.match[1]) as 30 | 60;
  await setState(ctx, 'choosing_style', { duration });
  await ctx.reply('Как подать новость?', {
    reply_markup: new InlineKeyboard()
      .text('📰 Новостная сводка', 'style:news').row()
      .text('⚡ Популярная подача', 'style:popular'),
  });
});

bot.callbackQuery(/^style:(news|popular)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const activeSession = await session(ctx);
  const duration = activeSession.state_data.duration === 60 ? 60 : 30;
  const id = randomUUID();
  const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
  await db.query(
    `INSERT INTO projects
     (id,owner_telegram_id,title,news_text,source_text,target_duration_sec,delivery_style,status)
     VALUES ($1,$2,$3,'','',$4,$5,'draft')`,
    [id, userId(ctx), `Проект ${date}`, duration, ctx.match[1]],
  );
  await db.query(
    `UPDATE bot_sessions SET current_project_id=$1,state='awaiting_source_text',state_data='{}',updated_at=now()
     WHERE telegram_user_id=$2`,
    [id, userId(ctx)],
  );
  await replyHome(ctx, 'Проект создан. Пришли сухой исходный текст новости одним сообщением.');
});

bot.callbackQuery(/^project:use:([a-f0-9-]{36})$/i, async ctx => {
  await ctx.answerCallbackQuery();
  if (!await useProject(ctx, ctx.match[1])) return ctx.reply('Проект не найден.');
  await showProjectHome(ctx);
  await ctx.reply('Управление проектом:', {reply_markup:new InlineKeyboard()
    .text('✏️ Переименовать','project:rename').text('🗄 Архивировать','project:archive')});
});
bot.callbackQuery('projects:open', async ctx => { await ctx.answerCallbackQuery(); await listProjects(ctx, 'open'); });
bot.callbackQuery('projects:completed', async ctx => { await ctx.answerCallbackQuery(); await listProjects(ctx, 'completed'); });
bot.callbackQuery('project:rename',async ctx=>{
  await ctx.answerCallbackQuery();
  await setState(ctx,'awaiting_project_name');
  await ctx.reply('Пришли новое название проекта одним сообщением.');
});
bot.callbackQuery('project:archive',async ctx=>{
  await ctx.answerCallbackQuery();
  await ctx.reply('Архивировать текущий проект?',{reply_markup:new InlineKeyboard()
    .text('Да, архивировать','project:archive-confirm').text('Отмена','projects:open')});
});
bot.callbackQuery('project:archive-confirm',async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(!project)return;
  await db.query('UPDATE projects SET archived_at=now(),updated_at=now() WHERE id=$1',[project.id]);
  await db.query("UPDATE bot_sessions SET current_project_id=NULL,state='idle',state_data='{}' WHERE telegram_user_id=$1",[userId(ctx)]);
  await replyHome(ctx,'Проект перенесён в архив.');
  await listProjects(ctx,'open');
});

bot.callbackQuery('script:source', async ctx => {
  await ctx.answerCallbackQuery();
  await setState(ctx, 'awaiting_source_text');
  await ctx.reply('Пришли новый исходный текст. Старые версии сценария останутся в истории.');
});
bot.callbackQuery('script:edit', async ctx => {
  await ctx.answerCallbackQuery();
  await setState(ctx, 'awaiting_script_edit');
  await ctx.reply('Пришли готовый исправленный сценарий одним сообщением.');
});
bot.callbackQuery('script:regen', async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Как сделать новый вариант?',{reply_markup:new InlineKeyboard()
    .text('✂️ Жёстко короче','script:mode:strict').row()
    .text('⚖️ Сбалансированно','script:mode:balanced').row()
    .text('⚡ Живее','script:mode:lively')});
});
bot.callbackQuery(/^script:mode:(strict|balanced|lively)$/,async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(project)await generateScript(ctx,project,ctx.match[1] as RewriteMode);
});
bot.callbackQuery('script:confirm', async ctx => {
  await ctx.answerCallbackQuery({ text: 'Текст подтверждён' });
  const project = await currentProject(ctx);
  if (!project) return;
  await db.query("UPDATE projects SET status='collecting_assets',updated_at=now() WHERE id=$1", [project.id]);
  await setState(ctx, 'awaiting_assets');
  await replyHome(ctx, 'Текст подтверждён. Теперь присылай видео и изображения по одному или альбомом.');
});

bot.callbackQuery('nav:text', async ctx => { await ctx.answerCallbackQuery(); await showScript(ctx); });
bot.callbackQuery('nav:assets', async ctx => { await ctx.answerCallbackQuery(); await showAsset(ctx); });
bot.callbackQuery('nav:settings', async ctx => { await ctx.answerCallbackQuery(); await showSettings(ctx); });

bot.callbackQuery(/^asset:view:([a-f0-9-]{36})$/i, async ctx => {
  await ctx.answerCallbackQuery();
  await showAsset(ctx, ctx.match[1]);
});
bot.callbackQuery(/^asset:move:([a-f0-9-]{36}):(-?1)$/i, async ctx => {
  await ctx.answerCallbackQuery();
  const project = await currentProject(ctx);
  if (!project) return;
  await moveAsset(project.id, ctx.match[1], Number(ctx.match[2]));
  await showAsset(ctx, ctx.match[1]);
});
bot.callbackQuery(/^asset:params:([a-f0-9-]{36})$/i,async ctx=>{
  await ctx.answerCallbackQuery();
  await showAssetParams(ctx,ctx.match[1]);
});
bot.callbackQuery(/^asset:trim:([a-f0-9-]{36}):(start|end):(-?1)$/i,async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(!project)return;
  const assets=await listAssets(project.id);
  const asset=assets.find(item=>item.id===ctx.match[1]);
  if(!asset)return;
  const duration=Number(asset.duration_seconds??0);
  let start=Number(asset.trim_start_sec??0);
  let end=Number(asset.trim_end_sec??duration);
  const delta=Number(ctx.match[3]);
  if(ctx.match[2]==='start')start=Math.max(0,Math.min(end-0.5,start+delta));
  else end=Math.min(duration,Math.max(start+0.5,end+delta));
  await db.query('UPDATE assets SET trim_start_sec=$1,trim_end_sec=$2 WHERE id=$3 AND project_id=$4',[start,end,asset.id,project.id]);
  await showAssetParams(ctx,asset.id);
});
bot.callbackQuery(/^asset:crop:([a-f0-9-]{36})$/i,async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(!project)return;
  const result=await db.query<{crop_mode:'left'|'center'|'right'}>('SELECT crop_mode FROM assets WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',[ctx.match[1],project.id]);
  const modes=['left','center','right'] as const;
  const current=result.rows[0]?.crop_mode??'center';
  const next=modes[(modes.indexOf(current)+1)%modes.length];
  await db.query('UPDATE assets SET crop_mode=$1 WHERE id=$2 AND project_id=$3',[next,ctx.match[1],project.id]);
  await showAssetParams(ctx,ctx.match[1]);
});
bot.callbackQuery(/^asset:describe:([a-f0-9-]{36})$/i,async ctx=>{
  await ctx.answerCallbackQuery();
  await setState(ctx,'awaiting_asset_description',{assetId:ctx.match[1]});
  await ctx.reply('Коротко опиши, что видно в этом футаже. Это поможет точно совместить кадр с озвучкой.');
});
bot.callbackQuery('assets:autoorder',async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(!project)return;
  const assets=await listAssets(project.id);
  if(assets.length<2)return ctx.reply('Для автопорядка нужно хотя бы два материала.');
  const progress=await ctx.reply('Сопоставляю содержание футажей с текстом озвучки…');
  try {
    const ids=await suggestAssetOrder(project.news_text,assets);
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      await renumberAssets(client,project.id,ids);
      await client.query('COMMIT');
    } catch(error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    await ctx.api.editMessageText(chatId(ctx),progress.message_id,'Автопорядок готов. Проверь материалы и при необходимости поправь стрелками.');
    await showAsset(ctx,ids[0]);
  } catch(error) {
    await ctx.api.editMessageText(chatId(ctx),progress.message_id,`Не удалось подобрать порядок: ${error instanceof Error?error.message:'неизвестная ошибка'}`);
  }
});
bot.callbackQuery(/^asset:replace:([a-f0-9-]{36})$/i, async ctx => {
  await ctx.answerCallbackQuery();
  await setState(ctx, 'awaiting_replacement_asset', { assetId: ctx.match[1] });
  await ctx.reply('Пришли один новый видеофайл или изображение. Он займёт ту же позицию.');
});
bot.callbackQuery(/^asset:delete:([a-f0-9-]{36})$/i, async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Точно удалить этот материал из проекта?', {
    reply_markup: new InlineKeyboard().text('Удалить', `asset:delete-confirm:${ctx.match[1]}`).text('Отмена', `asset:view:${ctx.match[1]}`),
  });
});
bot.callbackQuery(/^asset:delete-confirm:([a-f0-9-]{36})$/i, async ctx => {
  await ctx.answerCallbackQuery();
  const project = await currentProject(ctx);
  if (!project) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE assets SET deleted_at=now(),position=NULL WHERE id=$1 AND project_id=$2', [ctx.match[1], project.id]);
    const remaining = await client.query<{ id: string }>('SELECT id FROM assets WHERE project_id=$1 AND deleted_at IS NULL ORDER BY position,id', [project.id]);
    await renumberAssets(client, project.id, remaining.rows.map(row => row.id));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await ctx.reply('Материал удалён.');
  await showAsset(ctx);
});
bot.callbackQuery('assets:done', async ctx => {
  await ctx.answerCallbackQuery({ text: 'Материалы сохранены' });
  const project = await currentProject(ctx);
  if (project) await db.query("UPDATE projects SET status='ready',updated_at=now() WHERE id=$1", [project.id]);
  await setState(ctx, 'idle');
  await showSettings(ctx);
});

bot.callbackQuery(/^voice:(irina|dmitri|denis)$/, async ctx => {
  await ctx.answerCallbackQuery({ text: 'Голос сохранён' });
  const project = await currentProject(ctx);
  if (project) await db.query('UPDATE projects SET voice_id=$1,updated_at=now() WHERE id=$2', [ctx.match[1], project.id]);
  await showSettings(ctx);
});
bot.callbackQuery(/^font:(sans|serif|mono)$/, async ctx => {
  await ctx.answerCallbackQuery({ text: 'Шрифт сохранён' });
  const project = await currentProject(ctx);
  if (project) await db.query('UPDATE projects SET caption_font=$1,updated_at=now() WHERE id=$2', [fonts[ctx.match[1]], project.id]);
  await showSettings(ctx);
});
bot.callbackQuery(/^color:(white|yellow|cyan)$/, async ctx => {
  await ctx.answerCallbackQuery({ text: 'Цвет сохранён' });
  const project = await currentProject(ctx);
  if (project) await db.query('UPDATE projects SET caption_color=$1,updated_at=now() WHERE id=$2', [colors[ctx.match[1]].ass, project.id]);
  await showSettings(ctx);
});
bot.callbackQuery(/^size:(48|58|68)$/, async ctx => {
  await ctx.answerCallbackQuery({ text: 'Размер сохранён' });
  const project = await currentProject(ctx);
  if (project) await db.query('UPDATE projects SET caption_size=$1,updated_at=now() WHERE id=$2', [Number(ctx.match[1]), project.id]);
  await showSettings(ctx);
});
bot.callbackQuery('voice:sample',async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(!project)return;
  try { await sendVoiceSample(ctx,project); }
  catch(error) { await ctx.reply(`Не удалось создать пример голоса: ${error instanceof Error?error.message:'неизвестная ошибка'}`); }
});
bot.callbackQuery('caption:preview',async ctx=>{
  await ctx.answerCallbackQuery();
  const project=await currentProject(ctx);
  if(!project)return;
  try { await sendCaptionPreview(ctx,project); }
  catch(error) { await ctx.reply(`Не удалось создать пример субтитров: ${error instanceof Error?error.message:'неизвестная ошибка'}`); }
});

bot.callbackQuery('render:confirm', async ctx => {
  await ctx.answerCallbackQuery();
  const project = await currentProject(ctx);
  if (!project) return;
  const assets = await listAssets(project.id);
  if (!project.news_text || !assets.length) return renderSummary(ctx);
  const running = await db.query(
    "SELECT 1 FROM render_jobs WHERE project_id=$1 AND status IN ('queued','processing') LIMIT 1",
    [project.id],
  );
  if (running.rowCount) return ctx.reply('Этот проект уже собирается.');
  const jobId = randomUUID();
  const snapshot = {
    text: project.news_text,
    voiceId: project.voice_id,
    caption: { font: project.caption_font, color: project.caption_color, size: project.caption_size },
    assetIds: assets.map(asset => asset.id),
  };
  const statusMessage = await ctx.reply('Сборка поставлена в очередь: 0%', {
    reply_markup: new InlineKeyboard().text('Отменить', `render:cancel:${jobId}`),
  });
  await db.query(
    `INSERT INTO render_jobs
     (id,project_id,status,stage,progress,snapshot,telegram_chat_id,telegram_message_id)
     VALUES ($1,$2,'queued','queued',0,$3::jsonb,$4,$5)`,
    [jobId, project.id, JSON.stringify(snapshot), chatId(ctx), statusMessage.message_id],
  );
  await db.query("UPDATE projects SET status='rendering',updated_at=now() WHERE id=$1", [project.id]);
  await renderQueue.add('assemble-video', { jobId, projectId: project.id }, { jobId, attempts: 1 });
});
bot.callbackQuery(/^render:cancel:([a-f0-9-]{36})$/i, async ctx => {
  await ctx.answerCallbackQuery({ text: 'Отмена запрошена' });
  await db.query(
    `UPDATE render_jobs SET cancel_requested_at=now()
     WHERE id=$1 AND project_id IN (SELECT id FROM projects WHERE owner_telegram_id=$2)`,
    [ctx.match[1], userId(ctx)],
  );
});

bot.on('message', async ctx => {
  const media = incomingMedia(ctx);
  if (media) {
    const project = await currentProject(ctx);
    if (!project) return showProjectHome(ctx);
    const activeSession = await session(ctx);
    const replaceId = activeSession.state === 'awaiting_replacement_asset' && typeof activeSession.state_data.assetId === 'string'
      ? activeSession.state_data.assetId : undefined;
    const progress = await ctx.reply('Принимаю и проверяю файл…');
    try {
      const result = await saveIncomingMedia(ctx, media, project, replaceId);
      await setState(ctx, 'awaiting_assets');
      if (result.duplicate) {
        await ctx.api.editMessageText(chatId(ctx), progress.message_id, 'Этот файл уже есть в текущем проекте.');
        return;
      }
      const warning = result.width && result.height && result.width > result.height
        ? '\n⚠️ Горизонтальный материал будет обрезан под 9:16.' : '';
      await ctx.api.editMessageText(
        chatId(ctx), progress.message_id,
        `${replaceId ? 'Материал заменён' : `Добавлено: материал ${result.position}`}\n` +
        `${media.mime.startsWith('image/') ? 'Изображение' : 'Видео'}` +
        `${result.duration ? ` · ${result.duration.toFixed(1)} сек` : ''}` +
        `${result.width && result.height ? ` · ${result.width}×${result.height}` : ''}${warning}`,
        { reply_markup: new InlineKeyboard().text('➕ Добавить ещё', 'assets:add').text('👁 Открыть материалы', 'nav:assets').row()
          .text('✅ Материалы готовы', 'assets:done') },
      );
    } catch (error) {
      await ctx.api.editMessageText(
        chatId(ctx), progress.message_id,
        `Файл не принят: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
      );
    }
    return;
  }

  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;
  const activeSession = await session(ctx);
  const project = await currentProject(ctx);
  if (!project) return showProjectHome(ctx);
  if (activeSession.state === 'awaiting_source_text') {
    if (text.length > 20_000) return ctx.reply('Исходник слишком длинный. Максимум — 20 000 символов.');
    await db.query('UPDATE projects SET source_text=$1,updated_at=now() WHERE id=$2', [text, project.id]);
    await setState(ctx, 'generating_script');
    const refreshed = await currentProject(ctx);
    if (refreshed) await generateScript(ctx, refreshed);
    return;
  }
  if (activeSession.state === 'awaiting_script_edit') {
    await saveScript(project, text, 'manual');
    await setState(ctx, 'idle');
    const refreshed = await currentProject(ctx);
    await showScript(ctx, refreshed);
    return;
  }
  if(activeSession.state==='awaiting_project_name') {
    await db.query('UPDATE projects SET title=$1,updated_at=now() WHERE id=$2',[text.slice(0,80),project.id]);
    await setState(ctx,'idle');
    await showProjectHome(ctx);
    return;
  }
  if(activeSession.state==='awaiting_asset_description'&&typeof activeSession.state_data.assetId==='string') {
    await db.query('UPDATE assets SET description=$1 WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL',
      [text.slice(0,500),activeSession.state_data.assetId,project.id]);
    await setState(ctx,'idle');
    await showAsset(ctx,activeSession.state_data.assetId);
    return;
  }
  await ctx.reply('Не понял, куда сохранить этот текст. Нажми «📝 Текст» или выбери действие кнопками ниже.', { reply_markup: mainKeyboard });
});

bot.callbackQuery('assets:add', async ctx => {
  await ctx.answerCallbackQuery();
  await setState(ctx, 'awaiting_assets');
  await ctx.reply('Пришли следующее видео или изображение.', { reply_markup: mainKeyboard });
});

bot.catch(error => {
  console.error('Telegram bot error', error.error);
});

let watcherRunning = false;
async function watchRenderJobs() {
  if (watcherRunning) return;
  watcherRunning = true;
  try {
    const { rows } = await db.query<{
      id: string; project_id: string; status: string; stage: string; progress: number;
      output_path: string | null; error_message: string | null;
      telegram_chat_id: string; telegram_message_id: string;
    }>(
      `SELECT * FROM render_jobs
       WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL AND notified_at IS NULL
       ORDER BY created_at LIMIT 20`,
    );
    for (const job of rows) {
      const chat = job.telegram_chat_id;
      const messageId = Number(job.telegram_message_id);
      if (job.status === 'completed' && job.output_path) {
        await bot.api.editMessageText(chat, messageId, 'Видео готово: 100%').catch(() => undefined);
        try {
          await bot.api.sendVideo(chat, new InputFile(join(mediaRoot, job.output_path)), {
            caption: 'Готовый вертикальный ролик', supports_streaming: true,
          });
          await db.query('UPDATE render_jobs SET notified_at=now() WHERE id=$1', [job.id]);
          await db.query("UPDATE projects SET status='completed',updated_at=now() WHERE id=$1", [job.project_id]);
        } catch (error) {
          console.error('Could not send rendered video', error);
        }
      } else if (job.status === 'failed') {
        await bot.api.editMessageText(
          chat, messageId,
          `Сборка не удалась: ${job.error_message ?? 'неизвестная ошибка'}`,
          { reply_markup: new InlineKeyboard().text('Попробовать снова', 'render:confirm') },
        ).catch(() => undefined);
        await db.query('UPDATE render_jobs SET notified_at=now() WHERE id=$1', [job.id]);
        await db.query("UPDATE projects SET status='failed',updated_at=now() WHERE id=$1", [job.project_id]);
      } else {
        await bot.api.editMessageText(
          chat, messageId,
          `Собираю видео: ${job.progress}%\nЭтап: ${job.stage}`,
          { reply_markup: new InlineKeyboard().text('Отменить', `render:cancel:${job.id}`) },
        ).catch(() => undefined);
      }
    }
  } finally {
    watcherRunning = false;
  }
}

setInterval(() => void watchRenderJobs().catch(error => console.error('Render watcher error', error)), 5_000).unref();

bot.start({
  onStart: info => {
    console.log(`Telegram bot @${info.username} started`);
    if (!allowedIds.size&&!allowedUsernames.size) console.warn('Telegram allow-list is empty: every Telegram user can access the bot');
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => bot.stop());
}
