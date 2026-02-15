import { put } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { message } = req.body;
  if (!message) return res.status(200).send('OK');

  const fileId = message.photo ? message.photo[message.photo.length - 1].file_id : message.video?.file_id;
  if (!fileId) return res.status(200).send('OK');

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const { result } = await tgRes.json();

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${result.file_path}`;
    const fileContent = await fetch(fileUrl);
    
    // Get actual size for the frontend feature
    const sizeInBytes = result.file_size;
    const formattedSize = sizeInBytes > 1024 * 1024 
        ? (sizeInBytes / (1024 * 1024)).toFixed(1) + ' MB' 
        : (sizeInBytes / 1024).toFixed(0) + ' KB';

    const blob = await put(result.file_path, fileContent.body, { access: 'public' });

    const mediaEntry = {
      url: blob.url,
      filename: result.file_path.split('/').pop(),
      type: message.photo ? 'image' : 'video',
      date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      timestamp: Date.now(),
      size: formattedSize // Feature restored: shows actual size
    };

    await redis.lpush('media_history', JSON.stringify(mediaEntry));
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}