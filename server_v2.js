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

    // 2. Convert each image to a clip one at a time (low memory - ultrafast preset, low res encode)
    console.log('Converting images to clips...');
    const clipPaths = [];
    for (let i = 0; i < 4; i++) {
      const clipPath = path.join(tmpDir, `clip${i}.mp4`);
      await new Promise((resolve, reject) => {
        ffmpeg(imagePaths[i])
          .inputOptions(['-loop 1', '-t 10'])
          .outputOptions([
            '-vf scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2',
            '-c:v libx264',
            '-preset ultrafast',
            '-crf 28',
            '-pix_fmt yuv420p',
            '-r 25',
            '-an'
          ])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      clipPaths.push(clipPath);
      fs.unlinkSync(imagePaths[i]); // free image immediately after clip is made
      console.log(`Clip ${i} done`);
    }

    // 3. Concatenate clips using concat demuxer (very low memory)
    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));

    const outputPath = path.join(tmpDir, 'output.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions([
          '-c copy',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.listen(PORT, () => {
  console.log(`Estabin Video Renderer running on port ${PORT}`);
});
