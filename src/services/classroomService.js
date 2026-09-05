import { config } from '../config.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { createJoinCode } from '../lib/ids.js';
import { asOptionalString, asString } from '../lib/validate.js';
import {
  classroomRepository,
  membershipRepository,
} from '../repositories/classroomRepository.js';

/**
 * Classrooms, and the rules about who may see and change one.
 *
 * Every function here takes the signed-in user rather than a university id, so
 * a caller cannot accidentally ask about a tenant the user does not belong to.
 * The university always comes from the account, never from the request.
 */

const TEACHING_ROLES = new Set(['teacher', 'ta']);

/** A join code nobody else in this university is already using. */
async function allocateJoinCode(universityId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = createJoinCode(6);
    if (!(await classroomRepository.joinCodeExists(universityId, code))) return code;
  }
  // Ten collisions against a 31^6 space means something is badly wrong.
  throw new HttpError(500, 'Could not allocate a join code. Try again.');
}

function present(classroom, role = null) {
  return {
    id: classroom.id,
    name: classroom.name,
    description: classroom.description,
    visibility: classroom.visibility,
    term: classroom.term,
    archived: classroom.archivedAt !== null,
    createdAt: classroom.createdAt,
    ...(role ? { role } : {}),
    // The join code is a secret shared at the teacher's discretion, so it is
    // added by the caller for teaching staff only -- never here.
  };
}

export const classroomService = {
  /** Every classroom this person is enrolled in, with their role in each. */
  async listForUser(user) {
    const rooms = await classroomRepository.listForUser(user.universityId, user.id);
    return rooms.map((room) => ({
      ...present(room, room.role),
      ...(TEACHING_ROLES.has(room.role) ? { joinCode: room.joinCode } : {}),
    }));
  },

  /** Public classrooms in this university that the user could join unaided. */
  async listPublic(user) {
    const rooms = await classroomRepository.listPublic(user.universityId);
    return rooms.map((room) => present(room));
  },

  async create(user, { name, description, term, visibility }) {
    const cleanName = asString(name, 'name', { max: config.limits.titleMaxLength });
    const cleanDescription = asOptionalString(description, 'description', {
      max: config.limits.descriptionMaxLength,
    });

    if (visibility && visibility !== 'private' && visibility !== 'public') {
      throw badRequest('A classroom is either private or public.');
    }

    const joinCode = await allocateJoinCode(user.universityId);
    const classroom = await classroomRepository.insert({
      universityId: user.universityId,
      ownerId: user.id,
      name: cleanName,
      description: cleanDescription ?? '',
      // Private unless asked otherwise, so nothing is exposed by forgetting.
      visibility: visibility ?? 'private',
      joinCode,
      term: asOptionalString(term, 'term', { max: 40 }) ?? null,
    });

    // The owner is a member too; otherwise their own classroom would not
    // appear on their home screen.
    await membershipRepository.add(classroom.id, user.id, 'teacher');

    return { ...present(classroom, 'teacher'), joinCode: classroom.joinCode };
  },

  /**
   * Enrols the signed-in user by code. Only ever adds them as a student: a
   * code that could grant teaching rights would be one leak away from letting
   * a student read the gradebook.
   */
  async joinByCode(user, code) {
    const cleanCode = asString(code, 'code', { max: 12 });
    const classroom = await classroomRepository.findByJoinCode(user.universityId, cleanCode);

    // Same answer for a wrong code and a code at another university, so this
    // cannot be used to probe for classrooms.
    if (!classroom) throw notFound('That code does not match a classroom.');
    if (classroom.archivedAt) throw conflict('That classroom has been archived.');

    const existing = await membershipRepository.find(classroom.id, user.id);
    if (existing) return { ...present(classroom, existing.role), alreadyMember: true };

    const membership = await membershipRepository.add(classroom.id, user.id, 'student');
    return { ...present(classroom, membership.role), alreadyMember: false };
  },

  /**
   * The classroom plus the caller's role, or 404 if they cannot see it.
   *
   * A public classroom is readable by anyone in the university; a private one
   * only by its members. Refusing with 404 rather than 403 means a private
   * classroom's existence is not disclosed.
   */
  async requireAccess(user, classroomId) {
    const classroom = await classroomRepository.findById(user.universityId, classroomId);
    if (!classroom) throw notFound('That classroom does not exist.');

    const membership = await membershipRepository.find(classroomId, user.id);
    if (!membership && classroom.visibility !== 'public') {
      throw notFound('That classroom does not exist.');
    }

    return { classroom, role: membership?.role ?? null, isMember: Boolean(membership) };
  },

  /** Access, and the right to change things: teacher, TA, or a university admin. */
  async requireTeaching(user, classroomId) {
    const access = await this.requireAccess(user, classroomId);
    const staff = TEACHING_ROLES.has(access.role) || user.platformRole === 'admin';
    if (!staff) throw new HttpError(403, 'Only teaching staff can do that.');
    if (access.classroom.archivedAt) {
      throw conflict('That classroom is archived and cannot be changed.');
    }
    return access;
  },

  async describe(user, classroomId) {
    const { classroom, role, isMember } = await this.requireAccess(user, classroomId);
    const teaching = TEACHING_ROLES.has(role);

    return {
      ...present(classroom, role),
      isMember,
      studentCount: await membershipRepository.countStudents(classroom.id),
      ...(teaching ? { joinCode: classroom.joinCode } : {}),
    };
  },

  async roster(user, classroomId) {
    const { role } = await this.requireAccess(user, classroomId);
    // A student sees who else is in the room, but not their email addresses.
    const members = await membershipRepository.listMembers(classroomId);
    if (TEACHING_ROLES.has(role) || user.platformRole === 'admin') return members;
    return members.map(({ email, ...rest }) => rest);
  },

  async update(user, classroomId, patch) {
    await this.requireTeaching(user, classroomId);

    const updated = await classroomRepository.update(user.universityId, classroomId, {
      name: patch.name ? asString(patch.name, 'name', { max: config.limits.titleMaxLength }) : null,
      description:
        patch.description === undefined
          ? null
          : asOptionalString(patch.description, 'description', {
              max: config.limits.descriptionMaxLength,
            }) ?? '',
      visibility: patch.visibility ?? null,
      term: patch.term ?? null,
    });

    return { ...present(updated, 'teacher'), joinCode: updated.joinCode };
  },

  async rotateJoinCode(user, classroomId) {
    await this.requireTeaching(user, classroomId);
    const code = await allocateJoinCode(user.universityId);
    const updated = await classroomRepository.rotateJoinCode(user.universityId, classroomId, code);
    return { joinCode: updated.joinCode };
  },

  /** Only the owner may remove someone, and never themselves. */
  async removeMember(user, classroomId, memberId) {
    const { classroom } = await this.requireTeaching(user, classroomId);

    if (memberId === classroom.ownerId) {
      throw badRequest('The owner cannot be removed from their own classroom.');
    }

    const removed = await membershipRepository.remove(classroomId, memberId);
    if (!removed) throw notFound('That person is not in this classroom.');
    return { removed: true };
  },

  async setArchived(user, classroomId, archived) {
    // requireTeaching refuses an archived classroom, so un-archiving needs the
    // plainer check: access plus staff, without the archived guard.
    const access = await this.requireAccess(user, classroomId);
    if (!TEACHING_ROLES.has(access.role) && user.platformRole !== 'admin') {
      throw new HttpError(403, 'Only teaching staff can do that.');
    }

    const updated = await classroomRepository.setArchived(
      user.universityId,
      classroomId,
      Boolean(archived),
    );
    return present(updated, access.role);
  },
};
