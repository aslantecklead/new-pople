import 'dotenv/config';
import { Worker } from 'bullmq';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { connection } from './queue.js';
import { planTimeline, sceneCaptions, type EditingAsset, type Scene } from './timeline.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const run = promisify(execFile);
const mediaRoot = process.env.MEDIA_ROOT ?? join(process.cwd(), 'media');
const logoPath = resolve('assets/channel-logo.webp');
await db.query('ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS error_message TEXT');

async function setStage(jobId:string,stage:string) {
  await db.query("UPDATE render_jobs SET stage=$1,status='processing',error_message=NULL,updated_at=now() WHERE id=$2",[stage,jobId]);
}

new Worker('render',async job => {
  const jobId=job.data.jobId as string;
  try {
    const project=(await db.query('SELECT news_text FROM projects WHERE id=$1',[job.data.projectId])).rows[0];
    if(!project) throw new Error('Проект не найден');
    const requestedIds = Array.isArray(job.data.assetIds) ? job.data.assetIds : null;
    const assets=(await db.query<EditingAsset>(`SELECT a.id,a.object_key,a.mime_type,a.original_name,a.tags FROM assets a
      WHERE (a.project_id=$1 OR EXISTS(SELECT 1 FROM project_assets pa WHERE pa.asset_id=a.id AND pa.project_id=$1))
        AND ($2::uuid[] IS NULL OR a.id=ANY($2::uuid[]) OR a.source_provider IS NULL)
      ORDER BY a.created_at LIMIT 20`,[job.data.projectId,requestedIds])).rows;
    await setStage(jobId,'storyboard');
    const scenes=await planTimeline(project.news_text,assets);
    const workdir=join(mediaRoot,'outputs',jobId);
    await mkdir(workdir,{recursive:true});
    const timelinePath=join(workdir,'timeline.json');
    await writeFile(timelinePath,JSON.stringify(scenes,null,2));
    await setStage(jobId,'voiceover');
    await run(process.env.TTS_PYTHON ?? '/opt/tts/bin/python',['src/narrate.py',timelinePath],{timeout:600000,maxBuffer:2_000_000});
    const timed=JSON.parse(await readFile(timelinePath,'utf8')) as (Scene & {duration:number;frames:number})[];
    const clips:string[]=[];
    for(let i=0;i<timed.length;i++) {
      await setStage(jobId,`render:${i+1}/${timed.length}`);
      const scene=timed[i];
      const asset=assets.find(a=>a.id===scene.assetId);
      const captionPath=join(workdir,`${i}.ass`);
      const outputPath=join(workdir,`${i}.mp4`);
      await writeFile(captionPath,sceneCaptions(scene.text,scene.duration));
      const image=asset?.mime_type.startsWith('image/');
      const input=asset
        ? [...(image ? ['-loop','1','-framerate','30'] : ['-stream_loop','-1']),'-i',join(mediaRoot,asset.object_key)]
        : ['-f','lavfi','-i','color=c=0x172033:s=1080x1920:r=30'];
      const base='scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1';
      const motion=image
        ? `${base},zoompan=z='1+0.07*on/${scene.frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=30`
        : `${base},fps=30`;
      const subtitlePath=captionPath.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'");
      const filter=`[0:v]${motion},setpts=PTS-STARTPTS[base];[1:v]scale=180:-2,format=rgba[logo];[base][logo]overlay=W-w-55:80,subtitles='${subtitlePath}',format=yuv420p[v]`;
      await run('ffmpeg',['-v','error','-threads','2','-filter_complex_threads','1',...input,'-i',logoPath,
        '-filter_complex',filter,'-map','[v]','-an','-frames:v',String(scene.frames),'-r','30','-c:v','libx264','-preset','veryfast','-crf','22',
        '-pix_fmt','yuv420p','-video_track_timescale','15360','-y',outputPath],{timeout:300000,maxBuffer:4_000_000});
      clips.push(`file '${outputPath.replaceAll("'","'\\''")}'`);
    }
    await setStage(jobId,'export');
    const concatPath=join(workdir,'clips.txt');
    await writeFile(concatPath,clips.join('\n'));
    const outputPath=join(mediaRoot,'outputs',`${jobId}.mp4`);
    await run('ffmpeg',['-v','error','-f','concat','-safe','0','-i',concatPath,'-i',join(workdir,'narration.wav'),
      '-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest','-y',outputPath],{timeout:300000});
    await db.query("UPDATE render_jobs SET stage='completed',status='completed',output_path=$1,updated_at=now() WHERE id=$2",[`outputs/${jobId}.mp4`,jobId]);
  } catch(error) {
    console.error('Render failed',{jobId,error});
    const stderr=(error as {stderr?:string})?.stderr;
    const message=stderr?.trim().slice(-1000) || (error instanceof Error?error.message:'Неизвестная ошибка');
    await db.query("UPDATE render_jobs SET status='failed',stage='failed',error_message=$1,updated_at=now() WHERE id=$2",[message,jobId]);
    throw error;
  }
},{connection,concurrency:1});
