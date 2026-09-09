import winston from 'winston';
import path from 'path';

const logLevel = process.env.LOG_LEVEL || 'info';
const logFile = process.env.LOG_FILE?.trim();
const consoleFormat = process.env.NODE_ENV === 'production'
  ? winston.format.json()
  : winston.format.combine(
    winston.format.colorize(),
    winston.format.simple(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const util = require('util');
      return `${timestamp} [${level}]: ${message} ${
        Object.keys(meta).length ? util.inspect(meta, { depth: null }) : ''
      }`;
    })
  );
const transports: winston.transport[] = [new winston.transports.Console({ format: consoleFormat })];

// File logging is opt-in. Container processes always retain structured
// stdout/stderr logs, including workers with a read-only root filesystem.
if (logFile) {
  const logDir = path.dirname(logFile);
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: logFile,
      maxsize: 5242880,
      maxFiles: 5,
    })
  );
}

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'kfive-ai-backend' },
  transports,
});

export { logger };
