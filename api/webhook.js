import { put } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // 1. Only allow POST requests from Telegram
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { message } = req.body;
  
  // Ignore messages without photo or video
  if (!message || (!message.photo && !message.video)) {
    return res.status(200).send('OK'); 
  }

  // Get the highest quality file ID
  const fileId = message.photo 
    ? message.photo[message.photo.length - 1].file_id 
    : message.video.file_id;

  try {
    // 2. Fetch File Path from Telegram
    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const tgData = await tgRes.json();

    if (!tgData.ok) throw new Error('Telegram getFile failed');

    const filePath = tgData.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;

    // 3. Fetch actual file content
    const fileContent = await fetch(fileUrl);
    if (!fileContent.ok) throw new Error('Failed to fetch file from Telegram servers');

    // 4. Calculate size for your frontend feature
    const sizeInBytes = tgData.result.file_size;
    const formattedSize = sizeInBytes > 1024 * 1024 
        ? (sizeInBytes / (1024 * 1024)).toFixed(1) + ' MB' 
        : (sizeInBytes / 1024).toFixed(0) + ' KB';

    // 5. Upload to Vercel Blob
    const blob = await put(filePath, fileContent.body, {
      access: 'public',
      contentType: message.photo ? 'image/jpeg' : 'video/mp4'
    });

    // 6. Save Metadata to Upstash Redis
    const mediaEntry = {
      url: blob.url,
      filename: filePath.split('/').pop(),
      type: message.photo ? 'image' : 'video',
      date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      timestamp: Date.now(),
      size: formattedSize
    };

    await redis.lpush('media_history', JSON.stringify(mediaEntry));

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook Error:', error.message);
    // Always return 200 to Telegram so it doesn't keep retrying and blocking your bot
    return res.status(200).json({ error: 'Processing failed but acknowledged' });
  }
}