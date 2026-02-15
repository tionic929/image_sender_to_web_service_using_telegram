import { del } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { filename, url } = req.body;
  const auth = req.headers.authorization;

  // Validate required fields
  if (!url) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Validate authentication
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    console.warn('Unauthorized delete attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log(`Deleting media: ${filename || url}`);

    // 1. Delete from Vercel Blob
    try {
      await del(url);
      console.log('Blob deleted successfully');
    } catch (blobError) {
      console.error('Blob deletion error:', blobError.message);
      // Continue even if blob deletion fails (might already be deleted)
    }

    // 2. Remove from Redis list
    const history = await redis.lrange('media_history', 0, -1);
    
    if (!history || history.length === 0) {
      console.warn('No media history found in Redis');
      return res.status(200).json({ success: true, message: 'Already deleted' });
    }

    const updatedHistory = history.filter(item => {
      try {
        const parsed = typeof item === 'string' ? JSON.parse(item) : item;
        return parsed.url !== url;
      } catch (parseError) {
        console.error('Error parsing Redis item:', parseError.message);
        return false; // Remove corrupted entries
      }
    });

    const removedCount = history.length - updatedHistory.length;
    console.log(`Removed ${removedCount} item(s) from history`);

    // Replace the list with updated data
    await redis.del('media_history');
    
    if (updatedHistory.length > 0) {
      // Redis LPUSH expects individual items, so we need to reverse to maintain order
      const reversedHistory = [...updatedHistory].reverse();
      await redis.lpush('media_history', ...reversedHistory);
    }

    return res.status(200).json({ 
      success: true, 
      removed: removedCount,
      remaining: updatedHistory.length 
    });

  } catch (error) {
    console.error('Delete handler error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}