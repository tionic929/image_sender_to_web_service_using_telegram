import { del } from '@vercel/blob';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const { filename, url } = req.body;
  const auth = req.headers.authorization;

  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).send('Unauthorized');
  }

  try {
    // 1. Delete from Vercel Blob
    await del(url);

    // 2. Remove from Redis list
    const history = await redis.lrange('media_history', 0, -1);
    const updatedHistory = history.filter(item => {
        const parsed = typeof item === 'string' ? JSON.parse(item) : item;
        return parsed.url !== url;
    });

    // Replace the list with updated data
    await redis.del('media_history');
    if (updatedHistory.length > 0) {
        await redis.lpush('media_history', ...updatedHistory.reverse());
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}