import { getLiveness, getReadiness } from './health';
import { getEnvironment } from './environment';

describe('health state', () => {
  it('separates process liveness from dependency readiness', () => {
    const config = getEnvironment();
    expect(getLiveness(config)).toMatchObject({ status: 'healthy', mode: 'local' });

    const readiness = getReadiness(config);
    expect(readiness.statusCode).toBe(503);
    expect(readiness.body).toMatchObject({
      status: 'not-ready',
      dependencies: {
        mongodb: 'unavailable',
        redis: 'unavailable',
        codeRunner: 'not-configured',
      },
    });
  });
});
