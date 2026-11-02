import 'dotenv/config';
import { Worker } from 'bullmq';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { connection } from './queue.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const stages = ['storyboard', 'footage-selection', 'voiceover', 'captions', 'render'] as const;
const run = promisify(execFile);
const mediaRoot = process.env.MEDIA_ROOT ?? join(process.cwd(), 'media');

function searchTerms(text: string) {
  const stopWords = new Set(['который', 'которые', 'будет', 'также', 'новый', 'новые', 'людей', 'теперь', 'чтобы', 'после', 'среди', 'этого', 'своей', 'свои']);
  return [...new Set(text.toLowerCase().match(/[а-яёa-z]{4,}/g)?.filter((word) => !stopWords.has(word)) ?? [])].slice(0, 8);
}

function assEscape(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll('\n', ' ');
}

function subtitleScript(text: string, duration: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const groups = Array.from({ length: Math.ceil(words.length / 6) }, (_, index) => words.slice(index * 6, index * 6 + 6).join(' '));
  const toAss = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
  };
  const interval = duration / Math.max(groups.length, 1);
  const events = groups.map((group, index) => `Dialogue: 0,${toAss(index * interval)},${toAss(Math.min(duration, (index + 1) * interval))},Default,,0,0,0,,${assEscape(group)}`);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,DejaVu Sans,58,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,60,60,190,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join('\n')}`;
}

async function setStage(jobId: string, stage: (typeof stages)[number]) {
  await db.query("UPDATE render_jobs SET stage = $1, status = 'processing', updated_at = now() WHERE id = $2", [stage, jobId]);
}

new Worker(
  'render',
  async (job) => {
    const jobId = job.data.jobId as string;
    try {
      const projectResult = await db.query<{ news_text: string }>('SELECT news_text FROM projects WHERE id = $1', [job.data.projectId]);
      const project = projectResult.rows[0];
      if (!project) throw new Error('project not found');
      const attachedAssets = await db.query<{ object_key: string; mime_type: string }>(`SELECT a.object_key, a.mime_type FROM assets a
        LEFT JOIN project_assets pa ON pa.asset_id = a.id
        WHERE a.project_id = $1 OR pa.project_id = $1
        GROUP BY a.object_key, a.mime_type
        ORDER BY MAX(a.created_at) LIMIT 6`, [job.data.projectId]);
      await setStage(jobId, 'storyboard');
      await job.updateProgress({ stage: 'storyboard' });
      const terms = searchTerms(project.news_text);
      const libraryAssets = terms.length ? await db.query<{ object_key: string; mime_type: string }>(
        `SELECT object_key, mime_type FROM assets WHERE project_id IS NULL AND tags::text ILIKE ANY($1::text[]) ORDER BY created_at LIMIT 6`,
        [terms.map((term) => `%${term}%`)],
      ) : { rows: [] };
      // The editor already selects remote material during step 2. Do not launch a
      // second, invisible network search inside the renderer: slow providers used
      // to leave a job stuck at “storyboard” for minutes. If nothing is selected,
      // render a readable text card instead.
      const assets = attachedAssets.rows.length ? attachedAssets.rows : libraryAssets.rows;
      const outputDir = join(mediaRoot, 'outputs');
      await mkdir(outputDir, { recursive: true });

      await setStage(jobId, 'footage-selection');
      await job.updateProgress({ stage: 'footage-selection', source: assets.length ? 'uploaded-media' : 'color-background', assets: assets.length });

      const audioPath = join(outputDir, `${jobId}.wav`);
      await setStage(jobId, 'voiceover');
      await run('espeak-ng', ['-v', 'ru', '-s', '155', '-w', audioPath, project.news_text]);
      const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
      const duration = Math.max(1, Number.parseFloat(probe.stdout.trim()) || 1);

      const captionPath = join(outputDir, `${jobId}.ass`);
      await setStage(jobId, 'captions');
      await writeFile(captionPath, subtitleScript(project.news_text, duration), 'utf8');

      await setStage(jobId, 'render');
      const outputPath = join(outputDir, `${jobId}.mp4`);
      const subtitleFilter = `subtitles=${captionPath.replaceAll('\\', '/').replaceAll(':', '\\:')}`;
      const args = assets.length
        ? (() => {
            const clipDuration = duration / assets.length;
            const inputs = assets.flatMap((asset) => [
              ...(asset.mime_type.startsWith('image/') ? ['-loop', '1'] : ['-stream_loop', '-1']),
              '-i', join(mediaRoot, asset.object_key),
            ]);
            const clips = assets.map((_, index) => `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,trim=duration=${clipDuration},setpts=PTS-STARTPTS[v${index}]`);
            const concatInputs = assets.map((_, index) => `[v${index}]`).join('');
            const visuals = assets.length === 1
              ? `[v0]${subtitleFilter}[video]`
              : `${clips.join(';')};${concatInputs}concat=n=${assets.length}:v=1:a=0[base];[base]${subtitleFilter}[video]`;
            return [
              ...inputs, '-i', audioPath,
              '-filter_complex', assets.length === 1 ? `${clips[0]};${visuals}` : visuals,
              '-map', '[video]', '-map', `${assets.length}:a`, '-shortest', '-r', '30', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath,
            ];
          })()
        : [
            '-f', 'lavfi', '-i', 'color=c=0x172033:s=1080x1920:r=30', '-i', audioPath,
            '-filter_complex', `[0:v]${subtitleFilter}[video]`,
            '-map', '[video]', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath,
          ];
      await run('ffmpeg', args, { maxBuffer: 10_000_000 });
      await db.query(
        "UPDATE render_jobs SET stage = 'completed', status = 'completed', output_path = $1, updated_at = now() WHERE id = $2",
        [`outputs/${jobId}.mp4`, jobId],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка рендера';
      console.error('Render failed', { jobId, message, stack: error instanceof Error ? error.stack : undefined });
      await db.query("UPDATE render_jobs SET status = 'failed', stage = 'failed', error_message = $1, updated_at = now() WHERE id = $2", [message.slice(0, 1400), jobId]);
      throw error;
    }
  },
  { connection, concurrency: 1 },
);
