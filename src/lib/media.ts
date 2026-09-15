import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { config } from '../config.js'

export function absMedia(rel: string): string {
  return join(config.MEDIA_DIR, rel)
}

async function ensureDir(rel: string) {
  await mkdir(dirname(absMedia(rel)), { recursive: true })
}

export async function downloadToMedia(url: string, rel: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`下载失败 ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await ensureDir(rel)
  await writeFile(absMedia(rel), buf)
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => {
      err += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 失败(${code}): ${err.slice(-300)}`))
    })
  })
}

export function probeDuration(rel: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.FFPROBE_PATH, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      absMedia(rel),
    ])
    let out = ''
    proc.stdout.on('data', (d) => {
      out += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', () => {
      const value = Number.parseFloat(out.trim())
      if (Number.isFinite(value)) resolve(value)
      else reject(new Error('无法解析视频时长'))
    })
  })
}

export function probeHasAudio(rel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(config.FFPROBE_PATH, [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      absMedia(rel),
    ])
    let out = ''
    proc.stdout.on('data', (d) => {
      out += d.toString()
    })
    proc.on('error', () => resolve(false))
    proc.on('close', () => resolve(out.trim().length > 0))
  })
}

export async function composeShot(opts: {
  videoRel: string
  audioRel?: string
  outRel: string
  mixOriginalVolume?: number
}): Promise<void> {
  await ensureDir(opts.outRel)
  const out = absMedia(opts.outRel)
  const duration = await probeDuration(opts.videoRel)
  const hasAudio = await probeHasAudio(opts.videoRel)
  const vol = opts.mixOriginalVolume ?? 0.35

  if (opts.audioRel && hasAudio) {
    // 原声（压低）+ 旁白 混合
    await ffmpeg([
      '-y',
      '-i', absMedia(opts.videoRel),
      '-i', absMedia(opts.audioRel),
      '-filter_complex',
      `[0:a]volume=${vol}[bg];[1:a]volume=1.0[fg];[bg][fg]amix=inputs=2:duration=longest:normalize=0[a]`,
      '-map', '0:v:0',
      '-map', '[a]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-t', String(duration),
      out,
    ])
  } else if (opts.audioRel) {
    // 视频无原声，仅旁白（配音短则补静音）
    await ffmpeg([
      '-y',
      '-i', absMedia(opts.videoRel),
      '-i', absMedia(opts.audioRel),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-af', 'apad',
      '-t', String(duration),
      out,
    ])
  } else if (hasAudio) {
    // 无旁白：保留原声
    await ffmpeg([
      '-y',
      '-i', absMedia(opts.videoRel),
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-t', String(duration),
      out,
    ])
  } else {
    // 无原声也无旁白：补静音
    await ffmpeg([
      '-y',
      '-i', absMedia(opts.videoRel),
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-t', String(duration),
      out,
    ])
  }
}

export async function concatShots(rels: string[], outRel: string): Promise<void> {
  await ensureDir(outRel)
  const args: string[] = ['-y']
  for (const rel of rels) {
    args.push('-i', absMedia(rel))
  }

  let filter = ''
  for (let i = 0; i < rels.length; i++) {
    filter += `[${i}:v:0][${i}:a:0]`
  }
  filter += `concat=n=${rels.length}:v=1:a=1[v][a]`

  args.push(
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    absMedia(outRel),
  )

  await ffmpeg(args)
}

function fmtAssTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const cs = Math.floor((total - Math.floor(total)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export async function burnSubtitles(opts: {
  videoRel: string
  cues: { start: number; end: number; text: string }[]
  outRel: string
}): Promise<void> {
  await ensureDir(opts.outRel)

  const assRel = opts.outRel.replace(/\.mp4$/, '.ass')
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,46,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const lines = opts.cues.map(
    (cue) =>
      `Dialogue: 0,${fmtAssTime(cue.start)},${fmtAssTime(cue.end)},Default,,0,0,0,,${cue.text.replace(/\n/g, '\\N')}`,
  )
  await writeFile(absMedia(assRel), header + lines.join('\n') + '\n', 'utf8')

  await ffmpeg([
    '-y',
    '-i', absMedia(opts.videoRel),
    '-vf', `ass=${absMedia(assRel)}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    absMedia(opts.outRel),
  ])
}

export async function copyMedia(fromRel: string, toRel: string): Promise<void> {
  await ensureDir(toRel)
  await copyFile(absMedia(fromRel), absMedia(toRel))
}
