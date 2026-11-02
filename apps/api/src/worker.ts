import 'dotenv/config';
import { Worker } from 'bullmq';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { connection } from './queue.js';
import { ensureSchema } from './schema.js';
import { planOrderedTimeline, sceneCaptions, type CaptionStyle, type EditingAsset, type Scene } from './timeline.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const run = promisify(execFile);
const mediaRoot = process.env.MEDIA_ROOT ?? join(process.cwd(), 'media');
const logoPath = resolve('assets/channel-logo.webp');
await ensureSchema(db);

async function setStage(jobId:string,stage:string,progress:number) {
  await db.query("UPDATE render_jobs SET stage=$1,progress=$2,status='processing',error_message=NULL,updated_at=now() WHERE id=$3",[stage,progress,jobId]);
}

async function ensureNotCancelled(jobId:string) {
  const {rows}=await db.query<{cancel_requested_at:string|null}>('SELECT cancel_requested_at FROM render_jobs WHERE id=$1',[jobId]);
  if(rows[0]?.cancel_requested_at) throw new Error('Сборка отменена пользователем');
}

new Worker('render',async job => {
  const jobId=job.data.jobId as string;
  try {
    const project=(await db.query<{
      news_text:string;voice_id:string;caption_font:string;caption_color:string;caption_size:number;
    }>('SELECT news_text,voice_id,caption_font,caption_color,caption_size FROM projects WHERE id=$1',[job.data.projectId])).rows[0];
    if(!project) throw new Error('Проект не найден');
    const render=(await db.query<{snapshot:{text?:string;voiceId?:string;caption?:CaptionStyle;assetIds?:string[]}|null}>(
      'SELECT snapshot FROM render_jobs WHERE id=$1',[jobId])).rows[0];
    const snapshot=render?.snapshot;
    const requestedIds = Array.isArray(snapshot?.assetIds) ? snapshot.assetIds
      : Array.isArray(job.data.assetIds) ? job.data.assetIds : null;
    type RenderAsset=EditingAsset & {
      trim_start_sec:string|null;trim_end_sec:string|null;duration_seconds:string|null;crop_mode:'left'|'center'|'right';
    };
    const assets=requestedIds?.length
      ? (await db.query<RenderAsset>(`SELECT a.id,a.object_key,a.mime_type,a.original_name,a.tags,a.trim_start_sec,a.trim_end_sec,a.duration_seconds,a.crop_mode FROM assets a
          WHERE a.project_id=$1 AND a.deleted_at IS NULL AND a.id=ANY($2::uuid[])
          ORDER BY array_position($2::uuid[],a.id) LIMIT 30`,[job.data.projectId,requestedIds])).rows
      : (await db.query<RenderAsset>(`SELECT a.id,a.object_key,a.mime_type,a.original_name,a.tags,a.trim_start_sec,a.trim_end_sec,a.duration_seconds,a.crop_mode FROM assets a
          WHERE (a.project_id=$1 OR EXISTS(SELECT 1 FROM project_assets pa WHERE pa.asset_id=a.id AND pa.project_id=$1))
            AND a.deleted_at IS NULL
          ORDER BY a.position NULLS LAST,a.created_at LIMIT 30`,[job.data.projectId])).rows;
    await ensureNotCancelled(jobId);
    await setStage(jobId,'Раскадровка',5);
    const narration=snapshot?.text||project.news_text;
    const scenes=planOrderedTimeline(narration,assets);
    const workdir=join(mediaRoot,'outputs',jobId);
    await mkdir(workdir,{recursive:true});
    const timelinePath=join(workdir,'timeline.json');
    await writeFile(timelinePath,JSON.stringify(scenes,null,2));
    await ensureNotCancelled(jobId);
    await setStage(jobId,'Озвучка',10);
    const voice=snapshot?.voiceId||project.voice_id||'irina';
    await run(process.env.TTS_PYTHON ?? '/opt/tts/bin/python',['src/narrate.py',timelinePath,voice],{timeout:600000,maxBuffer:2_000_000});
    const timed=JSON.parse(await readFile(timelinePath,'utf8')) as (Scene & {duration:number;frames:number})[];
    const clips:string[]=[];
    const captionStyle=snapshot?.caption??{font:project.caption_font,color:project.caption_color,size:project.caption_size};
    for(let i=0;i<timed.length;i++) {
      await ensureNotCancelled(jobId);
      await setStage(jobId,`Рендер ${i+1}/${timed.length}`,10+Math.round((i/timed.length)*80));
      const scene=timed[i];
      const asset=assets.find(a=>a.id===scene.assetId);
      const captionPath=join(workdir,`${i}.ass`);
      const outputPath=join(workdir,`${i}.mp4`);
      await writeFile(captionPath,sceneCaptions(scene.text,scene.duration,captionStyle));
      const image=asset?.mime_type.startsWith('image/');
      const trimStart=Number(asset?.trim_start_sec??0);
      const trimEnd=Number(asset?.trim_end_sec??asset?.duration_seconds??(trimStart+scene.duration));
      const selectedDuration=Math.max(0.5,trimEnd-trimStart);
      const input=asset
        ? [...(image ? ['-loop','1','-framerate','30'] : ['-ss',String(trimStart)]),'-i',join(mediaRoot,asset.object_key)]
        : ['-f','lavfi','-i','color=c=0x172033:s=1080x1920:r=30'];
      const cropX=asset?.crop_mode==='left'?'0':asset?.crop_mode==='right'?'iw-ow':'(iw-ow)/2';
      const base=`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${cropX}:(ih-oh)/2,setsar=1`;
      const motion=image
        ? `${base},zoompan=z='1+0.07*on/${scene.frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=30`
        : selectedDuration<scene.duration
          ? `fps=30,trim=duration=${selectedDuration},setpts=PTS-STARTPTS,loop=loop=-1:size=${Math.max(1,Math.floor(selectedDuration*30))}:start=0,setpts=N/(30*TB),${base}`
          : `fps=30,trim=duration=${scene.duration},setpts=PTS-STARTPTS,${base}`;
      const subtitlePath=captionPath.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'");
      const filter=`[0:v]${motion},setpts=PTS-STARTPTS[base];[1:v]scale=180:-2,format=rgba[logo];[base][logo]overlay=W-w-55:80,subtitles='${subtitlePath}',format=yuv420p[v]`;
      await run('ffmpeg',['-v','error','-threads','2','-filter_complex_threads','1',...input,'-i',logoPath,
        '-filter_complex',filter,'-map','[v]','-an','-frames:v',String(scene.frames),'-r','30','-c:v','libx264','-preset','veryfast','-crf','22',
        '-pix_fmt','yuv420p','-video_track_timescale','15360','-y',outputPath],{timeout:300000,maxBuffer:4_000_000});
      clips.push(`file '${outputPath.replaceAll("'","'\\''")}'`);
    }
    await ensureNotCancelled(jobId);
    await setStage(jobId,'Экспорт',95);
    const concatPath=join(workdir,'clips.txt');
    await writeFile(concatPath,clips.join('\n'));
    const outputPath=join(mediaRoot,'outputs',`${jobId}.mp4`);
    await run('ffmpeg',['-v','error','-f','concat','-safe','0','-i',concatPath,'-i',join(workdir,'narration.wav'),
      '-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest','-y',outputPath],{timeout:300000});
    await db.query("UPDATE render_jobs SET stage='Готово',progress=100,status='completed',output_path=$1,updated_at=now() WHERE id=$2",[`outputs/${jobId}.mp4`,jobId]);
  } catch(error) {
    console.error('Render failed',{jobId,error});
    const stderr=(error as {stderr?:string})?.stderr;
    const message=stderr?.trim().slice(-1000) || (error instanceof Error?error.message:'Неизвестная ошибка');
    await db.query("UPDATE render_jobs SET status='failed',stage='failed',error_message=$1,updated_at=now() WHERE id=$2",[message,jobId]);
    throw error;
  }
},{connection,concurrency:1});
