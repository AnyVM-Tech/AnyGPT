export {};

process.env.CLUSTER_WORKERS = process.env.CLUSTER_WORKERS || '0';
await import('./server.js');
