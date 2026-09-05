import { badRequest } from './errors.js';

export function asString(value, field, { min = 1, max = 500, trim = true } = {}) {
  if (typeof value !== 'string') throw badRequest(`"${field}" must be text.`);
  const text = trim ? value.trim() : value;
  if (text.length < min) throw badRequest(`"${field}" must be at least ${min} character(s).`);
  if (text.length > max) throw badRequest(`"${field}" must be at most ${max} characters.`);
  return text;
}

export function asOptionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === '') return '';
  return asString(value, field, { ...options, min: 0 });
}

export function asInteger(value, field, { min, max } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isInteger(number)) {
    throw badRequest(`"${field}" must be a whole number.`);
  }
  if (min !== undefined && number < min) throw badRequest(`"${field}" must be at least ${min}.`);
  if (max !== undefined && number > max) throw badRequest(`"${field}" must be at most ${max}.`);
  return number;
}

export function asBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`"${field}" must be true or false.`);
}

export function asArray(value, field, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) throw badRequest(`"${field}" must be a list.`);
  if (value.length < min) throw badRequest(`"${field}" needs at least ${min} item(s).`);
  if (value.length > max) throw badRequest(`"${field}" allows at most ${max} item(s).`);
  return value;
}
