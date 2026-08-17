import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { Configuration } from '../../config/configuration';
import { ApiKeyGuard } from './api-key.guard';

const VALID_KEY = 'pk_test_valid_key_0123456789';
const ROTATED_KEY = 'pk_test_rotated_key_9876543210';

function createContext(headers: Record<string, string | string[]> = {}): ExecutionContext {
  const request = { headers, method: 'GET', originalUrl: '/api/v1/products', ip: '127.0.0.1' };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

function createGuard(apiKeys: string[] = [VALID_KEY, ROTATED_KEY], isPublic = false): ApiKeyGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
  const configService = {
    get: jest.fn().mockReturnValue({ apiKeyHeader: 'x-api-key', apiKeys }),
  } as unknown as ConfigService<Configuration, true>;

  return new ApiKeyGuard(reflector, configService);
}

describe('ApiKeyGuard', () => {
  it('accepts a request carrying the configured key', () => {
    expect(createGuard().canActivate(createContext({ 'x-api-key': VALID_KEY }))).toBe(true);
  });

  it('accepts any key from the rotation list', () => {
    expect(createGuard().canActivate(createContext({ 'x-api-key': ROTATED_KEY }))).toBe(true);
  });

  it('rejects a request without the header', () => {
    expect(() => createGuard().canActivate(createContext())).toThrow(UnauthorizedException);
  });

  it('rejects an empty header value', () => {
    expect(() => createGuard().canActivate(createContext({ 'x-api-key': '   ' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong key', () => {
    expect(() => createGuard().canActivate(createContext({ 'x-api-key': 'nope' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a key that is only a prefix of a valid one', () => {
    expect(() =>
      createGuard().canActivate(createContext({ 'x-api-key': VALID_KEY.slice(0, -1) })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects every request when no keys are configured', () => {
    expect(() => createGuard([]).canActivate(createContext({ 'x-api-key': VALID_KEY }))).toThrow(
      UnauthorizedException,
    );
  });

  it('lets @Public() routes through untouched', () => {
    expect(createGuard([VALID_KEY], true).canActivate(createContext())).toBe(true);
  });
});
