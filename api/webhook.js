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

// NEW HELPER: Send or Edit Telegram Messages
async function notifyTelegram(method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram ${method} failed:`, err.message);
    return null;
  }
}

// Helper function to get file from Telegram
async function getTelegramFile(fileId, token) {
  const tgRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!tgRes.ok) throw new Error(`Telegram API request failed: ${tgRes.status}`);
  const tgData = await tgRes.json();
  if (!tgData.ok) throw new Error(`Telegram getFile failed: ${tgData.description || 'Unknown error'}`);
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
  if (!process.env.TELEGRAM_TOKEN) return res.status(500).json({ error: 'Server configuration error' });

  const { message } = req.body;
  if (!message) return res.status(200).send('OK');

  const isPhoto = !!message.photo;
  const isVideo = !!message.video;
  const chatId = message.chat?.id;
  const msgId = message.message_id;

  if (!isPhoto && !isVideo) return res.status(200).send('OK');

  // STEP 0: Initial Receipt Reply
  const initialReply = await notifyTelegram('sendMessage', {
    chat_id: chatId,
    text: "⏳ **Webhook Received:** Processing your media...",
    reply_to_message_id: msgId,
    parse_mode: 'Markdown'
  });
  const statusMessageId = initialReply?.result?.message_id;

  const fileId = isPhoto ? message.photo[message.photo.length - 1].file_id : message.video.file_id;
  const userName = message.from?.username || message.from?.first_name || 'Unknown';

  try {
    // Step 1: Metadata
    const fileData = await getTelegramFile(fileId, process.env.TELEGRAM_TOKEN);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileData.file_path}`;

    if (statusMessageId) {
      await notifyTelegram('editMessageText', {
        chat_id: chatId,
        message_id: statusMessageId,
        text: `⏳ **Step 1/3:** Downloading ${formatFileSize(fileData.file_size)} from Telegram...`,
        parse_mode: 'Markdown'
      });
    }

    // Step 2: Download & Upload
    const fileContent = await downloadFileContent(fileUrl);
    
    if (statusMessageId) {
      await notifyTelegram('editMessageText', {
        chat_id: chatId,
        message_id: statusMessageId,
        text: `⏳ **Step 2/3:** Uploading to Vercel Blob...`,
        parse_mode: 'Markdown'
      });
    }

    const uniqueName = `${Date.now()}-${fileData.file_path.split('/').pop()}`;
    const blob = await put(uniqueName, fileContent.body, {
      access: 'public',
      contentType: isPhoto ? 'image/jpeg' : 'video/mp4'
    });

    // Step 3: Redis
    if (statusMessageId) {
      await notifyTelegram('editMessageText', {
        chat_id: chatId,
        message_id: statusMessageId,
        text: `⏳ **Step 3/3:** Saving to Media History...`,
        parse_mode: 'Markdown'
      });
    }

    const mediaEntry = {
      url: blob.url,
      filename: uniqueName,
      type: isPhoto ? 'image' : 'video',
      timestamp: Date.now(),
      size: formatFileSize(fileData.file_size),
      uploadedBy: userName
    };

    await redis.lpush('media_history', JSON.stringify(mediaEntry));
    const processingTime = Date.now() - startTime;

    // STEP 4: Success Finalization
    if (statusMessageId) {
      await notifyTelegram('editMessageText', {
        chat_id: chatId,
        message_id: statusMessageId,
        text: `✅ **Success!**\n\n**User:** ${userName}\n**Size:** ${formatFileSize(fileData.file_size)}\n**Time:** ${processingTime}ms\n\n🔗 [View Media](${blob.url})`,
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
    }

    return res.status(200).json({ success: true, url: blob.url });

  } catch (error) {
    console.error('Webhook Error:', error.message);
    
    if (chatId) {
      const errorMsg = `❌ **Webhook Error**\n${error.message}`;
      if (statusMessageId) {
        await notifyTelegram('editMessageText', {
          chat_id: chatId,
          message_id: statusMessageId,
          text: errorMsg,
          parse_mode: 'Markdown'
        });
      } else {
        await notifyTelegram('sendMessage', { chat_id: chatId, text: errorMsg, parse_mode: 'Markdown' });
      }
    }
    
    return res.status(200).json({ error: error.message, success: false });
  }
}