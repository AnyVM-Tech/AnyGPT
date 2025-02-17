import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

let redis: Redis | null = null;

if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
  redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB),
  });

  redis.on('error', (err) => {
    console.error('Redis connection error:', err);
    redis = null; 
  });

  redis.on('connect', () => {
    console.log('Connected to Redis');
  });
}

export default redis;