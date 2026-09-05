import { api, el, formatDateTime, renderParagraphs, showError, toast } from '../api.js';

/**
 * The Discussions tab.
 *
 * Two views in one panel: the list of threads, and one thread open. The server
 * decides what each person may do and sends it as canEdit / canRemove /
 * canModerate flags, so the page renders permissions rather than deciding them.
 *
 * Every write returns the whole thread, which is what gets re-rendered. The
 * server may fold a deep reply up a level, and re-rendering its answer is what
 * keeps the page from disagreeing with it.
 */

const initials = (name) =>
  String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

/* ---- One post ------------------------------------------------------------- */

function postCard(post, { classroomId, threadId, canPost, depth, refresh, error }) {
  if (post.deleted) {
    return el('div', { class: 'post post--deleted', dataset: { depth: String(depth) } }, [
      el('p', { class: 'meta', text: 'This post was removed.' }),
      ...post.replies.map((child) =>
        postCard(child, { classroomId, threadId, canPost, depth: depth + 1, refresh, error }),
      ),
    ]);
  }

  const composer = el('div', { hidden: true });

  const openComposer = () => {
    const input = el('textarea', {
      rows: '3',
      maxlength: '10000',
      placeholder: `Reply to ${post.author}…`,
    });
    const send = el('button', { class: 'button button--small', type: 'button', text: 'Reply' });

    send.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      send.disabled = true;
      try {
        await api.replyToDiscussion(classroomId, threadId, {
          body: input.value,
          parentId: post.id,
        });
        await refresh();
      } catch (failure) {
        showError(error, failure.message);
        send.disabled = false;
      }
    });

    composer.replaceChildren(
      el('div', { class: 'stack stack--tight' }, [
        input,
        el('div', { class: 'row row--tight' }, [
          send,
          el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Cancel',
            onClick: () => {
              composer.hidden = true;
            },
          }),
        ]),
      ]),
    );
    composer.hidden = false;
    input.focus();
  };

  const startEdit = () => {
    const input = el('textarea', { rows: '3', maxlength: '10000', value: post.body });
    const save = el('button', { class: 'button button--small', type: 'button', text: 'Save' });

    save.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      save.disabled = true;
      try {
        await api.editDiscussionPost(classroomId, threadId, post.id, { body: input.value });
        toast('Edited');
        await refresh();
      } catch (failure) {
        showError(error, failure.message);
        save.disabled = false;
      }
    });

    composer.replaceChildren(
      el('div', { class: 'stack stack--tight' }, [
        input,
        el('div', { class: 'row row--tight' }, [
          save,
          el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Cancel',
            onClick: () => {
              composer.hidden = true;
            },
          }),
        ]),
      ]),
    );
    composer.hidden = false;
    input.focus();
  };

  return el('div', { class: 'post', dataset: { depth: String(depth) } }, [
    el('div', { class: 'post__head' }, [
      el('span', { class: 'avatar', text: initials(post.author), 'aria-hidden': 'true' }),
      el('span', { class: 'post__author', text: post.author }),
      el('span', {
        class: 'post__when',
        text: formatDateTime(post.createdAt) + (post.edited ? ' · edited' : ''),
      }),
    ]),
    ...renderParagraphs(post.body, 'post__body'),
    el('div', { class: 'row row--tight post__actions' }, [
      // Depth 2 is the cap; the server folds anything deeper up beside it,
      // and offering "Reply" there would promise nesting that does not happen.
      canPost && depth < 2
        ? el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Reply',
            onClick: openComposer,
          })
        : null,
      post.canEdit
        ? el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Edit',
            onClick: startEdit,
          })
        : null,
      post.canRemove
        ? el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Remove',
            onClick: async () => {
              if (!window.confirm('Remove this post? Any replies to it are kept.')) return;
              try {
                await api.removeDiscussionPost(classroomId, threadId, post.id);
                toast('Post removed');
                await refresh();
              } catch (failure) {
                showError(error, failure.message);
              }
            },
          })
        : null,
    ]),
    composer,
    ...post.replies.map((child) =>
      postCard(child, { classroomId, threadId, canPost, depth: depth + 1, refresh, error }),
    ),
  ]);
}

/* ---- The tab -------------------------------------------------------------- */

export async function renderDiscussionsTab({ classroomId }) {
  const container = el('div', { class: 'stack' });
  const error = el('p', { class: 'notice notice--error', hidden: true });
  const body = el('div', { class: 'stack' });

  /** null shows the list; a thread id shows that thread. */
  let openThreadId = null;

  const show = async () => {
    try {
      body.replaceChildren(openThreadId ? await threadView() : await listView());
    } catch (failure) {
      showError(error, failure.message);
    }
  };

  /* ---- The list ---- */

  async function listView() {
    const { threads } = await api.listDiscussions(classroomId);

    const composer = el('form', { class: 'card stack', hidden: true }, [
      el('h3', { class: 'card__title', text: 'Start a discussion' }),
      el('div', { class: 'field' }, [
        el('label', { for: 'd-title', text: 'Title' }),
        el('input', { id: 'd-title', type: 'text', maxlength: '120', required: true }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'd-body', text: 'Your question or point' }),
        el('textarea', { id: 'd-body', rows: '5', maxlength: '10000', required: true }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'button', type: 'submit', text: 'Post it' }),
        el('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Cancel',
          onClick: () => {
            composer.hidden = true;
          },
        }),
      ]),
    ]);

    composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const created = await api.createDiscussion(classroomId, {
          title: composer.querySelector('#d-title').value,
          body: composer.querySelector('#d-body').value,
        });
        openThreadId = created.id;
        await show();
      } catch (failure) {
        showError(error, failure.message);
      }
    });

    const rows =
      threads.length === 0
        ? [
            el('div', {
              class: 'empty-state',
              text: 'No discussions yet. Ask the first question.',
            }),
          ]
        : [
            el(
              'section',
              { class: 'card card--flush' },
              threads.map((thread) =>
                el('div', { class: 'quiz-row' }, [
                  el('div', { class: 'stack stack--tight quiz-row__main' }, [
                    el('div', { class: 'row row--tight' }, [
                      thread.pinned
                        ? el('span', { class: 'badge badge--accent', text: 'Pinned' })
                        : null,
                      thread.locked ? el('span', { class: 'badge', text: 'Closed' }) : null,
                      el('button', {
                        class: 'link-button',
                        type: 'button',
                        text: thread.title,
                        onClick: async () => {
                          openThreadId = thread.id;
                          await show();
                        },
                      }),
                    ]),
                    el('span', {
                      class: 'meta',
                      text: `${thread.author} · ${thread.postCount} post${thread.postCount === 1 ? '' : 's'} · last activity ${formatDateTime(thread.lastActivityAt)}`,
                    }),
                  ]),
                ]),
              ),
            ),
          ];

    return el('div', { class: 'stack' }, [
      el('div', { class: 'row' }, [
        el('button', {
          class: 'button',
          type: 'button',
          text: 'Start a discussion',
          onClick: () => {
            composer.hidden = false;
            composer.querySelector('#d-title').focus();
          },
        }),
      ]),
      composer,
      ...rows,
    ]);
  }

  /* ---- One thread ---- */

  async function threadView() {
    const thread = await api.readDiscussion(classroomId, openThreadId);

    const replyBox = el('textarea', {
      rows: '3',
      maxlength: '10000',
      placeholder: 'Add to the discussion…',
    });
    const replyButton = el('button', { class: 'button', type: 'button', text: 'Post reply' });

    replyButton.addEventListener('click', async () => {
      if (!replyBox.value.trim()) return;
      replyButton.disabled = true;
      try {
        await api.replyToDiscussion(classroomId, openThreadId, { body: replyBox.value });
        await show();
      } catch (failure) {
        showError(error, failure.message);
        replyButton.disabled = false;
      }
    });

    const moderation = thread.canModerate
      ? [
          el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: thread.pinned ? 'Unpin' : 'Pin',
            onClick: async () => {
              await api.updateDiscussion(classroomId, thread.id, { pinned: !thread.pinned });
              await show();
            },
          }),
          el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: thread.locked ? 'Reopen' : 'Close',
            onClick: async () => {
              await api.updateDiscussion(classroomId, thread.id, { locked: !thread.locked });
              toast(thread.locked ? 'Reopened' : 'Closed to students');
              await show();
            },
          }),
        ]
      : [];

    const remove = thread.canRemove
      ? el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'Delete discussion',
          onClick: async () => {
            if (!window.confirm(`Delete "${thread.title}" and every post in it?`)) return;
            await api.removeDiscussion(classroomId, thread.id);
            toast('Discussion deleted');
            openThreadId = null;
            await show();
          },
        })
      : null;

    return el('div', { class: 'stack' }, [
      el('div', { class: 'row row--tight' }, [
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: '← All discussions',
          onClick: async () => {
            openThreadId = null;
            await show();
          },
        }),
        el('span', { class: 'spacer' }),
        ...moderation,
        remove,
      ]),

      el('div', { class: 'stack stack--tight' }, [
        el('div', { class: 'row row--tight' }, [
          thread.pinned ? el('span', { class: 'badge badge--accent', text: 'Pinned' }) : null,
          thread.locked ? el('span', { class: 'badge', text: 'Closed' }) : null,
          el('h2', { class: 'announcement__title', text: thread.title }),
        ]),
      ]),

      el('section', { class: 'card' }, [
        postCard(thread.opening, {
          classroomId,
          threadId: thread.id,
          canPost: thread.canPost,
          depth: 0,
          refresh: show,
          error,
        }),
      ]),

      thread.replies.length > 0
        ? el(
            'section',
            { class: 'card stack' },
            thread.replies.map((post) =>
              postCard(post, {
                classroomId,
                threadId: thread.id,
                canPost: thread.canPost,
                depth: 1,
                refresh: show,
                error,
              }),
            ),
          )
        : null,

      thread.canPost
        ? el('section', { class: 'card stack' }, [
            el('h3', { class: 'card__title', text: 'Reply' }),
            replyBox,
            el('div', { class: 'row' }, [replyButton]),
          ])
        : el('p', {
            class: 'notice notice--info',
            text: 'This discussion is closed. No new replies can be posted.',
          }),
    ]);
  }

  container.append(error, body);
  await show();
  return container;
}
