import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { asString } from '../lib/validate.js';
import { announcementRepository } from '../repositories/announcementRepository.js';
import { classroomService } from './classroomService.js';

/**
 * Announcements.
 *
 * Deliberately one-way: staff write, everybody reads, nobody replies. A notice
 * that wants a conversation belongs in Discussions, which has the threading
 * and the permissions for it.
 */

const MAX_BODY = 10_000;

/** A student is never sent a draft, so there is nothing to hide client-side. */
function present(announcement, { staff }) {
  return {
    id: announcement.id,
    title: announcement.title,
    body: announcement.body,
    pinned: announcement.pinned,
    // A departed author leaves the notice standing.
    author: announcement.authorName ?? 'A former member of staff',
    publishedAt: announcement.publishedAt,
    createdAt: announcement.createdAt,
    updatedAt: announcement.updatedAt,
    // Whether it was edited after going out, which is worth seeing.
    edited: Boolean(
      announcement.publishedAt &&
        Date.parse(announcement.updatedAt) - Date.parse(announcement.publishedAt) > 1000,
    ),
    ...(staff ? { isDraft: announcement.publishedAt === null } : {}),
  };
}

function parseBody(value) {
  const body = asString(value, 'body', { max: MAX_BODY });
  if (body.trim() === '') throw badRequest('An announcement needs something to say.');
  return body;
}

export const announcementService = {
  async list(user, classroomId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = role === 'teacher' || role === 'ta' || user.platformRole === 'admin';

    const announcements = staff
      ? await announcementRepository.listAll(classroomId)
      : await announcementRepository.listPublished(classroomId);

    return {
      canPost: staff,
      announcements: announcements.map((announcement) => present(announcement, { staff })),
    };
  },

  async create(user, classroomId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
    const body = parseBody(payload.body);

    const announcement = await announcementRepository.insert({
      classroomId,
      authorId: user.id,
      title,
      body,
      pinned: payload.pinned === true,
      // Publishing is explicit, so a half-written notice cannot go out by
      // being saved.
      publishedAt: payload.publish === true ? new Date().toISOString() : null,
    });

    return present(announcement, { staff: true });
  },

  async update(user, classroomId, id, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const existing = await announcementRepository.findById(classroomId, id);
    if (!existing) throw notFound('That announcement does not exist.');

    const patch = {};
    if (payload.title !== undefined) {
      patch.title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
    }
    if (payload.body !== undefined) patch.body = parseBody(payload.body);
    if (payload.pinned !== undefined) patch.pinned = payload.pinned === true;

    if (payload.publish !== undefined) {
      // Re-publishing something already out keeps its original date: the class
      // saw it when they saw it, and a correction does not make it new.
      patch.publishedAt =
        payload.publish === true
          ? (existing.publishedAt ?? new Date().toISOString())
          : null;
    }

    const updated = await announcementRepository.update(classroomId, id, patch);
    return present(updated, { staff: true });
  },

  async remove(user, classroomId, id) {
    await classroomService.requireTeaching(user, classroomId);

    const removed = await announcementRepository.remove(classroomId, id);
    if (!removed) throw notFound('That announcement does not exist.');
    return { removed: true };
  },
};
