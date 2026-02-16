import { put } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Helper function to format file size
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 KB';
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// NEW: Helper to send or update messages in Telegram
async function sendTelegramAction(method, body) {
  return fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Helper function to get file from Telegram
async function getTelegramFile(fileId, token) {
  const tgRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!tgRes.ok) throw new Error(`Telegram API failed: ${tgRes.status}`);
  const tgData = await tgRes.json();
  if (!tgData.ok) throw new Error(`getFile failed: ${tgData.description}`);
  return tgData.result;
}

// Helper function to download file content
async function downloadFileContent(fileUrl, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(fileUrl, { timeout: 30000 });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { message } = req.body;
  if (!message) return res.status(200).send('OK');

  const isPhoto = !!message.photo;
  const isVideo = !!message.video;
  const chatId = message.chat?.id;

  if (!isPhoto && !isVideo) return res.status(200).send('OK');

  // Initial Status Message
  let statusMsgId = null;
  try {
    const statusRes = await sendTelegramAction('sendMessage', {
      chat_id: chatId,
      text: "⏳ **Processing your media...**\nConnecting to cloud storage.",
      parse_mode: 'Markdown',
      reply_to_message_id: message.message_id
    });
    const statusData = await statusRes.json();
    statusMsgId = statusData.result?.message_id;
  } catch (e) { console.error("Could not send initial status"); }

  const fileId = isPhoto ? message.photo[message.photo.length - 1].file_id : message.video.file_id;
  const userName = message.from?.username || message.from?.first_name || 'Unknown';

  try {
    // Step 1: Get Metadata
    const fileData = await getTelegramFile(fileId, process.env.TELEGRAM_TOKEN);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.file_path}`;

    // Update Status: Downloading
    if (statusMsgId) {
      await sendTelegramAction('editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: `⏳ **Step 2/4: Downloading...**\nSize: ${formatFileSize(fileData.file_size)}`,
        parse_mode: 'Markdown'
      });
    }

    // Step 2: Download
    const fileContent = await downloadFileContent(fileUrl);

    // Update Status: Uploading
    if (statusMsgId) {
      await sendTelegramAction('editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: `⏳ **Step 3/4: Uploading to Vercel Blob...**`,
        parse_mode: 'Markdown'
      });
    }

    // Step 3: Upload to Vercel
    const uniqueName = `${Date.now()}-${fileData.file_path.split('/').pop()}`;
    const blob = await put(uniqueName, fileContent.body, {
      access: 'public',
      contentType: isPhoto ? 'image/jpeg' : 'video/mp4'
    });

    // Step 4: Save to Redis
    const mediaEntry = {
      url: blob.url,
      filename: uniqueName,
      type: isPhoto ? 'image' : 'video',
      timestamp: Date.now(),
      size: formatFileSize(fileData.file_size),
      uploadedBy: userName
    };
    await redis.lpush('media_history', JSON.stringify(mediaEntry));

    // Final Success Reply
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
    if (statusMsgId) {
      await sendTelegramAction('editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: `✅ **Upload Complete!**\n\n**File:** \`${uniqueName}\`\n**Size:** ${formatFileSize(fileData.file_size)}\n**Time:** ${processingTime}s\n\n🔗 [View Media](${blob.url})`,
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
    }

    return res.status(200).json({ success: true, url: blob.url });

  } catch (error) {
    console.error('Webhook Error:', error.message);
    
    // Error Notification to User
    if (chatId) {
      const errorText = `❌ **Upload Failed**\n${error.message}`;
      if (statusMsgId) {
        await sendTelegramAction('editMessageText', {
          chat_id: chatId,
          message_id: statusMsgId,
          text: errorText,
          parse_mode: 'Markdown'
        });
      } else {
        await sendTelegramAction('sendMessage', { chat_id: chatId, text: errorText, parse_mode: 'Markdown' });
      }
    }
    
    return res.status(200).json({ success: false, error: error.message });
  }
}