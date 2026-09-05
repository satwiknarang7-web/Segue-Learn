import { api, el, formatDateTime, renderParagraphs, showError, toast } from '../api.js';

/**
 * The Announcements tab.
 *
 * One-way: staff write, everybody reads. A student is never sent a draft, so
 * there is no draft on the page to hide.
 *
 * Bodies are plain text. They are rendered into paragraph elements through the
 * el() helper, which sets textContent -- so a notice containing markup is
 * displayed as markup rather than becoming it, structurally rather than by
 * escaping.
 */

const renderBody = (text) => renderParagraphs(text, 'announcement__body');

function announcementCard(classroomId, announcement, { canPost, refresh, error, openEditor }) {
  const actions = canPost
    ? el('div', { class: 'row row--tight' }, [
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: announcement.pinned ? 'Unpin' : 'Pin',
          onClick: async () => {
            await api.updateAnnouncement(classroomId, announcement.id, {
              pinned: !announcement.pinned,
            });
            toast(announcement.pinned ? 'Unpinned' : 'Pinned to the top');
            await refresh();
          },
        }),
        el('button', {
          class: announcement.isDraft ? 'button button--small' : 'button button--ghost button--small',
          type: 'button',
          text: announcement.isDraft ? 'Publish' : 'Withdraw',
          onClick: async () => {
            if (
              !announcement.isDraft &&
              !window.confirm('Withdraw this announcement? Students will stop seeing it.')
            ) {
              return;
            }
            await api.updateAnnouncement(classroomId, announcement.id, {
              publish: announcement.isDraft,
            });
            toast(announcement.isDraft ? 'Published to the classroom' : 'Withdrawn');
            await refresh();
          },
        }),
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'Edit',
          onClick: () => openEditor(announcement),
        }),
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'Delete',
          onClick: async () => {
            if (!window.confirm(`Delete "${announcement.title}"? This cannot be undone.`)) return;
            try {
              await api.deleteAnnouncement(classroomId, announcement.id);
              toast('Deleted');
              await refresh();
            } catch (failure) {
              showError(error, failure.message);
            }
          },
        }),
      ])
    : null;

  const when = announcement.isDraft
    ? `Drafted ${formatDateTime(announcement.createdAt)}`
    : formatDateTime(announcement.publishedAt);

  return el(
    'article',
    {
      class: 'announcement',
      dataset: { pinned: String(announcement.pinned), draft: String(Boolean(announcement.isDraft)) },
    },
    [
      el('div', { class: 'row row--tight' }, [
        announcement.pinned ? el('span', { class: 'badge badge--accent', text: 'Pinned' }) : null,
        announcement.isDraft ? el('span', { class: 'badge badge--draft', text: 'Draft' }) : null,
        el('h3', { class: 'announcement__title', text: announcement.title }),
      ]),
      el('p', { class: 'announcement__meta' }, [
        announcement.author,
        ' · ',
        when,
        announcement.edited ? ' · edited' : '',
      ]),
      ...renderBody(announcement.body),
      actions,
    ],
  );
}

/* ---- The tab -------------------------------------------------------------- */

export async function renderAnnouncementsTab({ classroomId }) {
  const container = el('div', { class: 'stack' });
  const error = el('p', { class: 'notice notice--error', hidden: true });
  const list = el('div', { class: 'stack' });

  /** null when composing something new, otherwise the one being edited. */
  let editing = null;

  const form = el('form', { class: 'card stack', hidden: true });
  const formTitle = el('h3', { class: 'card__title', text: 'New announcement' });
  const titleInput = el('input', {
    id: 'ann-title',
    type: 'text',
    maxlength: '120',
    required: true,
  });
  const bodyInput = el('textarea', {
    id: 'ann-body',
    rows: '6',
    maxlength: '10000',
    required: true,
    placeholder: 'What does the class need to know?',
  });
  const pinInput = el('input', { id: 'ann-pin', type: 'checkbox' });
  const publishButton = el('button', { class: 'button', type: 'submit', text: 'Publish' });
  const draftButton = el('button', {
    class: 'button button--ghost',
    type: 'button',
    text: 'Save as draft',
  });

  const closeForm = () => {
    form.hidden = true;
    editing = null;
  };

  const openEditor = (announcement = null) => {
    editing = announcement;
    formTitle.textContent = announcement ? 'Edit announcement' : 'New announcement';
    titleInput.value = announcement?.title ?? '';
    bodyInput.value = announcement?.body ?? '';
    pinInput.checked = announcement?.pinned ?? false;

    // An already-published notice is saved, not published again.
    publishButton.textContent = announcement
      ? announcement.isDraft
        ? 'Save and publish'
        : 'Save changes'
      : 'Publish';
    draftButton.hidden = Boolean(announcement) && !announcement.isDraft;

    form.hidden = false;
    titleInput.focus();
  };

  const save = async ({ publish }) => {
    const payload = {
      title: titleInput.value,
      body: bodyInput.value,
      pinned: pinInput.checked,
    };

    try {
      if (editing) {
        // Leave a published notice published; only a draft's state changes.
        await api.updateAnnouncement(classroomId, editing.id, {
          ...payload,
          ...(editing.isDraft ? { publish } : {}),
        });
        toast('Saved');
      } else {
        await api.createAnnouncement(classroomId, { ...payload, publish });
        toast(publish ? 'Published to the classroom' : 'Saved as a draft');
      }
      closeForm();
      await refresh();
    } catch (failure) {
      showError(error, failure.message);
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save({ publish: true });
  });

  draftButton.addEventListener('click', () => {
    if (!titleInput.value.trim() || !bodyInput.value.trim()) {
      showError(error, 'A draft still needs a title and something to say.');
      return;
    }
    save({ publish: false });
  });

  form.append(
    formTitle,
    el('div', { class: 'field' }, [el('label', { for: 'ann-title', text: 'Title' }), titleInput]),
    el('div', { class: 'field' }, [el('label', { for: 'ann-body', text: 'Message' }), bodyInput]),
    el('label', { class: 'switch' }, [pinInput, el('span', { text: 'Pin to the top' })]),
    el('div', { class: 'row' }, [
      publishButton,
      draftButton,
      el('button', {
        class: 'button button--ghost',
        type: 'button',
        text: 'Cancel',
        onClick: closeForm,
      }),
    ]),
  );

  // Filled by the first refresh. The API decides who may post, not the page.
  const composeRow = el('div', { class: 'row', hidden: true });
  let composeReady = false;

  async function refresh() {
    try {
      const { canPost, announcements } = await api.listAnnouncements(classroomId);

      if (canPost && !composeReady) {
        composeReady = true;
        composeRow.hidden = false;
        composeRow.append(
          el('button', {
            class: 'button',
            type: 'button',
            text: 'New announcement',
            onClick: () => openEditor(null),
          }),
        );
      }

      if (announcements.length === 0) {
        list.replaceChildren(
          el('div', {
            class: 'empty-state',
            text: canPost
              ? 'Nothing posted yet. Write the first announcement.'
              : 'No announcements yet.',
          }),
        );
        return;
      }

      list.replaceChildren(
        ...announcements.map((announcement) =>
          announcementCard(classroomId, announcement, {
            canPost,
            refresh,
            error,
            openEditor,
          }),
        ),
      );
    } catch (failure) {
      showError(error, failure.message);
    }
  }

  container.append(error, composeRow, form, list);
  await refresh();
  return container;
}
