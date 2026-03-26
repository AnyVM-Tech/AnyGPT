import crypto from 'node:crypto';
import os from 'node:os';
import redis from './db.js';

export type FleetLifecycleState = 'starting' | 'ready' | 'draining' | 'stopped';

export interface FleetInstanceSnapshot {
  instanceId: string;
  hostname: string;
  pid: number;
  port: number | null;
  nodeEnv: string | null;
  state: FleetLifecycleState;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  activeRequests?: number;
  queueSnapshots?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  drainingReason?: string | null;
}

type FleetStatusProvider = () => Partial<FleetInstanceSnapshot>;

const fleetHeartbeatHashKey = 'api:fleet:instances';
const fleetHeartbeatMs = Math.max(
  1000,
  Number(process.env.FLEET_HEARTBEAT_MS ?? 3000) || 3000
);
const fleetHeartbeatTtlMs = Math.max(
  fleetHeartbeatMs * 2,
  Number(process.env.FLEET_HEARTBEAT_TTL_MS ?? (fleetHeartbeatMs * 4)) || (fleetHeartbeatMs * 4)
);
const fleetEnabled = process.env.FLEET_COORDINATION_ENABLED !== '0';
const localInstanceId = (process.env.API_INSTANCE_ID || '').trim()
  || `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const localStartedAt = new Date().toISOString();

let currentState: FleetLifecycleState = 'starting';
let currentDrainingReason: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let statusProvider: FleetStatusProvider = () => ({});

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildLocalSnapshot(): FleetInstanceSnapshot {
  const providerData = statusProvider() || {};
  const portRaw = providerData.port ?? process.env.PORT;
  const parsedPort = Number(portRaw);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? Math.floor(parsedPort) : null;
  return {
    instanceId: localInstanceId,
    hostname: os.hostname(),
    pid: process.pid,
    port,
    nodeEnv: process.env.NODE_ENV || null,
    state: currentState,
    startedAt: localStartedAt,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + fleetHeartbeatTtlMs).toISOString(),
    ...(typeof providerData.activeRequests === 'number' ? { activeRequests: Math.max(0, Math.floor(providerData.activeRequests)) } : {}),
    ...(Array.isArray(providerData.queueSnapshots) ? { queueSnapshots: cloneSnapshot(providerData.queueSnapshots) } : {}),
    ...(providerData.metadata && typeof providerData.metadata === 'object' ? { metadata: cloneSnapshot(providerData.metadata) } : {}),
    ...(currentDrainingReason ? { drainingReason: currentDrainingReason } : {}),
  };
}

async function writeHeartbeat(): Promise<void> {
  if (!fleetEnabled || !redis || redis.status !== 'ready') return;
  try {
    await redis.hset(
      fleetHeartbeatHashKey,
      localInstanceId,
      JSON.stringify(buildLocalSnapshot())
    );
  } catch (error) {
    console.warn('[FleetCoordinator] Failed writing fleet heartbeat.', error);
  }
}

async function removeHeartbeat(): Promise<void> {
  if (!fleetEnabled || !redis || redis.status !== 'ready') return;
  try {
    await redis.hdel(fleetHeartbeatHashKey, localInstanceId);
  } catch (error) {
    console.warn('[FleetCoordinator] Failed removing fleet heartbeat.', error);
  }
}

function scheduleHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void writeHeartbeat();
  }, fleetHeartbeatMs);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

export function getLocalInstanceId(): string {
  return localInstanceId;
}

export function isFleetDraining(): boolean {
  return currentState === 'draining';
}

export function setFleetLifecycleState(
  state: FleetLifecycleState,
  options: { drainingReason?: string | null } = {}
): void {
  currentState = state;
  currentDrainingReason = state === 'draining'
    ? options.drainingReason ?? currentDrainingReason
    : null;
  void writeHeartbeat();
}

export function startFleetCoordinator(provider?: FleetStatusProvider): void {
  if (!fleetEnabled) return;
  if (provider) {
    statusProvider = provider;
  }
  scheduleHeartbeat();
  void writeHeartbeat();
}

export async function stopFleetCoordinator(removeRegistration: boolean = true): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  currentState = 'stopped';
  if (removeRegistration) {
    await removeHeartbeat();
    return;
  }
  await writeHeartbeat();
}

export async function getFleetInstances(): Promise<FleetInstanceSnapshot[]> {
  if (!fleetEnabled || !redis || redis.status !== 'ready') {
    return [buildLocalSnapshot()];
  }

  try {
    const entries = await redis.hgetall(fleetHeartbeatHashKey);
    const now = Date.now();
    const active: FleetInstanceSnapshot[] = [];
    const staleIds: string[] = [];

    for (const [instanceId, raw] of Object.entries(entries)) {
      try {
        const parsed = JSON.parse(raw) as FleetInstanceSnapshot;
        const expiresAt = Date.parse(parsed.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > now) {
          active.push(parsed);
        } else {
          staleIds.push(instanceId);
        }
      } catch {
        staleIds.push(instanceId);
      }
    }

    if (staleIds.length > 0) {
      void redis.hdel(fleetHeartbeatHashKey, ...staleIds).catch(() => undefined);
    }

    if (!active.some((entry) => entry.instanceId === localInstanceId)) {
      active.push(buildLocalSnapshot());
    }

    active.sort((left, right) => {
      if (left.state !== right.state) {
        return left.state.localeCompare(right.state);
      }
      return left.instanceId.localeCompare(right.instanceId);
    });
    return active;
  } catch (error) {
    console.warn('[FleetCoordinator] Failed reading fleet instances.', error);
    return [buildLocalSnapshot()];
  }
}
