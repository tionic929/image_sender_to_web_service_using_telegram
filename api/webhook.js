import { put } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Helper function to format file size
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 KB';
  
  if (bytes > 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  } else if (bytes > 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else if (bytes > 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

// Helper function to get file from Telegram
async function getTelegramFile(fileId, token) {
  const tgRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
    { timeout: 10000 }
  );

  if (!tgRes.ok) {
    throw new Error(`Telegram API request failed: ${tgRes.status}`);
  }

  const tgData = await tgRes.json();

  if (!tgData.ok) {
    throw new Error(`Telegram getFile failed: ${tgData.description || 'Unknown error'}`);
  }

  return tgData.result;
}

// Helper function to download file content
async function downloadFileContent(fileUrl, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Download attempt ${attempt}/${maxRetries}...`);
      
      const response = await fetch(fileUrl, { 
        timeout: 30000,
        headers: {
          'User-Agent': 'MediaCloudOS/2.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      console.error(`Download attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Failed to download after ${maxRetries} attempts: ${lastError.message}`);
}

export default async function handler(req, res) {
  const startTime = Date.now();
  
  console.log('========================================');
  console.log('NEW WEBHOOK REQUEST');
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('========================================');

  // Only allow POST requests
  if (req.method !== 'POST') {
    console.error('ERROR: Non-POST request received');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Validate environment variables
  if (!process.env.TELEGRAM_TOKEN) {
    console.error('CRITICAL: TELEGRAM_TOKEN not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { message } = req.body;
  
  // Handle empty or invalid payload
  if (!message) {
    console.warn('WARN: Request body empty or no message object');
    return res.status(200).send('OK'); 
  }

  // Check for photo or video
  const isPhoto = !!message.photo;
  const isVideo = !!message.video;
  const isDocument = !!message.document;

  console.log(`Message Type: ${isPhoto ? 'PHOTO' : isVideo ? 'VIDEO' : isDocument ? 'DOCUMENT' : 'OTHER'}`);

  // Only process photos and videos
  if (!isPhoto && !isVideo) {
    console.log('INFO: Message ignored (not photo/video)');
    return res.status(200).send('OK'); 
  }

  // Extract file information
  const fileId = isPhoto 
    ? message.photo[message.photo.length - 1].file_id 
    : message.video.file_id;

  const chatId = message.chat?.id;
  const userName = message.from?.username || message.from?.first_name || 'Unknown';

  console.log('File ID:', fileId);
  console.log('From:', userName);
  console.log('Chat ID:', chatId);

  try {
    // Step 1: Get file metadata from Telegram
    console.log('Step 1: Fetching file metadata from Telegram...');
    const fileData = await getTelegramFile(fileId, process.env.TELEGRAM_TOKEN);
    
    const filePath = fileData.file_path;
    const fileSize = fileData.file_size;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
    
    console.log('File Path:', filePath);
    console.log('File Size:', formatFileSize(fileSize));

    // Step 2: Download file content from Telegram
    console.log('Step 2: Downloading file from Telegram...');
    const fileContent = await downloadFileContent(fileUrl);
    
    // Step 3: Generate unique filename
    const timestamp = Date.now();
    const originalName = filePath.split('/').pop();
    const extension = originalName.split('.').pop();
    const uniqueName = `${timestamp}-${originalName}`;

    // Step 4: Upload to Vercel Blob
    console.log('Step 3: Uploading to Vercel Blob...');
    const contentType = isPhoto ? 'image/jpeg' : 'video/mp4';
    
    const blob = await put(uniqueName, fileContent.body, {
      access: 'public',
      contentType,
      addRandomSuffix: false
    });

    console.log('✓ Blob URL:', blob.url);

    // Step 5: Save metadata to Redis
    console.log('Step 4: Saving to Redis...');
    
    const mediaEntry = {
      url: blob.url,
      filename: uniqueName,
      originalFilename: originalName,
      type: isPhoto ? 'image' : 'video',
      date: new Date().toLocaleDateString('en-US', { 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric' 
      }),
      timestamp: timestamp,
      size: formatFileSize(fileSize),
      uploadedBy: userName,
      chatId: chatId
    };

    await redis.lpush('media_history', JSON.stringify(mediaEntry));
    
    const processingTime = Date.now() - startTime;
    console.log('========================================');
    console.log(`✓ SUCCESS - Processed in ${processingTime}ms`);
    console.log('========================================');

    // Optional: Send confirmation message back to Telegram
    if (process.env.SEND_CONFIRMATIONS === 'true' && chatId) {
      try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `✓ ${isPhoto ? 'Photo' : 'Video'} uploaded successfully!\nSize: ${formatFileSize(fileSize)}`,
            reply_to_message_id: message.message_id
          })
        });
      } catch (confirmError) {
        console.warn('Could not send confirmation message:', confirmError.message);
      }
    }

    return res.status(200).json({ 
      success: true,
      url: blob.url,
      size: formatFileSize(fileSize),
      processingTime: `${processingTime}ms`
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    console.error('========================================');
    console.error('❌ CRITICAL WEBHOOK ERROR');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error(`Failed after ${processingTime}ms`);
    console.error('========================================');

    // Send error notification to Telegram (if chat ID available)
    if (chatId && process.env.TELEGRAM_TOKEN) {
      try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `❌ Upload failed: ${error.message}`,
            reply_to_message_id: message.message_id
          })
        });
      } catch (notifyError) {
        console.error('Could not send error notification:', notifyError.message);
      }
    }
    
    // Always return 200 so Telegram doesn't retry
    // (retries won't help with most errors and would waste resources)
    return res.status(200).json({ 
      error: error.message,
      success: false
    });
  }
}