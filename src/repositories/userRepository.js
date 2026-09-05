import { query, queryOne, transaction } from '../db/index.js';

/**
 * Accounts.
 *
 * Every lookup that takes an email also takes a university: email is unique
 * per tenant, not globally, so `findByEmail(email)` alone would be ambiguous
 * and is deliberately not offered.
 *
 * Where SegueQuiz read a record, changed it in JavaScript and wrote it back,
 * this writes the change as a statement. Two people signing in at once cannot
 * then lose one another's update.
 */

const fromRow = (row) =>
  row && {
    id: row.id,
    universityId: row.university_id,
    name: row.name,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpConfirmed: row.totp_confirmed,
    recoveryCodes: row.recovery_codes ?? [],
    tokenVersion: row.token_version,
    platformRole: row.platform_role,
    emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
  };

const COLUMNS = `id, university_id, name, email, password_salt, password_hash, totp_secret,
                 totp_confirmed, recovery_codes, token_version, platform_role,
                 email_verified_at, created_at, last_sign_in_at`;

export const userRepository = {
  /** Lower-cased and trimmed. The column is citext, so this is belt and braces. */
  normaliseEmail(email) {
    return String(email ?? '').trim().toLowerCase();
  },

  /** The domain half of an address, which is what maps to a university. */
  domainOf(email) {
    const at = this.normaliseEmail(email).lastIndexOf('@');
    return at === -1 ? '' : this.normaliseEmail(email).slice(at + 1);
  },

  async findById(id) {
    return fromRow(await queryOne(`select ${COLUMNS} from users where id = $1`, [id]));
  },

  async findByEmail(universityId, email) {
    return fromRow(
      await queryOne(`select ${COLUMNS} from users where university_id = $1 and email = $2`, [
        universityId,
        this.normaliseEmail(email),
      ]),
    );
  },

  async countForUniversity(universityId) {
    const row = await queryOne('select count(*)::int as n from users where university_id = $1', [
      universityId,
    ]);
    return row?.n ?? 0;
  },

  async insert(user) {
    return fromRow(
      await queryOne(
        `insert into users (university_id, name, email, password_salt, password_hash,
                            totp_secret, totp_confirmed, recovery_codes, platform_role)
         values ($1, $2, $3, $4, $5, $6, false, '[]'::jsonb, $7)
         returning ${COLUMNS}`,
        [
          user.universityId,
          user.name,
          this.normaliseEmail(user.email),
          user.passwordSalt,
          user.passwordHash,
          user.totpSecret,
          user.platformRole ?? 'student',
        ],
      ),
    );
  },

  async markSignedIn(id) {
    return fromRow(
      await queryOne(
        `update users set last_sign_in_at = now() where id = $1 returning ${COLUMNS}`,
        [id],
      ),
    );
  },

  /** Finishing enrolment: the authenticator is proven, so store the codes. */
  async confirmTwoFactor(id, recoveryCodes) {
    return fromRow(
      await queryOne(
        `update users
            set totp_confirmed = true,
                recovery_codes = $2::jsonb,
                last_sign_in_at = now()
          where id = $1
        returning ${COLUMNS}`,
        [id, JSON.stringify(recoveryCodes)],
      ),
    );
  },

  /**
   * Spends one recovery code, under a row lock so the same code cannot be
   * redeemed twice by two requests arriving together. Returns null when the
   * code is not there or was already used.
   */
  async useRecoveryCode(id, hash) {
    return transaction(async (tx) => {
      const { rows } = await tx.query(
        'select recovery_codes from users where id = $1 for update',
        [id],
      );
      if (rows.length === 0) return null;

      const codes = rows[0].recovery_codes ?? [];
      const match = codes.find((entry) => entry.usedAt === null && entry.hash === hash);
      if (!match) return null;

      const next = codes.map((entry) =>
        entry.hash === hash ? { ...entry, usedAt: new Date().toISOString() } : entry,
      );

      const updated = await tx.query(
        `update users
            set recovery_codes = $2::jsonb,
                last_sign_in_at = now()
          where id = $1
        returning ${COLUMNS}`,
        [id, JSON.stringify(next)],
      );
      return fromRow(updated.rows[0]);
    });
  },

  /**
   * Sets a new password and bumps token_version, which invalidates every
   * cookie already issued for the account. `spentRecoveryHash`, when given,
   * marks that code used in the same statement.
   */
  async resetPassword(id, { salt, hash, spentRecoveryHash = null }) {
    return transaction(async (tx) => {
      const { rows } = await tx.query(
        'select recovery_codes from users where id = $1 for update',
        [id],
      );
      if (rows.length === 0) return null;

      const codes = rows[0].recovery_codes ?? [];
      const next = spentRecoveryHash
        ? codes.map((entry) =>
            entry.hash === spentRecoveryHash
              ? { ...entry, usedAt: new Date().toISOString() }
              : entry,
          )
        : codes;

      const updated = await tx.query(
        `update users
            set password_salt = $2,
                password_hash = $3,
                token_version = token_version + 1,
                recovery_codes = $4::jsonb
          where id = $1
        returning ${COLUMNS}`,
        [id, salt, hash, JSON.stringify(next)],
      );
      return fromRow(updated.rows[0]);
    });
  },

  async setPlatformRole(id, platformRole) {
    return fromRow(
      await queryOne(
        `update users set platform_role = $2 where id = $1 returning ${COLUMNS}`,
        [id, platformRole],
      ),
    );
  },

  async listForUniversity(universityId) {
    const { rows } = await query(
      `select ${COLUMNS} from users where university_id = $1 order by name`,
      [universityId],
    );
    return rows.map(fromRow);
  },
};
