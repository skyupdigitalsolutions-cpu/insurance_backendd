import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { redis } from '../src/lib/redis.js';
import { DEMO, PASSWORD, V1, api, closeConnections, resetDatabase } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

describe('Health and docs', () => {
  it('reports liveness and readiness (MongoDB + Redis)', async () => {
    expect((await api().get('/health')).body.status).toBe('ok');
    const ready = await api().get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', mongo: true, redis: true });
  });

  it('serves the OpenAPI document generated from the routes', async () => {
    const res = await api().get('/api/docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining([
      '/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/users/{id}', '/api/v1/admin/registrations/{id}/approve',
    ]));
    expect(res.body.paths['/api/v1/users'].get.description).toContain('user:manage');
  });
});

describe('Safety', () => {
  it('blocks query-operator injection in the login body', async () => {
    const res = await api().post(`${V1}/auth/login`).send({ identifier: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('answers broken JSON with 400, not 500', async () => {
    const res = await api().post(`${V1}/auth/login`).set('Content-Type', 'application/json').send('{"identifier": ');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Request body is not valid JSON');
  });

  it('returns JSON 404 for unknown routes and echoes the request id', async () => {
    const res = await api().get(`${V1}/nope`).set('X-Request-Id', 'test-request-0001');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('test-request-0001');
    expect(res.body.requestId).toBe('test-request-0001');
  });

  it('sets security headers', async () => {
    const res = await api().get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rate-limits repeated login attempts (counted in Redis)', async () => {
    await redis.flushdb();
    const limited = createApp({ rateLimit: true });
    const attempt = () => request(limited).post(`${V1}/auth/login`).send({ identifier: DEMO.advisor.email, password: 'wrong-pass1' });
    for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe('Too many attempts. Please wait and try again.');
    // a different account from the same IP is not blocked
    const other = await request(limited).post(`${V1}/auth/login`).send({ identifier: DEMO.staff.email, password: PASSWORD });
    expect(other.status).toBe(200);
    await redis.flushdb();
  });
});
