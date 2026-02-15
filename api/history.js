import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    // Fetch the list from Redis
    const history = await redis.lrange('media_history', 0, -1);
    
    // Redis returns strings, so we parse them back to objects
    const parsedHistory = history.map(item => 
      typeof item === 'string' ? JSON.parse(item) : item
    );

    return res.status(200).json(parsedHistory);
  } catch (error) {
    return res.status(500).json([]);
  }
}