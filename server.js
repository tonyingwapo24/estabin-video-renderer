const express = require('express');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'Estabin Video Renderer is running' });
});

app.post('/render', async (req, res) => {
  const { imageUrls, partNumber, title, fileName } = req.body;

  if (!imageUrls || imageUrls.length < 4) {
    return res.status(400).json({ error: 'Need exactly 4 image URLs' });
  }

  const tmpDir = `/tmp/render_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Download all 4 images
    console.log('Downloading images...');
    const imagePaths = [];
    for (let i = 0; i < 4; i++) {
      const imgPath = path.join(tmpDir, `img${i}.jpg`);
      const response = await fetch(imageUrls[i]);
      if (!response.ok) throw new Error(`Failed to download image ${i}: ${response.status}`);
      const buffer = await response.buffer();
      fs.writeFileSync(imgPath, buffer);
      imagePaths.push(imgPath);
      console.log(`Downloaded image ${i}`);
    }

    // 2. Create a text file listing images for FFmpeg concat
    const outputPath = path.join(tmpDir, 'output.mp4');

    // 3. Build video with FFmpeg - each image shown for 10 seconds, fade transitions
    await new Promise((resolve, reject) => {
      const inputArgs = [];
      imagePaths.forEach(p => inputArgs.push('-loop', '1', '-t', '10', '-i', p));

      ffmpeg()
        .input(imagePaths[0]).inputOptions(['-loop 1', '-t 10'])
        .input(imagePaths[1]).inputOptions(['-loop 1', '-t 10'])
        .input(imagePaths[2]).inputOptions(['-loop 1', '-t 10'])
        .input(imagePaths[3]).inputOptions(['-loop 1', '-t 10'])
        .complexFilter([
          '[0:v]scale=576:1024,setsar=1,fade=t=out:st=9:d=1[v0]',
          '[1:v]scale=576:1024,setsar=1,fade=t=in:st=0:d=1,fade=t=out:st=9:d=1[v1]',
          '[2:v]scale=576:1024,setsar=1,fade=t=in:st=0:d=1,fade=t=out:st=9:d=1[v2]',
          '[3:v]scale=576:1024,setsar=1,fade=t=in:st=0:d=1[v3]',
          '[v0][v1][v2][v3]concat=n=4:v=1:a=0[outv]'
        ], 'outv')
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-r 25',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', cmd => console.log('FFmpeg started:', cmd))
        .on('progress', p => console.log('Progress:', p.percent + '%'))
        .on('end', () => { console.log('FFmpeg done'); resolve(); })
        .on('error', (err) => { console.error('FFmpeg error:', err); reject(err); })
        .run();
    });

    // 4. Upload to Supabase
    console.log('Uploading to Supabase...');
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const videoBuffer = fs.readFileSync(outputPath);
    const videoFileName = fileName || `video_part${partNumber}_${Date.now()}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('estabin-audio')
      .upload(videoFileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

    if (uploadError) throw new Error('Supabase upload failed: ' + uploadError.message);

    const { data: { publicUrl } } = supabase.storage
      .from('estabin-audio')
      .getPublicUrl(videoFileName);

    console.log('Done! Video URL:', publicUrl);
    res.json({ success: true, videoUrl: publicUrl });

  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.listen(PORT, () => {
  console.log(`Estabin Video Renderer running on port ${PORT}`);
});
