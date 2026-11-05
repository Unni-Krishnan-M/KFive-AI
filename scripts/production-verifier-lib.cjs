'use strict';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSensitiveRedactor(initialValues = []) {
  const sensitiveValues = new Set();
  const add = (values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0) sensitiveValues.add(value);
    }
  };
  add(initialValues);

  const redact = (input) => {
    let output = String(input ?? '');
    for (const value of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
      output = output.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]');
    }
    output = output
      .replace(/(FIXTURE_BEARER_TOKEN=)[^\s]+/g, '$1[REDACTED]')
      .replace(/(--password(?:=|\s+))[^\s]+/g, '$1[REDACTED]')
      .replace(/(--env-file(?:=|\s+))[^\s]+/g, '$1[REDACTED]');
    return output;
  };
  redact.add = add;
  return redact;
}

module.exports = { createSensitiveRedactor };
