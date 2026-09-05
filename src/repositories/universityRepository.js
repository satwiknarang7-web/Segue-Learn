import { query, queryOne } from '../db/index.js';

/** Postgres columns are snake_case; the domain object stays camelCase. */
const fromRow = (row) =>
  row && {
    id: row.id,
    name: row.name,
    slug: row.slug,
    emailDomain: row.email_domain,
    facultySignupCode: row.faculty_signup_code ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };

const COLUMNS = 'id, name, slug, email_domain, faculty_signup_code, created_at';

export const universityRepository = {
  async findById(id) {
    return fromRow(await queryOne(`select ${COLUMNS} from universities where id = $1`, [id]));
  },

  async findBySlug(slug) {
    return fromRow(await queryOne(`select ${COLUMNS} from universities where slug = $1`, [slug]));
  },

  /**
   * The lookup that gates signup: an address's domain decides which ecosystem
   * the new account belongs to, and an unrecognised domain gets no account.
   */
  async findByEmailDomain(domain) {
    return fromRow(
      await queryOne(`select ${COLUMNS} from universities where email_domain = $1`, [domain]),
    );
  },

  async list() {
    const { rows } = await query(`select ${COLUMNS} from universities order by name`);
    return rows.map(fromRow);
  },

  async insert({ name, slug, emailDomain, facultySignupCode = null }) {
    return fromRow(
      await queryOne(
        `insert into universities (name, slug, email_domain, faculty_signup_code)
         values ($1, $2, $3, $4)
         returning ${COLUMNS}`,
        [name, slug, emailDomain, facultySignupCode],
      ),
    );
  },
};
