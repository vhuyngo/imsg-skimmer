// Contact-name lookup built from the backup's AddressBook.sqlitedb.
import { openCachedDatabase } from './backup.js';

const PHONE = 3;
const EMAIL = 4;
const SUFFIX_DIGITS = 9;

export const digitsOf = (value) => String(value ?? '').replace(/\D+/g, '');
const isEmail = (value) => String(value ?? '').includes('@');

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

export function displayName({ First, Last, Middle, Organization, Nickname }) {
  const full = [First, Middle, Last].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).join(' ');
  return full || (typeof Organization === 'string' && Organization.trim()) || (typeof Nickname === 'string' && Nickname.trim()) || null;
}

export class Contacts {
  constructor() {
    this.exact = new Map();
    this.suffix = new Map();
    this.emails = new Map();
    this.people = 0;
  }

  static empty() {
    return new Contacts();
  }

  static load(file, opts) {
    const contacts = new Contacts();
    const db = openCachedDatabase(file, opts);
    try {
      const person = columns(db, 'ABPerson');
      const multi = columns(db, 'ABMultiValue');
      if (!person.has('ROWID') || !multi.has('record_id') || !multi.has('value')) return contacts;
      const pick = (c) => (person.has(c) ? `p.${c}` : 'NULL');
      const rows = db
        .prepare(
          `SELECT p.ROWID AS id, ${pick('First')} AS First, ${pick('Last')} AS Last, ${pick('Middle')} AS Middle,
                  ${pick('Organization')} AS Organization, ${pick('Nickname')} AS Nickname,
                  mv.property AS property, mv.value AS value
             FROM ABPerson p JOIN ABMultiValue mv ON mv.record_id = p.ROWID
            WHERE mv.property IN (${PHONE}, ${EMAIL}) AND mv.value IS NOT NULL`,
        )
        .all();
      const ids = new Set();
      for (const row of rows) {
        const name = displayName(row);
        if (!name) continue;
        ids.add(row.id);
        contacts.add(String(row.value), name, row.property === EMAIL);
      }
      contacts.people = ids.size;
    } finally {
      db.close();
    }
    return contacts;
  }

  add(value, name, email = isEmail(value)) {
    if (email) {
      this.emails.set(value.trim().toLowerCase(), name);
      return;
    }
    const digits = digitsOf(value);
    if (!digits) return;
    this.exact.set(digits, name);
    if (digits.length >= SUFFIX_DIGITS) {
      const key = digits.slice(-SUFFIX_DIGITS);
      const prior = this.suffix.get(key);
      // An ambiguous suffix (two different people) is dropped rather than guessed.
      this.suffix.set(key, prior === undefined || prior === name ? name : null);
    }
  }

  lookup(handle) {
    if (!handle) return null;
    if (isEmail(handle)) return this.emails.get(handle.trim().toLowerCase()) ?? null;
    const digits = digitsOf(handle);
    if (!digits) return null;
    if (this.exact.has(digits)) return this.exact.get(digits);
    if (digits.length >= SUFFIX_DIGITS) return this.suffix.get(digits.slice(-SUFFIX_DIGITS)) ?? null;
    return null;
  }
}
