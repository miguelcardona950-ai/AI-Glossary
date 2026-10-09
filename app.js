// Glossary: the screens, navigation between them, and what to show when.
// Every Supabase call lives in db.js; this file never talks to the database directly.

import * as db from './db.js';

const view = document.getElementById('view');
const pageTitle = document.getElementById('page-title');
const backButton = document.getElementById('back-button');
const tabbar = document.getElementById('tabbar');
const toastBox = document.getElementById('toast');

const CONNECTION_PROBLEMS = ['offline', 'timeout', 'unreachable'];
const STALE_AFTER_MS = 60_000; // reload terms when you come back to the app after this long

const state = {
  session: null,      // set once you're signed in
  terms: null,        // every term, newest first; null until the first successful load
  loadError: null,    // why the latest load failed, if it did
  loadedAt: 0,
  justAddedId: null,  // highlighted once in the list after you add it
  searchQuery: '',
  prefillTerm: '',    // carried over from "Add “xyz”" on the search screen
  signInNotice: '',
};

let refreshView = null;  // redraws the current screen when terms finish loading
let leaveScreen = null;  // cleanup for the current screen, run when you move to another one
let renderedHash = null; // the address currently on screen
let loading = null;      // the load in progress, so screens share one request
let bootFailed = false;

// ---------- Navigation ----------
// Each screen has its own address after the #, e.g. #/term/<id>. Changing it
// swaps the screen without reloading the page, and the back button works.

const routes = [
  [/^#\/$/, renderList],
  [/^#\/term\/([\w-]+)$/, renderDetail],
  [/^#\/add$/, renderAdd],
  [/^#\/edit\/([\w-]+)$/, renderEdit],
  [/^#\/search$/, renderSearch],
];

function route() {
  renderedHash = location.hash;
  refreshView = null;
  leaveScreen?.();
  leaveScreen = null;
  if (!state.session) return renderSignIn();

  for (const [pattern, render] of routes) {
    const match = location.hash.match(pattern);
    if (match) return render(match[1]);
  }
  navigate('#/', { replace: true }); // unknown address: go to the list
}

function navigate(hash, { replace = false } = {}) {
  // Remember how far down this screen was scrolled, for when you come back to it.
  history.replaceState({ ...history.state, scrollY: window.scrollY }, '');
  const depth = history.state?.depth ?? 0;
  if (replace) history.replaceState({ depth }, '', hash);
  else history.pushState({ depth: depth + 1 }, '', hash);
  route();
  window.scrollTo(0, 0);
}

// Links navigate inside the tap itself (rather than after the address changes)
// because iOS only opens the keyboard for Search and Add during a tap.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const hash = link.getAttribute('href');
  navigate(hash, { replace: hash === location.hash });
});

window.addEventListener('popstate', () => {
  if (location.hash === renderedHash) return;
  route();
  window.scrollTo(0, history.state?.scrollY ?? 0);
});

// Covers addresses typed or edited by hand.
window.addEventListener('hashchange', () => {
  if (location.hash !== renderedHash) route();
});

backButton.addEventListener('click', () => {
  if ((history.state?.depth ?? 0) > 0) history.back();
  else navigate('#/', { replace: true });
});

// Sets up the header and tab bar for a screen and clears the old content.
function showScreen({ title, tab = null, back = false }) {
  pageTitle.textContent = title;
  document.title = title && title !== 'Glossary' ? `${title} · Glossary` : 'Glossary';
  backButton.hidden = !back;
  tabbar.hidden = !state.session;
  for (const link of tabbar.querySelectorAll('[data-tab]')) {
    const active = link.dataset.tab === tab;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  view.replaceChildren();
}

// ---------- Loading terms ----------

function loadTerms() {
  loading ??= db
    .listTerms()
    .then((terms) => {
      state.terms = terms;
      state.loadError = null;
      state.loadedAt = Date.now();
    })
    .catch((error) => {
      state.loadError = error;
      if (error.kind === 'auth') signedOut('Your sign-in expired. Please sign in again.');
    })
    .finally(() => {
      loading = null;
      refreshView?.();
    });
  return loading;
}

// While the terms aren't available, returns a loading or error screen to show
// in their place. Returns null once they're loaded.
function termsGate() {
  if (state.terms) return null;
  if (state.loadError) return errorScreen(state.loadError, retryLoad);
  loadTerms();
  return loadingScreen();
}

function retryLoad() {
  state.loadError = null;
  loadTerms();
  refreshView?.();
}

// A save or delete just worked, so the connection is back: if an earlier
// reload failed, reload now to clear the "can't reach" banner.
function connectionWorked() {
  if (state.loadError) loadTerms();
}

// Coming back to the app: fetch anything added or changed on another device.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.session) return;
  if (Date.now() - state.loadedAt > STALE_AFTER_MS) loadTerms();
});

window.addEventListener('online', () => {
  if (bootFailed) boot();
  else if (state.session && state.loadError) retryLoad();
});

// ---------- Screens ----------

function renderList() {
  showScreen({ title: 'Glossary', tab: 'list' });
  refreshView = renderList;
  const gate = termsGate();
  if (gate) {
    view.append(gate);
    return;
  }

  if (state.loadError) view.append(staleBanner());
  if (state.terms.length === 0) {
    view.append(emptyGlossary());
  } else {
    view.append(
      el('p', { class: 'list-count' }, plural(state.terms.length, 'term')),
      el('ul', { class: 'term-list' }, state.terms.map((term) => termRow(term))),
    );
  }
  view.append(accountFooter());
  state.justAddedId = null;
}

function renderDetail(id) {
  showScreen({ title: '', back: true });
  refreshView = () => renderDetail(id);
  const gate = termsGate();
  if (gate) {
    view.append(gate);
    return;
  }

  const term = state.terms.find((t) => t.id === id);
  if (!term) {
    view.append(termNotFound());
    return;
  }
  document.title = `${plainText(term.term)} · Glossary`;

  const status = el('div', { class: 'form-status' });
  const deleteButton = el(
    'button',
    { type: 'button', class: 'button button-danger', onclick: () => deleteTerm(term, deleteButton, status) },
    'Delete',
  );

  if (state.loadError) view.append(staleBanner());
  view.append(
    el(
      'article',
      { class: 'term-detail' },
      el('h2', { class: 'term-detail-name' }, richText(term.term)),
      term.definition.trim()
        ? el('div', { class: 'term-detail-definition' }, richText(term.definition))
        : el('p', { class: 'term-detail-definition is-empty' }, 'No definition yet. Tap Edit to add one.'),
      el('p', { class: 'term-detail-meta' }, termDates(term)),
    ),
    status,
    el(
      'div',
      { class: 'actions' },
      el('a', { href: `#/edit/${term.id}`, class: 'button button-primary' }, 'Edit'),
      deleteButton,
    ),
  );
}

async function deleteTerm(term, button, status) {
  if (!confirm(`Delete “${plainText(term.term)}”? This can’t be undone.`)) return;
  button.disabled = true;
  button.textContent = 'Deleting…';
  status.replaceChildren();
  try {
    await db.deleteTerm(term.id);
    state.terms = state.terms.filter((t) => t.id !== term.id);
    navigate('#/', { replace: true });
    toast('Deleted');
    connectionWorked();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Delete';
    status.replaceChildren(inlineError(error, 'The term is still there. Try again when you’re connected.'));
  }
}

function renderAdd() {
  showScreen({ title: 'Add term', tab: 'add' });
  const prefill = state.prefillTerm;
  state.prefillTerm = '';
  termForm({ draftKey: 'draft:add', original: { term: prefill, definition: '' } });
}

function renderEdit(id) {
  showScreen({ title: 'Edit term', back: true });
  refreshView = () => renderEdit(id);
  const gate = termsGate();
  if (gate) {
    view.append(gate);
    return;
  }

  const term = state.terms.find((t) => t.id === id);
  if (!term) {
    view.append(termNotFound());
    return;
  }
  refreshView = null; // never redraw a form while you're typing in it
  termForm({ existing: term, draftKey: `draft:edit:${id}`, original: term });
}

// What to say when getting an AI definition fails. Your term is always kept,
// and you can still type a definition yourself.
const AI_MESSAGES = {
  offline: 'You’re offline. Getting a definition and saving both need a connection.',
  timeout: 'The AI took too long to answer. Try again, or type your own definition.',
  unreachable: 'Couldn’t reach the definition service. Try again, or type your own definition.',
  ai_unavailable: 'The AI service isn’t responding right now. Try again in a moment, or type your own definition.',
  ai_busy: 'The AI is busy. Wait a minute and try again, or type your own definition.',
  ai_empty: 'The AI didn’t return a usable definition, so nothing was filled in. Try again, or type your own.',
  ai_unknown_term: 'The AI doesn’t recognise this as a software term. Check the spelling, or type your own definition.',
  ai_no_credit: 'Your Anthropic account is out of credit. Add some at console.anthropic.com, or type your own definition.',
  ai_setup: 'Automatic definitions aren’t set up yet (see “Automatic definitions” in the README). You can type your own.',
};

// The form for both adding and editing. `existing` is the term being edited, if any.
// Only the add form has "Get definition".
function termForm({ existing = null, draftKey, original }) {
  const draft = readDraft(draftKey);
  // A new term's id is made here so that saving twice can't create two terms (see db.addTerm).
  const newId = existing ? null : (draft?.id ?? crypto.randomUUID());
  let aiSuggestion = draft?.aiSuggestion ?? null;         // the last definition the AI wrote, if any
  let aiSuggestionTerm = draft?.aiSuggestionTerm ?? null; // ...and the term it was written for
  let aiRequest = null;                                   // lets Cancel stop the request in progress

  const termInput = el('input', {
    id: 'term',
    type: 'text',
    required: true,
    maxlength: 200,
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
    value: draft?.term ?? original.term,
  });
  const definitionInput = el('textarea', {
    id: 'definition',
    rows: 8,
    maxlength: 20000,
    autocapitalize: 'sentences',
    value: draft?.definition ?? original.definition,
  });
  const status = el('div', { class: 'form-status' });
  const saveLabel = existing ? 'Save changes' : 'Save term';
  const saveButton = el('button', { type: 'submit', class: 'button button-primary' }, saveLabel);
  const aiButton =
    !existing &&
    el(
      'button',
      { type: 'button', class: 'button button-secondary', onclick: getDefinition },
      aiSuggestion ? 'Try again' : 'Get definition',
    );
  const aiStatus = el('div', { class: 'ai-status' });
  const aiBadge = el('span', { class: 'ai-badge' }, 'Suggested by AI. Check it and edit if needed before saving.');

  // The return key in the Term field moves to Definition instead of submitting.
  termInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      definitionInput.focus();
    }
  });

  // Keep unsaved typing: iOS often reloads home-screen apps when you switch away.
  function saveDraft() {
    const current = { term: termInput.value, definition: definitionInput.value };
    const unchanged = current.term === original.term && current.definition === original.definition;
    if (unchanged) clearDraft(draftKey);
    else writeDraft(draftKey, { ...current, id: newId, aiSuggestion, aiSuggestionTerm });
  }

  // True while the Definition box still holds the AI's suggestion exactly as written.
  function isUntouchedSuggestion() {
    return Boolean(aiSuggestion) && definitionInput.value.trim() === aiSuggestion.trim();
  }

  function updateBadge() {
    aiBadge.hidden = !(aiSuggestion && definitionInput.value.trim());
    const termChanged = aiSuggestionTerm && aiSuggestionTerm !== termInput.value.trim();
    aiBadge.textContent = termChanged
      ? `Suggested by AI for “${aiSuggestionTerm}”. Check it fits this term before saving.`
      : 'Suggested by AI. Check it and edit if needed before saving.';
  }

  async function getDefinition() {
    const term = termInput.value.trim();
    if (!term) {
      aiStatus.replaceChildren(el('p', { class: 'field-error', role: 'alert' }, 'Type the term first.'));
      termInput.focus();
      return;
    }
    const isOwnWriting = definitionInput.value.trim() && !isUntouchedSuggestion();
    if (isOwnWriting && !confirm('Replace the definition you’ve written with an AI suggestion?')) return;
    // A suggestion written for a different term is cleared now, so if this request
    // fails the box is empty rather than holding a definition of something else.
    if (isUntouchedSuggestion() && aiSuggestionTerm !== term) {
      definitionInput.value = '';
      saveDraft();
    }

    const controller = new AbortController();
    aiRequest = controller;
    showWaiting(term);
    try {
      const definition = await db.defineTerm(term, controller.signal);
      if (aiRequest !== controller || !definitionInput.isConnected) return; // cancelled, or you left the form
      aiSuggestion = definition;
      aiSuggestionTerm = term;
      definitionInput.value = definition;
      aiStatus.replaceChildren();
      saveDraft();
    } catch (error) {
      if (aiRequest !== controller || error.kind === 'cancelled') return;
      if (error.kind === 'auth') {
        signedOut('Your sign-in expired. Please sign in again.'); // what you typed is kept as a draft
        return;
      }
      aiStatus.replaceChildren(
        el(
          'div',
          { class: 'notice notice-error notice-inline', role: 'alert' },
          el('p', {}, el('strong', {}, 'Couldn’t get a definition')),
          el('p', {}, AI_MESSAGES[error.kind] ?? error.message),
        ),
      );
    } finally {
      if (aiRequest === controller) stopWaiting();
      updateBadge();
    }
  }

  function showWaiting(term) {
    termInput.readOnly = true;
    definitionInput.readOnly = true;
    saveButton.disabled = true;
    aiButton.hidden = true;
    aiStatus.replaceChildren(
      el(
        'div',
        { class: 'ai-waiting', role: 'status' },
        el('span', { class: 'spinner', 'aria-hidden': 'true' }),
        el('p', {}, `Writing a definition for “${term}”…`),
        el('button', { type: 'button', class: 'ai-cancel', onclick: cancelDefinition }, 'Cancel'),
      ),
    );
  }

  function stopWaiting() {
    aiRequest = null;
    termInput.readOnly = false;
    definitionInput.readOnly = false;
    saveButton.disabled = false;
    aiButton.hidden = false;
    aiButton.textContent = aiSuggestion ? 'Try again' : 'Get definition';
  }

  function cancelDefinition() {
    aiRequest?.abort();
    stopWaiting();
    aiStatus.replaceChildren();
  }

  // Leaving the form (Back, a tab, signing out) stops a request still in progress.
  leaveScreen = () => aiRequest?.abort();

  async function save(event) {
    event.preventDefault();
    const fields = { term: termInput.value.trim(), definition: definitionInput.value.trim() };
    if (!fields.term) {
      status.replaceChildren(el('p', { class: 'field-error', role: 'alert' }, 'Enter the term first.'));
      termInput.focus();
      return;
    }
    // A term is never saved without a definition.
    if (!fields.definition) {
      const hint = existing ? 'Add a definition first.' : 'Add a definition first: type one, or tap Get definition.';
      status.replaceChildren(el('p', { class: 'field-error', role: 'alert' }, hint));
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    status.replaceChildren();
    try {
      if (existing) {
        const saved = await db.updateTerm(existing.id, fields);
        clearDraft(draftKey);
        state.terms = state.terms.map((t) => (t.id === saved.id ? saved : t));
        navigate(`#/term/${saved.id}`, { replace: true });
        toast('Saved');
      } else {
        const saved = await db.addTerm({ id: newId, ...fields });
        clearDraft(draftKey);
        // Only add to a list that's already loaded. If it isn't, the list loads
        // fresh, rather than showing just this one term as if it were all of them.
        if (state.terms) state.terms = [saved, ...state.terms.filter((t) => t.id !== saved.id)];
        state.justAddedId = saved.id;
        navigate('#/', { replace: true });
        toast(`Added “${plainText(saved.term)}”`);
      }
      connectionWorked();
    } catch (error) {
      saveButton.disabled = false;
      saveButton.textContent = saveLabel;
      status.replaceChildren(inlineError(error, 'Nothing you typed is lost. Try again when you’re connected.'));
    }
  }

  const restoredNotice =
    draft &&
    el(
      'div',
      { class: 'restored' },
      el('p', {}, 'Restored what you were typing.'),
      el(
        'button',
        {
          type: 'button',
          class: 'restored-button',
          onclick: () => {
            clearDraft(draftKey);
            existing ? renderEdit(existing.id) : renderAdd();
          },
        },
        'Discard',
      ),
    );

  view.append(
    el(
      'form',
      {
        class: 'term-form',
        novalidate: true,
        onsubmit: save,
        oninput: () => {
          saveDraft();
          updateBadge();
        },
      },
      restoredNotice,
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Term'), termInput),
      aiButton,
      aiStatus,
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field-label' }, 'Definition'),
        !existing && aiBadge,
        definitionInput,
      ),
      el('p', { class: 'field-hint' }, 'Wrap code in `backticks` to show it as code.'),
      status,
      el(
        'div',
        { class: 'actions' },
        saveButton,
        existing &&
          el(
            'button',
            {
              type: 'button',
              class: 'button button-secondary',
              onclick: () => {
                clearDraft(draftKey);
                backButton.click();
              },
            },
            'Cancel',
          ),
      ),
    ),
  );

  updateBadge();
  // An empty Add form opens the keyboard on Term. A prefilled one doesn't,
  // so "Get definition" stays in view.
  if (!existing && !termInput.value) termInput.focus();
}

function renderSearch() {
  showScreen({ title: 'Search', tab: 'search' });
  const results = el('div', { class: 'search-results' });
  const input = el('input', {
    type: 'search',
    class: 'search-input',
    placeholder: 'Search terms and definitions',
    'aria-label': 'Search terms and definitions',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    value: state.searchQuery,
    oninput: () => {
      state.searchQuery = input.value;
      showResults();
    },
  });

  function showResults() {
    const gate = termsGate();
    if (gate) {
      results.replaceChildren(gate);
      return;
    }
    const query = state.searchQuery.trim();
    const matches = query ? search(state.terms, query) : state.terms;
    results.replaceChildren();
    if (state.loadError) results.append(staleBanner());

    if (state.terms.length === 0) {
      results.append(emptyGlossary());
    } else if (matches.length === 0) {
      results.append(
        el(
          'section',
          { class: 'empty' },
          el('h2', {}, 'No matches'),
          el('p', {}, `Nothing in your glossary matches “${query}”.`),
          el(
            'button',
            {
              type: 'button',
              class: 'button button-primary',
              onclick: () => {
                state.prefillTerm = query;
                navigate('#/add');
              },
            },
            `Add “${query}”`,
          ),
        ),
      );
    } else {
      results.append(
        el('p', { class: 'list-count' }, query ? plural(matches.length, 'match', 'matches') : plural(matches.length, 'term')),
        el('ul', { class: 'term-list' }, matches.map((term) => termRow(term, query))),
      );
    }
  }

  view.append(
    el(
      'form',
      {
        class: 'search-form',
        role: 'search',
        onsubmit: (event) => {
          event.preventDefault();
          input.blur(); // hide the keyboard so the results are visible
        },
      },
      input,
    ),
    results,
  );
  refreshView = showResults;
  showResults();
  input.focus();
}

// Term-name matches first (those starting with the search before those
// containing it), then definition-only matches. Ties stay newest first.
function search(terms, query) {
  const q = query.toLowerCase();
  const scored = [];
  for (const term of terms) {
    const name = plainText(term.term).toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (plainText(term.definition).toLowerCase().includes(q)) score = 2;
    if (score >= 0) scored.push([score, term]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, term]) => term);
}

function renderSignIn() {
  showScreen({ title: 'Sign in' });
  const email = el('input', {
    type: 'email',
    autocomplete: 'username',
    inputmode: 'email',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
    required: true,
  });
  const password = el('input', { type: 'password', autocomplete: 'current-password', enterkeyhint: 'go', required: true });
  const status = el('div', { class: 'form-status' });
  const button = el('button', { type: 'submit', class: 'button button-primary' }, 'Sign in');

  async function signIn(event) {
    event.preventDefault();
    if (!email.value.trim() || !password.value) {
      status.replaceChildren(el('p', { class: 'field-error', role: 'alert' }, 'Enter your email and password.'));
      return;
    }
    button.disabled = true;
    button.textContent = 'Signing in…';
    status.replaceChildren();
    try {
      state.session = await db.signIn(email.value.trim(), password.value);
      state.terms = null;
      state.loadError = null;
      state.signInNotice = '';
      route();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Sign in';
      status.replaceChildren(inlineError(error, 'Check your connection and try again.'));
    }
  }

  view.append(
    el('p', { class: 'intro' }, 'Sign in with the account you created in your Supabase dashboard.'),
    state.signInNotice && el('p', { class: 'notice notice-inline' }, state.signInNotice),
    el(
      'form',
      { class: 'term-form', novalidate: true, onsubmit: signIn },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Email'), email),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Password'), password),
      status,
      el('div', { class: 'actions' }, button),
    ),
  );
}

function signedOut(notice) {
  state.session = null;
  state.terms = null;
  state.loadError = null;
  state.signInNotice = notice;
  route();
  db.signOut().catch(() => {});
}

async function confirmSignOut(event) {
  if (!confirm('Sign out? You’ll need your password to sign back in.')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await db.signOut(); // the onSignedOut handler below switches to the sign-in screen
  } catch (error) {
    button.disabled = false;
    toast(`Couldn’t sign out: ${describeError(error).title}`);
  }
}

db.onSignedOut(() => {
  if (!state.session) return; // already showing the sign-in screen
  state.session = null;
  state.terms = null;
  state.loadError = null;
  route();
});

// ---------- Pieces shared by several screens ----------

const REASSURANCE = 'Your terms aren’t lost. The app just can’t reach the database right now.';

function describeError(error) {
  switch (error.kind) {
    case 'offline':
      return {
        title: 'You’re offline',
        body: REASSURANCE,
        hint: 'Check Wi-Fi or mobile data. The app will try again when you’re back online.',
      };
    case 'timeout':
      return {
        title: 'Can’t reach your glossary database',
        body: REASSURANCE,
        hint: 'It took too long to answer. Your connection may be slow, or Supabase may be having trouble.',
      };
    case 'unreachable':
      return {
        title: 'Can’t reach your glossary database',
        body: REASSURANCE,
        hint: 'Supabase isn’t responding. Free Supabase projects pause after a week without use. If yours has, open supabase.com/dashboard and restore the project.',
      };
    case 'setup':
      return {
        title: 'The terms table is missing',
        body: 'The database answered, but it doesn’t have a terms table yet.',
        hint: 'Run schema.sql in Supabase → SQL Editor, then try again.',
      };
    case 'notfound':
      return { title: 'This term no longer exists', body: 'It may have been deleted on another device.', hint: '' };
    case 'invalid':
    case 'auth':
      return { title: error.message, body: '', hint: '' };
    default:
      return { title: 'Something went wrong', body: error.message, hint: '' };
  }
}

function errorScreen(error, onRetry) {
  const { title, body, hint } = describeError(error);
  return el(
    'section',
    { class: 'notice notice-error', role: 'alert' },
    el('h2', {}, title),
    body && el('p', {}, body),
    hint && el('p', { class: 'notice-hint' }, hint),
    el('button', { type: 'button', class: 'button button-primary', onclick: onRetry }, 'Try again'),
  );
}

// A compact error inside a form, where a full-screen message would hide what you typed.
function inlineError(error, connectionNote) {
  const { title, body, hint } = describeError(error);
  const isConnectionProblem = CONNECTION_PROBLEMS.includes(error.kind);
  return el(
    'div',
    { class: 'notice notice-error notice-inline', role: 'alert' },
    el('p', {}, el('strong', {}, title)),
    el('p', {}, isConnectionProblem ? connectionNote : hint || body),
  );
}

// Shown above terms that loaded earlier when a later reload failed.
function staleBanner() {
  return el(
    'div',
    { class: 'banner', role: 'status' },
    el('p', {}, el('strong', {}, describeError(state.loadError).title), `. Showing terms loaded at ${clockTime(state.loadedAt)}.`),
    el('button', { type: 'button', class: 'banner-button', onclick: retryLoad }, 'Retry'),
  );
}

function loadingScreen(text = 'Loading your terms…') {
  return el('div', { class: 'loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

function emptyGlossary() {
  return el(
    'section',
    { class: 'empty' },
    el('h2', {}, 'No terms yet'),
    el('p', {}, 'Next time you hit a word you don’t know, add it here.'),
    el('a', { href: '#/add', class: 'button button-primary' }, 'Add your first term'),
  );
}

function termNotFound() {
  return el(
    'section',
    { class: 'empty' },
    el('h2', {}, 'Term not found'),
    el('p', {}, 'It may have been deleted.'),
    el('a', { href: '#/', class: 'button button-secondary' }, 'Back to all terms'),
  );
}

function termRow(term, query = '') {
  const definition = plainText(term.definition).replace(/\s+/g, ' ').trim();
  return el(
    'li',
    {},
    el(
      'a',
      { href: `#/term/${term.id}`, class: term.id === state.justAddedId ? 'term-row is-new' : 'term-row' },
      el('span', { class: 'term-row-name' }, highlight(plainText(term.term), query)),
      definition
        ? el('span', { class: 'term-row-preview' }, highlight(snippet(definition, query), query))
        : el('span', { class: 'term-row-preview is-empty' }, 'No definition yet'),
    ),
  );
}

function accountFooter() {
  return el(
    'footer',
    { class: 'account' },
    el('p', {}, 'Signed in as ', el('strong', {}, state.session.user?.email ?? 'you')),
    el('button', { type: 'button', class: 'button button-quiet', onclick: confirmSignOut }, 'Sign out'),
  );
}

let toastTimer;
function toast(message) {
  toastBox.textContent = message;
  toastBox.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.remove('is-visible'), 2500);
}

// ---------- Small helpers ----------

// Builds an element: el('a', { href: '#/', class: 'row' }, 'text', otherElement, [more]).
// Text is always added as text, never as HTML, so nothing you type can break the page.
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'value') node.value = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child != null && child !== false && child !== ''));
  return node;
}

// Text between `backticks` is shown as code.
function richText(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    parts.push(text.slice(last, match.index), el('code', {}, match[1]));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function plainText(text) {
  return text.replaceAll('`', '');
}

// Wraps each occurrence of the search in <mark>.
function highlight(text, query) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts = [];
  let from = 0;
  let at;
  while ((at = lower.indexOf(q, from)) !== -1) {
    parts.push(text.slice(from, at), el('mark', {}, text.slice(at, at + q.length)));
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return parts;
}

// For a match deep inside a long definition, start the preview near the match.
function snippet(text, query) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at <= 40) return text;
  const space = text.indexOf(' ', at - 30); // start on a whole word
  return `…${text.slice(space === -1 || space >= at ? at : space + 1)}`;
}

function plural(count, one, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function termDates(term) {
  const created = new Date(term.created_at);
  const updated = new Date(term.updated_at);
  const added = `Added ${dateFormat.format(created)}`;
  return updated - created > 60_000 ? `${added} · Edited ${dateFormat.format(updated)}` : added;
}

function clockTime(timestamp) {
  return timeFormat.format(new Date(timestamp));
}

function readDraft(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeDraft(key, draft) {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Private browsing or storage full: drafts just won't survive a reload.
  }
}

function clearDraft(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as above.
  }
}

// ---------- Start ----------

async function boot() {
  bootFailed = false;
  showScreen({ title: 'Glossary' });
  view.append(loadingScreen('Opening your glossary…'));
  try {
    state.session = await db.getSession();
  } catch (error) {
    // The saved sign-in couldn't be checked because of the connection. Say that,
    // rather than asking for a password that isn't the problem.
    bootFailed = true;
    showScreen({ title: 'Glossary' });
    view.append(errorScreen(error, boot));
    return;
  }
  route();
}

history.scrollRestoration = 'manual';
if (!location.hash) history.replaceState({ depth: 0 }, '', '#/');
else if (!history.state) history.replaceState({ depth: 0 }, '');
boot();
