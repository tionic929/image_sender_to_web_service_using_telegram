import { put } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // DEBUG: Log incoming request
  console.log('--- NEW WEBHOOK REQUEST ---');
  console.log('Method:', req.method);

  if (req.method !== 'POST') {
    console.error('ERROR: Non-POST request received');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { message } = req.body;
  
  if (!message) {
    console.warn('WARN: Request body empty or no message object');
    return res.status(200).send('OK'); 
  }

  // DEBUG: Log message type
  const isPhoto = !!message.photo;
  const isVideo = !!message.video;
  console.log(`Payload Type: ${isPhoto ? 'PHOTO' : isVideo ? 'VIDEO' : 'OTHER'}`);

  if (!isPhoto && !isVideo) {
    console.log('INFO: Message ignored (not photo/video)');
    return res.status(200).send('OK'); 
  }

  const fileId = isPhoto 
    ? message.photo[message.photo.length - 1].file_id 
    : message.video.file_id;

  console.log('File ID extracted:', fileId);

  try {
    // 1. Get File Path
    console.log('Fetching file path from Telegram...');
    const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('TELEGRAM API ERROR:', tgData);
      throw new Error(`Telegram getFile failed: ${tgData.description}`);
    }

    const filePath = tgData.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
    console.log('Telegram File URL constructed:', fileUrl);

    // 2. Download File Content
    console.log('Downloading file from Telegram servers...');
    const fileContent = await fetch(fileUrl);
    if (!fileContent.ok) throw new Error('Failed to fetch file content from Telegram');

    // 3. Format size
    const sizeInBytes = tgData.result.file_size;
    const formattedSize = sizeInBytes > 1024 * 1024 
        ? (sizeInBytes / (1024 * 1024)).toFixed(1) + ' MB' 
        : (sizeInBytes / 1024).toFixed(0) + ' KB';

    // 4. Upload to Vercel Blob
    console.log('Uploading to Vercel Blob...');
    const blob = await put(filePath, fileContent.body, {
      access: 'public',
      contentType: isPhoto ? 'image/jpeg' : 'video/mp4'
    });
    console.log('Blob Upload Successful:', blob.url);

    // 5. Save to Redis
    const mediaEntry = {
      url: blob.url,
      filename: filePath.split('/').pop(),
      type: isPhoto ? 'image' : 'video',
      date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      timestamp: Date.now(),
      size: formattedSize
    };

    console.log('Saving to Redis history...');
    await redis.lpush('media_history', JSON.stringify(mediaEntry));
    console.log('DONE: Webhook processed successfully');

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('CRITICAL WEBHOOK ERROR:', error.message);
    console.error('Stack Trace:', error.stack);
    
    // Always 200 so Telegram stops retrying the failing message
    return res.status(200).json({ error: error.message });
  }
}