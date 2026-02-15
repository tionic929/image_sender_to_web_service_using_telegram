import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    console.log('Fetching media statistics...');

    // Get total count
    const total = await redis.llen('media_history');

    // Optionally get more detailed stats
    let totalSize = 0;
    let imageCount = 0;
    let videoCount = 0;

    if (total > 0) {
      try {
        const history = await redis.lrange('media_history', 0, -1);
        
        history.forEach(item => {
          try {
            const parsed = typeof item === 'string' ? JSON.parse(item) : item;
            
            // Count by type
            if (parsed.type === 'image') imageCount++;
            if (parsed.type === 'video') videoCount++;
            
            // Calculate total size (if size is stored)
            if (parsed.size) {
              const sizeMatch = parsed.size.match(/([\d.]+)\s*(KB|MB|GB)/i);
              if (sizeMatch) {
                const value = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                
                if (unit === 'KB') totalSize += value / 1024;
                else if (unit === 'MB') totalSize += value;
                else if (unit === 'GB') totalSize += value * 1024;
              }
            }
          } catch (parseError) {
            console.error('Error parsing item for stats:', parseError.message);
          }
        });
      } catch (detailError) {
        console.warn('Could not fetch detailed stats:', detailError.message);
      }
    }

    // Format total size
    const formattedSize = totalSize > 1024 
      ? `${(totalSize / 1024).toFixed(2)} GB`
      : `${totalSize.toFixed(2)} MB`;

    const stats = {
      totalFiles: total,
      totalSize: formattedSize,
      images: imageCount,
      videos: videoCount,
      lastUpdated: new Date().toISOString()
    };

    console.log('Stats:', stats);

    // Cache stats for 1 minute
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    
    return res.status(200).json(stats);

  } catch (error) {
    console.error('Stats handler error:', error.message);
    console.error('Stack:', error.stack);
    
    // Return minimal stats on error
    return res.status(200).json({ 
      totalFiles: 0, 
      totalSize: '0 MB',
      images: 0,
      videos: 0
    });
  }
}